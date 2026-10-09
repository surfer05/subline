/**
 * Our ownership marker.
 *
 * Why a sidecar file rather than a comment inside the stub: the stub must stay
 * a bare `require()` (see stub.ts), and path-sniffing alone cannot answer "did
 * *we* write this?" — we bundle Vencord, so a require path containing
 * "Vencord" proves nothing about who put it there. The marker is the only
 * positive proof of ownership, and it doubles as the record the helper reads
 * to notice a Discord update (spec §6).
 *
 * It lives beside `app.asar` so it is removed by the same uninstall that
 * restores the backup, and so a Discord update that replaces the whole
 * Resources directory takes it with the patch (leaving a consistent
 * "unpatched" state rather than a marker pointing at nothing).
 */

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "./realFs.js";
import { join } from "node:path";

import { renameRetrying, unlinkRetrying, type RetryHooks } from "./retry.js";

import type { Result } from "./result.js";
import { err, fsError, ok } from "./result.js";

export const MARKER_FILENAME = "subline-patch.json";

/** 2 — `pluginBuildId` added, so the marker can also answer "which build". */
export const MARKER_FORMAT = 2;

/** A build id is a hex digest (see the plugin's buildStamp.ts). */
const BUILD_ID_PATTERN = /^[0-9a-f]{8,64}$/;

export interface PatchMarker {
    format: number;
    product: "subline";
    /** Version of the installer that wrote the patch. */
    productVersion: string;
    /** The absolute path the stub `require()`s. Cross-checked against the stub itself. */
    loaderPath: string;
    /**
     * WHICH BUILD of the plugin this patch installed — the value the running
     * plugin stamps into its status beacon, recorded here at patch time so
     * verification has something to compare against.
     *
     * `loaderPath` cannot serve: we bundle Vencord, so a path is
     * indistinguishable from Vencord's own (§3c's whole point), and the same
     * path keeps pointing at a new bundle every time the helper self-updates.
     * The build id changes with the bytes.
     *
     * Nullable because a marker written by an older installer has none, and the
     * reader must not invent one — an absent id means "we cannot say which build
     * this is", which downstream costs a confirmation rather than granting one.
     */
    pluginBuildId: string | null;
    /** Discord's version at patch time — the helper compares this to notice updates. */
    discordVersion: string | null;
    /** Where the untouched original was preserved. */
    backupPath: string;
    patchedAt: string;
}

export function markerPathFor(resourcesPath: string): string {
    return join(resourcesPath, MARKER_FILENAME);
}

/**
 * The largest marker read. A real one is well under 1 KB; anything bigger is
 * not ours, and is never read whole into memory.
 */
export const MAX_MARKER_BYTES = 64 * 1024;

/**
 * Read our marker. ok(null) when there is none; an error when there is a file
 * but it is not a marker of ours (empty, truncated, hand-edited, another
 * product's, wrong types, too big, unreadable).
 *
 * A BAD MARKER IS NOT A BROKEN INSTALL (audit 2026-10-06, missed high item).
 * It proves nothing, either way: inspectInstall then judges ownership by what
 * app.asar is, exactly as with no marker, and every write path replaces it.
 * Callers must never turn this error into "refuse" on its own.
 */
export function readMarker(resourcesPath: string): Result<PatchMarker | null> {
    const path = markerPathFor(resourcesPath);
    if (!existsSync(path)) return ok(null);

    try {
        const size = statSync(path).size;
        if (size > MAX_MARKER_BYTES) {
            return err<PatchMarker | null>("BROKEN_INSTALL", `${MARKER_FILENAME} is ${size} bytes, far too big to be one of ours.`, { path });
        }
    } catch (cause) {
        return fsError<PatchMarker | null>(cause, path, `read ${MARKER_FILENAME}`);
    }

    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (cause) {
        return fsError<PatchMarker | null>(cause, path, `read ${MARKER_FILENAME}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        return err<PatchMarker | null>("BROKEN_INSTALL", `${MARKER_FILENAME} is not readable JSON.`, { path, cause });
    }

    const candidate = parsed as Partial<PatchMarker> | null;
    if (
        typeof candidate !== "object" ||
        candidate === null ||
        candidate.product !== "subline" ||
        typeof candidate.loaderPath !== "string"
    ) {
        return err<PatchMarker | null>("BROKEN_INSTALL", `${MARKER_FILENAME} is not one of ours.`, { path });
    }

    return ok({
        format: typeof candidate.format === "number" ? candidate.format : 0,
        product: "subline",
        productVersion: typeof candidate.productVersion === "string" ? candidate.productVersion : "unknown",
        loaderPath: candidate.loaderPath,
        // Validated, not merely copied: this value is compared against a beacon
        // to decide whether an install is confirmed, and a marker on disk can be
        // edited. A malformed one reads as "no id", never as a wildcard.
        pluginBuildId:
            typeof candidate.pluginBuildId === "string" && BUILD_ID_PATTERN.test(candidate.pluginBuildId)
                ? candidate.pluginBuildId
                : null,
        discordVersion: typeof candidate.discordVersion === "string" ? candidate.discordVersion : null,
        backupPath: typeof candidate.backupPath === "string" ? candidate.backupPath : "",
        patchedAt: typeof candidate.patchedAt === "string" ? candidate.patchedAt : ""
    });
}

/**
 * Staged and renamed, so the marker is the old file or the new one, never a
 * truncated one (a kill mid-write used to leave half a JSON file). The rename
 * also replaces a marker this process cannot read (EACCES): replacing a file
 * needs the folder's permission, not the file's.
 */
export function writeMarker(resourcesPath: string, marker: PatchMarker, hooks: RetryHooks = {}): Result<string> {
    const path = markerPathFor(resourcesPath);
    const temp = `${path}.tmp`;
    try {
        writeFileSync(temp, `${JSON.stringify(marker, null, 4)}\n`, "utf8");
        // Retried on Windows: an antivirus opening the fresh temp file to scan
        // it makes the rename fail for a moment (audit #16, as for the stub).
        renameRetrying(temp, path, hooks);
        return ok(path);
    } catch (cause) {
        try {
            if (existsSync(temp)) unlinkSync(temp);
        } catch {
            // A stranded temp file is harmless: the next write replaces it.
        }
        return fsError<string>(cause, path, `write ${MARKER_FILENAME}`);
    }
}

export function removeMarker(resourcesPath: string, hooks: RetryHooks = {}): Result<boolean> {
    const path = markerPathFor(resourcesPath);
    if (!existsSync(path)) return ok(false);
    try {
        unlinkRetrying(path, hooks);
        return ok(true);
    } catch (cause) {
        return fsError<boolean>(cause, path, `remove ${MARKER_FILENAME}`);
    }
}
