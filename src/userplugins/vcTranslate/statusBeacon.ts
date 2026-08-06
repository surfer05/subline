/**
 * The renderer half of the status beacon: what actually happened this session,
 * coalesced into an occasional write through the main process.
 *
 * WHAT THIS IS FOR. Spec §7: "Do not declare success on 'the file was
 * written'." The installer can see that it patched `app.asar`; it cannot see
 * whether Discord then loaded our code, and spec §3b shows a BetterDiscord
 * install where the patch verifies byte-perfect and none of it runs. Only the
 * plugin can answer that, and only from inside the renderer. Everything this
 * module records is a fact the installer has no other way to learn.
 *
 * THE HOT PATH RULE. Every function here is called from translation code — one
 * per stored result, one per rendered subtitle. So:
 *
 *   - Recording is assignment and arithmetic on module state. No IO.
 *   - Writes are COALESCED behind `MIN_WRITE_INTERVAL_MS`. A 25-message batch
 *     lands 25 results in one tick and produces ONE write; a channel of live
 *     chat produces at most one write per interval, whatever the traffic.
 *   - Nothing here throws. `Native.reportStatus` is invoked inside try/catch
 *     and its promise is caught: an absent native half (an old build, a
 *     partially loaded plugin), a full disk, a revoked permission — all of them
 *     log once and are ignored. If the beacon breaks, translation continues
 *     exactly as if this file did not exist.
 *
 * WHAT IT NEVER RECORDS. Message text, ids, authors, channels, languages —
 * nothing that describes a conversation. Counts, timestamps, an engine id and
 * an error CODE from a closed list. `statusShape.ts`'s `sanitizeBeacon` then
 * enforces that again on the writing side, so this module's discipline is a
 * second line rather than the only one.
 */

import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";

import {
    BEACON_FORMAT, PLUGIN_VERSION, tierForEngine,
    type BeaconErrorCode, type BeaconTier, type StatusBeacon
} from "./statusShape";
import type { EngineId } from "./types";

const Native = VencordNative.pluginHelpers.VcTranslate as PluginNative<typeof import("./native")>;
const logger = new Logger("VcTranslate");

/**
 * The floor between two writes.
 *
 * 5s is chosen against what the installer needs, not against what is cheap: it
 * polls after launching Discord and waits far longer than this, so a five
 * second lag costs the user nothing, while a per-result write would put a
 * synchronous main-process file write behind every one of the 25 results in a
 * quality batch.
 *
 * The plugin-load write deliberately IGNORES this floor — that one is the
 * signal the installer is actively waiting for, and delaying it by five seconds
 * would only make an install look dead for five extra seconds.
 */
export const MIN_WRITE_INTERVAL_MS = 5_000;

/**
 * Session state. Reset by `resetStatusBeacon()` on stop(), because the beacon
 * describes ONE launch: that is what makes `loadedAt` a staleness anchor the
 * installer can compare its own launch time against. Carrying counts across a
 * stop/start would let a previous session's success vouch for this one.
 */
let loadedAt: string | null = null;
let lastTranslationAt: string | null = null;
let lastRenderedAt: string | null = null;
let lastEngine: EngineId | null = null;
let counts: Record<BeaconTier, number> = { approx: 0, upgraded: 0 };
let lastError: { code: BeaconErrorCode; at: string } | null = null;

let lastWriteAt = 0;
let pendingWrite: ReturnType<typeof setTimeout> | null = null;
/** One log line per session for a broken beacon, not one per write. */
let announcedWriteFailure = false;

function nowIso(): string {
    return new Date().toISOString();
}

function snapshot(): StatusBeacon | null {
    if (loadedAt === null) return null;
    return {
        format: BEACON_FORMAT,
        product: "subline",
        pluginVersion: PLUGIN_VERSION,
        loadedAt,
        updatedAt: nowIso(),
        lastTranslationAt,
        lastRenderedAt,
        lastEngine,
        counts: { ...counts },
        lastError: lastError === null ? null : { ...lastError }
    };
}

function noteWriteFailure(reason: unknown): void {
    if (announcedWriteFailure) return;
    announcedWriteFailure = true;
    // warn, not error, and once: a beacon that cannot be written costs the
    // INSTALLER its confirmation, not the reader their translations, and the
    // console belongs to the user.
    logger.warn("Couldn't write the status beacon; diagnostics will be unavailable.", reason);
}

/** Build and send. Never throws, never rejects, never blocks the caller. */
function flush(): void {
    lastWriteAt = Date.now();
    try {
        const beacon = snapshot();
        if (beacon === null) return;
        const sent = Native.reportStatus(JSON.stringify(beacon));
        // `reportStatus` returns a promise across IPC. An unhandled rejection
        // from a fire-and-forget call would surface as a console error the user
        // can do nothing about.
        void Promise.resolve(sent).then(
            wrote => {
                if (!wrote) noteWriteFailure("the native side reported the write did not land");
            },
            reason => noteWriteFailure(reason)
        );
    } catch (err) {
        // Reached when the native half is missing entirely, so `reportStatus`
        // is not a function. Deliberately caught rather than guarded with `?.`:
        // whatever the reason, the answer is the same and translation must not
        // notice.
        noteWriteFailure(err);
    }
}

/**
 * Ask for a write soon. Several calls inside one interval produce exactly one
 * write, carrying whatever state has accumulated by the time it fires.
 */
function scheduleWrite(): void {
    if (loadedAt === null) return;      // nothing worth reporting yet
    if (pendingWrite !== null) return;  // already coalescing into a scheduled write

    const since = Date.now() - lastWriteAt;
    if (since >= MIN_WRITE_INTERVAL_MS) {
        flush();
        return;
    }
    pendingWrite = setTimeout(() => {
        pendingWrite = null;
        flush();
    }, MIN_WRITE_INTERVAL_MS - since);
}

/**
 * "The plugin loaded." The single most important thing the beacon says, and the
 * only write that skips the throttle.
 *
 * Starts a NEW session: counts, errors and timestamps from a previous run are
 * dropped, so a reader comparing `loadedAt` against its own launch time can
 * trust that everything alongside it belongs to the same launch.
 */
export function recordPluginLoaded(): void {
    loadedAt = nowIso();
    lastTranslationAt = null;
    lastRenderedAt = null;
    lastEngine = null;
    counts = { approx: 0, upgraded: 0 };
    lastError = null;
    announcedWriteFailure = false;
    if (pendingWrite !== null) {
        clearTimeout(pendingWrite);
        pendingWrite = null;
    }
    lastWriteAt = 0;
    flush();
}

/**
 * An engine result was committed to the store the subtitle reads from — a
 * translation was PRODUCED.
 *
 * Called from `writeResult()` and only for a real translation that was actually
 * accepted, so an upgrade from `≈` to `✦` counts once for each tier (which is
 * the truth: two translations were produced) and a refused write counts for
 * neither.
 */
export function recordTranslation(engine: EngineId): void {
    const tier = tierForEngine(engine);
    counts[tier] += 1;
    lastEngine = engine;
    lastTranslationAt = nowIso();
    scheduleWrite();
}

/**
 * A subtitle was actually PAINTED — spec §7's step 4, "the strongest available
 * signal", and the only thing this project accepts as proof the install works.
 *
 * Separate from `recordTranslation` because spec §6 names the failure where
 * they diverge: a Discord frontend change leaves the mod loading, translating,
 * and rendering nothing. Producing without rendering is that install, and it is
 * indistinguishable from a healthy one on every other signal.
 *
 * Called from the accessory's render. That is a deliberate exception to "no
 * side effects in render": this assigns a timestamp and nothing else — no React
 * state, no counter — so a double render under StrictMode or a concurrent
 * re-render produces exactly the same beacon as a single one.
 */
export function recordRendered(): void {
    lastRenderedAt = nowIso();
    scheduleWrite();
}

/**
 * Something failed. `code` is from a closed vocabulary (see
 * `BEACON_ERROR_CODES`) — never an engine's error string, which is remote text.
 *
 * Only the LATEST error is kept. The beacon answers "is this install working
 * right now", not "what has ever gone wrong"; spec §7's rotating human-readable
 * log is where a history belongs.
 */
export function recordError(code: BeaconErrorCode): void {
    lastError = { code, at: nowIso() };
    scheduleWrite();
}

/**
 * Drop this session. Called from stop(), so a disabled plugin leaves no armed
 * timer behind and the next start() begins a genuinely new session.
 */
export function resetStatusBeacon(): void {
    if (pendingWrite !== null) {
        clearTimeout(pendingWrite);
        pendingWrite = null;
    }
    loadedAt = null;
    lastTranslationAt = null;
    lastRenderedAt = null;
    lastEngine = null;
    counts = { approx: 0, upgraded: 0 };
    lastError = null;
    lastWriteAt = 0;
    announcedWriteFailure = false;
}

/** Test-only view of what the next write would carry. */
export function __beaconSnapshot(): StatusBeacon | null {
    return snapshot();
}
