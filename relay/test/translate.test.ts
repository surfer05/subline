import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPrompt, translate, translateWithFallback, type BatchRequest, type Provider } from "../src/translate";

const req = (texts: string[]): BatchRequest => ({
    messages: texts.map((t, i) => ({ id: String(i), author: "a", text: t })),
    context: [], targetLang: "en"
});
const groqBody = (content: string): any => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => ({ choices: [{ message: { content } }] }), clone() { return this; }, text: async () => "" });
const geminiBody = (content: string): any => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => ({ candidates: [{ content: { parts: [{ text: content }] } }] }), clone() { return this; }, text: async () => "" });
const fixed = (rows: unknown[]) => JSON.stringify({ translations: rows });
// SIGNATURE CHANGE: translate() now takes the whole Provider, because the route
// is an explicit `kind` — OpenRouter and Groq share model ids, so the id alone
// can no longer decide which endpoint and key to use.
const groq = (model: string): Provider => ({ kind: "groq", apiKey: "k", model });
const gemini = (apiKey = "gk"): Provider => ({ kind: "gemini", apiKey, model: "gemini-3.8-flash" });
const groqFallback: Provider = { kind: "groq", apiKey: "grq", model: "openai/gpt-oss-120b" };

afterEach(() => vi.restoreAllMocks());

describe("buildPrompt — drift guard", () => {
    it("still carries every load-bearing rule", () => {
        const p = buildPrompt(req(["hola"]));
        for (const clause of [
            "'children', 'sacrifice'", "guys', 'mate', 'dude'",
            "3 for ع, 7 for ح", "Keep slang as slang and profanity as profanity",
            "Return exactly one entry per message id given",
            "JSON-encoded strings", "BCP-47",
            // Line breaks (field report, 0.1.6): a two-line message came back
            // as one line. The model must keep them, written as \n.
            "Keep the same line breaks.", "Write each line break in your JSON text as \\n"
        ]) expect(p, clause).toContain(clause);
    });
    it("keeps a multi-line message's line breaks through the parse", async () => {
        const twoLine = "For stuff like pasta etc., Mommo's\nBut if you only feel like pizza, Dirty Harry's";
        vi.stubGlobal("fetch", vi.fn(async () => groqBody(JSON.stringify({ translations: [{ id: "0", lang: "de", text: twoLine, skip: false }] }))));
        const r = await translate(req(["Für so Pasta usw mommo's\nAber wenn du nur Bock auf Pizza hast Dirty Harry's"]), groq("m"));
        expect(r).toEqual([{ id: "0", lang: "de", text: twoLine, skip: false }]);
        expect(buildPrompt(req(["a\nb"]))).toContain('"a\\nb"');
    });
    it("includes context only when present, and never translates it", () => {
        const withCtx: BatchRequest = { ...req(["hola"]), context: [{ author: "z", text: "hey" }] };
        expect(buildPrompt(withCtx)).toContain("context only");
        expect(buildPrompt(req(["hola"]))).not.toContain("context only");
    });
});

describe("translate — tolerant parse, strict trust", () => {
    it("accepts a plain {translations:[]} object", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => groqBody(JSON.stringify({ translations: [{ id: "0", lang: "es", text: "hi", skip: false }] }))));
        expect(await translate(req(["hola"]), groq("m"))).toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
    });
    it("accepts a ```json-fenced BARE ARRAY with numeric ids", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => groqBody("```json\n[{\"id\":0,\"lang\":\"es\",\"text\":\"hi\",\"skip\":false}]\n```")));
        expect(await translate(req(["hola"]), groq("m"))).toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
    });
    it("gives a missing id an explicit failed verdict", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => groqBody(JSON.stringify({ translations: [{ id: "0", lang: "es", text: "hi", skip: false }] }))));
        const r = await translate(req(["a", "b"]), groq("m"));
        expect(r[1]).toEqual({ id: "1", failed: true });
    });
    it("honours skip", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => groqBody(JSON.stringify({ translations: [{ id: "0", skip: true }] }))));
        expect(await translate(req(["hello"]), groq("m"))).toEqual([{ id: "0", skip: true }]);
    });
    it("throws a TranslateError carrying the status and retry hint on a non-OK", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, headers: new Headers({ "retry-after": "20" }), clone() { return this; }, text: async () => "" })));
        await expect(translate(req(["hola"]), groq("m"))).rejects.toMatchObject({ status: 429, retryAfterMs: 20000 });
    });
    it("retries once without reasoning controls on a 400 that names them", async () => {
        const calls: any[] = [];
        vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
            calls.push(JSON.parse(init.body));
            if (calls.length === 1) return { ok: false, status: 400, headers: new Headers(), clone() { return this; }, text: async () => "unsupported reasoning_effort" };
            return groqBody(JSON.stringify({ translations: [{ id: "0", lang: "es", text: "hi", skip: false }] }));
        }));
        await translate(req(["hola"]), groq("openai/gpt-oss-120b"));
        expect(calls[0].reasoning_effort).toBe("low");
        expect(calls[1].reasoning_effort).toBeUndefined();
    });
});

describe("translate: Gemini provider (provider.kind routes)", () => {
    it("calls the Gemini endpoint with a keyed header + schema, and parses parts", async () => {
        const seen: { url: string; init: any }[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
            seen.push({ url, init });
            return geminiBody(fixed([{ id: "0", lang: "es", text: "hi", skip: false }]));
        }));
        const out = await translate(req(["hola"]), gemini("gk"));
        expect(out).toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
        const call = seen[0]!;
        expect(call.url).toContain("generativelanguage.googleapis.com");
        expect(call.url).toContain("gemini-3.8-flash:generateContent");
        expect(call.init.headers["x-goog-api-key"]).toBe("gk");
        const body = JSON.parse(call.init.body);
        expect(body.generationConfig.responseMimeType).toBe("application/json");
        expect(body.generationConfig.responseSchema).toBeTruthy();
        expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
        // Never leaks the key into the URL (proxy/access-log safety).
        expect(call.url).not.toContain("gk");
    });
    it("honours skip and missing-id verdicts through the Gemini parse", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => geminiBody(fixed([{ id: "0", skip: true }]))));
        const r = await translate(req(["hello", "b"]), gemini("gk"));
        expect(r[0]).toEqual({ id: "0", skip: true });
        expect(r[1]).toEqual({ id: "1", failed: true });
    });
    it("retries once without thinkingConfig on a 400 that names thinking", async () => {
        const calls: any[] = [];
        vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
            calls.push(JSON.parse(init.body));
            if (calls.length === 1) return { ok: false, status: 400, headers: new Headers(), clone() { return this; }, text: async () => "thinkingConfig not supported" };
            return geminiBody(fixed([{ id: "0", lang: "es", text: "hi", skip: false }]));
        }));
        await translate(req(["hola"]), gemini("gk"));
        expect(calls[0].generationConfig.thinkingConfig.thinkingBudget).toBe(0);
        expect(calls[1].generationConfig.thinkingConfig).toBeUndefined();
    });
    it("treats an empty candidate (safety block) as a 502 upstream failure", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(),
            json: async () => ({ candidates: [] }), clone() { return this; }, text: async () => "" })));
        await expect(translate(req(["hola"]), gemini("gk"))).rejects.toMatchObject({ status: 502 });
    });
});

describe("translateWithFallback: a primary, then a second provider", () => {
    it("uses only the primary when it succeeds", async () => {
        const fetchMock = vi.fn(async () => geminiBody(fixed([{ id: "0", lang: "es", text: "hi", skip: false }])));
        vi.stubGlobal("fetch", fetchMock);
        const out = await translateWithFallback(req(["hola"]), gemini(), groqFallback);
        expect(out).toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it("falls back to Groq when Gemini rate-limits, and returns the Groq result", async () => {
        const urls: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            urls.push(url);
            if (url.includes("generativelanguage")) return { ok: false, status: 429, headers: new Headers(), clone() { return this; }, text: async () => "" };
            return groqBody(fixed([{ id: "0", lang: "es", text: "hola-en", skip: false }]));
        }));
        const out = await translateWithFallback(req(["hola"]), gemini(), groqFallback);
        expect(out).toEqual([{ id: "0", lang: "es", text: "hola-en", skip: false }]);
        expect(urls[0]).toContain("generativelanguage");
        expect(urls[1]).toContain("groq.com");
    });
    it("falls back even when the Gemini key is bad (401), so users keep working", async () => {
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            if (url.includes("generativelanguage")) return { ok: false, status: 401, headers: new Headers(), clone() { return this; }, text: async () => "" };
            return groqBody(fixed([{ id: "0", lang: "es", text: "ok", skip: false }]));
        }));
        const out = await translateWithFallback(req(["hola"]), gemini("bad"), groqFallback);
        expect(out[0]).toMatchObject({ text: "ok" });
    });
    it("rethrows the primary error when there is no fallback", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, headers: new Headers({ "retry-after": "12" }), clone() { return this; }, text: async () => "" })));
        await expect(translateWithFallback(req(["hola"]), gemini(), null))
            .rejects.toMatchObject({ status: 429, retryAfterMs: 12000 });
    });
    it("does NOT start the fallback once the request's time budget is aborted", async () => {
        const fetchMock = vi.fn(async () => { throw { status: 504 }; });
        vi.stubGlobal("fetch", fetchMock);
        const ac = new AbortController();
        ac.abort();
        await expect(translateWithFallback(req(["hola"]), gemini(), groqFallback, ac.signal))
            .rejects.toBeTruthy();
        expect(fetchMock).toHaveBeenCalledTimes(1); // primary only, no fallback
    });
});
