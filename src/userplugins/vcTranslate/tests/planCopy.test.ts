import { describe, expect, it } from "vitest";

import settings from "../settings";
import { SETTINGS_COPY } from "../settingsCopy";
import { TASTE_CAP } from "../taste";
import { AI_ANNUAL_CENTS, AI_MONTHLY_CENTS, annualSavingPercent, SUPPORT_EMAIL, UPGRADE_COPY } from "../upgradeCopy";

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
        expect(UPGRADE_COPY.deviceLimit).toBe("This code is on 3 computers already. It frees up after 30 days unused, or email support@subline.page for a reset.");
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
        // P3: the prices are the buttons.
        expect(UPGRADE_COPY.panelTitle).toBe("Add AI");
        expect(UPGRADE_COPY.monthlyButton).toBe("$1.99 a month");
        expect(UPGRADE_COPY.annualButton).toBe("$19.99 a year · Save 16%");
        expect(UPGRADE_COPY.couponHint).toBe("Coupon? Enter it on the payment page.");
        expect(UPGRADE_COPY.paymentPending).toBe("Payment being confirmed");
        expect(UPGRADE_COPY.popoverPreview.replace("{n}", "4")).toBe("Preview ✦ (4 left today)");
        expect(UPGRADE_COPY.popoverUpgrade).toBe("Add AI ✦");
        expect(UPGRADE_COPY.googleBusy).toBe("Google is busy. Subline retries by itself.");
    });

    it("has no old price left anywhere in the plugin's copy", () => {
        const all = JSON.stringify(UPGRADE_COPY);
        expect(all).not.toContain("2.49");
        expect(all).not.toContain("4 months");
        expect(all).toContain("$1.99 a month");
        expect(all).toContain("Save 16%");
        expect(all).not.toContain("months free");
    });

    it("never claims a bigger yearly saving than the prices give", () => {
        const yearOfMonths = 12 * AI_MONTHLY_CENTS;
        const saved = yearOfMonths - AI_ANNUAL_CENTS;
        expect(UPGRADE_COPY.monthlyButton).toBe(`$${(AI_MONTHLY_CENTS / 100).toFixed(2)} a month`);
        const m = /^\$(\d+\.\d\d) a year · Save (\d+)%$/.exec(UPGRADE_COPY.annualButton);
        expect(Number(m?.[1])).toBe(AI_ANNUAL_CENTS / 100);
        const pct = Number(m?.[2]);
        expect(pct).toBeGreaterThan(0);
        expect(pct * yearOfMonths).toBeLessThanOrEqual(saved * 100);
        expect(annualSavingPercent(199, 1999)).toBe(16);
    });

    it("gives Automatic five ✦ previews a day", () => {
        expect(TASTE_CAP).toBe(5);
    });

    it("uses the re-audit's exact strings, matching the installer", () => {
        expect(UPGRADE_COPY.codeConfirmTitle).toBe("Use this code?");
        expect(UPGRADE_COPY.codeConfirm).toBe("It works on up to 3 computers.");
        expect(UPGRADE_COPY.codeConfirmButton).toBe("Use it");
        expect(UPGRADE_COPY.codeEmpty).toBe("Type or paste a code first.");
        expect(UPGRADE_COPY.deviceLimit).toBe("This code is on 3 computers already. It frees up after 30 days unused, or email support@subline.page for a reset.");
        // P10: Vencord opens no mailto: links, so the button copies the address.
        expect(UPGRADE_COPY.deviceLimitButton).toBe("Copy email");
        expect(UPGRADE_COPY.emailCopied).toBe("Email copied.");
        expect(SUPPORT_EMAIL).toBe("support@subline.page");
        expect(UPGRADE_COPY.earlyCheckingNotice).toBe("Checking your early-user access. This can take a minute.");
    });

    it("uses the third audit's strings: the same rate-limit sentence as the installer, and the coupon hint", async () => {
        const { readFileSync } = await import("node:fs");
        const installer = readFileSync(new URL("../../../../installer/src/app/codeScreen.ts", import.meta.url), "utf8");
        expect(UPGRADE_COPY.codeRateLimited).toBe("Too many codes tried from this network today. Try again after midnight UTC.");
        expect(installer).toContain(`errRateLimited: "${UPGRADE_COPY.codeRateLimited}"`);
        // P3: the owner's line, which replaced "Have a coupon? Pick Monthly...".
        expect(UPGRADE_COPY.couponHint).toBe("Coupon? Enter it on the payment page.");
    });
});
