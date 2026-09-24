import * as DataStore from "@api/DataStore";

/**
 * THE TASTE TIER — three ✦ translations a day for an install with no code.
 *
 * A free install translates with Google (≈) and has no quality tier at all:
 * the ⚡ button was hidden, so the only way to find out what ✦ reads like was
 * to buy it. Three deliberate presses a day is the answer — never automatic,
 * never a batch, only a message the reader chose. This module owns the two
 * pieces of state that makes possible: WHO is asking (an install id the relay
 * counts against) and HOW MANY are left today.
 *
 * Everything here is deliberately free of Discord, of settings and of the
 * network, so the funnel's arithmetic — the count, the day rollover, the
 * wording — can be read and tested on its own. index.tsx owns the decisions
 * (is this a free install? was this press allowed?) and native.ts owns the
 * requests.
 */

/**
 * Where the install id lives. A plain DataStore key rather than a setting:
 * a setting is user-editable, exportable and visible in the settings UI, and
 * this is none of those things — it identifies nothing, it is never shown, and
 * a user editing it could only ever break their own count.
 */
export const INSTALL_ID_KEY = "VcTranslate_installId";

/** The day's allowance, until a relay response says otherwise. */
export const TASTE_CAP = 3;

/** Where the nudge sends somebody who wants more than three. */
export const TASTE_UPGRADE_URL = "https://surfer05.github.io/subline/#pricing";

/* ------------------------------------------------------------ install id -- */

/**
 * 32 lowercase hex characters, generated once and reused forever.
 *
 * WHY IT EXISTS: the relay has to count three presses a day against SOMETHING,
 * and a free install has no code. This is the smallest thing that can serve as
 * that something — 16 random bytes, tied to no account, no machine identifier
 * and no message content, generated locally and never shown to the user or
 * written to a log.
 *
 * Memoised on the PROMISE, not on the value: two ⚡ presses in the same tick
 * would otherwise both miss the cache, both generate an id, and both write —
 * leaving the two requests counted against two different install ids and the
 * user with six tastes instead of three.
 */
let installId: string | null = null;
let installIdPending: Promise<string> | null = null;

/** Shaped exactly as the relay's bearer requires, so a bad id cannot be reused. */
const INSTALL_ID_RE = /^[0-9a-f]{32}$/;

function newInstallId(): string {
    const bytes = new Uint8Array(16);
    // crypto.getRandomValues, not Math.random: this is the only thing standing
    // between one install and another install's count. Reached through
    // globalThis because this project's tsconfig has no DOM lib (the plugin
    // targets ES2020 + Vencord's own ambient types), and `crypto` is a global
    // in both the renderer and the Node process the tests run in.
    (globalThis as any).crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export async function installIdOnce(): Promise<string> {
    if (installId !== null) return installId;
    if (installIdPending !== null) return installIdPending;

    installIdPending = (async () => {
        let stored: unknown;
        try {
            stored = await DataStore.get<unknown>(INSTALL_ID_KEY);
        } catch {
            // A failed read degrades to a fresh id for this session rather
            // than to a broken ⚡ button. The worst case is one install being
            // counted twice, which costs the relay three requests.
            stored = undefined;
        }
        // Re-validated rather than trusted: anything that is not the shape the
        // relay's bearer requires would be rejected on every press forever,
        // with no way for the user to clear it.
        if (typeof stored === "string" && INSTALL_ID_RE.test(stored)) {
            installId = stored;
            return stored;
        }
        const fresh = newInstallId();
        try {
            await DataStore.set(INSTALL_ID_KEY, fresh);
        } catch {
            // Same reasoning: an id that could not be persisted still works
            // for this session; the next launch simply generates another.
        }
        installId = fresh;
        return fresh;
    })();

    return installIdPending;
}

/** The Authorization bearer for a taste request. */
export function tasteBearer(id: string): string {
    return `free_${id}`;
}

/* ---------------------------------------------------------- daily count -- */

/**
 * How many of today's three are spent, as the RELAY last stated it — never a
 * local tally.
 *
 * `null` means "not known yet": no press has been made and /v1/status has not
 * answered. Unknown is deliberately NOT treated as exhausted; the relay is the
 * authority on the count, and guessing "none left" from silence would take
 * away the three tastes this whole tier exists to give.
 */
let used: number | null = null;
let cap = TASTE_CAP;

/**
 * The UTC date the count above was read on, as "YYYY-MM-DD".
 *
 * The relay's day rolls at UTC midnight, so a count read yesterday says
 * nothing about today — and a user who spent their three in the evening must
 * not find the button dead the next morning. Comparing dates (rather than
 * running a timer) means the rollover is noticed by whatever reads the count
 * next, at any point, with nothing to arm or cancel.
 */
let readDay: string | null = null;

function utcDay(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

/** Record what the relay said. Ignores anything malformed rather than showing it. */
export function recordTasteQuota(u: unknown, c: unknown, now: number = Date.now()): void {
    if (typeof u !== "number" || !Number.isFinite(u) || u < 0) return;
    used = Math.floor(u);
    if (typeof c === "number" && Number.isFinite(c) && c > 0) cap = Math.floor(c);
    readDay = utcDay(now);
}

/**
 * The relay refused a press with "daily limit reached". That IS the count,
 * stated as plainly as it can be, so record it as such — otherwise the next
 * press would be sent too, and refused too.
 */
export function markTasteExhausted(now: number = Date.now()): void {
    used = cap;
    readDay = utcDay(now);
}

/**
 * Has the UTC day turned over since the count was read? If so the count is
 * dropped and this returns true, which is the caller's cue to re-read it from
 * /v1/status.
 */
export function rolloverTasteIfNewUtcDay(now: number = Date.now()): boolean {
    if (readDay === null) return false;
    if (readDay === utcDay(now)) return false;
    used = null;
    readDay = null;
    return true;
}

export function tasteCap(): number {
    return cap;
}

export function tasteUsed(): number {
    return used ?? 0;
}

export function tasteRemaining(): number {
    return Math.max(0, cap - tasteUsed());
}

/** Only a count the relay actually stated can close the door. See `used`. */
export function tasteExhausted(): boolean {
    return used !== null && used >= cap;
}

/** "2 of 3 left today" — what the ⚡ button says before it is pressed. */
export function tasteLabel(): string {
    return `${tasteRemaining()} of ${cap} left today`;
}

/** "3 of 3 free ✦ used today." — shown once, right after the last one lands. */
export function tasteUsedUpMessage(): string {
    return `${cap} of ${cap} free ✦ used today.`;
}

/**
 * The nudge, for a press with nothing left. Neutral, never red: nothing is
 * broken, ≈ is still translating every message, and this is the one moment the
 * reader has just been shown what ✦ reads like.
 */
export function tasteLimitMessage(): string {
    // Never "unlimited": a paid code has a daily fair-use cap too.
    return `Today's ${cap} free ✦ are used. Upgrade for more. ${TASTE_UPGRADE_URL}`;
}

/** Test-only, same shape as cooldownStore's __resetCooldowns. */
export function __resetTaste(): void {
    installId = null;
    installIdPending = null;
    used = null;
    cap = TASTE_CAP;
    readDay = null;
}
