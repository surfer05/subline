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

/**
 * THE CLOCK SKEW. The relay's `trialEndsAt` is on the relay's clock, and a
 * reader's computer can be hours or days off. The relay states its own `now`
 * on every response to a v0.1.6 client; the difference is kept here and the
 * relay's end time is converted onto the LOCAL clock the moment it arrives,
 * so every comparison below is local-vs-local. Zero until the relay says.
 */
let clockOffsetMs = 0;

const sane = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Record the relay's clock (`now` on its responses). Ignores anything malformed. */
export function noteServerNow(serverNow: unknown, localNow: number = Date.now()): void {
    if (!sane(serverNow)) return;
    clockOffsetMs = serverNow - localNow;
}

/**
 * Record the relay's `trialEndsAt` (relay clock). Pass the relay's `now` from
 * the same response when there is one, so the offset is current.
 */
export function noteServerTrialEnd(endsAt: unknown, serverNow?: unknown, localNow: number = Date.now()): void {
    noteServerNow(serverNow, localNow);
    if (!sane(endsAt)) return;
    serverTrialEndsAt = endsAt - clockOffsetMs;
}

/** Has the relay said anything about this trial this session? */
export function relayHasSpoken(): boolean {
    return serverTrialEndsAt !== null;
}

/** The relay refused an automatic request with "trial ended": it is over now. */
export function markServerTrialEnded(now: number = Date.now()): void {
    serverTrialEndsAt = Math.min(serverTrialEndsAt ?? now, now);
}

/** The end of the trial on the LOCAL clock: the relay's word when it has given one, else the local start's. */
export function trialEndsAt(localStartedAt: number): number {
    if (serverTrialEndsAt !== null) return serverTrialEndsAt;
    return localStartedAt + TRIAL_MS;
}

/** Automatic (trial) or click-to-translate, for a FREE install. */
export function freeMode(localStartedAt: number, now: number = Date.now()): FreeMode {
    return now < trialEndsAt(localStartedAt) ? "trial" : "click";
}

/** How long past its local end the trial must be before the local clock alone may say it ended. */
export const LOCAL_END_GRACE_MS = DAY_MS;

/**
 * The end of the trial that is safe to ANNOUNCE, or null. Only an ending the
 * relay stated (its `trialEndsAt` is past, or it refused a batch as "trial
 * ended"). If the relay has never answered this session, the local clock may
 * stand in, but only a full day after its own end: a wrong "your trial
 * ended" is worse than a late one.
 */
export function announceableTrialEnd(localStartedAt: number, now: number = Date.now()): number | null {
    if (serverTrialEndsAt !== null) return now >= serverTrialEndsAt ? serverTrialEndsAt : null;
    const localEnd = localStartedAt + TRIAL_MS;
    return now >= localEnd + LOCAL_END_GRACE_MS ? localEnd : null;
}

/**
 * Is `end` a different ending from the one already announced? Endings are
 * compared loosely (the relay's and the local clock's end of the SAME trial
 * differ by minutes or days); only a new trial ending counts again.
 */
export function isNewEnding(end: number, announced: number): boolean {
    return announced <= 0 || end > announced + TRIAL_MS;
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
 * install, which is told nothing new. After the trial, settings.ts adds an
 * "Upgrade" link after this text (a toast cannot carry one; this can).
 */
export function freePlanLine(isFree: boolean, localStartedAt: number, now: number = Date.now()): string | null {
    if (!isFree) return null;
    if (freeMode(localStartedAt, now) === "trial") {
        const d = trialDaysLeft(localStartedAt, now);
        return `Free trial: ${d} ${d === 1 ? "day" : "days"} left.`;
    }
    return "Free plan: messages translate when you click.";
}

/**
 * Shown once per ending. No URL: toast text is not clickable. The settings
 * line carries the link instead.
 */
export function trialEndedMessage(): string {
    return "Your 7-day free trial ended. Messages now translate when you click. Upgrade to keep it automatic.";
}

/* ------------------------------------------------------------ preview -- */

/** How much of a ✦ preview the relay returns (mirrors relay previewText). */
export const PREVIEW_WORDS = 5;
export const PREVIEW_MAX_CHARS = 32;

/**
 * The first few words of a translation, exactly as the relay cuts a ✦ preview.
 *
 * A MIRROR of the relay's own truncation, used twice. (1) On whatever the relay
 * returns in preview mode: a v0.1.6 relay has already cut it, but an older one
 * ignores `mode` and sends the full ✦ line, so the client cuts again and a
 * preview can never show more than this. (2) On the ≈ line, before comparing:
 * if the two cut the same, the preview would show nothing new, so it is not
 * shown.
 *
 * WHAT THIS DOES NOT PROMISE: the relay cuts only v0.1.6 preview requests. A
 * header-less legacy (v0.1.5) ⚡ press still gets the full ✦ line within the
 * 3-a-day taste allowance, as it always did.
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
    clockOffsetMs = 0;
}
