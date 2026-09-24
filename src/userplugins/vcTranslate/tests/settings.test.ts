import { __resetSettings } from "@api/Settings";
import { beforeEach, describe, expect, it } from "vitest";

import { RELAY_ENGINE as INSTALLER_RELAY_ENGINE } from "../../../../installer/src/app/language";
import settings, { FREE_ENGINE, RELAY_ENGINE } from "../settings";
import { onSettingsChanged } from "../settingsBridge";

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

/**
 * Pasting a code in settings used to leave Engine on Google, so ✦ stayed off
 * until the user also found the Engine dropdown. The installer writes
 * engine "relay" with the code; the settings field must do the same.
 */
describe("the Subline code field drives the engine", () => {
    beforeEach(() => __resetSettings());

    it("switches Engine to the relay when a code is pasted", () => {
        expect(settings.store.engine).toBe("google");
        settings.store.sublineCode = "SUBLINE-TEST-CODE";
        expect(settings.store.engine).toBe(RELAY_ENGINE);
    });

    it("uses the same engine value the installer seeds", () => {
        expect(RELAY_ENGINE).toBe(INSTALLER_RELAY_ENGINE);
        expect(settings.def.engine.options.map((o: { value: string }) => o.value)).toContain(RELAY_ENGINE);
    });

    it("switches back to Google when the code is cleared", () => {
        settings.store.sublineCode = "SUBLINE-TEST-CODE";
        settings.store.sublineCode = "";
        expect(settings.store.engine).toBe(FREE_ENGINE);
    });

    it("treats a code of only spaces as no code", () => {
        settings.store.sublineCode = "   ";
        expect(settings.store.engine).toBe("google");
    });

    it("moves a legacy bring-your-own-key engine to the relay too", () => {
        settings.store.engine = "groq";
        settings.store.sublineCode = "SUBLINE-TEST-CODE";
        expect(settings.store.engine).toBe(RELAY_ENGINE);
    });

    it("tells the plugin about the change", () => {
        let calls = 0;
        onSettingsChanged(() => { calls++; });
        try {
            settings.store.sublineCode = "SUBLINE-TEST-CODE";
            expect(calls).toBeGreaterThan(0);
        } finally {
            onSettingsChanged(null);
        }
    });
});
