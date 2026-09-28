import { describe, expect, it } from "vitest";

import settings from "../settings";
import { SETTINGS_COPY } from "../settingsCopy";
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
        expect(UPGRADE_COPY.deviceLimit).toBe("This code is already used on 3 computers.");
        expect(UPGRADE_COPY.automaticButton).toBe("Buy Automatic, $4.99");
        expect(UPGRADE_COPY.enterCodeButton).toBe("Enter a code");
        expect(UPGRADE_COPY.activateButton).toBe("Activate");
    });
});
