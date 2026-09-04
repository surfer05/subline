import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPrompt, translate, type BatchRequest } from "../src/translate";

const req = (texts: string[]): BatchRequest => ({
    messages: texts.map((t, i) => ({ id: String(i), author: "a", text: t })),
    context: [], targetLang: "en"
});
const groqBody = (content: string) => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => ({ choices: [{ message: { content } }] }), clone() { return this; }, text: async () => "" });

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
