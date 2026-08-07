/**
 * The helper's memory between runs.
 *
 * THE HELPER RUNS WHEN NOBODY IS WATCHING, and every decision it makes needs a
 * *previous* observation to be a decision at all:
 *
 *  - "Discord's version changed" is meaningless without the version we last
 *    patched against (spec §6, trigger A).
 *  - "the mod has rendered nothing over a meaningful window" is meaningless
 *    without knowing when the window opened — a single sample cannot tell a
 *    broken mod from a quiet channel, and guessing in either direction is the
 *    failure mode the health check exists to avoid.
 *  - "we have already told the user about this" is what stops a notification
 *    firing every hour for the same unfixable problem.
 *
 * The marker (`subline-patch.json`) records the version *at patch time* and is
 * the primary source for trigger A — but it lives beside `app.asar` and a Discord
 * update takes it with the patch. That is exactly the case we must still detect,
 * so the same fact is mirrored here, in a directory Discord cannot reach.
 *
 * EVERY FIELD IS OPTIONAL ON READ. This file is JSON in a user-writable
 * directory that a future version will extend; a reader that refused an
 * unfamiliar document would turn "we added a field" into "the helper stopped
 * repairing installs". Anything unreadable degrades to the empty state, which
 * costs at most one extra observation.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Result } from "../patcher/result.js";
import { fsError, ok } from "../patcher/result.js";

export const HELPER_STATE_FILENAME = "helper-state.json";
export const HELPER_STATE_FORMAT = 1;

/** What we know about one Discord we have patched. */
export interface InstallMemory {
    /** Discord's version when we last patched it successfully. */
    discordVersion: string | null;
    /** The mod build id we last installed there. */
    buildId: string | null;
    patchedAt: number | null;
    /** Consecutive failed re-patch attempts, so one bad night is not an alert. */
    failures: number;
}

/**
 * The rolling health judgement.
 *
 * `suspectSince` and `observations` are the whole point: a status is escalated
 * only when the SAME suspicious signal has been seen repeatedly across a long
 * enough window. One sample is never enough (see `health.ts`).
 */
export interface HealthMemory {
    /** The last raw signal observed. */
    lastStatus: string;
    lastObservedAt: number | null;
    /** When the current run of suspicious observations began. */
    suspectSince: number | null;
    /** How many consecutive suspicious observations there have been. */
    observations: number;
}

/** One alert we have already raised, so we do not raise it again every hour. */
export interface AlertMemory {
    firstAt: number;
    lastNotifiedAt: number;
    count: number;
}

export interface HelperState {
    format: number;
    lastRunAt: number | null;
    /** Keyed by the install's root path. */
    installs: Record<string, InstallMemory>;
    lastUpdateCheckAt: number | null;
    /** The newest build id the release feed has offered us. */
    lastReleaseBuildId: string | null;
    /** Consecutive failed update checks. A flaky network is not news. */
    updateFailures: number;
    health: HealthMemory;
    alerts: Record<string, AlertMemory>;
}

export function emptyHelperState(): HelperState {
    return {
        format: HELPER_STATE_FORMAT,
        lastRunAt: null,
        installs: {},
        lastUpdateCheckAt: null,
        lastReleaseBuildId: null,
        updateFailures: 0,
        health: { lastStatus: "unknown", lastObservedAt: null, suspectSince: null, observations: 0 },
        alerts: {}
    };
}

export function helperStatePathFor(productDir: string): string {
    return join(productDir, HELPER_STATE_FILENAME);
}

function num(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function str(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn whatever is on disk into a usable state.
 *
 * Never fails. A missing, truncated, hand-edited or future-format file all read
 * as "we have no memory", which makes the helper cautious rather than broken:
 * with no memory it re-observes, and one extra observation is the entire cost.
 */
export function parseHelperState(raw: string): HelperState {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return emptyHelperState();
    }
    if (!isRecord(parsed)) return emptyHelperState();

    const state = emptyHelperState();
    state.lastRunAt = num(parsed.lastRunAt);
    state.lastUpdateCheckAt = num(parsed.lastUpdateCheckAt);
    state.lastReleaseBuildId = str(parsed.lastReleaseBuildId);
    state.updateFailures = count(parsed.updateFailures);

    if (isRecord(parsed.installs)) {
        for (const [rootPath, value] of Object.entries(parsed.installs)) {
            if (!isRecord(value)) continue;
            state.installs[rootPath] = {
                discordVersion: str(value.discordVersion),
                buildId: str(value.buildId),
                patchedAt: num(value.patchedAt),
                failures: count(value.failures)
            };
        }
    }

    if (isRecord(parsed.health)) {
        state.health = {
            lastStatus: str(parsed.health.lastStatus) ?? "unknown",
            lastObservedAt: num(parsed.health.lastObservedAt),
            suspectSince: num(parsed.health.suspectSince),
            observations: count(parsed.health.observations)
        };
    }

    if (isRecord(parsed.alerts)) {
        for (const [code, value] of Object.entries(parsed.alerts)) {
            if (!isRecord(value)) continue;
            const firstAt = num(value.firstAt);
            const lastNotifiedAt = num(value.lastNotifiedAt);
            if (firstAt === null || lastNotifiedAt === null) continue;
            state.alerts[code] = { firstAt, lastNotifiedAt, count: count(value.count) };
        }
    }

    return state;
}

export function readHelperState(path: string): HelperState {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        return emptyHelperState();
    }
    return parseHelperState(raw);
}

/**
 * Write the state atomically.
 *
 * Staged and renamed for the same reason the plugin writes its beacon that way:
 * the helper can be killed at logout mid-write, and a half-written state file
 * that still parses would be a *plausible* lie about what we last saw. Renaming
 * makes the file either the old one or the new one.
 */
export function writeHelperState(path: string, state: HelperState): Result<string> {
    const temp = `${path}.tmp`;
    try {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(temp, `${JSON.stringify({ ...state, format: HELPER_STATE_FORMAT }, null, 4)}\n`, "utf8");
        renameSync(temp, path);
    } catch (cause) {
        return fsError<string>(cause, path, `write ${HELPER_STATE_FILENAME}`);
    }
    return ok(path);
}
