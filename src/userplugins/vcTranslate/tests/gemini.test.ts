import { describe, expect, it, vi } from "vitest";
import { buildPrompt, parseGeminiResponse, translateWithGemini } from "../engines/gemini";
import type { BatchRequest } from "../types";
import {
    REAL_GEMINI_429_JSON, REAL_GEMINI_429_LIMIT, REAL_GEMINI_429_RETRY_MS
} from "./fixtures/real429";

const req: BatchRequest = {
    messages: [
        { id: "10", author: "kenji", text: "今日はやめとく" },
        { id: "11", author: "ana", text: "ok cool" }
    ],
    context: [{ author: "sam", text: "are we playing tonight?" }],
    targetLang: "en"
};

/** A well-formed `interactions` response: text lives in the final step. */
const apiResponse = (payload: unknown) => ({
    ok: true,
    json: async () => ({
        steps: [
            { content: [{ type: "text", text: "(intermediate step, ignored)" }] },
            { content: [{ type: "text", text: JSON.stringify(payload) }] }
        ]
    })
});

describe("buildPrompt (shared with claude.ts via llmShared)", () => {
    it("includes every message with its id and author", () => {
        const prompt = buildPrompt(req);
        expect(prompt).toContain("今日はやめとく");
        expect(prompt).toContain("kenji");
        expect(prompt).toContain("10");
    });

    it("is the exact same function claude.ts uses", async () => {
        const claudeModule = await import("../engines/claude");
        expect(buildPrompt).toBe(claudeModule.buildPrompt);
    });
});

describe("parseGeminiResponse", () => {
    it("maps translations and skips", () => {
        const body = {
            steps: [{
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        translations: [
                            { id: "10", lang: "ja", text: "I'll skip today", skip: false },
                            { id: "11", lang: "en", text: "", skip: true }
                        ]
                    })
                }]
            }]
        };
        expect(parseGeminiResponse(body, req)).toEqual([
            { id: "10", lang: "ja", text: "I'll skip today", skip: false },
            { id: "11", skip: true }
        ]);
    });

    it("finds the text block in the LAST step when earlier steps are non-text", () => {
        const body = {
            steps: [
                { content: [{ type: "thought", text: "planning..." }] },
                {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            translations: [{ id: "10", lang: "ja", text: "ok", skip: false }]
                        })
                    }]
                }
            ]
        };
        expect(parseGeminiResponse(body, req)).toContainEqual(
            { id: "10", lang: "ja", text: "ok", skip: false }
        );
    });

    it("walks backwards past a final step with no text content", () => {
        // The spec says the text lives in the FINAL step "roughly" — parse
        // defensively rather than assuming steps[len-1] always has it.
        const body = {
            steps: [
                {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            translations: [{ id: "10", lang: "ja", text: "ok", skip: false }]
                        })
                    }]
                },
                { content: [{ type: "tool_use", name: "noop" }] }
            ]
        };
        expect(parseGeminiResponse(body, req)).toContainEqual(
            { id: "10", lang: "ja", text: "ok", skip: false }
        );
    });

    // Hallucinated-id filtering, per-row validation and the pass-through skip
    // are exercised via the shared llmShared.mapRows() — covered exhaustively
    // in claude.test.ts. These few here confirm gemini.ts actually routes
    // through the same function rather than reimplementing it differently.
    it("drops entries whose id was not in the request", () => {
        const body = {
            steps: [{
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        translations: [
                            { id: "10", lang: "ja", text: "ok", skip: false },
                            { id: "999", lang: "ja", text: "hallucinated", skip: false }
                        ]
                    })
                }]
            }]
        };
        const results = parseGeminiResponse(body, req);
        expect(results.map(r => r.id)).not.toContain("999");
        expect(results).toEqual([
            { id: "10", lang: "ja", text: "ok", skip: false },
            { id: "11", failed: true }
        ]);
    });

    it("marks a requested id absent from the response as failed", () => {
        const body = {
            steps: [{
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        translations: [{ id: "10", lang: "ja", text: "ok", skip: false }]
                    })
                }]
            }]
        };
        expect(parseGeminiResponse(body, req)).toContainEqual({ id: "11", failed: true });
    });

    it("skips a translation identical to its source (pass-through guard)", () => {
        const body = {
            steps: [{
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        translations: [
                            { id: "10", lang: "en", text: "ok cool", skip: false },
                            { id: "11", lang: "en", text: "OK   Cool", skip: false }
                        ]
                    })
                }]
            }]
        };
        // "11"'s source text is "ok cool"; "OK   Cool" differs only in case
        // and spacing, so isSameText treats it as no real translation.
        expect(parseGeminiResponse(body, req)).toContainEqual({ id: "11", skip: true });
    });

    it("throws when the body is not an object", () => {
        expect(() => parseGeminiResponse(null, req)).toThrow();
        expect(() => parseGeminiResponse("nope", req)).toThrow();
    });

    it("throws with the response's top-level keys when steps is missing", () => {
        expect(() => parseGeminiResponse({ foo: 1, bar: 2 }, req)).toThrow(/foo, bar/);
    });

    it("throws with the response's top-level keys when no step has text content", () => {
        const body = { steps: [{ content: [{ type: "tool_use" }] }], usage: {} };
        expect(() => parseGeminiResponse(body, req)).toThrow(/usage/);
    });

    it("throws when the text block is not valid JSON", () => {
        const body = { steps: [{ content: [{ type: "text", text: "sorry, I can't" }] }] };
        expect(() => parseGeminiResponse(body, req)).toThrow();
    });

    it("throws when translations is missing", () => {
        const body = { steps: [{ content: [{ type: "text", text: JSON.stringify({ nope: [] }) }] }] };
        expect(() => parseGeminiResponse(body, req)).toThrow();
    });
});

describe("translateWithGemini", () => {
    it("sends the correct endpoint, model, and auth header", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse({ translations: [{ id: "10", lang: "ja", text: "ok", skip: false }] })
        );
        await translateWithGemini(req, "AIza-test", fetchImpl as any);

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
        expect(init.headers["x-goog-api-key"]).toBe("AIza-test");
        // Not a Bearer token, not a query param.
        expect(init.headers).not.toHaveProperty("authorization");
        expect(url).not.toContain("AIza-test");

        const sent = JSON.parse(init.body);
        expect(sent.model).toBe("gemini-3.6-flash");
        expect(sent.input).toBe(buildPrompt(req));
        expect(sent.response_format.type).toBe("text");
        expect(sent.response_format.mime_type).toBe("application/json");
        expect(sent.response_format.schema).toBeTruthy();
    });

    it("throws on a non-OK status", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 401, text: async () => "unauthorized"
        });
        await expect(translateWithGemini(req, "bad", fetchImpl as any)).rejects.toThrow(/401/);
    });

    it("never includes the api key in a thrown error", async () => {
        const key = "AIza-secret-value-do-not-leak";
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 401, text: async () => "unauthorized"
        });

        // NB: `.rejects.toThrow(expect.not.stringContaining(...))` does NOT
        // work here — vitest applies the matcher to the Error object, not its
        // message, so a negated string matcher passes unconditionally.
        // Inspect the caught error explicitly instead.
        let caught: unknown;
        try {
            await translateWithGemini(req, key, fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(Error);
        const err = caught as Error;
        expect(err.message).toContain("401");
        expect(err.message).not.toContain(key);
        expect(err.stack ?? "").not.toContain(key);
        expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(key);
    });

    it("attaches the retry-after header as retryAfterMs on a 429", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: { get: (n: string) => (n === "retry-after" ? "7" : null) },
            json: async () => ({})
        });

        let caught: unknown;
        try {
            await translateWithGemini(req, "k", fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect((caught as { retryAfterMs?: number }).retryAfterMs).toBe(7_000);
    });

    it("falls back to the RetryInfo body when there is no Retry-After header", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: { get: () => null },
            json: async () => ({
                error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "9s" }] }
            })
        });

        let caught: unknown;
        try {
            await translateWithGemini(req, "k", fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect((caught as { retryAfterMs?: number }).retryAfterMs).toBe(9_000);
    });

    it("parses the retry hint and the quota out of a VERBATIM captured live 429", async () => {
        // End to end through the engine, on the exact bytes the live API
        // returned: no Retry-After header, no RetryInfo, both numbers living
        // only in the prose of error.message.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: { get: () => null },
            json: async () => JSON.parse(REAL_GEMINI_429_JSON)
        });

        let caught: unknown;
        try {
            await translateWithGemini(req, "k", fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect((caught as { retryAfterMs?: number }).retryAfterMs).toBe(REAL_GEMINI_429_RETRY_MS);
        expect((caught as { quotaLimitPerMinute?: number }).quotaLimitPerMinute)
            .toBe(REAL_GEMINI_429_LIMIT);
        // Both numbers come from ONE body read — res.json() consumes the
        // stream, so a second call would reject and lose whichever number was
        // parsed second.
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("leaves quotaLimitPerMinute undefined when the body states no quota", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: { get: () => null },
            json: async () => ({ error: { message: "Please retry in 2s." } })
        });

        let caught: unknown;
        try {
            await translateWithGemini(req, "k", fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect((caught as { retryAfterMs?: number }).retryAfterMs).toBe(2_000);
        expect((caught as { quotaLimitPerMinute?: number }).quotaLimitPerMinute).toBeUndefined();
    });

    it("leaves retryAfterMs undefined when neither header nor body carries a hint", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 429, text: async () => "rate limited"
        });

        let caught: unknown;
        try {
            await translateWithGemini(req, "k", fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect((caught as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
    });

    it("does not leak the api key even when parsing the response body fails", async () => {
        // A defensive-parsing failure error (missing steps, no text block)
        // must not accidentally echo the key either.
        const key = "AIza-secret-value-do-not-leak-2";
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ nothing: "useful" })
        });

        let caught: unknown;
        try {
            await translateWithGemini(req, key, fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).not.toContain(key);
    });
});
