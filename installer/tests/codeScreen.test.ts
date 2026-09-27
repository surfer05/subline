/**
 * The code screen is a choice: "Start free trial" (the filled button) or
 * "I have a code", which reveals the paste field and Save. The renderer draws
 * it from codeScreenView, which is tested here because the renderer is the one
 * module the suite never executes.
 */

import { describe, expect, it } from "vitest";

import { ACTION_LABELS } from "../src/app/actions.js";
import { CODE_SCREEN_COPY, DODO_BUSINESS_ID, codeScreenView, portalUrl } from "../src/app/codeScreen.js";

describe("the code screen", () => {
    it("starts as a choice: trial first and filled, the field hidden", () => {
        const view = codeScreenView({ revealed: false });
        expect(view.showField).toBe(false);
        expect(view.buttons.map(b => [b.kind, b.label, b.primary])).toEqual([
            ["skip-code", "Start free trial", true],
            ["reveal", "I have a code", false]
        ]);
    });

    it("\"I have a code\" reveals the field with Save as the one filled button", () => {
        const view = codeScreenView({ revealed: true });
        expect(view.showField).toBe(true);
        expect(view.buttons.map(b => [b.kind, b.label, b.primary])).toEqual([
            ["set-code", "Save code", true],
            ["skip-code", "Start free trial", false]
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
        expect(ACTION_LABELS["skip-code"]).toBe(CODE_SCREEN_COPY.startTrial);
        expect(ACTION_LABELS["set-code"]).toBe(CODE_SCREEN_COPY.save);
    });

    it("has no em dashes in its copy", () => {
        for (const text of Object.values(CODE_SCREEN_COPY)) expect(text).not.toContain("—");
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
