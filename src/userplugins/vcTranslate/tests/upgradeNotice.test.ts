import { describe, expect, it } from "vitest";

import { maybeShowUpgradeNudge, shouldNudge, type UpgradeNudgeDeps } from "../upgradeNotice";

describe("shouldNudge", () => {
    it("nudges a free-tier user who has not been nudged", () => {
        expect(shouldNudge(true, false)).toBe(true);
    });

    it("does not nudge a user who already has AI (not on the free tier)", () => {
        expect(shouldNudge(false, false)).toBe(false);
    });

    it("does not nudge again once nudged", () => {
        expect(shouldNudge(true, true)).toBe(false);
    });
});

function harness(opts: {
    onFreeTier: boolean;
    seen?: boolean;
    hasNudgedThrows?: boolean;
    markThrows?: boolean;
}) {
    let shown = 0;
    let marked = 0;
    const deps: UpgradeNudgeDeps = {
        onFreeTier: () => opts.onFreeTier,
        hasNudged: () => opts.hasNudgedThrows
            ? Promise.reject(new Error("datastore down"))
            : Promise.resolve(opts.seen ?? false),
        markNudged: () => { marked += 1; return opts.markThrows ? Promise.reject(new Error("write failed")) : Promise.resolve(); },
        showNudge: () => { shown += 1; }
    };
    return { deps, get shown() { return shown; }, get marked() { return marked; } };
}

describe("maybeShowUpgradeNudge", () => {
    it("shows the nudge once and records it for a fresh free-tier user", async () => {
        const h = harness({ onFreeTier: true });
        await maybeShowUpgradeNudge(h.deps);
        expect(h.shown).toBe(1);
        expect(h.marked).toBe(1);
    });

    it("never nudges a user who is not on the free tier", async () => {
        const h = harness({ onFreeTier: false });
        await maybeShowUpgradeNudge(h.deps);
        expect(h.shown).toBe(0);
        expect(h.marked).toBe(0);
    });

    it("does not nudge a user who was already nudged", async () => {
        const h = harness({ onFreeTier: true, seen: true });
        await maybeShowUpgradeNudge(h.deps);
        expect(h.shown).toBe(0);
    });

    it("shows the nudge when the seen-flag read fails (best effort, not a blocker)", async () => {
        const h = harness({ onFreeTier: true, hasNudgedThrows: true });
        await maybeShowUpgradeNudge(h.deps);
        expect(h.shown).toBe(1);
    });

    it("does not throw when recording the nudge fails", async () => {
        const h = harness({ onFreeTier: true, markThrows: true });
        await expect(maybeShowUpgradeNudge(h.deps)).resolves.toBeUndefined();
        expect(h.shown).toBe(1);
    });
});
