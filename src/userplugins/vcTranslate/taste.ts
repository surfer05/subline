import * as DataStore from "@api/DataStore";

/**
 * THE INSTALL ID AND TODAY'S ✦ PREVIEWS.
 *
 * Two pieces of state an install needs whatever it owns. WHO is asking: an
 * install id the relay ties purchases, promo codes and the 3-computer limit
 * to (sent as `x-subline-install`, and as the credential when no code is
 * saved). HOW MANY ✦ previews are left today: an Automatic owner gets three a
 * day on rough ≈ lines (see index.tsx requestPreview).
 *
 * Everything here is deliberately free of Discord and of the network, so the
 * count, the day rollover and the wording can be read and tested on their
 * own. index.tsx owns the decisions and native.ts owns the requests. (The
 * module keeps its old name: "taste" was the free tier's three a day.)
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

/**
 * THE INSTALLER'S ID. A fresh install is activated in the installer, before
 * Discord ever runs this code, so the installer generates the id, ties the
 * purchase or promo to it, and seeds it into Vencord's settings as
 * `plugins.VcTranslate.installId`. index.tsx connects that setting here. When it
 * holds a valid id it wins; otherwise the DataStore id (or a fresh one) is
 * used and written back to it, so the two always agree afterwards.
 */
export interface InstallIdSetting {
    read(): unknown;
    write(id: string): void;
}
let installIdSetting: InstallIdSetting | null = null;

export function connectInstallIdSetting(setting: InstallIdSetting | null): void {
    installIdSetting = setting;
}

function settingId(): string | null {
    try {
        const v = installIdSetting?.read();
        return typeof v === "string" && INSTALL_ID_RE.test(v) ? v : null;
    } catch {
        return null;
    }
}

function writeSettingId(id: string): void {
    try {
        if (settingId() !== id) installIdSetting?.write(id);
    } catch { /* the DataStore copy still holds it */ }
}

export async function installIdOnce(): Promise<string> {
    if (installId !== null) return installId;
    if (installIdPending !== null) return installIdPending;

    installIdPending = (async () => {
        const seeded = settingId();
        if (seeded !== null) {
            installId = seeded;
            try {
                if (await DataStore.get<unknown>(INSTALL_ID_KEY) !== seeded) await DataStore.set(INSTALL_ID_KEY, seeded);
            } catch { /* the setting holds it */ }
            return seeded;
        }
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
            writeSettingId(stored);
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
        writeSettingId(fresh);
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

/* ------------------------------------------------ the local second guard -- */

/**
 * THE CLIENT'S OWN COUNT, as a second guard beside the relay's. The relay is
 * the authority, but a relay that counts a free id against something larger
 * than three (an older relay, or one that resolved the id as a trial) must not
 * turn "3 previews a day" into more, and must not leave the label stuck at
 * "3 of 3". So every ✦ the relay actually SERVED under the taste allowance (a
 * preview, or a ⚡ press) is counted here too, per UTC day, and persisted so a
 * restart does not hand out three more. The label and the gate use whichever
 * of the two counts is higher (the fewer left).
 */
export const LOCAL_TASTE_KEY = "VcTranslate_tasteToday";
let localDay: string | null = null;
let localUsed = 0;

function localUsedToday(now: number): number {
    return localDay === utcDay(now) ? localUsed : 0;
}

/** Read the persisted local count. A bad or missing value is a zero. */
export async function loadLocalTasteCount(): Promise<void> {
    try {
        const raw = await DataStore.get<unknown>(LOCAL_TASTE_KEY) as { day?: unknown; used?: unknown } | undefined;
        if (raw && typeof raw.day === "string" && typeof raw.used === "number" && Number.isFinite(raw.used) && raw.used >= 0) {
            localDay = raw.day;
            localUsed = Math.floor(raw.used);
        }
    } catch { /* a zero: the relay still guards */ }
}

/** One ✦ served under the taste allowance (a preview or a ⚡ press). */
export function noteTasteSpent(now: number = Date.now()): void {
    const day = utcDay(now);
    if (localDay !== day) { localDay = day; localUsed = 0; }
    localUsed++;
    void DataStore.set(LOCAL_TASTE_KEY, { day: localDay, used: localUsed }).catch(() => { });
}

export function tasteUsed(now: number = Date.now()): number {
    return Math.max(used ?? 0, localUsedToday(now));
}

export function tasteRemaining(now: number = Date.now()): number {
    return Math.max(0, Math.min(cap, TASTE_CAP) - tasteUsed(now));
}

/**
 * Only a count someone actually stated can close the door: the relay's (see
 * `used`), or this client's own count of what the relay served today.
 */
export function tasteExhausted(now: number = Date.now()): boolean {
    return (used !== null && used >= cap) || localUsedToday(now) >= Math.min(cap, TASTE_CAP);
}

/** "2 of 3 left today" — what the ⚡ button says before it is pressed. */
export function tasteLabel(): string {
    return `${tasteRemaining()} of ${Math.min(cap, TASTE_CAP)} left today`;
}

// v0.1.6 dropped the two taste toasts ("3 of 3 free ✦ used today." and
// "Today's 3 free ✦ are used. Upgrade for more."). The same three a day now
// also pay for the free plan's ✦ previews, and those stop silently when the
// day's three are gone: the ⚡ label already counts down, and a toast on top of
// it was a nag rather than information.

/** Test-only, same shape as cooldownStore's __resetCooldowns. */
export function __resetTaste(): void {
    installId = null;
    installIdPending = null;
    used = null;
    cap = TASTE_CAP;
    readDay = null;
    localDay = null;
    localUsed = 0;
}
