import { describe, expect, it } from "vitest";
import { quotaLimitFromGeminiBody, retryAfterFromGeminiBody, retryAfterFromHeader } from "../rateHint";
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
