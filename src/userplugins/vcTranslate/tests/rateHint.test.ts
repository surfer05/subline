import { describe, expect, it } from "vitest";
import { retryAfterFromGeminiBody, retryAfterFromHeader } from "../rateHint";

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
