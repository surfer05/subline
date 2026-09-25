/**
 * THE FREE PLAN (v0.1.6): a 7-day automatic trial, then translate on click.
 *
 * A free install (no Subline code) gets its first seven days exactly like a
 * paid one: ≈ and ✦ on every foreign message, automatically. After that,
 * nothing is translated until the reader clicks the "≈ Translate" line under a
 * message. The paywall is on AUTOMATIC reading, never on the quality of what a
 * click shows.
 *
 * WHO DECIDES. Two clocks, and they are not equal:
 *  - the RELAY records the first time it saw this install id and states the
 *    trial's end (`trialEndsAt`). That is the authority: it survives a wiped
 *    settings file, and it is what the relay itself enforces.
 *  - the LOCAL start time (a hidden plugin setting) is the fallback, used only
 *    while the relay has not answered this session (offline, or an older relay
 *    that does not know about trials). It never grants ✦ on its own; see
 *    `trialConfirmed`.
 *
 * Pure apart from the one piece of session state below, and free of Discord,
 * settings and the network, so settings.ts can render the plan line from it
 * and the arithmetic can be tested on its own.
 */

export const DAY_MS = 86_400_000;
export const TRIAL_DAYS = 7;
export const TRIAL_MS = TRIAL_DAYS * DAY_MS;

/** Where every upgrade link on the free plan points. */
export const PRICING_URL = "https://surfer05.github.io/subline/#pricing";

export type FreeMode = "trial" | "click";

/**
 * What the relay last said about this install's trial, this session.
 * `null` means it has not said anything yet (or is an older relay).
 */
let serverTrialEndsAt: number | null = null;

/** Record the relay's `trialEndsAt`. Ignores anything that is not a sane epoch. */
export function noteServerTrialEnd(endsAt: unknown): void {
    if (typeof endsAt !== "number" || !Number.isFinite(endsAt) || endsAt <= 0) return;
    serverTrialEndsAt = endsAt;
}

/** The relay refused an automatic request with "trial ended": it is over now. */
export function markServerTrialEnded(now: number = Date.now()): void {
    serverTrialEndsAt = Math.min(serverTrialEndsAt ?? now, now);
}

/** The end of the trial: the relay's word when it has given one, else the local clock's. */
export function trialEndsAt(localStartedAt: number): number {
    if (serverTrialEndsAt !== null) return serverTrialEndsAt;
    return localStartedAt + TRIAL_MS;
}

/** Automatic (trial) or click-to-translate, for a FREE install. */
export function freeMode(localStartedAt: number, now: number = Date.now()): FreeMode {
    return now < trialEndsAt(localStartedAt) ? "trial" : "click";
}

/**
 * Has the relay itself confirmed a running trial this session?
 *
 * Automatic ✦ during the trial is gated on this, not on the local clock: the
 * relay is what pays for ✦ and what enforces the trial, so a client that only
 * THINKS it is in its trial (an old relay, or no answer yet) translates with
 * ≈ automatically and asks for no ✦ it would be refused.
 */
export function trialConfirmed(now: number = Date.now()): boolean {
    return serverTrialEndsAt !== null && now < serverTrialEndsAt;
}

/** Whole days left in the trial, rounded up, never below 1 while it runs. */
export function trialDaysLeft(localStartedAt: number, now: number = Date.now()): number {
    const left = trialEndsAt(localStartedAt) - now;
    if (left <= 0) return 0;
    return Math.max(1, Math.ceil(left / DAY_MS));
}

/**
 * The read-only line under the Subline Code setting. `null` for a paid
 * install, which is told nothing new.
 */
export function freePlanLine(isFree: boolean, localStartedAt: number, now: number = Date.now()): string | null {
    if (!isFree) return null;
    if (freeMode(localStartedAt, now) === "trial") {
        const d = trialDaysLeft(localStartedAt, now);
        return `Free trial: ${d} ${d === 1 ? "day" : "days"} left.`;
    }
    return "Free plan: messages translate when you click.";
}

/** Shown once, the first time a message is shown after the trial ends. */
export function trialEndedMessage(): string {
    return "Your 7-day free trial ended. Messages now translate when you click. "
        + `Upgrade to keep it automatic. ${PRICING_URL}`;
}

/* ------------------------------------------------------------ preview -- */

/** How much of a ✦ preview the relay returns (mirrors relay previewText). */
export const PREVIEW_WORDS = 5;
export const PREVIEW_MAX_CHARS = 32;

/**
 * The first few words of a translation, exactly as the relay cuts a ✦ preview.
 *
 * A MIRROR of the relay's own truncation, and used for one thing only: to cut
 * the ≈ line the same way before comparing it with the preview. If the two cut
 * the same, the preview would show the reader nothing they cannot already
 * read, so it is not shown. The relay is what actually truncates ✦: the full
 * text never reaches a free client.
 */
export function previewText(text: string): { text: string; truncated: boolean } {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const full = words.join(" ");
    let out = words.slice(0, PREVIEW_WORDS).join(" ");
    const chars = Array.from(out);
    if (chars.length > PREVIEW_MAX_CHARS) out = chars.slice(0, PREVIEW_MAX_CHARS).join("").trimEnd();
    return { text: out, truncated: out !== full };
}

/** Case, spacing and punctuation folded away: "Hello, there." reads as "hello there". */
function normalise(s: string): string {
    return s.toLowerCase().replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Would this ✦ preview tell the reader anything the ≈ line does not already?
 * False when ✦ reads the same as ≈ over the words the preview shows.
 */
export function previewDiffers(preview: string, googleText: string): boolean {
    return normalise(previewText(googleText).text) !== normalise(preview)
        && normalise(googleText) !== normalise(preview);
}

/** Test-only: forget what the relay said. */
export function __resetFreePlan(): void {
    serverTrialEndsAt = null;
}
