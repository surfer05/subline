/**
 * "Is the mod actually WORKING?" — spec §6's health check, as distinct from a
 * patch check.
 *
 * ## The failure this exists for
 *
 * Two different things break when Discord updates, and only one is repairable by
 * re-patching (spec §6):
 *
 *  1. the injection is wiped — mechanical, always fixable, and `helper.ts`
 *     handles it without ever consulting this module;
 *  2. Discord ships a new frontend, Vencord's webpack finders stop locating
 *     `MessageStore` / `FluxDispatcher`, or the message-renderer patch fails.
 *     **The mod loads and silently renders nothing.** No amount of re-patching
 *     fixes it: it needs a new build with upstream's fixes merged.
 *
 * The second one has no error anywhere. Every signal an installer normally has —
 * the patch verified, the archive is byte-perfect, the mod reported in — is
 * green. The single distinguishing fact is in the beacon: translations are being
 * PRODUCED and none is being PAINTED. `verifyOnce` already names that state
 * (`translating-not-rendering`), so this module does not re-derive it; it decides
 * what to DO about seeing it.
 *
 * ## Why one observation is never enough
 *
 * "Nothing has been translated" is a perfectly healthy state — someone whose
 * server speaks their own language has nothing to translate, possibly for weeks.
 * Spec §6's own warning applies here: **an updater that warns falsely gets
 * ignored when it warns truthfully.** So:
 *
 *  - **Silence is never a signal.** `not-loaded`, `loaded-idle`, a stale beacon,
 *    an unreadable one — none of these ever escalates. They CLEAR the counter,
 *    because a healthy quiet install must not accumulate suspicion.
 *  - **Only the contradiction is a signal**: translated recently, rendered
 *    nothing. That is not quiet — it is work being done and thrown away.
 *  - **And even that must persist**: at least `MIN_OBSERVATIONS` consecutive
 *    sightings spanning at least `MIN_WINDOW_MS`, so a translation caught
 *    in-flight between "translated" and "painted" cannot escalate on its own.
 *  - **Errors are a different problem.** A rate-limited or key-rejected engine
 *    reports `loaded-erroring`; that is an engine or quota fault, not a stale
 *    build, and shipping a new mod would not fix it. It is reported under its own
 *    name and never escalates to `broken`.
 */

import type { VerificationReport, VerificationStatus } from "../verify/verify.js";
import type { HealthMemory } from "./state.js";

export type HealthStatus =
    /** No evidence either way — nothing has reported, or the beacon is not ours. */
    | "unknown"
    /** Loaded, and something was painted on screen. The good one. */
    | "healthy"
    /** Loaded, with nothing to translate. HEALTHY, and must never be alerted on. */
    | "quiet"
    /** Loaded and reporting engine errors. A different problem; never escalates. */
    | "erroring"
    /** Translating and rendering nothing — seen, but not yet often or long enough. */
    | "suspect"
    /** Translating and rendering nothing, sustained. Spec §6's unrepairable case. */
    | "broken";

export interface HealthObservation {
    status: HealthStatus;
    /** The verification status this was derived from, unedited. */
    from: VerificationStatus;
    /** The memory to persist for the next run. */
    memory: HealthMemory;
    /** True on the run where `suspect` became `broken` — the moment to tell someone. */
    escalated: boolean;
    /** How many consecutive suspicious observations, including this one. */
    observations: number;
    /** How long the suspicion has been running, in ms. */
    sustainedMs: number;
    /** One line for the log: what we decided and why. */
    reason: string;
}

/**
 * Three sightings. Two would let a single unlucky pair escalate; four would take
 * most of a day at any sensible helper interval to say something already true.
 */
export const MIN_OBSERVATIONS = 3;

/**
 * Six hours. The window matters more than the count: at a one-hour helper
 * interval three sightings could all fall inside one Discord session with one
 * stuck message. Six hours means the user has opened Discord, used it, and the
 * contradiction is still there.
 */
export const MIN_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface ObserveHealthOptions {
    verification: VerificationReport;
    previous: HealthMemory;
    now: number;
    minObservations?: number;
    minWindowMs?: number;
}

/**
 * The statuses that are evidence of the §6 failure. Exactly one, deliberately.
 *
 * `loaded-erroring` is NOT here: the engine failing is not the frontend having
 * changed, and a new mod build would not help. Nothing that merely means "we saw
 * nothing" is here either, because the absence of translation is the normal state
 * of a healthy install in a channel that speaks the reader's language.
 */
const SUSPICIOUS: readonly VerificationStatus[] = ["translating-not-rendering"];

function classify(status: VerificationStatus): HealthStatus {
    switch (status) {
        case "translating-approx":
        case "translating-upgraded":
            return "healthy";
        case "loaded-idle":
            return "quiet";
        case "loaded-erroring":
            return "erroring";
        case "translating-not-rendering":
            return "suspect";
        default:
            // not-loaded, stale-beacon, unreadable-beacon, foreign-beacon,
            // unidentified-beacon. Each means we have no usable evidence about
            // OUR build — never that it is broken.
            return "unknown";
    }
}

/**
 * Fold one verification report into the running health judgement.
 *
 * Pure: takes the previous memory and the clock, returns the next memory. The
 * helper persists what comes back and nothing else decides health.
 */
export function observeHealth(options: ObserveHealthOptions): HealthObservation {
    const { verification, previous, now } = options;
    const minObservations = options.minObservations ?? MIN_OBSERVATIONS;
    const minWindowMs = options.minWindowMs ?? MIN_WINDOW_MS;

    const raw = classify(verification.status);
    const suspicious = SUSPICIOUS.includes(verification.status);

    if (!suspicious) {
        // Everything that is not the contradiction RESETS the counter, including
        // "we saw nothing". Suspicion that survives a healthy or a silent
        // observation is suspicion that only ever grows.
        return {
            status: raw,
            from: verification.status,
            memory: {
                lastStatus: raw,
                lastObservedAt: now,
                suspectSince: null,
                observations: 0
            },
            escalated: false,
            observations: 0,
            sustainedMs: 0,
            reason: reasonFor(raw, verification.status)
        };
    }

    const suspectSince = previous.suspectSince ?? now;
    const observations = previous.observations + 1;
    const sustainedMs = now - suspectSince;
    const wasBroken = previous.lastStatus === "broken";
    const qualifies = observations >= minObservations && sustainedMs >= minWindowMs;
    const status: HealthStatus = qualifies ? "broken" : "suspect";

    return {
        status,
        from: verification.status,
        memory: { lastStatus: status, lastObservedAt: now, suspectSince, observations },
        // Only the transition, so the alert fires once rather than every run.
        escalated: qualifies && !wasBroken,
        observations,
        sustainedMs,
        reason: qualifies
            ? `translations are being produced and none is reaching the screen — seen ${observations} times over ${Math.round(sustainedMs / 3_600_000)}h, which re-patching cannot fix`
            : `translations are being produced and none is reaching the screen — seen ${observations} time(s) over ${Math.round(sustainedMs / 60_000)}m, not yet enough to call it broken`
    };
}

function reasonFor(status: HealthStatus, from: VerificationStatus): string {
    switch (status) {
        case "healthy":
            return "a translated subtitle has been painted since the patch";
        case "quiet":
            return "the mod is loaded and has had nothing to translate — a normal, healthy state";
        case "erroring":
            return "the mod is loaded but the translation engine is reporting errors, which a new build would not fix";
        default:
            return `no usable evidence about our build (${from})`;
    }
}
