/**
 * Where the status beacon lives on disk, and how it gets there.
 *
 * MAIN PROCESS ONLY. The renderer cannot write files — the same constraint
 * `native.ts` already exists for — so this module is reached exactly the way
 * network calls already are: an export of `native.ts`, invoked from the
 * renderer through `VencordNative.pluginHelpers.VcTranslate`. No second
 * mechanism is introduced.
 *
 * ATOMIC, because the reader is a separate process that may look at any
 * instant. A truncated `writeFileSync` would hand the installer half a JSON
 * document and, worse, could do so for the beacon that was about to prove the
 * install works. Writing a sibling temp file and renaming means a reader sees
 * either the previous complete beacon or the new one. (The reader tolerates a
 * partial document anyway — a rename is atomic within a filesystem, and this
 * is one guarantee worth holding from both ends.)
 *
 * NOTHING HERE THROWS. This sits on the translation hot path via IPC. Spec §7
 * wants diagnostics, not a new way for translation to fail: every failure is
 * reported as `false` and dropped.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BEACON_FILENAME, PRODUCT_DIR_NAME, sanitizeBeacon, type StatusBeacon } from "./statusShape";

/**
 * Per-platform data directory, as a TABLE rather than an if/else chain.
 *
 * macOS is what ships first (spec §11). Windows is spec §5 and is already
 * written here, because the point of a table is that the second platform is a
 * row and not a redesign — `%LOCALAPPDATA%\Subline\` is where spec §5 puts our
 * logs, and it needs no UAC. A platform with no row (or a Windows box with no
 * LOCALAPPDATA) yields null, and a null path means the beacon is silently not
 * written: no beacon is an honest "cannot confirm", which is exactly the
 * result the reader is built to return.
 */
const DATA_DIR_BY_PLATFORM: Partial<
    Record<NodeJS.Platform, (env: NodeJS.ProcessEnv, home: string) => string | null>
> = {
    darwin: (_env, home) => join(home, "Library", "Application Support", PRODUCT_DIR_NAME),
    win32: env => (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, PRODUCT_DIR_NAME) : null)
};

export function statusDirFor(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): string | null {
    return DATA_DIR_BY_PLATFORM[platform]?.(env, home) ?? null;
}

export function statusPathFor(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): string | null {
    const dir = statusDirFor(platform, env, home);
    return dir === null ? null : join(dir, BEACON_FILENAME);
}

/**
 * Write one beacon to `path`, atomically. Returns whether it landed.
 *
 * The temp file carries the pid so two Discord branches (or a stale process)
 * cannot half-overwrite each other's temp copy and then rename the mixture
 * into place.
 */
export function writeStatusFile(path: string, beacon: StatusBeacon): boolean {
    const temp = `${path}.${process.pid}.tmp`;
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temp, `${JSON.stringify(beacon, null, 4)}\n`, "utf8");
        renameSync(temp, path);
        return true;
    } catch {
        // Best effort by design — see this file's header. Clean up the temp so
        // a failing write does not leave a growing pile of them next to the
        // beacon the installer reads.
        try {
            rmSync(temp, { force: true });
        } catch {
            // Nothing left to try, and nothing that may be thrown.
        }
        return false;
    }
}

export interface WriteBeaconOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    /** Bypasses path resolution entirely. Tests only. */
    path?: string;
}

/**
 * The whole main-process side of the beacon: parse what the renderer sent,
 * strip it back to the known shape (see `sanitizeBeacon` — this is where the
 * "never message text" guarantee is enforced, on the writing side, so no
 * renderer mistake can defeat it), resolve the path, write.
 *
 * `raw` is a JSON string for the same reason `translateBatch`'s request is: it
 * crosses IPC, and one serialisation boundary is easier to reason about than a
 * structured-clone of whatever the renderer happened to build.
 */
export function writeStatusBeacon(raw: unknown, options: WriteBeaconOptions = {}): boolean {
    let parsed: unknown;
    if (typeof raw === "string") {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return false;
        }
    } else {
        parsed = raw;
    }

    const beacon = sanitizeBeacon(parsed);
    if (beacon === null) return false;

    const path = options.path
        ?? statusPathFor(options.platform ?? process.platform, options.env, options.home);
    if (path === null) return false;

    return writeStatusFile(path, beacon);
}
