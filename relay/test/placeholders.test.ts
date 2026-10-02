import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/codes";
import { buildPrompt, previewText, toPreview, type BatchRequest } from "../src/translate";
import { codeRec, fakeBudget, fakeKV } from "./kv-mock";

// ===========================================================================
//  PLACEHOLDERS (0.2.1 field bug). The plugin sends every Discord token
//  (custom emoji, mentions, links, times, code) as ⟦n⟧. The live model
//  dropped every one of them. The prompt now asks, in one general rule, for
//  every placeholder to be kept; the relay must carry them both ways unchanged
//  (validation, escaping, parsing, the preview cut).
// ===========================================================================

const RULE = "Messages may contain placeholders like ⟦1⟧ that stand for emoji, mentions, links, times or code. "
    + "Keep every placeholder exactly as written, once, in the position where it belongs in your translation.";

const req = (texts: string[]): BatchRequest => ({
    messages: texts.map((t, i) => ({ id: String(i), author: "a", text: t })),
    context: [], targetLang: "en"
});

const pending: Promise<unknown>[] = [];
const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {}
} as unknown as ExecutionContext;

const okBody = (content: string): any => ({
    ok: true, status: 200, headers: new Headers(),
    json: async () => ({ choices: [{ message: { content } }] }),
    clone() { return this; }, text: async () => ""
});

/**
 * A scripted model: it reads the messages out of the prompt it is sent and
 * answers each with `answer(text)`. That is the whole relay path a real model
 * sees, so what goes in and what comes back can both be checked.
 */
function scriptedModel(answer: (text: string) => string) {
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        const prompt: string = body.messages.map((m: any) => m.content).join("\n");
        prompts.push(prompt);
        const rows: any[] = [];
        for (const line of prompt.split("\n")) {
            const m = /^\[id="([^"]+)"\] "[^"]*": (".*")$/.exec(line);
            if (m) rows.push({ id: m[1], lang: "pl", text: answer(JSON.parse(m[2]!)), skip: false });
        }
        return okBody(JSON.stringify({ translations: rows }));
    }));
    return prompts;
}

const CODE = "slp_placeholdertest"; // an admin-minted beta code (AI), seeded below
function translateReq(texts: string[], mode?: string) {
    return new Request("https://relay/v1/translate", {
        method: "POST",
        headers: { authorization: `Bearer ${CODE}`, "content-type": "application/json" },
        body: JSON.stringify({
            messages: texts.map((t, i) => ({ id: String(i), author: "a", text: t })),
            context: [], targetLang: "en", ...(mode ? { mode } : {})
        })
    });
}
const env = () => ({
    CODES: fakeKV({ [`code:${CODE}`]: codeRec({ plan: "paid", dailyCap: 5000 }) }), GROQ_KEY: "gk", ADMIN_TOKEN: "a", MODEL: "openai/gpt-oss-120b", BUDGET: fakeBudget().ns
} as unknown as Env);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const FIELD = "⟦1⟧ HAPPY BIRTHDAY⟦2⟧ Wszystkiego najlepszego z okazji urodzin!⟦3⟧ my dear 19 years old boy⟦4⟧";

describe("the prompt asks for every placeholder to be kept", () => {
    it("carries the rule once, after the emote-name rule, and the message keeps its placeholders verbatim", () => {
        const p = buildPrompt(req([FIELD]));
        expect(p).toContain("- " + RULE);
        expect(p.split(RULE)).toHaveLength(2);
        expect(p.indexOf(RULE)).toBeGreaterThan(p.indexOf("Leave usernames, game terms, and custom emote names untranslated."));
        // enc() leaves ⟦ and ⟧ alone (JSON keeps non-ASCII as is).
        expect(p).toContain(JSON.stringify(FIELD));
    });
});

describe("placeholders through the relay handler, end to end", () => {
    it("a model that keeps them: the answer comes back byte for byte", async () => {
        const prompts = scriptedModel(t => t.replace("Wszystkiego najlepszego z okazji urodzin!", "Happy birthday!"));
        const res = await worker.fetch(translateReq([FIELD]), env(), ctx);
        await Promise.all(pending.splice(0));
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.results[0].text).toBe("⟦1⟧ HAPPY BIRTHDAY⟦2⟧ Happy birthday!⟦3⟧ my dear 19 years old boy⟦4⟧");
        expect(prompts[0]).toContain(RULE);
        expect(prompts[0]).toContain(JSON.stringify(FIELD));
    });

    it("a model that drops them: the relay passes its answer through unchanged (the client mends it)", async () => {
        scriptedModel(() => "HAPPY BIRTHDAY! Happy birthday! My dear 19-year-old boy");
        const res = await worker.fetch(translateReq([FIELD]), env(), ctx);
        await Promise.all(pending.splice(0));
        expect(res.status).toBe(200);
        expect((await res.json() as any).results[0].text).toBe("HAPPY BIRTHDAY! Happy birthday! My dear 19-year-old boy");
    });

    it("duplicated and reordered placeholders also pass through untouched", async () => {
        scriptedModel(() => "⟦4⟧⟦4⟧ look ⟦3⟧ are you coming at ⟦2⟧? ⟦1⟧");
        const res = await worker.fetch(translateReq(["⟦1⟧ ¿vienes a las ⟦2⟧? mira ⟦3⟧ ⟦4⟧⟦4⟧ jaja"]), env(), ctx);
        await Promise.all(pending.splice(0));
        expect((await res.json() as any).results[0].text).toBe("⟦4⟧⟦4⟧ look ⟦3⟧ are you coming at ⟦2⟧? ⟦1⟧");
    });

    it("many placeholders in a full batch are accepted by validation and kept", async () => {
        const many = Array.from({ length: 30 }, (_, i) => `word ⟦${i + 1}⟧`).join(" ");
        const texts = Array.from({ length: 25 }, () => many);
        scriptedModel(t => t);
        const res = await worker.fetch(translateReq(texts), env(), ctx);
        await Promise.all(pending.splice(0));
        expect(res.status).toBe(200);
        const rows = (await res.json() as any).results;
        expect(rows).toHaveLength(25);
        for (const r of rows) expect(r.text).toBe(many);
    });
});

describe("the preview cut never leaves half a placeholder", () => {
    it("a cut by words keeps whole placeholders", () => {
        expect(previewText("⟦1⟧ are you coming at ⟦2⟧ tonight with us").text).toBe("⟦1⟧ are you coming at");
    });

    it("a cut by code points that lands inside a placeholder drops the fragment", () => {
        // 30 letters, a space, then ⟦12⟧: the 32-code-point cut lands on "⟦".
        const text = "a".repeat(30) + " ⟦12⟧";
        const p = previewText(text);
        expect(p.text).toBe("a".repeat(30));
        expect(p.text).not.toMatch(/⟦/);
        expect(p.truncated).toBe(true);
        // One code point further in: "⟦1" is still a fragment, and still goes.
        expect(previewText("a".repeat(29) + " ⟦12⟧").text).toBe("a".repeat(29));
    });

    it("toPreview applies the same rule to every row", () => {
        const rows = toPreview([{ id: "0", lang: "pl", text: "b".repeat(30) + " ⟦7⟧ rest", skip: false }]);
        expect((rows[0] as any).text).toBe("b".repeat(30));
    });
});
