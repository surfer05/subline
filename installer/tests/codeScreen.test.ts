/**
 * The activation screen is a choice: "Buy for $4.99" (the filled button)
 * or "I have a code", which reveals the paste field and Save. There is no skip. The renderer draws
 * it from codeScreenView, which is tested here because the renderer is the one
 * module the suite never executes.
 */

import { describe, expect, it } from "vitest";

import { ACTION_LABELS } from "../src/app/actions.js";
import { CODE_SCREEN_COPY, DODO_BUSINESS_ID, RESET_HELP_URL, SITE_URL, codeScreenView, portalUrl, showsDiagnostics } from "../src/app/codeScreen.js";

describe("the code screen", () => {
    it("starts as a choice: buying first and filled, the field hidden", () => {
        const view = codeScreenView({ revealed: false });
        expect(view.showField).toBe(false);
        expect(view.buttons.map(b => [b.kind, b.label, b.primary])).toEqual([
            ["buy-automatic", "Buy for $4.99", true],
            ["reveal", "I have a code", false]
        ]);
    });

    it("\"I have a code\" reveals the field with Save as the one filled button", () => {
        const view = codeScreenView({ revealed: true });
        expect(view.showField).toBe(true);
        expect(view.buttons.map(b => [b.kind, b.label, b.primary])).toEqual([
            ["set-code", "Save code", true],
            ["buy-automatic", "Buy for $4.99", false]
        ]);
    });

    it("a refused save comes back on the field, not on the choice", () => {
        expect(codeScreenView({ revealed: false, hasError: true }).showField).toBe(true);
    });

    it("draws exactly one primary in both states", () => {
        for (const revealed of [false, true]) {
            expect(codeScreenView({ revealed }).buttons.filter(b => b.primary)).toHaveLength(1);
        }
    });

    it("labels the flow actions from the same copy object", () => {
        expect(ACTION_LABELS["buy-automatic"]).toBe(CODE_SCREEN_COPY.buy);
        expect(ACTION_LABELS.back).toBe(CODE_SCREEN_COPY.back);
        expect(ACTION_LABELS["set-code"]).toBe(CODE_SCREEN_COPY.save);
    });

    it("has no em dashes, and nothing free or trial, in its copy", () => {
        for (const text of Object.values(CODE_SCREEN_COPY)) {
            expect(text).not.toContain("—");
            expect(text).not.toMatch(/\bfree\b|\btrial\b/i);
        }
    });

    it("never offers a way past the screen without activation", () => {
        for (const revealed of [false, true]) {
            const kinds = codeScreenView({ revealed }).buttons.map(b => b.kind);
            expect(kinds).not.toContain("skip-code");
            expect(kinds.every(k => ["buy-automatic", "set-code", "reveal"].includes(k))).toBe(true);
        }
    });
});

describe("Find my code", () => {
    it("links the documented customer portal login when the business id is known", () => {
        expect(portalUrl("bus_ABC123")).toBe("https://customer.dodopayments.com/login/bus_ABC123");
        const view = codeScreenView({ revealed: true, businessId: "bus_ABC123" });
        expect(view.findCodeUrl).toBe("https://customer.dodopayments.com/login/bus_ABC123");
    });

    it("draws no link while the business id is unknown", () => {
        expect(portalUrl("")).toBeNull();
        expect(portalUrl("  ")).toBeNull();
        expect(codeScreenView({ revealed: true, businessId: "" }).findCodeUrl).toBeNull();
    });

    it("the shipped screen links Find my code to this business's customer portal", () => {
        expect(DODO_BUSINESS_ID).toBe("bus_0Nn5xovcpJlT15uPLKQ8M");
        expect(codeScreenView({ revealed: true }).findCodeUrl)
            .toBe("https://customer.dodopayments.com/login/bus_0Nn5xovcpJlT15uPLKQ8M");
    });

    it("is not drawn before the field is revealed", () => {
        expect(codeScreenView({ revealed: false, businessId: "bus_ABC123" }).findCodeUrl).toBeNull();
    });

    it("refuses an id that could change the URL's shape", () => {
        expect(portalUrl("bus/../x")).toBeNull();
        expect(portalUrl("bus?x=1")).toBeNull();
    });
});

describe("the activation copy (the owner's exact words)", () => {
    it("says what Subline costs, in the field test's words (I4)", () => {
        expect(CODE_SCREEN_COPY.title).toBe("Activate Subline");
        expect(CODE_SCREEN_COPY.detail).toBe("$4.99, once.");
        expect(CODE_SCREEN_COPY.fieldLabel).toBe("Code");
        expect(CODE_SCREEN_COPY.findCode).toBe("Lost your code?");
        expect(CODE_SCREEN_COPY.buy).toBe("Buy for $4.99");
        expect(CODE_SCREEN_COPY.haveCode).toBe("I have a code");
        expect(CODE_SCREEN_COPY.whereFrom).toBe("Bought it? The code is in the email from Dodo Payments. Check spam.");
    });

    it("tells the buyer to finish in the browser, and that it carries on by itself", () => {
        expect(CODE_SCREEN_COPY.waitingTitle).toBe("Finish paying in your browser");
        expect(CODE_SCREEN_COPY.waiting).toBe("Subline carries on by itself when it's done.");
        expect(CODE_SCREEN_COPY.back).toBe("Back");
    });

    it("says when the per-network code limit resets", () => {
        // The relay counts redemptions per IP per UTC day (rl:rd:<ip>:<UTC date>).
        expect(CODE_SCREEN_COPY.errRateLimited).toBe("Too many codes tried from this network today. Try again after midnight UTC.");
    });

    it("has no em dashes and no free or trial wording", () => {
        for (const s of Object.values(CODE_SCREEN_COPY)) {
            expect(s).not.toContain("—");
            expect(s).not.toMatch(/\b(free|trial)\b/i);
        }
    });
});

describe("the diagnostics box (field test I5)", () => {
    it("is not drawn for the relay's answers about a code", () => {
        expect(showsDiagnostics({ code: "CODE_REFUSED" })).toBe(false);
        expect(showsDiagnostics(null)).toBe(false);
    });
    it("is drawn for a real failure", () => {
        expect(showsDiagnostics({ code: "IO_ERROR" })).toBe(true);
    });
    it("support is an email to subline.page, the only mailto the main process opens", () => {
        expect(RESET_HELP_URL).toBe("mailto:support@subline.page");
        expect(SITE_URL).toBe("https://subline.page");
    });
});
