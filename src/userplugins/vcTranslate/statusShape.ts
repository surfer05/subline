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
 *   - `buildId`         — lowercase hex only. A digest, so it cannot be a
 *                         sentence even in principle.
 *
 * There is no field a caller can put arbitrary text into, so message content
 * cannot reach the file even if something upstream tries to put it there.
 *
 * Deliberately dependency-free apart from `./types` and the generated
 * `./buildStamp` (both pure): this module is imported by BOTH the renderer and
 * the Electron main process, and the main process cannot resolve Vencord's
 * `@api/*` aliases.
 */

import { BUILD_ID, PLUGIN_VERSION } from "./buildStamp";
import { ENGINE_CAPS, type EngineId } from "./types";

/**
 * Bumped only for a change a reader written against the previous version could
 * MISREAD. The installer's reader refuses a format it does not know rather than
 * guessing — an unknown beacon must read as "cannot confirm", never as a
 * confirmation assembled from fields that no longer mean what it thinks.
 *
 * 2 — `buildId` added. A format-1 reader does not know the field exists, so it
 * would read a beacon written by SOMEONE ELSE'S build of this plugin as a
 * confirmation of ours: exactly the hole `buildId` was added to close. Bumping
 * turns that misread into "unsupported format", i.e. "cannot confirm", which is
 * the only safe way for an old reader to meet a new beacon.
 */
export const BEACON_FORMAT = 2;

export const BEACON_FILENAME = "status.json";

/** `~/Library/Application Support/Subline` on macOS; `%LOCALAPPDATA%\Subline` on Windows. */
export const PRODUCT_DIR_NAME = "Subline";

/**
 * The build identity and version, from the generated stamp (`pnpm stamp`) —
 * NOT hand-maintained constants.
 *
 * `PLUGIN_VERSION` is spec §6's "which build is actually running": a Discord
 * frontend change makes the patches stale and only a NEW BUILD fixes it, so a
 * version nobody remembers to bump answers that question wrongly. `BUILD_ID` is
 * a digest of the plugin's own sources, which is what lets the installer tell
 * "a vcTranslate is running" apart from "the vcTranslate we installed is
 * running". See scripts/stampBuild.mjs.
 */
export { BUILD_ID, PLUGIN_VERSION };

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
    gemini: "upgraded",
    groq: "upgraded"
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
    /** 401. The key itself was rejected; the session has fallen back to Google. */
    "auth-rejected",
    /**
     * 403. The request never got as far as the key — the network, region or ISP
     * is blocked. Separate from auth-rejected because the remedy is the
     * opposite: nothing is wrong with the key, and telling someone to fix one
     * that works sends them to replace a perfectly good credential. Observed
     * live: Groq answered 403 to an UNAUTHENTICATED request from the same
     * machine, which is proof the key was never consulted.
     */
    "access-blocked",
    /** The IPC call itself rejected — the native half never answered. */
    "ipc-failed",
    /** Anything else an engine reported. */
    "engine-error"
] as const;

export type BeaconErrorCode = (typeof BEACON_ERROR_CODES)[number];

export interface BeaconError {
    code: BeaconErrorCode;
    at: string;
    /**
     * The HTTP status, when the failure had one.
     *
     * A NUMBER, deliberately — the provider's error prose is remote text and
     * this file's whole rule is that a beacon cannot carry a conversation. But
     * "engine-error" alone sent us round a loop: the request worked from curl
     * and failed in the plugin, and the code said only that it was not 401, 403
     * or 429. A status separates a 400 we are sending wrongly from a 500 at the
     * other end, which are opposite problems.
     */
    status?: number;
}

export interface StatusBeacon {
    format: number;
    product: "subline";
    pluginVersion: string;
    /**
     * WHICH BUILD reported in — the identity that travels with the bundle.
     *
     * `pluginVersion` cannot do this job: two different builds can both call
     * themselves "0.1.0", and Vencord's own copy of a plugin like this one would
     * happily claim any version it liked. `BUILD_ID` is a digest of the shipped
     * sources (scripts/stampBuild.mjs), so it is different for every build that
     * differs at all, and the installer records the one it expects in
     * `subline-patch.json` when it patches (spec §3c).
     *
     * That is what closes the hole this beacon otherwise leaves open: a machine
     * that ALREADY had Vencord running a copy of this plugin would write a
     * perfectly healthy beacon while our patch sat inert, and the installer
     * would read it and report success for an install that does nothing.
     *
     * Nullable because the reader must be able to tell "a build that carries no
     * identity" apart from "a build that carries a different one" — and treat
     * both as "not confirmed" rather than guessing at either.
     *
     * Deliberately NOT derived from anything about the surrounding Discord
     * install: the renderer has no reliable way to learn which app.asar loaded
     * it, and a value it had to infer would be a value it could infer wrongly.
     */
    buildId: string | null;
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

/**
 * A build id is a truncated hex digest and nothing else.
 *
 * The bound is a range rather than the exact 16 the stamper emits so a future
 * change of digest length is not a format change; the alphabet is what matters.
 * Lowercase hex has no spaces, no punctuation and no letters past `f`, so this
 * field cannot carry a word, let alone a message — which is the property every
 * string in this file has to have (see the header).
 */
const BUILD_ID_PATTERN = /^[0-9a-f]{8,64}$/;

export function isBeaconTimestamp(value: unknown): value is string {
    return typeof value === "string" && ISO_TIMESTAMP.test(value);
}

export function isBuildId(value: unknown): value is string {
    return typeof value === "string" && BUILD_ID_PATTERN.test(value);
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
            ? {
                code: rawError.code,
                at: rawError.at,
                // A plausible HTTP status and nothing else. Bounded so a
                // hostile or buggy value cannot smuggle anything through the
                // one field on this object that is not a closed vocabulary.
                ...(typeof rawError.status === "number"
                    && Number.isInteger(rawError.status)
                    && rawError.status >= 100
                    && rawError.status <= 599
                    ? { status: rawError.status }
                    : {})
            }
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
        // Null, never a placeholder string: "no identity" and "some identity"
        // must stay distinguishable, because the installer refuses both — but
        // for different reasons and with different advice.
        buildId: isBuildId(raw.buildId) ? raw.buildId : null,
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
