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

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Result } from "./result.js";
import { err, fsError, ok } from "./result.js";

export const MARKER_FILENAME = "subline-patch.json";
export const MARKER_FORMAT = 1;

export interface PatchMarker {
    format: number;
    product: "subline";
    /** Version of the installer that wrote the patch. */
    productVersion: string;
    /** The absolute path the stub `require()`s. Cross-checked against the stub itself. */
    loaderPath: string;
    /** Discord's version at patch time — the helper compares this to notice updates. */
    discordVersion: string | null;
    /** Where the untouched original was preserved. */
    backupPath: string;
    patchedAt: string;
}

export function markerPathFor(resourcesPath: string): string {
    return join(resourcesPath, MARKER_FILENAME);
}

export function readMarker(resourcesPath: string): Result<PatchMarker | null> {
    const path = markerPathFor(resourcesPath);
    if (!existsSync(path)) return ok(null);

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
        discordVersion: typeof candidate.discordVersion === "string" ? candidate.discordVersion : null,
        backupPath: typeof candidate.backupPath === "string" ? candidate.backupPath : "",
        patchedAt: typeof candidate.patchedAt === "string" ? candidate.patchedAt : ""
    });
}

export function writeMarker(resourcesPath: string, marker: PatchMarker): Result<string> {
    const path = markerPathFor(resourcesPath);
    try {
        writeFileSync(path, `${JSON.stringify(marker, null, 4)}\n`, "utf8");
        return ok(path);
    } catch (cause) {
        return fsError<string>(cause, path, `write ${MARKER_FILENAME}`);
    }
}

export function removeMarker(resourcesPath: string): Result<boolean> {
    const path = markerPathFor(resourcesPath);
    if (!existsSync(path)) return ok(false);
    try {
        unlinkSync(path);
        return ok(true);
    } catch (cause) {
        return fsError<boolean>(cause, path, `remove ${MARKER_FILENAME}`);
    }
}
