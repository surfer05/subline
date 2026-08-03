import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock at the module boundary: translateBatch calls the engines directly, so
// this is the only seam. Without it these tests would hit the network.
vi.mock("../engines/google", () => ({ translateWithGoogle: vi.fn() }));
// PARTIAL mock: only the network-calling function is replaced. TRUNCATED_ERROR
// must be the REAL constant — stubbing it here would let native.ts and this
// test agree on a string that claude.ts never actually throws, which is exactly
// the kind of agreement that makes a test vacuous.
vi.mock("../engines/claude", async importOriginal => ({
    // `as`, not a type argument: `vi` is untyped when this file is compiled
    // inside the Vencord checkout (vitest resolves only from this repo), and a
    // type argument on an untyped call is a hard TS error there.
    ...(await importOriginal() as typeof import("../engines/claude")),
    translateWithClaude: vi.fn()
}));
vi.mock("../engines/gemini", async importOriginal => ({
    ...(await importOriginal() as typeof import("../engines/gemini")),
    translateWithGemini: vi.fn()
}));

import { translateWithClaude, TRUNCATED_ERROR } from "../engines/claude";
import { translateWithGemini } from "../engines/gemini";
import { translateWithGoogle } from "../engines/google";
import { translateBatch } from "../native";
import type { BatchRequest, Result } from "../types";

const google = vi.mocked(translateWithGoogle);
const claude = vi.mocked(translateWithClaude);
const gemini = vi.mocked(translateWithGemini);

const req: BatchRequest = {
    messages: [{ id: "1", author: "ana", text: "hola" }],
    context: [],
    targetLang: "en"
};
const reqJson = JSON.stringify(req);

// Vencord injects the IpcMainInvokeEvent; nothing in translateBatch touches it,
// so a bare cast keeps electron out of this package's dependency graph.
const EV = {} as never;

/**
 * Drive translateBatch to completion under fake timers so the 1000ms retry
 * backoff does not make every retry test take a real second.
 */
async function run(engine: "google" | "claude" | "gemini", apiKey: string, json = reqJson) {
    const p = translateBatch(EV, engine, apiKey, json);
    const settled = Promise.allSettled([p]);
    await vi.runAllTimersAsync();
    const [outcome] = await settled;
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
}

beforeEach(() => {
    vi.useFakeTimers();
    google.mockReset();
    claude.mockReset();
    gemini.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("translateBatch — request payload", () => {
    it("rejects a malformed request payload without calling any engine", async () => {
        const res = await run("google", "", "not json");
        expect(res).toEqual({ ok: false, error: "bad request payload" });
        expect(google).not.toHaveBeenCalled();
        expect(claude).not.toHaveBeenCalled();
    });
});

describe("translateBatch — success", () => {
    it("passes the engine's results through unchanged", async () => {
        const results: Result[] = [
            { id: "1", lang: "es", text: "hello", skip: false },
            { id: "2", skip: true },
            { id: "3", failed: true }
        ];
        google.mockResolvedValue(results);

        const res = await run("google", "");

        expect(res).toEqual({ ok: true, results });
        expect(google).toHaveBeenCalledTimes(1);
        expect(google.mock.calls[0][0]).toEqual(req);
    });

    it("dispatches to the claude engine with the api key when selected", async () => {
        claude.mockResolvedValue([{ id: "1", skip: true }]);

        const res = await run("claude", "sk-test");

        expect(res).toEqual({ ok: true, results: [{ id: "1", skip: true }] });
        expect(claude).toHaveBeenCalledTimes(1);
        expect(claude.mock.calls[0][1]).toBe("sk-test");
        expect(google).not.toHaveBeenCalled();
    });

    it("dispatches to the gemini engine with the api key when selected", async () => {
        gemini.mockResolvedValue([{ id: "1", skip: true }]);

        const res = await run("gemini", "AIza-test");

        expect(res).toEqual({ ok: true, results: [{ id: "1", skip: true }] });
        expect(gemini).toHaveBeenCalledTimes(1);
        expect(gemini.mock.calls[0][1]).toBe("AIza-test");
        expect(google).not.toHaveBeenCalled();
        expect(claude).not.toHaveBeenCalled();
    });
});

describe("translateBatch — isRetryable classifier boundaries", () => {
    // One call = the failure was classified as unrecoverable and not retried.
    // Two calls = classified as retryable, so withRetry made its one retry.
    it("does not retry a 401 — the same wrong key fails identically", async () => {
        claude.mockRejectedValue(new Error("claude: HTTP 401"));
        const res = await run("claude", "bad");
        expect(claude).toHaveBeenCalledTimes(1);
        expect(res).toEqual({ ok: false, error: "claude: HTTP 401", retryAfterMs: undefined });
    });

    it("does not retry a 400 or a 403 either", async () => {
        claude.mockRejectedValue(new Error("claude: HTTP 400"));
        await run("claude", "k");
        expect(claude).toHaveBeenCalledTimes(1);

        claude.mockReset();
        claude.mockRejectedValue(new Error("claude: HTTP 403"));
        await run("claude", "k");
        expect(claude).toHaveBeenCalledTimes(1);
    });

    it("retries a 429", async () => {
        claude.mockRejectedValue(new Error("claude: HTTP 429"));
        await run("claude", "k");
        expect(claude).toHaveBeenCalledTimes(2);
    });

    it("does not retry a gemini 401 — the same wrong key fails identically", async () => {
        gemini.mockRejectedValue(new Error("gemini: HTTP 401"));
        const res = await run("gemini", "bad");
        expect(gemini).toHaveBeenCalledTimes(1);
        expect(res).toEqual({ ok: false, error: "gemini: HTTP 401", retryAfterMs: undefined });
    });

    it("retries a gemini 429", async () => {
        gemini.mockRejectedValue(new Error("gemini: HTTP 429"));
        const res = await run("gemini", "k");
        expect(gemini).toHaveBeenCalledTimes(2);
        expect(res).toEqual({ ok: false, error: "gemini: HTTP 429", retryAfterMs: 30_000 });
    });

    it("retries a 500", async () => {
        google.mockRejectedValue(new Error("google: HTTP 500"));
        await run("google", "");
        expect(google).toHaveBeenCalledTimes(2);
    });

    it("retries a 503", async () => {
        google.mockRejectedValue(new Error("google: HTTP 503"));
        await run("google", "");
        expect(google).toHaveBeenCalledTimes(2);
    });

    it("retries a parse error that carries no HTTP status", async () => {
        claude.mockRejectedValue(new Error("claude: response was not valid JSON"));
        await run("claude", "k");
        expect(claude).toHaveBeenCalledTimes(2);
    });

    it("retries a bare network error", async () => {
        google.mockRejectedValue(new Error("fetch failed"));
        await run("google", "");
        expect(google).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry a max_tokens truncation", async () => {
        // Truncation carries no HTTP status, so the "no status → retry"
        // default would pick it up — but the retry sends the same prompt with
        // the same output budget and truncates at the identical point. Pure
        // double spend for a guaranteed second failure, same class of bug as
        // the 401 blanket retry.
        claude.mockRejectedValue(new Error(TRUNCATED_ERROR));
        // A realistic key: the one-character "k" used elsewhere in this file is
        // itself a substring of "max_tokens", and the scrubber would redact it.
        const res = await run("claude", "sk-ant-truncation-test");
        expect(claude).toHaveBeenCalledTimes(1);
        expect(res).toEqual({ ok: false, error: TRUNCATED_ERROR, retryAfterMs: undefined });
    });

    it("still retries a truncation-shaped message that is not the real marker", async () => {
        // Guards the exact-match: a generic parse failure must keep its retry.
        claude.mockRejectedValue(new Error("claude: response truncated somehow"));
        await run("claude", "k");
        expect(claude).toHaveBeenCalledTimes(2);
    });
});

describe("translateBatch — retryAfterMs", () => {
    it("prefers the engine's own parsed retry hint over the hardcoded 30s default", async () => {
        // The engine (see httpError.ts/rateHint.ts) may have parsed a real
        // Retry-After/RetryInfo hint onto the thrown error's `retryAfterMs`
        // property. If native.ts ignored it and always used the constant,
        // this would come back 30_000 instead of 5_000.
        const err = new Error("claude: HTTP 429");
        (err as { retryAfterMs?: number }).retryAfterMs = 5_000;
        claude.mockRejectedValue(err);

        const res = await run("claude", "k");

        expect(res).toEqual({ ok: false, error: "claude: HTTP 429", retryAfterMs: 5_000 });
    });

    it("falls back to the 30s default when the engine attached no hint", async () => {
        claude.mockRejectedValue(new Error("claude: HTTP 429"));
        const res = await run("claude", "k");
        expect((res as { retryAfterMs?: number }).retryAfterMs).toBe(30_000);
    });

    it("ignores a non-numeric retryAfterMs property rather than trusting it blindly", async () => {
        const err = new Error("claude: HTTP 429");
        (err as { retryAfterMs?: unknown }).retryAfterMs = "soon";
        claude.mockRejectedValue(err);

        const res = await run("claude", "k");

        expect((res as { retryAfterMs?: number }).retryAfterMs).toBe(30_000);
    });

    it("signals a 30s pause on a rate-limit failure", async () => {
        claude.mockRejectedValue(new Error("claude: HTTP 429"));
        const res = await run("claude", "k");
        expect(res).toEqual({ ok: false, error: "claude: HTTP 429", retryAfterMs: 30_000 });
    });

    it("leaves retryAfterMs undefined for a non-rate-limit failure", async () => {
        claude.mockRejectedValue(new Error("claude: HTTP 401"));
        const res = await run("claude", "k");
        expect(res.ok).toBe(false);
        expect((res as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
    });

    it("does not treat a bare 429 without the HTTP prefix as a rate limit", async () => {
        // isRetryable and the retryAfterMs signal must agree on what a message
        // means; both use the strict /\bHTTP (\d{3})\b/ extractor. A message
        // that merely contains the digits 429 is not a rate limit.
        google.mockRejectedValue(new Error("google: 429 tokens over budget"));
        const res = await run("google", "");
        expect((res as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
    });

    it("reads the status from the RAW message, so scrubbing cannot desync it from isRetryable", async () => {
        // A degenerate key that happens to contain the status text. isRetryable
        // classifies the raw message (rate limited → retry), so if the pause
        // signal were read off the SCRUBBED string it would see "[redacted]",
        // find no status, and skip the pause — the queue would keep hammering
        // an endpoint that just rate-limited us. The api key is arbitrary user
        // input; nothing stops it looking like this.
        const key = "HTTP 429";
        claude.mockRejectedValue(new Error("claude: HTTP 429"));

        const res = await run("claude", key);

        expect(claude).toHaveBeenCalledTimes(2);            // isRetryable saw the 429
        expect((res as { retryAfterMs?: number }).retryAfterMs).toBe(30_000);   // and so did this
        // ...while the value that crosses IPC is still scrubbed.
        expect((res as { error: string }).error).toBe("claude: [redacted]");
    });
});

describe("translateBatch — api key safety", () => {
    it("never returns the api key in the error string", async () => {
        // The existing canary in claude.test.ts only covers the message
        // claude.ts itself throws. This one covers the value that actually
        // crosses the IPC boundary into the renderer: translateBatch echoes
        // err.message verbatim, so any engine (or a future one, or a
        // dependency) that puts the key in an error would leak it.
        const key = "sk-ant-secret-value-do-not-leak";
        claude.mockRejectedValue(new Error(`claude: HTTP 401 for key ${key}`));

        const res = await run("claude", key);

        expect(res.ok).toBe(false);
        expect((res as { error: string }).error).not.toContain(key);
    });

    it("never returns the gemini api key in the error string", async () => {
        const key = "AIza-secret-value-do-not-leak";
        gemini.mockRejectedValue(new Error(`gemini: HTTP 401 for key ${key}`));

        const res = await run("gemini", key);

        expect(res.ok).toBe(false);
        expect((res as { error: string }).error).not.toContain(key);
    });

    it("does not redact anything when no api key is configured", async () => {
        // Guard against a scrubber that treats an empty key as a match and
        // shreds every error message into single characters.
        google.mockRejectedValue(new Error("google: HTTP 500"));
        const res = await run("google", "");
        expect((res as { error: string }).error).toBe("google: HTTP 500");
    });

    it("does not mangle an unrelated message when the key is whitespace-only", async () => {
        // A whitespace-only key is not a secret, but it IS a live separator: a
        // length-only blank check would replace every three-space run in this
        // message with [redacted].
        google.mockRejectedValue(new Error("google: HTTP 500   three   spaces"));
        const res = await run("google", "   ");
        const { error } = res as { error: string };
        expect(error).toBe("google: HTTP 500   three   spaces");
        expect(error).not.toContain("[redacted]");
    });
});
