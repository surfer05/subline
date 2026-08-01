import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock at the module boundary: translateBatch calls the engines directly, so
// this is the only seam. Without it these tests would hit the network.
vi.mock("../engines/google", () => ({ translateWithGoogle: vi.fn() }));
vi.mock("../engines/claude", () => ({ translateWithClaude: vi.fn() }));

import { translateWithClaude } from "../engines/claude";
import { translateWithGoogle } from "../engines/google";
import { translateBatch } from "../native";
import type { BatchRequest, Result } from "../types";

const google = vi.mocked(translateWithGoogle);
const claude = vi.mocked(translateWithClaude);

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
async function run(engine: "google" | "claude", apiKey: string, json = reqJson) {
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
});

describe("translateBatch — retryAfterMs", () => {
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

    it("does not redact anything when no api key is configured", async () => {
        // Guard against a scrubber that treats an empty key as a match and
        // shreds every error message.
        google.mockRejectedValue(new Error("google: HTTP 500"));
        const res = await run("google", "");
        expect((res as { error: string }).error).toBe("google: HTTP 500");
    });
});
