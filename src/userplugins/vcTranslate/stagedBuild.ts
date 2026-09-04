/**
 * The build id of the mod bundle STAGED ON DISK — what the background helper
 * has installed, which may be NEWER than the code currently running in this
 * Discord.
 *
 * MAIN PROCESS ONLY, and reached the one way everything else that touches the
 * filesystem is (see native.ts / statusFile.ts): an export of `native.ts`,
 * invoked from the renderer through `VencordNative.pluginHelpers.VcTranslate`.
 *
 * WHY THIS EXISTS. The helper downloads a new release, replaces the bundle
 * under `<productDir>/mod/`, and re-patches Discord's app.asar on its own — but
 * the Discord that is already open keeps the OLD renderer in memory until it is
 * restarted. Its only nudge to restart is an OS notification a user can miss
 * entirely (one did: "i lost subline ... because i didn't know the update
 * happened"). Comparing this staged id against the compiled BUILD_ID is how the
 * running plugin notices the disk is ahead of memory and can say so in Discord.
 *
 * NOTHING HERE THROWS. An unreadable manifest is an honest "nothing new to
 * report", never a new way for the plugin to fail.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { statusDirFor } from "./statusFile";
import { isBuildId } from "./statusShape";

/**
 * The bundle directory and manifest filename the helper writes, restated here
 * because the plugin cannot import installer code. These MUST match the
 * installer's `MOD_DIR_NAME` (installer/src/bundle/layout.ts) and
 * `MOD_MANIFEST_FILENAME` (installer/src/bundle/spec.ts). They are a stable
 * on-disk contract — the path the helper has always staged into.
 */
const MOD_DIR_NAME = "mod";
const MOD_MANIFEST_FILENAME = "subline-mod.json";

/**
 * Pull a valid buildId out of a mod-manifest JSON string, or null.
 *
 * Pure and TOTAL: every malformed input — not JSON, not an object, no buildId,
 * a buildId of the wrong shape — is just null. The shape check is the same
 * `isBuildId` the beacon validates with, so a garbage value on disk
 * can never be mistaken for a real build and trigger a spurious restart prompt.
 */
export function parseStagedBuildId(jsonText: string): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object") return null;
    const id = (parsed as { buildId?: unknown }).buildId;
    return isBuildId(id) ? id : null;
}

export interface StagedBuildOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    /** Bypasses path resolution entirely. Tests only. */
    path?: string;
}

/**
 * Read the staged bundle's build id, or null when it cannot be read (no install
 * directory for this platform, no manifest yet, or a manifest that does not
 * parse). Synchronous like statusFile.ts's writes: the file is tiny and this is
 * called a few times an hour, not on any hot path.
 */
export function readStagedBuildIdSync(options: StagedBuildOptions = {}): string | null {
    const path = options.path ?? manifestPath(options);
    if (path === null) return null;
    try {
        return parseStagedBuildId(readFileSync(path, "utf8"));
    } catch {
        // Missing file / permission / anything else: nothing new to report.
        return null;
    }
}

function manifestPath(options: StagedBuildOptions): string | null {
    const dir = statusDirFor(
        options.platform ?? process.platform,
        options.env,
        options.home ?? homedir()
    );
    return dir === null ? null : join(dir, MOD_DIR_NAME, MOD_MANIFEST_FILENAME);
}
