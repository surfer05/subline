import { describe, expect, it } from "vitest";

import settings from "../settings";
import { SETTINGS_COPY } from "../settingsCopy";
import { TASTE_CAP } from "../taste";
import { UPGRADE_COPY } from "../upgradeCopy";

/** Every string in a (nested) copy object. */
function strings(v: unknown): string[] {
    if (typeof v === "string") return [v];
    if (v && typeof v === "object") return Object.values(v).flatMap(strings);
    return [];
}

/**
 * There is no free tier and no trial any more (entitlement.ts). Nothing the
 * reader sees may still promise one, and nothing may send them to a Vencord
 * "Plugins" page that no user can see.
 */
describe("the copy after the free tier", () => {
    const all = [
        ...strings(UPGRADE_COPY),
        ...strings(SETTINGS_COPY),
        ...settings.def.engine.options.map((o: { label: string }) => o.label)
    ];

    it("says nothing about a trial or a free plan", () => {
        for (const s of all) {
            expect(s).not.toMatch(/trial/i);
            expect(s).not.toMatch(/free (plan|week|install)/i);
            expect(s).not.toMatch(/free trial/i);
        }
    });

    it("never points at Vencord's Plugins page, and has no em dash", () => {
        for (const s of all) {
            expect(s).not.toMatch(/\bPlugins\b|VcTranslate/);
            expect(s).not.toContain("—");
        }
    });

    it("uses the owner's exact sentences for codes and the 3-computer limit", () => {
        expect(UPGRADE_COPY.codeClaimed).toBe("This code has been fully claimed.");
        expect(UPGRADE_COPY.codeNotFound).toBe("That code doesn't exist.");
        expect(UPGRADE_COPY.codeAlready).toBe("Already yours.");
        expect(UPGRADE_COPY.codeUnreachable).toBe("Can't reach Subline right now. Try again in a minute.");
        expect(UPGRADE_COPY.deviceLimit).toBe("This code is on 3 computers already. It frees up after 30 days unused, or ask us to reset it.");
        expect(UPGRADE_COPY.automaticButton).toBe("Buy for $4.99");
        expect(UPGRADE_COPY.enterCodeButton).toBe("Enter a code");
        expect(UPGRADE_COPY.activateButton).toBe("Activate");
    });
});

describe("the Windows test round's wording", () => {
    it("uses the owner's exact strings", () => {
        expect(UPGRADE_COPY.activateNotice).toBe("Subline isn't activated on this computer yet.");
        expect(UPGRADE_COPY.activateButton).toBe("Activate");
        expect(UPGRADE_COPY.activateTitle).toBe("Activate Subline");
        expect(UPGRADE_COPY.activateSubtitle).toBe("Pay once and every message gets translated.");
        expect(UPGRADE_COPY.automaticNote).toBe("≈ under every message, profile and embed. Yours for good.");
        expect(UPGRADE_COPY.automaticButton).toBe("Buy for $4.99");
        expect(UPGRADE_COPY.enterCodeButton).toBe("Enter a code");
        expect(UPGRADE_COPY.codeSubtitle).toBe("A server code, or the code from your purchase email.");
        expect(UPGRADE_COPY.panelSubtitle).toBe("✦ reads the whole conversation, so slang and replies come out right.");
        expect(UPGRADE_COPY.monthlyButton).toBe("Monthly $1.99");
        expect(UPGRADE_COPY.annualButton).toBe("Yearly $19.99 · 2 months free");
        expect(UPGRADE_COPY.popoverPreview.replace("{n}", "4")).toBe("Preview ✦ (4 left today)");
        expect(UPGRADE_COPY.popoverUpgrade).toBe("Add AI ✦");
        expect(UPGRADE_COPY.googleBusy).toBe("Google is busy. Subline retries by itself.");
    });

    it("has no old price left anywhere in the plugin's copy", () => {
        const all = JSON.stringify(UPGRADE_COPY);
        expect(all).not.toContain("2.49");
        expect(all).not.toContain("4 months");
        expect(all).toContain("$1.99 a month");
        expect(all).toContain("2 months free");
    });

    it("gives Automatic five ✦ previews a day", () => {
        expect(TASTE_CAP).toBe(5);
    });
});
