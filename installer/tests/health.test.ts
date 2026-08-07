/**
 * Telling a QUIET install from a BROKEN one (spec §6).
 *
 * The failure being detected has no error anywhere: the patch verifies, the mod
 * reports in, and nothing reaches the screen. The failure being AVOIDED is
 * warning about it wrongly — someone whose server speaks their own language has
 * nothing to translate, possibly for weeks, and an updater that warns falsely
 * gets ignored when it warns truthfully.
 *
 * So the tests below are mostly about what does NOT escalate.
 */

import { describe, expect, it } from "vitest";

import { MIN_OBSERVATIONS, MIN_WINDOW_MS, observeHealth } from "../src/helper/health.js";
import type { HealthObservation } from "../src/helper/health.js";
import { emptyHelperState } from "../src/helper/state.js";
import type { HealthMemory } from "../src/helper/state.js";
import type { VerificationReport, VerificationStatus } from "../src/verify/verify.js";

const HOUR = 60 * 60 * 1000;

function verification(status: VerificationStatus, extra: Partial<VerificationReport> = {}): VerificationReport {
    return {
        status,
        confirmed: false,
        loaded: false,
        pending: false,
        stale: false,
        identity: "match",
        tier: "none",
        errorCode: null,
        beacon: null,
        problem: null,
        summary: "",
        ...extra
    };
}

function fresh(): HealthMemory {
    return emptyHelperState().health;
}

/** Observe the same status repeatedly, `stepMs` apart, carrying the memory forward. */
function observeRepeatedly(
    status: VerificationStatus,
    times: number,
    stepMs: number,
    start = 1_700_000_000_000
): HealthObservation[] {
    let memory = fresh();
    let now = start;
    const results: HealthObservation[] = [];
    for (let index = 0; index < times; index += 1) {
        const observation = observeHealth({ verification: verification(status), previous: memory, now });
        memory = observation.memory;
        results.push(observation);
        now += stepMs;
    }
    return results;
}

describe("health — the quiet states, which must never raise anything", () => {
    it("calls a loaded mod with nothing to translate QUIET, however long it goes on", () => {
        // A month of hourly runs. Not one of them may escalate.
        const observations = observeRepeatedly("loaded-idle", 30 * 24, HOUR);

        expect(observations.every(entry => entry.status === "quiet")).toBe(true);
        expect(observations.some(entry => entry.escalated)).toBe(false);
        expect(observations[observations.length - 1]?.memory.suspectSince).toBeNull();
        expect(observations[0]?.reason).toContain("normal, healthy state");
    });

    it("never escalates when nothing has reported in — Discord may simply not have been opened", () => {
        const observations = observeRepeatedly("not-loaded", 30 * 24, HOUR);
        expect(observations.every(entry => entry.status === "unknown")).toBe(true);
        expect(observations.some(entry => entry.escalated)).toBe(false);
    });

    it("never escalates on a beacon it cannot attribute to our build", () => {
        for (const status of ["stale-beacon", "unreadable-beacon", "foreign-beacon", "unidentified-beacon"] as const) {
            const observations = observeRepeatedly(status, 24, HOUR);
            expect(observations.every(entry => entry.status === "unknown")).toBe(true);
            expect(observations.some(entry => entry.escalated)).toBe(false);
        }
    });

    it("reports an erroring engine under its own name and NEVER as broken", () => {
        // Rate limits and rejected keys are engine problems. Shipping a new mod
        // build would not fix one, so escalating here would send the user chasing
        // an update that cannot help.
        const observations = observeRepeatedly("loaded-erroring", 30 * 24, HOUR);

        expect(observations.every(entry => entry.status === "erroring")).toBe(true);
        expect(observations.some(entry => entry.escalated)).toBe(false);
        expect(observations[0]?.reason).toContain("a new build would not fix");
    });

    it("calls a rendering install healthy on both tiers", () => {
        for (const status of ["translating-approx", "translating-upgraded"] as const) {
            const observation = observeHealth({
                verification: verification(status),
                previous: fresh(),
                now: 1
            });
            expect(observation.status).toBe("healthy");
            expect(observation.escalated).toBe(false);
        }
    });
});

describe("health — the one signal that is real", () => {
    it("does not call a single translating-not-rendering sighting broken", () => {
        const observation = observeHealth({
            verification: verification("translating-not-rendering"),
            previous: fresh(),
            now: 1_700_000_000_000
        });

        expect(observation.status).toBe("suspect");
        expect(observation.escalated).toBe(false);
        expect(observation.observations).toBe(1);
        expect(observation.reason).toContain("not yet enough");
    });

    it("does not escalate on enough sightings that are all too close together", () => {
        // Three sightings inside one hour is one Discord session with one stuck
        // message, not a Discord that has changed underneath us.
        const observations = observeRepeatedly("translating-not-rendering", MIN_OBSERVATIONS + 2, 60_000);

        expect(observations.every(entry => entry.status === "suspect")).toBe(true);
        expect(observations.some(entry => entry.escalated)).toBe(false);
    });

    it("does not escalate on a long window with too few sightings", () => {
        const first = observeHealth({
            verification: verification("translating-not-rendering"),
            previous: fresh(),
            now: 0
        });
        const second = observeHealth({
            verification: verification("translating-not-rendering"),
            previous: first.memory,
            now: MIN_WINDOW_MS * 4
        });

        expect(second.status).toBe("suspect");
        expect(second.escalated).toBe(false);
        expect(second.observations).toBe(2);
    });

    it("escalates once both the count AND the window are satisfied", () => {
        const observations = observeRepeatedly("translating-not-rendering", MIN_OBSERVATIONS, 3 * HOUR);
        const last = observations[observations.length - 1];

        expect(last?.status).toBe("broken");
        expect(last?.escalated).toBe(true);
        expect(last?.observations).toBe(MIN_OBSERVATIONS);
        expect(last?.sustainedMs).toBeGreaterThanOrEqual(MIN_WINDOW_MS);
        expect(last?.reason).toContain("re-patching cannot fix");
    });

    it("escalates only ONCE, so the user is not told every hour", () => {
        const observations = observeRepeatedly("translating-not-rendering", 24, 3 * HOUR);
        const escalations = observations.filter(entry => entry.escalated);

        expect(escalations).toHaveLength(1);
        expect(observations[observations.length - 1]?.status).toBe("broken");
    });

    it("clears the suspicion the moment something is painted", () => {
        const before = observeRepeatedly("translating-not-rendering", 2, 3 * HOUR);
        const recovered = observeHealth({
            verification: verification("translating-approx"),
            previous: before[before.length - 1]?.memory ?? fresh(),
            now: 9 * HOUR
        });

        expect(recovered.status).toBe("healthy");
        expect(recovered.memory.suspectSince).toBeNull();
        expect(recovered.memory.observations).toBe(0);
    });

    it("clears the suspicion on a QUIET observation too, so it cannot accumulate across sessions", () => {
        // Suspicion that survives a silent observation is suspicion that only
        // ever grows, and would eventually escalate on any install.
        const before = observeRepeatedly("translating-not-rendering", 2, 3 * HOUR);
        const quiet = observeHealth({
            verification: verification("loaded-idle"),
            previous: before[before.length - 1]?.memory ?? fresh(),
            now: 9 * HOUR
        });
        const again = observeHealth({
            verification: verification("translating-not-rendering"),
            previous: quiet.memory,
            now: 12 * HOUR
        });

        expect(quiet.memory.observations).toBe(0);
        expect(again.observations).toBe(1);
        expect(again.escalated).toBe(false);
    });

    it("carries the verification status through unedited, so the log says what was seen", () => {
        const observation = observeHealth({
            verification: verification("translating-not-rendering"),
            previous: fresh(),
            now: 1
        });
        expect(observation.from).toBe("translating-not-rendering");
    });

    it("honours injected thresholds so the helper's own tests need not wait six hours", () => {
        const first = observeHealth({
            verification: verification("translating-not-rendering"),
            previous: fresh(),
            now: 0,
            minObservations: 2,
            minWindowMs: 1_000
        });
        const second = observeHealth({
            verification: verification("translating-not-rendering"),
            previous: first.memory,
            now: 2_000,
            minObservations: 2,
            minWindowMs: 1_000
        });

        expect(first.status).toBe("suspect");
        expect(second.status).toBe("broken");
        expect(second.escalated).toBe(true);
    });
});
