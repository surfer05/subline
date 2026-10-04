import { describe, expect, it } from "vitest";

import { buildPrompt, forcedRule } from "../engines/llmShared";
import { fitLlmRequest, shrinkAfterRefusal } from "../fitRequest";
import type { BatchRequest } from "../types";

/** ⚡ (forced) requests: the flag survives every split, and the prompt follows it. */
describe("a forced ✦ request", () => {
    const long = (n: number) => Array.from({ length: n }, (_, i) => ({
        id: String(i), author: "ana", text: "Ein sehr langer Satz, der immer weiter geht. ".repeat(300).slice(0, 3_900)
    }));

    it("keeps force on every piece fitLlmRequest splits it into", () => {
        const req: BatchRequest = { messages: long(20), context: [], targetLang: "en", force: true };
        const parts = fitLlmRequest(req);
        expect(parts.length).toBeGreaterThan(1);
        for (const p of parts) expect(p.force).toBe(true);
        expect(parts.flatMap(p => p.messages.map(m => m.id))).toEqual(req.messages.map(m => m.id));
    });

    it("keeps force through shrinkAfterRefusal, both halves and the context-less retry", () => {
        const req: BatchRequest = { messages: long(4), context: [{ author: "bo", text: "hola" }], targetLang: "en", force: true };
        for (const p of shrinkAfterRefusal(req)) expect(p.force).toBe(true);
        const lone: BatchRequest = { ...req, messages: long(1) };
        for (const p of shrinkAfterRefusal(lone)) expect(p.force).toBe(true);
    });

    it("an unforced request stays unforced through a split", () => {
        const parts = fitLlmRequest({ messages: long(20), context: [], targetLang: "en" });
        for (const p of parts) expect(p).not.toHaveProperty("force");
    });

    it("the keyed engines' prompt swaps the skip rule for the forced rule, mirroring the relay", () => {
        const base: BatchRequest = { messages: [{ id: "0", author: "a", text: "hola" }], context: [], targetLang: "English" };
        const plain = buildPrompt(base);
        const forced = buildPrompt({ ...base, force: true });
        expect(plain).toContain("Set skip to true");
        expect(forced).not.toContain("Set skip to true");
        expect(forced).toContain(forcedRule("English"));
        expect(forcedRule("X")).toBe(
            "- The reader asked for every message below to be translated. Translate each one into X, "
            + "even if it looks like a name, slang, or is already written in X. Never skip: always set skip "
            + "to false and put the translation in text. If a message is already in X, give it back as it is."
        );
    });
});
