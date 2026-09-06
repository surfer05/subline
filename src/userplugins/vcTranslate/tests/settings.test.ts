import { describe, expect, it } from "vitest";

import settings from "../settings";

/**
 * These guard the product's paywall against a self-inflicted loophole: if the
 * settings UI lets anyone pick a bring-your-own-key engine and paste a key,
 * they get ✦ AI for free and never need a Subline code. The whole model is
 * "free Google (≈), or a code for ✦ AI" — so the UI must expose no other AI
 * path. (The engine implementations still exist in the code, unreachable, for
 * the test suite; what matters is that a shipped build offers no way in.)
 */
describe("no bring-your-own-key loophole in the settings UI", () => {
    it("offers only Google and the Subline code as engines", () => {
        const values = settings.def.engine.options.map((o: { value: string }) => o.value);
        expect(values).toEqual(["google", "relay"]);
        // Explicitly: none of the API-key engines are selectable.
        expect(values).not.toContain("claude");
        expect(values).not.toContain("gemini");
        expect(values).not.toContain("groq");
    });

    it("keeps every API-key field permanently hidden, whatever the engine", () => {
        for (const field of ["anthropicApiKey", "geminiApiKey", "geminiModel", "groqApiKey", "groqModel"]) {
            const hidden = settings.def[field].hidden;
            expect(typeof hidden).toBe("function");
            // Hidden regardless of the (legacy) engine value — no context makes it appear.
            expect(hidden.call({ store: { engine: "claude" } })).toBe(true);
            expect(hidden.call({ store: { engine: "groq" } })).toBe(true);
            expect(hidden.call({ store: { engine: "relay" } })).toBe(true);
        }
    });

    it("still offers the Subline code field for the ✦ upgrade", () => {
        expect(settings.def.sublineCode).toBeDefined();
        expect(settings.def.sublineCode.type).toBeDefined();
    });
});
