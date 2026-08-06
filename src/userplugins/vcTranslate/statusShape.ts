/**
 * The status beacon's on-disk shape, and the validator that is the ONLY way a
 * value becomes one.
 *
 * WHY THIS FILE EXISTS AT ALL. For a week this plugin was installed, built,
 * pushed and completely inert — it asked for a Gemini model the key had no
 * quota for — while every signal available to the installer said "success":
 * files written, build green, tests passing. Nothing a patcher can observe
 * distinguishes that from a working install, and spec §3b makes it worse: a
 * BetterDiscord install verifies byte-perfect and still loads none of our code.
 * So the installer is given exactly one trustworthy witness — the plugin
 * itself, reporting from inside Discord that it loaded and that a translation
 * reached the screen. This is the format of that report.
 *
 * WHY THE VALIDATOR IS THE ONLY CONSTRUCTOR. Spec §7: "Never message text. This
 * tool reads private messages including DMs. A plaintext log of other people's
 * conversations on disk is a liability the moment a stranger installs this."
 * That cannot be a convention the renderer is trusted to keep — a renderer bug,
 * or a future field added carelessly, would leak DM content to a file any
 * process on the machine can read. So the main-process writer never serialises
 * what it was handed. It passes it through `sanitizeBeacon`, which rebuilds a
 * fresh object out of whitelisted keys whose types are checked, and every
 * free-form-looking string is constrained to a closed vocabulary or a strict
 * pattern:
 *
 *   - `lastError.code`  — one of BEACON_ERROR_CODES. Never an error message.
 *   - `lastEngine`      — an id ENGINE_CAPS already knows.
 *   - timestamps        — exactly `Date#toISOString()`'s output, nothing else.
 *   - `pluginVersion`   — version characters only, 32 max.
 *
 * There is no field a caller can put arbitrary text into, so message content
 * cannot reach the file even if something upstream tries to put it there.
 *
 * Deliberately dependency-free apart from `./types` (itself pure): this module
 * is imported by BOTH the renderer and the Electron main process, and the main
 * process cannot resolve Vencord's `@api/*` aliases.
 */

import { ENGINE_CAPS, type EngineId } from "./types";

/**
 * Bumped only for a change a reader written against the previous version could
 * MISREAD. The installer's reader refuses a format it does not know rather than
 * guessing — an unknown beacon must read as "cannot confirm", never as a
 * confirmation assembled from fields that no longer mean what it thinks.
 */
export const BEACON_FORMAT = 1;

export const BEACON_FILENAME = "status.json";

/** `~/Library/Application Support/Subline` on macOS; `%LOCALAPPDATA%\Subline` on Windows. */
export const PRODUCT_DIR_NAME = "Subline";

/**
 * The mod version the installer reports and the helper compares (spec §6: a
 * Discord frontend change makes the patches stale and only a NEW BUILD fixes
 * it, so "which build is actually running" has to be observable).
 */
export const PLUGIN_VERSION = "0.1.0";

/**
 * Which glyph the reader saw. `approx` is Google's `≈` line — free, instant,
 * per-message, no conversation context. `upgraded` is an LLM's `✦` — batched,
 * context-aware. Both count as working; the split is what lets the installer
 * say "translating, but the ✦ upgrade never arrives", which is precisely the
 * failure that cost this project its week and would otherwise look identical
 * to a healthy install.
 */
export type BeaconTier = "approx" | "upgraded";

/**
 * Engine → tier. Mirrors `ENGINE_PROVENANCE`'s glyphs in index.tsx and
 * `ENGINE_RANK` in upgrade.ts, and is pinned against ENGINE_RANK by a test —
 * pinned rather than imported, because this module is bundled into the main
 * process and upgrade.ts drags a (type-only, but fragile) edge to store.ts,
 * which imports Vencord aliases the main process cannot resolve.
 */
const TIER_BY_ENGINE: Record<EngineId, BeaconTier> = {
    google: "approx",
    claude: "upgraded",
    gemini: "upgraded"
};

export function tierForEngine(engine: EngineId): BeaconTier {
    return TIER_BY_ENGINE[engine];
}

/**
 * The complete vocabulary of things the beacon may say went wrong.
 *
 * A CLOSED LIST, not a message string, and that is the whole point: an engine's
 * error text is remote input that has already been observed to carry a model
 * name, and there is no rule that stops a future engine (or a dependency)
 * putting something worse in it. A code cannot carry a conversation.
 */
export const BEACON_ERROR_CODES = [
    /** 429. The engine is over quota — possibly for a model the key cannot use at all. */
    "rate-limited",
    /** 401/403. The key is wrong; the session has fallen back to Google. */
    "auth-rejected",
    /** The IPC call itself rejected — the native half never answered. */
    "ipc-failed",
    /** Anything else an engine reported. */
    "engine-error"
] as const;

export type BeaconErrorCode = (typeof BEACON_ERROR_CODES)[number];

export interface BeaconError {
    code: BeaconErrorCode;
    at: string;
}

export interface StatusBeacon {
    format: number;
    product: "subline";
    pluginVersion: string;
    /**
     * When `start()` ran. THE staleness anchor: the installer compares this
     * against the moment it launched Discord, and a beacon whose load predates
     * that launch is a previous install's, proving nothing about this one.
     */
    loadedAt: string;
    /** When this file was last written. */
    updatedAt: string;
    /**
     * When an engine result was last committed to the store the subtitle reads
     * from — i.e. a translation was PRODUCED.
     */
    lastTranslationAt: string | null;
    /**
     * When a subtitle was last actually PAINTED by the message accessory.
     *
     * Distinct from `lastTranslationAt` on purpose, and the distinction is
     * spec §6's named failure: after a Discord frontend change "the mod loads
     * and silently renders nothing". That install produces translations and
     * shows none of them — identical to a healthy one on every other signal.
     * Two timestamps make it visible.
     */
    lastRenderedAt: string | null;
    /** The engine that produced the most recent translation. */
    lastEngine: EngineId | null;
    counts: Record<BeaconTier, number>;
    lastError: BeaconError | null;
}

/** Exactly what `new Date().toISOString()` emits, and nothing else. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Version characters only. No spaces, so no sentence can pass. */
const VERSION_STRING = /^[0-9A-Za-z.+-]{1,32}$/;

export function isBeaconTimestamp(value: unknown): value is string {
    return typeof value === "string" && ISO_TIMESTAMP.test(value);
}

function isKnownEngine(value: unknown): value is EngineId {
    return typeof value === "string"
        && Object.prototype.hasOwnProperty.call(ENGINE_CAPS, value);
}

function isErrorCode(value: unknown): value is BeaconErrorCode {
    return typeof value === "string"
        && (BEACON_ERROR_CODES as readonly string[]).includes(value);
}

/** A count is a non-negative safe integer or it is not a count. */
function toCount(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function toTimestampOrNull(value: unknown): string | null {
    return isBeaconTimestamp(value) ? value : null;
}

/**
 * Rebuild a beacon out of a caller-supplied value, keeping ONLY what is
 * recognised and well-formed.
 *
 * Rejects (returns null) only when the two load-bearing fields are unusable:
 * without `loadedAt` there is nothing to compare against the install time, so
 * the file could not answer the one question it exists for. Everything else
 * degrades to null/0 rather than failing the whole write — a beacon that says
 * "loaded, nothing else known" is still worth far more than no beacon.
 *
 * Unrecognised keys are not copied. That is what makes the "never message
 * text" guarantee structural instead of aspirational.
 */
export function sanitizeBeacon(value: unknown): StatusBeacon | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;

    if (raw.product !== "subline") return null;
    if (!isBeaconTimestamp(raw.loadedAt)) return null;

    const rawCounts = (
        raw.counts !== null && typeof raw.counts === "object" && !Array.isArray(raw.counts)
            ? raw.counts
            : {}
    ) as Record<string, unknown>;

    const rawError = (
        raw.lastError !== null && typeof raw.lastError === "object" && !Array.isArray(raw.lastError)
            ? raw.lastError
            : null
    ) as Record<string, unknown> | null;

    const lastError: BeaconError | null =
        rawError !== null && isErrorCode(rawError.code) && isBeaconTimestamp(rawError.at)
            ? { code: rawError.code, at: rawError.at }
            : null;

    return {
        // Never echoed from the input: the writer states its own format, so a
        // caller cannot label an old shape as a new one.
        format: BEACON_FORMAT,
        product: "subline",
        pluginVersion:
            typeof raw.pluginVersion === "string" && VERSION_STRING.test(raw.pluginVersion)
                ? raw.pluginVersion
                : "unknown",
        loadedAt: raw.loadedAt,
        // An absent/malformed updatedAt would make every beacon look freshly
        // written; falling back to loadedAt is the conservative direction.
        updatedAt: toTimestampOrNull(raw.updatedAt) ?? raw.loadedAt,
        lastTranslationAt: toTimestampOrNull(raw.lastTranslationAt),
        lastRenderedAt: toTimestampOrNull(raw.lastRenderedAt),
        lastEngine: isKnownEngine(raw.lastEngine) ? raw.lastEngine : null,
        counts: {
            approx: toCount(rawCounts.approx),
            upgraded: toCount(rawCounts.upgraded)
        },
        lastError
    };
}
