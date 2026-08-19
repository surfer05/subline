import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GROQ_MODEL, effectiveGroqModel, RETIRED_GROQ_MODELS } from "../types";
import { buildPrompt, looksLikeReasoningModel, parseGroqResponse, translateWithGroq } from "../engines/groq";
import type { BatchRequest } from "../types";
import { REAL_GEMINI_FENCED_TEXT, REAL_GEMINI_TRANSLATIONS } from "./fixtures/realGeminiText";

const req: BatchRequest = {
    messages: [
        { id: "10", author: "kenji", text: "今日はやめとく" },
        { id: "11", author: "ana", text: "ok cool" }
    ],
    context: [{ author: "sam", text: "are we playing tonight?" }],
    targetLang: "en"
};

/** A well-formed OpenAI chat-completions response, with no rate-limit headers. */
const apiResponse = (payload: unknown, headers: Record<string, string> = {}) => ({
    ok: true,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => ({
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) } }]
    })
});

/** The exact header names an OpenAI-compatible service sends. */
const GROQ_HEADERS = {
    "x-ratelimit-limit-requests": "14400",
    "x-ratelimit-remaining-requests": "14370",
    "x-ratelimit-reset-requests": "2m59.56s"
};

const ok = (payload: unknown) => ({
    translations: Array.isArray(payload) ? payload : [payload]
});

describe("buildPrompt (shared with claude.ts and gemini.ts via llmShared)", () => {
    it("is the exact same function the other two engines use", async () => {
        // Not "produces the same string" — the same OBJECT. A Groq-specific
        // copy of the prompt builder is exactly how a future injection fix
        // would reach two engines out of three.
        const claudeModule = await import("../engines/claude");
        const geminiModule = await import("../engines/gemini");
        expect(buildPrompt).toBe(claudeModule.buildPrompt);
        expect(buildPrompt).toBe(geminiModule.buildPrompt);
    });
});

describe("parseGroqResponse", () => {
    it("reads the text from choices[0].message.content", () => {
        const body = {
            choices: [{
                message: {
                    content: JSON.stringify({
                        translations: [
                            { id: "10", lang: "ja", text: "I'll skip today", skip: false },
                            { id: "11", lang: "en", text: "", skip: true }
                        ]
                    })
                }
            }]
        };
        expect(parseGroqResponse(body, req)).toEqual([
            { id: "10", lang: "ja", text: "I'll skip today", skip: false },
            { id: "11", skip: true }
        ]);
    });

    it("walks past a choice with no string content rather than giving up on the first", () => {
        // n defaults to 1 so there is normally one choice, but a choice that
        // carried a tool call and no text would make a blind choices[0] index
        // report "no content" while the answer sat one element along.
        const body = {
            choices: [
                { message: { role: "assistant", tool_calls: [{ id: "t1" }] } },
                {
                    message: {
                        content: JSON.stringify({
                            translations: [{ id: "10", lang: "ja", text: "ok", skip: false }]
                        })
                    }
                }
            ]
        };
        expect(parseGroqResponse(body, req)).toContainEqual(
            { id: "10", lang: "ja", text: "ok", skip: false }
        );
    });

    it("parses a ```json-FENCED response", () => {
        // Fences are what actually came back from the live Gemini endpoint
        // despite a strict schema being requested, and they used to be fatal.
        // Groq is assumed to be capable of the same surprise rather than
        // trusted not to be.
        const body = {
            choices: [{
                message: {
                    content: "```json\n"
                        + JSON.stringify({
                            translations: [{ id: "10", lang: "ja", text: "ok", skip: false }]
                        })
                        + "\n```"
                }
            }]
        };
        expect(parseGroqResponse(body, req)).toContainEqual(
            { id: "10", lang: "ja", text: "ok", skip: false }
        );
    });

    it("parses a BARE top-level array instead of the { translations: [...] } object", () => {
        const body = {
            choices: [{
                message: {
                    content: JSON.stringify([{ id: "10", lang: "ja", text: "ok", skip: false }])
                }
            }]
        };
        expect(parseGroqResponse(body, req)).toContainEqual(
            { id: "10", lang: "ja", text: "ok", skip: false }
        );
    });

    it("accepts NUMERIC ids and coerces them to the request's own string ids", () => {
        const body = {
            choices: [{
                message: {
                    content: JSON.stringify({
                        translations: [{ id: 10, lang: "ja", text: "ok", skip: false }]
                    })
                }
            }]
        };
        expect(parseGroqResponse(body, req)).toContainEqual(
            { id: "10", lang: "ja", text: "ok", skip: false }
        );
    });

    it("parses all three deviations AT ONCE, on the verbatim bytes a live LLM sent", () => {
        // The same fixture gemini.test.ts and llmShared.test.ts assert against:
        // a ```json fence around a bare array with numeric ids, captured from a
        // real response. Shared so the three engines cannot drift apart from
        // each other or from what an LLM actually does.
        const liveReq: BatchRequest = {
            messages: [
                { id: "1", author: "yassine", text: "شحال هاد الوحش" },
                { id: "2", author: "rana", text: "قلبت عمان كلها عليك" }
            ],
            context: [],
            targetLang: "en"
        };
        const body = { choices: [{ message: { content: REAL_GEMINI_FENCED_TEXT } }] };

        expect(parseGroqResponse(body, liveReq)).toEqual([
            { id: "1", lang: "ar-MA", text: REAL_GEMINI_TRANSLATIONS[0], skip: false },
            { id: "2", lang: "ar-JO", text: REAL_GEMINI_TRANSLATIONS[1], skip: false }
        ]);
    });

    it("drops entries whose id was not in the request", () => {
        const body = {
            choices: [{
                message: {
                    content: JSON.stringify({
                        translations: [
                            { id: "10", lang: "ja", text: "ok", skip: false },
                            { id: "999", lang: "ja", text: "hallucinated", skip: false }
                        ]
                    })
                }
            }]
        };
        const results = parseGroqResponse(body, req);
        expect(results.map(r => r.id)).not.toContain("999");
        expect(results).toEqual([
            { id: "10", lang: "ja", text: "ok", skip: false },
            { id: "11", failed: true }
        ]);
    });

    it("marks a requested id absent from the response as failed", () => {
        const body = {
            choices: [{
                message: {
                    content: JSON.stringify({
                        translations: [{ id: "10", lang: "ja", text: "ok", skip: false }]
                    })
                }
            }]
        };
        expect(parseGroqResponse(body, req)).toContainEqual({ id: "11", failed: true });
    });

    it("skips a translation identical to its source (pass-through guard)", () => {
        const body = {
            choices: [{
                message: {
                    content: JSON.stringify({
                        translations: [{ id: "11", lang: "en", text: "OK   Cool", skip: false }]
                    })
                }
            }]
        };
        expect(parseGroqResponse(body, req)).toContainEqual({ id: "11", skip: true });
    });

    it("forwards the debug flag through to mapRows without changing the result", () => {
        const body = {
            choices: [{
                message: {
                    content: JSON.stringify({
                        translations: [{ id: "10", lang: "ja", text: "ok", skip: false }]
                    })
                }
            }]
        };
        expect(parseGroqResponse(body, req, true)).toEqual(parseGroqResponse(body, req, false));
    });
});

describe("parseGroqResponse — a malformed response fails DIAGNOSABLY, never silently", () => {
    // The whole point of the defensive style: a shape change must be readable
    // off the Discord console, not inferred from missing subtitles. Every case
    // below asserts on the message's CONTENT, because "it threw" is satisfied
    // by a useless error just as well as by a useful one.
    it("names the type when the body is not an object at all", () => {
        expect(() => parseGroqResponse(null, req)).toThrow(/groq: response is not an object/);
        expect(() => parseGroqResponse("nope", req)).toThrow(/got string/);
    });

    it("names the response's OWN top-level keys when choices is missing", () => {
        expect(() => parseGroqResponse({ error: 1, id: "x" }, req)).toThrow(/error, id/);
    });

    it("names the response's OWN top-level keys when no choice carries content", () => {
        const body = { choices: [{ message: { tool_calls: [] } }], usage: {}, model: "m" };
        expect(() => parseGroqResponse(body, req)).toThrow(/usage/);
        expect(() => parseGroqResponse(body, req)).toThrow(/no message content found/);
    });

    it("does not accept a non-string content as text", () => {
        // A shape change that made `content` an array of parts must be an
        // error, not a `[object Object]` handed to JSON.parse.
        const body = { choices: [{ message: { content: [{ type: "text", text: "{}" }] } }] };
        expect(() => parseGroqResponse(body, req)).toThrow(/no message content found/);
    });

    it("attributes a JSON failure to groq by name", () => {
        const body = { choices: [{ message: { content: "sorry, I can't do that" } }] };
        expect(() => parseGroqResponse(body, req)).toThrow(/^groq: response was not valid JSON$/);
    });

    it("attributes a missing translations array to groq by name", () => {
        const body = { choices: [{ message: { content: JSON.stringify({ nope: [] }) } }] };
        expect(() => parseGroqResponse(body, req)).toThrow(/^groq: missing translations array$/);
    });

    it("never reports an unreadable response as a successful empty translation", () => {
        // The failure that would be invisible: an empty Result[] looks exactly
        // like "nothing needed translating" to every caller.
        for (const body of [null, {}, { choices: [] }, { choices: [{ message: {} }] }]) {
            expect(() => parseGroqResponse(body, req)).toThrow();
        }
    });
});

describe("translateWithGroq — the request", () => {
    it("sends the OpenAI-compatible endpoint, body shape and Bearer auth", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse(ok({ id: "10", lang: "ja", text: "ok", skip: false }))
        );
        await translateWithGroq(req, "gsk-test", fetchImpl as any);

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
        expect(init.headers.authorization).toBe("Bearer gsk-test");
        // Neither sibling's header, and never a query param.
        expect(init.headers).not.toHaveProperty("x-goog-api-key");
        expect(init.headers).not.toHaveProperty("x-api-key");
        expect(url).not.toContain("gsk-test");

        const sent = JSON.parse(init.body);
        expect(sent.messages).toHaveLength(1);
        expect(sent.messages[0].role).toBe("user");
        expect(sent.messages[0].content).toContain(buildPrompt(req));
    });

    it("asks for the schema in the PROMPT rather than in a response_format field", async () => {
        // response_format is per-model on OpenAI-compatible services, so
        // sending it for a model that does not support it is a 400 on EVERY
        // request — and the model is a user-editable setting. The schema still
        // has to be asked for, so it is asked for where it cannot 400.
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse(ok({ id: "10", lang: "ja", text: "ok", skip: false }))
        );
        await translateWithGroq(req, "gsk-test", fetchImpl as any);

        const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(sent).not.toHaveProperty("response_format");
        expect(sent.messages[0].content).toContain("\"translations\"");
        expect(sent.messages[0].content).toContain("\"skip\"");
    });

    it("defaults to the current live model", async () => {
        // A LITERAL, not the DEFAULT_GROQ_MODEL constant: asserting against the
        // constant would pass for any value it was ever changed to, which is
        // exactly how a default with no free-tier allowance could be
        // introduced silently — the failure that cost this project a week.
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse(ok({ id: "10", lang: "ja", text: "ok", skip: false }))
        );
        await translateWithGroq(req, "gsk-test", fetchImpl as any);
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe(DEFAULT_GROQ_MODEL);
    });

    it("sends the model it was given, so a settings change reaches the wire", async () => {
        // The point of the setting existing: a model can lose free-tier
        // availability under us. An engine that ignored this argument would
        // make the setting inert and leave a stuck user with only a rebuild.
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse(ok({ id: "10", lang: "ja", text: "ok", skip: false }))
        );
        await translateWithGroq(req, "gsk-test", fetchImpl as any, "llama-4-maverick-17b");
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe("llama-4-maverick-17b");
    });

    it("falls back to the default for a blank, whitespace-only or absent model", async () => {
        // A cleared field must never send `"model": ""` — a 400 on every
        // single request, strictly worse than whatever it was escaping.
        for (const blank of ["", "   ", undefined]) {
            const fetchImpl = vi.fn().mockResolvedValue(
                apiResponse(ok({ id: "10", lang: "ja", text: "ok", skip: false }))
            );
            await translateWithGroq(req, "gsk-test", fetchImpl as any, blank);
            expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model)
                .toBe(DEFAULT_GROQ_MODEL);
        }
    });

    it("trims a model name pasted with surrounding whitespace", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse(ok({ id: "10", lang: "ja", text: "ok", skip: false }))
        );
        await translateWithGroq(req, "gsk-test", fetchImpl as any, "  llama-3.1-8b-instant \n");
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe("llama-3.1-8b-instant");
    });
});

describe("translateWithGroq — rate-limit headers on a SUCCESS", () => {
    it("returns the provider's remaining count, ceiling and reset window", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse(ok({ id: "10", lang: "ja", text: "ok", skip: false }), GROQ_HEADERS)
        );

        const outcome = await translateWithGroq(req, "gsk-test", fetchImpl as any);

        expect(outcome.rateLimit).toEqual({
            remainingRequests: 14370,
            limitRequests: 14400,
            // "2m59.56s" — a Go-style duration, not a number of seconds.
            resetRequestsMs: 179_560
        });
    });

    it("still returns the translations alongside them", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse(ok({ id: "10", lang: "ja", text: "ok", skip: false }), GROQ_HEADERS)
        );
        const outcome = await translateWithGroq(req, "gsk-test", fetchImpl as any);
        expect(outcome.results).toContainEqual({ id: "10", lang: "ja", text: "ok", skip: false });
    });

    it("reports ZERO remaining as zero, not as 'nothing reported'", async () => {
        // The single most important thing these headers can say, and the exact
        // value a truthiness check would swallow.
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse(ok({ id: "10", lang: "ja", text: "ok", skip: false }), {
                ...GROQ_HEADERS,
                "x-ratelimit-remaining-requests": "0"
            })
        );
        const outcome = await translateWithGroq(req, "gsk-test", fetchImpl as any);
        expect(outcome.rateLimit?.remainingRequests).toBe(0);
    });

    it("leaves rateLimit undefined when the response carries no such headers", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse(ok({ id: "10", lang: "ja", text: "ok", skip: false }))
        );
        const outcome = await translateWithGroq(req, "gsk-test", fetchImpl as any);
        expect(outcome.rateLimit).toBeUndefined();
    });
});

describe("translateWithGroq — failures", () => {
    it("throws with the status on a non-OK response", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 401, headers: { get: () => null }
        });
        await expect(translateWithGroq(req, "bad", fetchImpl as any)).rejects.toThrow(/groq: HTTP 401/);
    });

    it("turns a Retry-After header on a 429 into a cooldown in milliseconds", async () => {
        // OpenAI-compatible services send this header; Gemini's real 429s do
        // not, which is why gemini.ts has to parse prose and this does not.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: { get: (n: string) => (n === "retry-after" ? "13" : null) }
        });

        let caught: unknown;
        try {
            await translateWithGroq(req, "gsk-test", fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect((caught as { status?: number }).status).toBe(429);
        expect((caught as { retryAfterMs?: number }).retryAfterMs).toBe(13_000);
    });

    it("leaves retryAfterMs undefined when the 429 carries no Retry-After", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 429, headers: { get: () => null }
        });

        let caught: unknown;
        try {
            await translateWithGroq(req, "gsk-test", fetchImpl as any);
        } catch (e) {
            caught = e;
        }
        expect((caught as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
    });

    it("does NOT parse Gemini's error prose — that format belongs to one vendor", async () => {
        // Pointing Google's message-text parsing at another provider's body
        // could only ever produce a coincidental match: a fabricated cooldown,
        // or a fabricated "limit: N" that would retune the rate gate from a
        // number nobody stated.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: { get: () => null },
            json: async () => ({
                error: { message: "Quota exceeded ..., limit: 20, model: llama-x Please retry in 551.874307ms." }
            })
        });

        let caught: unknown;
        try {
            await translateWithGroq(req, "gsk-test", fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect((caught as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
        expect((caught as { quotaLimitPerMinute?: number }).quotaLimitPerMinute).toBeUndefined();
        expect((caught as { quotaModel?: string }).quotaModel).toBeUndefined();
    });

    it("never reports the DAILY request ceiling as a per-minute quota", async () => {
        // x-ratelimit-limit-requests is requests-per-DAY on this provider.
        // Handing it to the rate gate (which takes a per-MINUTE ceiling) would
        // open the gate to thousands of requests a minute and disable the only
        // protection this plugin has.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: {
                get: (n: string) => (GROQ_HEADERS as Record<string, string>)[n.toLowerCase()] ?? null
            }
        });

        let caught: unknown;
        try {
            await translateWithGroq(req, "gsk-test", fetchImpl as any);
        } catch (e) {
            caught = e;
        }
        expect((caught as { quotaLimitPerMinute?: number }).quotaLimitPerMinute).toBeUndefined();
    });

    it("never includes the api key in a thrown error", async () => {
        const key = "gsk-secret-value-do-not-leak";
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 401, headers: { get: () => null }
        });

        // NB: `.rejects.toThrow(expect.not.stringContaining(...))` does NOT
        // work — vitest applies the matcher to the Error object, not its
        // message, so a negated string matcher passes unconditionally.
        let caught: unknown;
        try {
            await translateWithGroq(req, key, fetchImpl as any);
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

    it("does not leak the api key when parsing a 200's body fails either", async () => {
        const key = "gsk-secret-value-do-not-leak-2";
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            headers: { get: () => null },
            json: async () => ({ nothing: "useful" })
        });

        let caught: unknown;
        try {
            await translateWithGroq(req, key, fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).not.toContain(key);
    });
});

describe("a retired model does not strand an existing install", () => {
    it("falls back to the current default when the stored model is dead", () => {
        // The model is a persisted SETTING, so a new default reaches nobody who
        // already installed: their settings.json still names the dead model and
        // every request fails. Groq decommissioned Llama 3.3 70B on 2026-08-16.
        expect(effectiveGroqModel("llama-3.3-70b-versatile")).toBe(DEFAULT_GROQ_MODEL);
        for (const retired of RETIRED_GROQ_MODELS) {
            expect(effectiveGroqModel(retired)).toBe(DEFAULT_GROQ_MODEL);
        }
    });

    it("respects any live model the user chose", () => {
        expect(effectiveGroqModel("llama-3.1-8b-instant")).toBe("llama-3.1-8b-instant");
        expect(effectiveGroqModel("  qwen/qwen3.6-27b  ")).toBe("qwen/qwen3.6-27b");
    });

    it("falls back on a blank value, which would be a 400 on every request", () => {
        expect(effectiveGroqModel("")).toBe(DEFAULT_GROQ_MODEL);
        expect(effectiveGroqModel("   ")).toBe(DEFAULT_GROQ_MODEL);
        expect(effectiveGroqModel(undefined)).toBe(DEFAULT_GROQ_MODEL);
    });

    it("does not ship a default that is itself retired", () => {
        // The one mistake this whole mechanism cannot survive.
        expect(RETIRED_GROQ_MODELS).not.toContain(DEFAULT_GROQ_MODEL);
    });
});

describe("reasoning models", () => {
    it("recognises the families that emit their working", () => {
        expect(looksLikeReasoningModel("openai/gpt-oss-120b")).toBe(true);
        expect(looksLikeReasoningModel("qwen/qwen3.6-27b")).toBe(true);
        expect(looksLikeReasoningModel("llama-3.1-8b-instant")).toBe(false);
    });

    it("asks a reasoning model to keep its thinking out of the reply", async () => {
        // Measured, not assumed: gpt-oss-120b answered with an empty `content`
        // and finish_reason "length", having spent the budget on hidden
        // reasoning. That is not the JSON this engine parses.
        const bodies: any[] = [];
        const fetchImpl = (async (_url: string, init: any) => {
            bodies.push(JSON.parse(init.body));
            return apiResponse(ok({ id: "10", lang: "ja", text: "not tonight" }));
        }) as unknown as typeof fetch;

        await translateWithGroq(req, "gsk_x", fetchImpl, "openai/gpt-oss-120b");
        expect(bodies[0].reasoning_effort).toBe("low");
        expect(bodies[0].reasoning_format).toBe("hidden");
    });

    it("sends no such parameter to a model that would reject it", async () => {
        const bodies: any[] = [];
        const fetchImpl = (async (_url: string, init: any) => {
            bodies.push(JSON.parse(init.body));
            return apiResponse(ok({ id: "10", lang: "ja", text: "not tonight" }));
        }) as unknown as typeof fetch;

        await translateWithGroq(req, "gsk_x", fetchImpl, "llama-3.1-8b-instant");
        expect(bodies[0].reasoning_effort).toBeUndefined();
        expect(bodies[0].reasoning_format).toBeUndefined();
    });

    it("retries without them when the provider says they are unsupported", async () => {
        // The model is user-editable, so the family test above is only ever a
        // first guess. A wrong guess must cost one retry, not every request.
        const bodies: any[] = [];
        let call = 0;
        const fetchImpl = (async (_url: string, init: any) => {
            bodies.push(JSON.parse(init.body));
            call += 1;
            if (call === 1) {
                const body = JSON.stringify({
                    error: { message: "`reasoning_effort` is not supported with this model" }
                });
                return {
                    ok: false,
                    status: 400,
                    headers: { get: () => null },
                    clone: () => ({ text: async () => body }),
                    text: async () => body,
                    json: async () => JSON.parse(body)
                };
            }
            return apiResponse(ok({ id: "10", lang: "ja", text: "not tonight" }));
        }) as unknown as typeof fetch;

        await translateWithGroq(req, "gsk_x", fetchImpl, "qwen/some-future-non-reasoning");
        expect(bodies).toHaveLength(2);
        expect(bodies[0].reasoning_effort).toBe("low");
        expect(bodies[1].reasoning_effort).toBeUndefined();
    });
});
