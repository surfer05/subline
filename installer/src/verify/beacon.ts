/**
 * Reading the plugin's status beacon.
 *
 * THE CONTRACT IS DUPLICATED HERE ON PURPOSE. The plugin defines the same shape
 * in `src/userplugins/vcTranslate/statusShape.ts`, and this module deliberately
 * does not import it. Two reasons, both load-bearing:
 *
 *  1. The beacon is a FILE, written by a different process, possibly by an
 *     OLDER build than the installer reading it (spec §6: the helper
 *     self-updates, so the two versions drift by design). A reader that assumed
 *     the current in-repo shape would be assuming something it cannot know.
 *  2. It is untrusted input. Anything on disk under a user-writable directory
 *     can be edited, truncated, or replaced, so it is validated here rather
 *     than deserialised.
 *
 * The drift that duplication risks is a FALSE NEGATIVE — a beacon this reader
 * fails to recognise reads as "cannot confirm", never as a confirmation. That
 * is the safe direction, and it is the direction spec §7 asks for: "A false
 * success is worse than a clear 'installed, but we could not confirm it is
 * working'."
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Result } from "../patcher/result.js";
import { err, fsError, ok } from "../patcher/result.js";

export const BEACON_FILENAME = "status.json";
export const PRODUCT_DIR_NAME = "Subline";

/**
 * The format this reader understands. A beacon claiming any other is refused.
 *
 * MUST BE BUMPED IN LOCKSTEP with `BEACON_FORMAT` in the plugin's
 * `statusShape.ts` (they are duplicated on purpose — see the header). Format 2
 * added `buildId`, without which this reader cannot tell our build's beacon from
 * a pre-existing vcTranslate's, so a format-1 document is refused rather than
 * read with the identity check quietly skipped.
 */
export const SUPPORTED_BEACON_FORMAT = 2;

export type BeaconTier = "approx" | "upgraded";

export const BEACON_ERROR_CODES = [
    "rate-limited",
    "auth-rejected",
    "ipc-failed",
    "engine-error"
] as const;

export type BeaconErrorCode = (typeof BEACON_ERROR_CODES)[number];

export interface BeaconError {
    code: BeaconErrorCode;
    at: number;
}

/**
 * A validated beacon. Timestamps are epoch milliseconds here, not the ISO
 * strings on disk: every question this file exists to answer is a comparison
 * against the moment we patched or launched, and parsing once at the boundary
 * means the rest of the installer cannot compare a string by accident.
 */
export interface Beacon {
    format: number;
    pluginVersion: string;
    /**
     * WHICH BUILD wrote this — a digest stamped into the plugin's own bundle.
     *
     * `null` when the document carries no usable one. That is kept distinct from
     * "carries a different one" all the way to `verifyOnce`, because they are
     * different situations with different advice, and because collapsing them
     * here would be this reader guessing — which it never does.
     */
    buildId: string | null;
    loadedAt: number;
    updatedAt: number;
    lastTranslationAt: number | null;
    lastRenderedAt: number | null;
    lastEngine: string | null;
    counts: Record<BeaconTier, number>;
    lastError: BeaconError | null;
    /** The raw file, for the diagnostics bundle. Never re-interpreted. */
    path: string;
}

/**
 * Where the plugin writes it. Mirrors the plugin's own per-platform table, and
 * is a table here for the same reason — Windows (spec §5) is a row, not a
 * redesign.
 */
const DIR_BY_PLATFORM: Partial<
    Record<NodeJS.Platform, (env: NodeJS.ProcessEnv, home: string) => string | null>
> = {
    darwin: (_env, home) => join(home, "Library", "Application Support", PRODUCT_DIR_NAME),
    win32: env => (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, PRODUCT_DIR_NAME) : null)
};

export function beaconDirFor(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): string | null {
    return DIR_BY_PLATFORM[platform]?.(env, home) ?? null;
}

export function beaconPathFor(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): string | null {
    const dir = beaconDirFor(platform, env, home);
    return dir === null ? null : join(dir, BEACON_FILENAME);
}

/** Exactly `Date#toISOString()`'s output. Anything looser is not a timestamp. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function toEpoch(value: unknown): number | null {
    if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

function toCount(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isErrorCode(value: unknown): value is BeaconErrorCode {
    return typeof value === "string" && (BEACON_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * A build id is a hex digest. Mirrors the plugin's `BUILD_ID_PATTERN`.
 *
 * Enforced on the reading side too, not merely trusted: this file is untrusted
 * input from a user-writable directory, and an unconstrained string here would
 * be a free-text field in a document that is explicitly not allowed to have one
 * (spec §7 — this tool reads DMs, and the beacon is world-readable).
 */
const BUILD_ID_PATTERN = /^[0-9a-f]{8,64}$/;

export function toBuildId(value: unknown): string | null {
    return typeof value === "string" && BUILD_ID_PATTERN.test(value) ? value : null;
}

/**
 * Validate a parsed document into a `Beacon`, or explain why not.
 *
 * `loadedAt` is the only field whose absence is fatal, because it is the one
 * the staleness comparison needs: without it there is no way to tell this
 * install's beacon from one written last week, and a beacon that cannot be
 * dated is worth strictly less than no beacon at all.
 */
export function validateBeacon(parsed: unknown, path: string): Result<Beacon> {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return err<Beacon>("BEACON_MALFORMED", "The status file is not a JSON object.", { path });
    }
    const raw = parsed as Record<string, unknown>;

    if (raw.product !== "subline") {
        return err<Beacon>("BEACON_MALFORMED", "The status file was not written by Subline.", { path });
    }

    if (raw.format !== SUPPORTED_BEACON_FORMAT) {
        // Refused rather than best-guessed. A beacon from a newer plugin may
        // have redefined a field this reader would otherwise read as a
        // confirmation.
        return err<Beacon>(
            "BEACON_FORMAT_UNSUPPORTED",
            `The status file is format ${String(raw.format)}, and this installer understands ${SUPPORTED_BEACON_FORMAT}.`,
            { path }
        );
    }

    const loadedAt = toEpoch(raw.loadedAt);
    if (loadedAt === null) {
        // The commonest way to land here is a PARTIALLY WRITTEN file: the
        // plugin writes atomically, but a hand-edited or truncated copy still
        // parses as JSON while missing exactly this.
        return err<Beacon>(
            "BEACON_MALFORMED",
            "The status file has no usable load timestamp, so it cannot be matched to this installation.",
            { path }
        );
    }

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

    const errorAt = rawError === null ? null : toEpoch(rawError.at);
    const lastError: BeaconError | null =
        rawError !== null && isErrorCode(rawError.code) && errorAt !== null
            ? { code: rawError.code, at: errorAt }
            : null;

    return ok({
        format: SUPPORTED_BEACON_FORMAT,
        pluginVersion: typeof raw.pluginVersion === "string" ? raw.pluginVersion : "unknown",
        // NOT fatal, and deliberately so: a beacon with no identity is still
        // evidence that SOMETHING loaded, which the diagnostics screen wants to
        // say out loud. It simply is not evidence that OUR build loaded, and
        // `verifyOnce` is where that costs the confirmation.
        buildId: toBuildId(raw.buildId),
        loadedAt,
        // A missing updatedAt must not read as "written just now" — fall back
        // to the load, which is the older and therefore safer of the two.
        updatedAt: toEpoch(raw.updatedAt) ?? loadedAt,
        lastTranslationAt: toEpoch(raw.lastTranslationAt),
        lastRenderedAt: toEpoch(raw.lastRenderedAt),
        lastEngine: typeof raw.lastEngine === "string" ? raw.lastEngine : null,
        counts: {
            approx: toCount(rawCounts.approx),
            upgraded: toCount(rawCounts.upgraded)
        },
        lastError,
        path
    });
}

/**
 * Read the beacon at `path`.
 *
 * `ok(null)` means "there is no beacon", which is an ordinary, expected state
 * (nothing has launched yet) and not a failure. Everything else that goes wrong
 * comes back as a named error, because the GUI says something different for
 * each: a missing file is "waiting", an unreadable one is "something is wrong
 * with the install".
 */
export function readBeaconAt(path: string): Result<Beacon | null> {
    if (!existsSync(path)) return ok(null);

    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (cause) {
        return fsError<Beacon | null>(cause, path, `read ${BEACON_FILENAME}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        // The case this exists for: we may read WHILE the plugin writes. The
        // plugin renames into place so this should not happen, but a reader
        // that only works because of the writer's discipline is one change away
        // from breaking, and "half a file" must never crash an installer.
        return err<Beacon | null>(
            "BEACON_MALFORMED",
            "The status file could not be read as JSON — it may have been caught mid-write.",
            { path, cause }
        );
    }

    const validated = validateBeacon(parsed, path);
    return validated.ok ? ok(validated.value) : (validated as Result<Beacon | null>);
}

/** Read the beacon from the platform's standard location. */
export function readBeacon(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): Result<Beacon | null> {
    const path = beaconPathFor(platform, env, home);
    // No known location on this platform is indistinguishable, from here, from
    // a beacon that was never written — and it is treated as such rather than
    // as an error, because that is exactly what it means: nothing has reported.
    if (path === null) return ok(null);
    return readBeaconAt(path);
}
