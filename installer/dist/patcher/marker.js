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
import { err, fsError, ok } from "./result.js";
export const MARKER_FILENAME = "subline-patch.json";
/** 2 — `pluginBuildId` added, so the marker can also answer "which build". */
export const MARKER_FORMAT = 2;
/** A build id is a hex digest (see the plugin's buildStamp.ts). */
const BUILD_ID_PATTERN = /^[0-9a-f]{8,64}$/;
export function markerPathFor(resourcesPath) {
    return join(resourcesPath, MARKER_FILENAME);
}
export function readMarker(resourcesPath) {
    const path = markerPathFor(resourcesPath);
    if (!existsSync(path))
        return ok(null);
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch (cause) {
        return fsError(cause, path, `read ${MARKER_FILENAME}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (cause) {
        return err("BROKEN_INSTALL", `${MARKER_FILENAME} is not readable JSON.`, { path, cause });
    }
    const candidate = parsed;
    if (typeof candidate !== "object" ||
        candidate === null ||
        candidate.product !== "subline" ||
        typeof candidate.loaderPath !== "string") {
        return err("BROKEN_INSTALL", `${MARKER_FILENAME} is not one of ours.`, { path });
    }
    return ok({
        format: typeof candidate.format === "number" ? candidate.format : 0,
        product: "subline",
        productVersion: typeof candidate.productVersion === "string" ? candidate.productVersion : "unknown",
        loaderPath: candidate.loaderPath,
        // Validated, not merely copied: this value is compared against a beacon
        // to decide whether an install is confirmed, and a marker on disk can be
        // edited. A malformed one reads as "no id", never as a wildcard.
        pluginBuildId: typeof candidate.pluginBuildId === "string" && BUILD_ID_PATTERN.test(candidate.pluginBuildId)
            ? candidate.pluginBuildId
            : null,
        discordVersion: typeof candidate.discordVersion === "string" ? candidate.discordVersion : null,
        backupPath: typeof candidate.backupPath === "string" ? candidate.backupPath : "",
        patchedAt: typeof candidate.patchedAt === "string" ? candidate.patchedAt : ""
    });
}
export function writeMarker(resourcesPath, marker) {
    const path = markerPathFor(resourcesPath);
    try {
        writeFileSync(path, `${JSON.stringify(marker, null, 4)}\n`, "utf8");
        return ok(path);
    }
    catch (cause) {
        return fsError(cause, path, `write ${MARKER_FILENAME}`);
    }
}
export function removeMarker(resourcesPath) {
    const path = markerPathFor(resourcesPath);
    if (!existsSync(path))
        return ok(false);
    try {
        unlinkSync(path);
        return ok(true);
    }
    catch (cause) {
        return fsError(cause, path, `remove ${MARKER_FILENAME}`);
    }
}
//# sourceMappingURL=marker.js.map