/**
 * What the installed Subline APP (and its background helper) says about itself,
 * read from disk for the running plugin.
 *
 * WHY THIS EXISTS. The update feed replaces the mod bundle only. The installed
 * app, and the helper inside it that repairs Discord after a Discord update,
 * stay whatever version the user once downloaded. A user on an old app never
 * gets helper fixes, and nothing in Discord ever told them. The plugin needs two
 * facts to say so (appNotice.ts):
 *
 *  1. Which app version is installed. The app and its helper write it to
 *     `app-version.json` on every run (installer: src/app/appVersionFile.ts).
 *     Apps older than that file write nothing, so ABSENCE MEANS OLD.
 *  2. Whether the helper has said it could not repair Discord. Every helper
 *     since the first one writes `alerts.json` with closed alert codes
 *     (installer: src/helper/alerts.ts), so this works on old apps too.
 *
 * MAIN PROCESS ONLY, reached through native.ts like stagedBuild.ts.
 *
 * NOTHING HERE THROWS. A corrupt file is "old" (version) or "no alert" (alerts),
 * never an exception: this is a notice, and a notice must never become a way
 * for the plugin to fail.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { statusDirFor } from "./statusFile";

/**
 * Restated from the installer because the plugin cannot import installer code.
 * MUST match `APP_VERSION_FILENAME` (installer/src/app/appVersionFile.ts),
 * `ALERTS_FILENAME` (installer/src/helper/alerts.ts), `MOD_DIR_NAME` and
 * `MOD_MANIFEST_FILENAME` (installer/src/bundle/). Stable on-disk contracts.
 */
export const APP_VERSION_FILENAME = "app-version.json";
export const ALERTS_FILENAME = "alerts.json";
const MOD_DIR_NAME = "mod";
const MOD_MANIFEST_FILENAME = "subline-mod.json";

/**
 * Helper alert codes that mean "Discord updated and the helper could not put
 * Subline back". A closed list of codes the helper has written since 0.1.0.
 * `update-failed`, `mod-stale`, `restart-required` and `quit-required` are
 * other problems with other remedies, so they are not here.
 */
export const CANNOT_REPAIR_CODES: readonly string[] = ["repatch-failed", "rollback-failed", "backup-missing"];

/** A version the app wrote: digits and dots, nothing else (e.g. "0.2.3"). */
const VERSION_SHAPE = /^\d+(\.\d+){0,3}$/;

export interface AppSignals {
    /**
     * Subline manages this Discord: its mod bundle is staged in the product
     * directory. False for a hand-built or Vencord-only install, which has no
     * Subline app to be old, so it is never told to download one.
     */
    managed: boolean;
    /** The installed app's version, or null when absent or unreadable (= old). */
    appVersion: string | null;
    /** The helper has an outstanding "could not repair" alert. */
    cannotRepair: boolean;
}

export const NO_SIGNALS: AppSignals = { managed: false, appVersion: null, cannotRepair: false };

/** The app version out of `app-version.json` text, or null. Total. */
export function parseAppVersion(text: string): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const v = (parsed as { appVersion?: unknown }).appVersion;
    return typeof v === "string" && VERSION_SHAPE.test(v) ? v : null;
}

/** Whether `alerts.json` text holds a "could not repair" alert. Total. */
export function parseCannotRepair(text: string): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return false;
    }
    if (parsed === null || typeof parsed !== "object") return false;
    const alerts = (parsed as { alerts?: unknown }).alerts;
    if (!Array.isArray(alerts)) return false;
    return alerts.some(entry =>
        entry !== null && typeof entry === "object"
        && CANNOT_REPAIR_CODES.includes((entry as { code?: unknown }).code as string));
}

export interface AppSignalsOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    /** Bypasses path resolution: the product directory itself. Tests only. */
    dir?: string;
}

function readText(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

/** Read both signals. Never throws; an unsupported platform is NO_SIGNALS. */
export function readAppSignalsSync(options: AppSignalsOptions = {}): AppSignals {
    try {
        const dir = options.dir ?? statusDirFor(
            options.platform ?? process.platform,
            options.env,
            options.home ?? homedir()
        );
        if (dir === null) return NO_SIGNALS;
        const managed = existsSync(join(dir, MOD_DIR_NAME, MOD_MANIFEST_FILENAME));
        const versionText = readText(join(dir, APP_VERSION_FILENAME));
        const alertsText = readText(join(dir, ALERTS_FILENAME));
        return {
            managed,
            appVersion: versionText === null ? null : parseAppVersion(versionText),
            cannotRepair: alertsText === null ? false : parseCannotRepair(alertsText)
        };
    } catch {
        return NO_SIGNALS;
    }
}
