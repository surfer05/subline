/**
 * Discord's own version, from `Contents/Resources/build_info.json`.
 *
 * Confirmed against the live install:
 *   {"releaseChannel":"stable","sentryDist":…,"sentryRelease":…,"version":"0.0.406"}
 *
 * The helper (spec §6) compares this against the version recorded in our patch
 * marker to notice that Discord updated and the injection was wiped.
 */
import { existsSync, readFileSync } from "node:fs";
import { err, fsError, ok } from "./result.js";
export function readDiscordVersion(install) {
    const path = install.buildInfoPath;
    if (!existsSync(path)) {
        return err("BUILD_INFO_MISSING", "Discord's build_info.json is missing.", { path });
    }
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch (cause) {
        return fsError(cause, path, "read build_info.json");
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (cause) {
        return err("BUILD_INFO_MALFORMED", "Discord's build_info.json is not valid JSON.", {
            path,
            cause
        });
    }
    if (typeof parsed !== "object" || parsed === null) {
        return err("BUILD_INFO_MALFORMED", "Discord's build_info.json is not an object.", { path });
    }
    const record = parsed;
    const version = record.version;
    if (typeof version !== "string" || version.length === 0) {
        return err("BUILD_INFO_MALFORMED", "Discord's build_info.json has no version.", { path });
    }
    return ok({
        version,
        releaseChannel: typeof record.releaseChannel === "string" ? record.releaseChannel : null,
        raw: record
    });
}
//# sourceMappingURL=version.js.map