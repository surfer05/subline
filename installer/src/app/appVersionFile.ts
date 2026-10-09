/**
 * `app-version.json`: which Subline APP is installed, for the running plugin.
 *
 * WHY. The update feed replaces the mod bundle only, never the app, and the
 * app's background helper is what repairs Discord after a Discord update. The
 * plugin needs to know when the app (and so the helper) is older than it needs,
 * so it can say "download the new Subline" once (plugin: appNotice.ts,
 * appSignals.ts). Apps from before this file write nothing, and the plugin
 * reads that absence as "old".
 *
 * WRITTEN ON EVERY RUN, by the app at launch (only from an installed copy, not
 * the disk image or a temporary one: writeAppVersionFromLaunch) and by the
 * helper on each of its runs. The helper is the same binary as the app (same
 * bundle, different flag), so both write the same version. Writing on every
 * helper run is what keeps the file true after the app is replaced in place.
 *
 * A small file of its own, not a field in `helper-state.json`: the plugin must
 * read it cheaply and the helper state is the helper's private memory.
 *
 * NEVER THROWS. A failed write is returned with its cause for the log; the
 * worst it costs is one "download the new Subline" notice too many.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AppLocationVerdict, TemporaryLocationReason } from "../helper/launchAgent.js";
import type { Result } from "../patcher/result.js";
import { fsError, ok } from "../patcher/result.js";

/** MUST match `APP_VERSION_FILENAME` in the plugin's appSignals.ts. */
export const APP_VERSION_FILENAME = "app-version.json";
export const APP_VERSION_FORMAT = 1;

export type AppVersionWriter = "app" | "helper";

export interface AppVersionDocument {
    format: number;
    product: "subline";
    appVersion: string;
    writtenBy: AppVersionWriter;
    writtenAt: number;
}

export function appVersionPathFor(productDir: string): string {
    return join(productDir, APP_VERSION_FILENAME);
}

/**
 * Write the file atomically (temp + rename), so the plugin never reads half a
 * document. `productDir` null (an unsupported platform) writes nothing.
 */
export function writeAppVersionFile(
    productDir: string | null,
    appVersion: string,
    writtenBy: AppVersionWriter,
    now: number = Date.now()
): Result<string | null> {
    if (productDir === null) return ok(null);
    const path = appVersionPathFor(productDir);
    const document: AppVersionDocument = {
        format: APP_VERSION_FORMAT,
        product: "subline",
        appVersion,
        writtenBy,
        writtenAt: now
    };
    const temp = `${path}.${process.pid}.tmp`;
    try {
        mkdirSync(productDir, { recursive: true });
        writeFileSync(temp, `${JSON.stringify(document, null, 4)}\n`, "utf8");
        renameSync(temp, path);
    } catch (cause) {
        return fsError<string | null>(cause, path, `write ${APP_VERSION_FILENAME}`);
    }
    return ok(path);
}

export type AppLaunchVersionOutcome =
    | { kind: "written"; result: Result<string | null> }
    | { kind: "skipped"; reason: TemporaryLocationReason }
    | { kind: "location-failed"; cause: string };

/**
 * The APP LAUNCH's write: only from a copy the helper can run from.
 *
 * A Subline opened off the disk image, from a translocated copy or from the
 * Trash is not the installed app. Its version must not be recorded: the
 * installed (older) app and its helper keep running, and an old helper from
 * before this file never rewrites it, so the plugin would believe the app is
 * new for good and never say "download the new Subline". `locate` is the same
 * test the helper registration uses (appLocationFor). If it fails, nothing is
 * written: the helper's own runs write the file from the registered path.
 */
export async function writeAppVersionFromLaunch(
    productDir: string | null,
    appVersion: string,
    locate: () => Promise<AppLocationVerdict>,
    now: number = Date.now()
): Promise<AppLaunchVersionOutcome> {
    let location: AppLocationVerdict;
    try {
        location = await locate();
    } catch (cause) {
        return { kind: "location-failed", cause: String(cause) };
    }
    if (location.temporary) return { kind: "skipped", reason: location.reason };
    return { kind: "written", result: writeAppVersionFile(productDir, appVersion, "app", now) };
}
