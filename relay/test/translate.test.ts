import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPrompt, translate, translateWithFallback, type BatchRequest } from "../src/translate";

const req = (texts: string[]): BatchRequest => ({
    messages: texts.map((t, i) => ({ id: String(i), author: "a", text: t })),
    context: [], targetLang: "en"
});
const groqBody = (content: string): any => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => ({ choices: [{ message: { content } }] }), clone() { return this; }, text: async () => "" });
const geminiBody = (content: string): any => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => ({ candidates: [{ content: { parts: [{ text: content }] } }] }), clone() { return this; }, text: async () => "" });
const fixed = (rows: unknown[]) => JSON.stringify({ translations: rows });

afterEach(() => vi.restoreAllMocks());

describe("buildPrompt — drift guard", () => {
    it("still carries every load-bearing rule", () => {
        const p = buildPrompt(req(["hola"]));
        for (const clause of [
            "'children', 'sacrifice'", "guys', 'mate', 'dude'",
            "3 for ع, 7 for ح", "Keep slang as slang and profanity as profanity",
            "Return exactly one entry per message id given",
            "JSON-encoded strings", "BCP-47"
        ]) expect(p, clause).toContain(clause);
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
        expect(await translate(req(["hola"]), "k", "m")).toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
    });
    it("accepts a ```json-fenced BARE ARRAY with numeric ids", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => groqBody("```json\n[{\"id\":0,\"lang\":\"es\",\"text\":\"hi\",\"skip\":false}]\n```")));
        expect(await translate(req(["hola"]), "k", "m")).toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
    });
    it("gives a missing id an explicit failed verdict", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => groqBody(JSON.stringify({ translations: [{ id: "0", lang: "es", text: "hi", skip: false }] }))));
        const r = await translate(req(["a", "b"]), "k", "m");
        expect(r[1]).toEqual({ id: "1", failed: true });
    });
    it("honours skip", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => groqBody(JSON.stringify({ translations: [{ id: "0", skip: true }] }))));
        expect(await translate(req(["hello"]), "k", "m")).toEqual([{ id: "0", skip: true }]);
    });
    it("throws a TranslateError carrying the status and retry hint on a non-OK", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, headers: new Headers({ "retry-after": "20" }), clone() { return this; }, text: async () => "" })));
        await expect(translate(req(["hola"]), "k", "m")).rejects.toMatchObject({ status: 429, retryAfterMs: 20000 });
    });
    it("retries once without reasoning controls on a 400 that names them", async () => {
        const calls: any[] = [];
        vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
            calls.push(JSON.parse(init.body));
            if (calls.length === 1) return { ok: false, status: 400, headers: new Headers(), clone() { return this; }, text: async () => "unsupported reasoning_effort" };
            return groqBody(JSON.stringify({ translations: [{ id: "0", lang: "es", text: "hi", skip: false }] }));
        }));
        await translate(req(["hola"]), "k", "openai/gpt-oss-120b");
        expect(calls[0].reasoning_effort).toBe("low");
        expect(calls[1].reasoning_effort).toBeUndefined();
    });
});

describe("translate — Gemini provider (model id routes)", () => {
    it("calls the Gemini endpoint with a keyed header + schema, and parses parts", async () => {
        const seen: { url: string; init: any }[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
            seen.push({ url, init });
            return geminiBody(fixed([{ id: "0", lang: "es", text: "hi", skip: false }]));
        }));
        const out = await translate(req(["hola"]), "gk", "gemini-3.8-flash");
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
        const r = await translate(req(["hello", "b"]), "gk", "gemini-3.8-flash");
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
        await translate(req(["hola"]), "gk", "gemini-3.8-flash");
        expect(calls[0].generationConfig.thinkingConfig.thinkingBudget).toBe(0);
        expect(calls[1].generationConfig.thinkingConfig).toBeUndefined();
    });
    it("treats an empty candidate (safety block) as a 502 upstream failure", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(),
            json: async () => ({ candidates: [] }), clone() { return this; }, text: async () => "" })));
        await expect(translate(req(["hola"]), "gk", "gemini-3.8-flash")).rejects.toMatchObject({ status: 502 });
    });
});

describe("translateWithFallback — Gemini primary, Groq fallback", () => {
    it("uses only the primary when it succeeds", async () => {
        const fetchMock = vi.fn(async () => geminiBody(fixed([{ id: "0", lang: "es", text: "hi", skip: false }])));
        vi.stubGlobal("fetch", fetchMock);
        const out = await translateWithFallback(req(["hola"]), { apiKey: "gk", model: "gemini-3.8-flash" }, { apiKey: "grq", model: "openai/gpt-oss-120b" });
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
        const out = await translateWithFallback(req(["hola"]), { apiKey: "gk", model: "gemini-3.8-flash" }, { apiKey: "grq", model: "openai/gpt-oss-120b" });
        expect(out).toEqual([{ id: "0", lang: "es", text: "hola-en", skip: false }]);
        expect(urls[0]).toContain("generativelanguage");
        expect(urls[1]).toContain("groq.com");
    });
    it("falls back even when the Gemini key is bad (401), so users keep working", async () => {
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            if (url.includes("generativelanguage")) return { ok: false, status: 401, headers: new Headers(), clone() { return this; }, text: async () => "" };
            return groqBody(fixed([{ id: "0", lang: "es", text: "ok", skip: false }]));
        }));
        const out = await translateWithFallback(req(["hola"]), { apiKey: "bad", model: "gemini-3.8-flash" }, { apiKey: "grq", model: "openai/gpt-oss-120b" });
        expect(out[0]).toMatchObject({ text: "ok" });
    });
    it("rethrows the primary error when there is no fallback", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, headers: new Headers({ "retry-after": "12" }), clone() { return this; }, text: async () => "" })));
        await expect(translateWithFallback(req(["hola"]), { apiKey: "gk", model: "gemini-3.8-flash" }, null))
            .rejects.toMatchObject({ status: 429, retryAfterMs: 12000 });
    });
    it("does NOT start the fallback once the request's time budget is aborted", async () => {
        const fetchMock = vi.fn(async () => { throw { status: 504 }; });
        vi.stubGlobal("fetch", fetchMock);
        const ac = new AbortController();
        ac.abort();
        await expect(translateWithFallback(req(["hola"]), { apiKey: "gk", model: "gemini-3.8-flash" }, { apiKey: "grq", model: "openai/gpt-oss-120b" }, ac.signal))
            .rejects.toBeTruthy();
        expect(fetchMock).toHaveBeenCalledTimes(1); // primary only, no fallback
    });
});
