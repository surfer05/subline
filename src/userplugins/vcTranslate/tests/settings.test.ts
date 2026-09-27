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

/**
 * The settings page as the reader sees it. Vencord titles a setting from its
 * `displayName`, falling back to a title built from the key ("Target Lang"),
 * so every visible setting carries its own sentence-case title.
 */
describe("the settings page copy", () => {
    const def = (settings as any).def;

    it("titles and describes every visible setting exactly", () => {
        const expected: Record<string, [string, string]> = {
            sublineCode: ["Subline code", "From your purchase email. Keeps everything automatic."],
            targetLang: ["Reading language", "Messages are translated into this language."],
            catchUpCount: ["Earlier messages", "How many recent messages to translate when you open a channel."],
            globalAuto: ["All servers", "Off: only channels you turn on with the globe button. DMs stay off unless you turn one on."],
            translateSurfaces: ["Profiles, embeds and more", "Also translate statuses, bios, embeds, polls, topics and titles."],
            debugLogging: ["Debug log", "Writes details to Discord's console for troubleshooting. Stays on your computer."]
        };
        for (const [key, [title, description]] of Object.entries(expected)) {
            expect(def[key].displayName, key).toBe(title);
            expect(def[key].description, key).toBe(description);
        }
    });

    it("hides the engine, which follows the code by itself, but keeps it working", () => {
        __resetSettings();
        expect(def.engine.hidden()).toBe(true);
        settings.store.sublineCode = "SUBLINE-TEST-CODE";
        expect(def.engine.hidden()).toBe(true);
        expect(settings.store.engine).toBe(RELAY_ENGINE);
    });

    it("keeps the setting keys the installer writes, so no stored value is stranded", () => {
        for (const key of ["engine", "sublineCode", "targetLang"]) expect(def[key], key).toBeDefined();
    });

    it("says nothing with an em dash", () => {
        for (const d of Object.values(def) as any[]) {
            if (d.hidden?.() === true) continue;
            expect(String(d.displayName ?? "") + String(d.description ?? "")).not.toContain("—");
        }
    });
});

/**
 * Clearing the code turns the install free at once: the engine is Google
 * again, and the free-plan line under the code field is there on the very
 * next render, without reopening settings. (The settings panes re-render on
 * every plugin setting change; the line and its hidden check read the store.)
 */
describe("clearing the code", () => {
    beforeEach(() => __resetSettings());

    it("switches the engine back and shows the free-plan line straight away", () => {
        settings.store.sublineCode = "SUBLINE-TEST-CODE";
        const line = (settings as any).def.freePlanStatus;
        expect(line.hidden()).toBe(true);
        expect(line.component()).toBeNull();
        settings.store.freeTrialStartedAt = Date.now();
        settings.store.sublineCode = "";
        expect(settings.store.engine).toBe(FREE_ENGINE);
        expect(line.hidden()).toBe(false);
        expect(line.component().children[0]).toBe("Free trial: 7 days left.");
    });
});
