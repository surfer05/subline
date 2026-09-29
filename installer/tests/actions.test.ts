/**
 * The action vocabulary, and the one rule about it that was only ever a comment.
 *
 * `IS_PRIMARY` used to live in `renderer.ts` as a bare array of the primary
 * actions, which meant two things: a new action silently defaulted to secondary,
 * and nothing could assert "one primary per screen, never two" because the
 * renderer is the one module the suite never executes.
 */

import { describe, expect, it } from "vitest";

import { ACTION_LABELS, IS_PRIMARY } from "../src/app/actions.js";
import type { FlowActionType } from "../src/app/flow.js";

describe("the action vocabulary", () => {
    it("names and styles exactly the same set of actions", () => {
        // Two tables over one union. If they disagree, one action either has no
        // label or no answer to "is this the filled button".
        expect(Object.keys(IS_PRIMARY).sort()).toEqual(Object.keys(ACTION_LABELS).sort());
    });

    it("gives every action a non-empty label", () => {
        for (const [action, label] of Object.entries(ACTION_LABELS)) {
            expect(label.trim(), action).not.toBe("");
        }
    });

    it("names destructive and lossy actions for what they cost", () => {
        // A recurring decision in this project: "Continue" would let somebody
        // give up self-repair, or force-close Discord, without noticing.
        expect(ACTION_LABELS["skip-helper"]).toMatch(/without background updates/i);
        expect(ACTION_LABELS["force-quit-discord"]).toMatch(/anyway/i);
        // Paid only: the activation screen leads with the purchase, and says
        // the price on the button.
        expect(ACTION_LABELS["buy-automatic"]).toBe("Buy for $4.99");
        for (const label of Object.values(ACTION_LABELS)) expect(label).not.toMatch(/free|trial/i);
    });

    it("marks no more than one action per screen as primary", () => {
        // The rule the old comment stated and nothing enforced. Screens are
        // asserted from the flow itself in flow.test.ts; this holds the weaker
        // but still useful property that the obvious pairs are not both filled.
        const bothPrimary = (a: FlowActionType, b: FlowActionType) => IS_PRIMARY[a] && IS_PRIMARY[b];
        expect(bothPrimary("quit-discord", "recheck")).toBe(false);
        expect(bothPrimary("set-code", "buy-automatic")).toBe(false);
        expect(bothPrimary("back", "buy-automatic")).toBe(false);
        expect(bothPrimary("retry", "cancel")).toBe(false);
        expect(bothPrimary("proceed-over-mod", "cancel")).toBe(false);
    });

    it("never makes cancel the filled button", () => {
        // Cancel is the way out of a refusal. Filling it would read as the
        // recommended action on exactly the screens that have no good one.
        expect(IS_PRIMARY.cancel).toBe(false);
    });
});
