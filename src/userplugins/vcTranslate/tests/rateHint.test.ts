import { describe, expect, it } from "vitest";
import {
    modelFromGeminiBody, parseResetDuration, quotaLimitFromGeminiBody, rateLimitFromHeaders,
    retryAfterFromGeminiBody, retryAfterFromHeader
} from "../rateHint";
import {
    REAL_GEMINI_429_BODY, REAL_GEMINI_429_LIMIT, REAL_GEMINI_429_RETRY_MS
} from "./fixtures/real429";

describe("retryAfterFromHeader", () => {
    it("parses a Retry-After header (seconds) into milliseconds", () => {
        const res = { headers: { get: (n: string) => (n === "retry-after" ? "13" : null) } };
        expect(retryAfterFromHeader(res)).toBe(13_000);
    });

    it("returns undefined when the header is absent", () => {
        const res = { headers: { get: () => null } };
        expect(retryAfterFromHeader(res)).toBeUndefined();
    });

    it("returns undefined when there is no headers object at all", () => {
        expect(retryAfterFromHeader({})).toBeUndefined();
    });

    it("returns undefined for a non-numeric header value", () => {
        // The HTTP-date form of Retry-After is deliberately not parsed here.
        const res = { headers: { get: () => "Wed, 21 Oct 2026 07:28:00 GMT" } };
        expect(retryAfterFromHeader(res)).toBeUndefined();
    });

    it("returns undefined for a negative value", () => {
        const res = { headers: { get: () => "-5" } };
        expect(retryAfterFromHeader(res)).toBeUndefined();
    });
});

describe("retryAfterFromGeminiBody", () => {
    it("parses a whole-second RetryInfo retryDelay", () => {
        const body = {
            error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "13s" }] }
        };
        expect(retryAfterFromGeminiBody(body)).toBe(13_000);
    });

    it("parses a fractional retryDelay", () => {
        const body = { error: { details: [{ retryDelay: "1.5s" }] } };
        expect(retryAfterFromGeminiBody(body)).toBe(1_500);
    });

    it("skips a details entry with no retryDelay and keeps looking", () => {
        const body = { error: { details: [{ "@type": "other" }, { retryDelay: "2s" }] } };
        expect(retryAfterFromGeminiBody(body)).toBe(2_000);
    });

    it("returns undefined when details is missing or empty", () => {
        expect(retryAfterFromGeminiBody({ error: {} })).toBeUndefined();
        expect(retryAfterFromGeminiBody({ error: { details: [] } })).toBeUndefined();
    });

    it("returns undefined for a non-object body", () => {
        expect(retryAfterFromGeminiBody(null)).toBeUndefined();
        expect(retryAfterFromGeminiBody("nope")).toBeUndefined();
        expect(retryAfterFromGeminiBody(undefined)).toBeUndefined();
    });
});

describe("retryAfterFromGeminiBody — the message-text path (what real 429s use)", () => {
    it("parses the retry delay out of a VERBATIM captured live 429 body", () => {
        // THE case we know occurs in production. This body has no
        // Retry-After header and no error.details[] at all; the delay exists
        // only as prose inside error.message. A parser that only knows about
        // RetryInfo returns undefined here — which is what shipped, and why
        // every real rate limit fell back to a guessed constant.
        expect(retryAfterFromGeminiBody(REAL_GEMINI_429_BODY)).toBe(REAL_GEMINI_429_RETRY_MS);
    });

    it("treats a bare number with an ms suffix as milliseconds, not seconds", () => {
        const body = { error: { message: "Please retry in 250ms." } };
        expect(retryAfterFromGeminiBody(body)).toBe(250);
    });

    it("treats an s suffix as seconds", () => {
        expect(retryAfterFromGeminiBody({ error: { message: "Please retry in 13s" } })).toBe(13_000);
    });

    it("handles a fractional value in either unit", () => {
        expect(retryAfterFromGeminiBody({ error: { message: "please retry in 1.5s" } })).toBe(1_500);
        expect(retryAfterFromGeminiBody({ error: { message: "please retry in 0.5ms" } })).toBe(1);
    });

    it("prefers the message text over a RetryInfo entry when both are present", () => {
        // The message text is the shape every observed real response uses, so
        // it wins; RetryInfo stays as a fallback for the other Google APIs
        // that do send it.
        const body = {
            error: {
                message: "Please retry in 2s.",
                details: [{ retryDelay: "99s" }]
            }
        };
        expect(retryAfterFromGeminiBody(body)).toBe(2_000);
    });

    it("still uses RetryInfo when the message text says nothing about a delay", () => {
        const body = {
            error: { message: "You exceeded your current quota.", details: [{ retryDelay: "9s" }] }
        };
        expect(retryAfterFromGeminiBody(body)).toBe(9_000);
    });

    it("ignores a unit it does not understand rather than guessing", () => {
        expect(retryAfterFromGeminiBody({ error: { message: "Please retry in 13sec" } })).toBeUndefined();
        expect(retryAfterFromGeminiBody({ error: { message: "Please retry in a bit" } })).toBeUndefined();
    });

    it("ignores a non-string message", () => {
        expect(retryAfterFromGeminiBody({ error: { message: 429 } })).toBeUndefined();
    });
});

describe("quotaLimitFromGeminiBody", () => {
    it("reads the quota the real 429 body reports", () => {
        // "limit: 20", alongside a sub-second retry hint — i.e. a per-MINUTE
        // ceiling, not a daily cap: a daily cap could not roll over in half a
        // second. This is what the rate gate retunes itself from.
        expect(quotaLimitFromGeminiBody(REAL_GEMINI_429_BODY)).toBe(REAL_GEMINI_429_LIMIT);
    });

    it("returns undefined when no limit is stated", () => {
        expect(quotaLimitFromGeminiBody({ error: { message: "Please retry in 2s." } })).toBeUndefined();
        expect(quotaLimitFromGeminiBody({ error: { details: [{ retryDelay: "2s" }] } })).toBeUndefined();
        expect(quotaLimitFromGeminiBody(null)).toBeUndefined();
    });

    it("returns undefined for a nonsensical limit rather than throttling to nothing", () => {
        expect(quotaLimitFromGeminiBody({ error: { message: "limit: 0" } })).toBeUndefined();
    });
});

describe("modelFromGeminiBody", () => {
    it("reads the model the real 429 body says the quota belongs to", () => {
        // This is the number-free half of the same message, and the only thing
        // that distinguishes "this key cannot call this model at all" (a
        // permanent 429 a settings change fixes) from ordinary throttling.
        expect(modelFromGeminiBody(REAL_GEMINI_429_BODY)).toBe("gemini-3.6-flash");
    });

    it("stops at the model name and does not swallow the prose after it", () => {
        // "... model: gemini-2.5-flash Please retry in 551.874307ms." — the
        // value goes straight into a toast, so it must not drag a sentence in.
        expect(modelFromGeminiBody({
            error: { message: "limit: 20, model: gemini-2.5-flash Please retry in 2s." }
        })).toBe("gemini-2.5-flash");
    });

    it("returns undefined when the message names no model", () => {
        expect(modelFromGeminiBody({ error: { message: "Please retry in 2s." } })).toBeUndefined();
        expect(modelFromGeminiBody(null)).toBeUndefined();
        expect(modelFromGeminiBody({ error: { details: [{ retryDelay: "2s" }] } })).toBeUndefined();
    });

    it("does not let a hostile body smuggle arbitrary text into the toast", () => {
        // The body is remote input. The capture is bounded to model-name
        // characters so it cannot carry markup, newlines or a fake instruction.
        expect(modelFromGeminiBody({
            error: { message: "model: evil<script>alert(1)</script>" }
        })).toBe("evil");
        expect(modelFromGeminiBody({
            error: { message: "model: " + "a".repeat(500) }
        })!.length).toBeLessThanOrEqual(64);
    });
});

describe("parseResetDuration — Go-style durations, the format OpenAI-compatible services send", () => {
    it("parses the compound form a real Groq header uses", () => {
        expect(parseResetDuration("2m59.56s")).toBe(179_560);
    });

    it("parses a bare seconds term with a fraction", () => {
        expect(parseResetDuration("7.66s")).toBe(7_660);
    });

    it("reads ms as MILLIseconds, not as minutes", () => {
        // Alternation is ordered, so a pattern listing `m` before `ms` reads
        // "35ms" as 35 MINUTES and leaves a stray "s" — a 60,000x error, in
        // the direction of parking the engine for over half an hour.
        expect(parseResetDuration("35ms")).toBe(35);
        expect(parseResetDuration("35m")).toBe(2_100_000);
    });

    it("parses hours and multi-term durations", () => {
        expect(parseResetDuration("1h")).toBe(3_600_000);
        expect(parseResetDuration("1h2m3s")).toBe(3_723_000);
    });

    it("accepts a bare number as seconds, matching Retry-After's own form", () => {
        expect(parseResetDuration("60")).toBe(60_000);
        expect(parseResetDuration("0.5")).toBe(500);
    });

    it("tolerates surrounding whitespace", () => {
        expect(parseResetDuration("  7.66s \n")).toBe(7_660);
    });

    it("returns undefined rather than a PARTIAL reading of something it cannot fully read", () => {
        // A half-understood duration is worse than none: it is silently wrong
        // in a value that decides how long the engine is parked.
        expect(parseResetDuration("5s later")).toBeUndefined();
        expect(parseResetDuration("about 5s")).toBeUndefined();
        expect(parseResetDuration("5d")).toBeUndefined();
        expect(parseResetDuration("soon")).toBeUndefined();
        expect(parseResetDuration("")).toBeUndefined();
        expect(parseResetDuration("   ")).toBeUndefined();
    });

    it("does not carry state between calls", () => {
        // The matcher is a module-level sticky regex; a leftover lastIndex
        // would make the SECOND call of a pair silently wrong.
        expect(parseResetDuration("2m59.56s")).toBe(179_560);
        expect(parseResetDuration("2m59.56s")).toBe(179_560);
        expect(parseResetDuration("nope")).toBeUndefined();
        expect(parseResetDuration("7.66s")).toBe(7_660);
    });
});

describe("rateLimitFromHeaders — what an OpenAI-compatible response says about itself", () => {
    const headers = (map: Record<string, string>) => ({
        headers: { get: (n: string) => map[n.toLowerCase()] ?? null }
    });

    it("reads the remaining count, the ceiling and the reset window", () => {
        expect(rateLimitFromHeaders(headers({
            "x-ratelimit-limit-requests": "14400",
            "x-ratelimit-remaining-requests": "14370",
            "x-ratelimit-reset-requests": "2m59.56s"
        }))).toEqual({
            remainingRequests: 14370,
            limitRequests: 14400,
            resetRequestsMs: 179_560
        });
    });

    it("keeps a remaining count of ZERO — the most important thing it can report", () => {
        const parsed = rateLimitFromHeaders(headers({
            "x-ratelimit-remaining-requests": "0"
        }));
        expect(parsed).toBeDefined();
        expect(parsed!.remainingRequests).toBe(0);
    });

    it("returns undefined when the response carries none of the headers", () => {
        // Distinguishable from "zero remaining" on purpose: Gemini and Claude
        // report nothing at all, and that must not read as an exhausted quota.
        expect(rateLimitFromHeaders(headers({}))).toBeUndefined();
        expect(rateLimitFromHeaders({})).toBeUndefined();
        expect(rateLimitFromHeaders({ headers: null })).toBeUndefined();
    });

    it("reports the fields it could read and drops only the ones it could not", () => {
        expect(rateLimitFromHeaders(headers({
            "x-ratelimit-remaining-requests": "12",
            "x-ratelimit-reset-requests": "gibberish"
        }))).toEqual({
            remainingRequests: 12,
            limitRequests: undefined,
            resetRequestsMs: undefined
        });
    });

    it("refuses a count that is not a whole non-negative number", () => {
        for (const bad of ["-1", "1.5", "lots", "", "   ", "NaN", "Infinity"]) {
            const parsed = rateLimitFromHeaders(headers({
                "x-ratelimit-remaining-requests": bad,
                // A second, valid header so the result is defined and the
                // assertion is about THIS field rather than about undefined.
                "x-ratelimit-reset-requests": "10s"
            }));
            expect(parsed!.remainingRequests).toBeUndefined();
        }
    });

    it("does not read the Gemini-only helpers' inputs, and they do not read its", () => {
        // The two families are deliberately unrelated: prose parsing belongs to
        // one vendor's error body, headers to another vendor's every response.
        const geminiShaped = { error: { message: "limit: 20 Please retry in 2s." } };
        expect(rateLimitFromHeaders(geminiShaped as never)).toBeUndefined();
        expect(quotaLimitFromGeminiBody(headers({ "x-ratelimit-limit-requests": "30" })))
            .toBeUndefined();
    });
});
