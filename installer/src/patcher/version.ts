/**
 * Discord's own version, from `Contents/Resources/build_info.json`.
 *
 * Confirmed against the live install:
 *   {"releaseChannel":"stable","sentryDist":…,"sentryRelease":…,"version":"0.0.406"}
 *
 * The helper (spec §6) compares this against the version recorded in our patch
 * marker to notice that Discord updated and the injection was wiped.
 */

import { existsSync, readFileSync } from "./realFs.js";

import type { DiscordInstall } from "./locate.js";
import type { Result } from "./result.js";
import { err, fsError, ok } from "./result.js";

export interface DiscordBuildInfo {
    version: string;
    releaseChannel: string | null;
    /** Everything else in the file, kept for the diagnostics header. */
    raw: Record<string, unknown>;
}

export function readDiscordVersion(install: DiscordInstall): Result<DiscordBuildInfo> {
    const path = install.buildInfoPath;
    if (!existsSync(path)) {
        return err<DiscordBuildInfo>("BUILD_INFO_MISSING", "Discord's build_info.json is missing.", { path });
    }

    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (cause) {
        return fsError<DiscordBuildInfo>(cause, path, "read build_info.json");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        return err<DiscordBuildInfo>("BUILD_INFO_MALFORMED", "Discord's build_info.json is not valid JSON.", {
            path,
            cause
        });
    }

    if (typeof parsed !== "object" || parsed === null) {
        return err<DiscordBuildInfo>("BUILD_INFO_MALFORMED", "Discord's build_info.json is not an object.", { path });
    }

    const record = parsed as Record<string, unknown>;
    const version = record.version;
    if (typeof version !== "string" || version.length === 0) {
        return err<DiscordBuildInfo>("BUILD_INFO_MALFORMED", "Discord's build_info.json has no version.", { path });
    }

    return ok({
        version,
        releaseChannel: typeof record.releaseChannel === "string" ? record.releaseChannel : null,
        raw: record
    });
}
