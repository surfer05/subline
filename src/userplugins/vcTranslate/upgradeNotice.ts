/**
 * A once-ever, dismissible in-Discord nudge for users still on the free ≈ tier:
 * "you can paste a Subline code for ✦ AI quality."
 *
 * WHY. Onboarding is deliberately no-friction: a user who installs without a
 * code still gets instant Google (≈) translation, nothing pushed in their face.
 * But then they never learn the ✦ upgrade exists. This is the one gentle
 * pointer — shown a single time, persisted so it never nags again, and never
 * shown at all to someone who already has a code or their own key.
 *
 * PURE AND INJECTED, like updateNotice.ts: no Vencord imports here, so the
 * decision and the once-ever bookkeeping are unit-tested without a Discord.
 * index.tsx supplies the real effectiveEngine / DataStore / Notices.
 */

/**
 * Nudge only a free-tier user who has not been nudged before. Identity of the
 * running engine is decided by the caller (effectiveEngine() === "google");
 * this keeps the rule in one testable place.
 */
export function shouldNudge(onFreeTier: boolean, alreadyNudged: boolean): boolean {
    return onFreeTier && !alreadyNudged;
}

export interface UpgradeNudgeDeps {
    /** True when the plugin is falling back to Google (no code, no own key). */
    onFreeTier: () => boolean;
    /** Whether the nudge has already been shown (persisted across launches). */
    hasNudged: () => Promise<boolean>;
    /** Record that the nudge has now been shown. */
    markNudged: () => Promise<void>;
    /** Show the banner. */
    showNudge: () => void;
}

/**
 * Show the upgrade nudge at most once, ever, and only to a free-tier user.
 *
 * Best effort throughout: if the "already nudged" read fails we err towards
 * showing it (a stray extra nudge is a smaller sin than a persistent one that
 * a broken read would suppress forever), and a failed write never throws — the
 * worst case is the nudge reappears on the next launch, which is harmless.
 */
export async function maybeShowUpgradeNudge(deps: UpgradeNudgeDeps): Promise<void> {
    if (!deps.onFreeTier()) return;

    let seen: boolean;
    try {
        seen = await deps.hasNudged();
    } catch {
        seen = false;
    }
    if (seen) return;

    deps.showNudge();
    try {
        await deps.markNudged();
    } catch {
        // A re-nudge on the next launch is acceptable; a thrown error on the
        // translation-adjacent startup path is not.
    }
}
