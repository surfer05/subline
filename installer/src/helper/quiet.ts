/**
 * Two small pieces the faster triggers (0.2.1) need.
 *
 * Since 0.2.1 the helper runs far more often: on macOS whenever launchd sees
 * Discord's Resources change (WatchPaths), on Windows every 5 minutes. Almost
 * every one of those runs finds nothing to do, and the diagnostics log is
 * rotated, so a run that changes nothing must cost one line, not a dozen: a
 * log of identical "not needed" decisions every 5 minutes would push the one
 * run that mattered out of the file.
 *
 * Neither piece touches the network or the filesystem.
 */

import type { FlowLogger } from "../app/flow.js";
import type { DiscordInstall } from "../patcher/locate.js";
import type { Result } from "../patcher/result.js";
import type { InstallState } from "../patcher/state.js";
import type { HelperRunReport } from "./helper.js";

type Fields = Record<string, string | number | boolean | null | undefined>;

export interface BufferedLogger {
    /** Pass this to the run instead of the real logger. */
    logger: FlowLogger;
    /** Write everything held back, in order, to the real logger. */
    flush(): void;
    /** How many lines are held back. */
    readonly size: number;
}

/**
 * A logger that holds every line until the run is over, so the caller can
 * decide whether the run was worth more than one line. A crash flushes it (the
 * caller does that), so nothing that explains a failure is ever lost.
 */
export function bufferedLogger(target: FlowLogger): BufferedLogger {
    const held: { level: keyof FlowLogger; event: string; fields?: Fields }[] = [];
    const hold = (level: keyof FlowLogger) => (event: string, fields?: Fields): void => {
        held.push({ level, event, fields });
    };
    return {
        logger: { info: hold("info"), warn: hold("warn"), error: hold("error") },
        flush() {
            for (const line of held.splice(0)) target[line.level](line.event, line.fields);
        },
        get size() { return held.length; }
    };
}

/**
 * Did this run change or learn anything worth reading later?
 *
 * Idle means: nothing repatched, deferred or failed, no update check (so no
 * network), no alert raised or resolved, and health not reporting a problem.
 * A healthy "everything is fine" run is idle; anything else is logged in full.
 */
export function isIdleRun(report: HelperRunReport): boolean {
    if (report.repatched.length > 0 || report.deferred.length > 0 || report.failed.length > 0) return false;
    if (report.updateChecked || report.updateInstalled !== null) return false;
    if (report.alerts.length > 0) return false;
    if (report.decisions.some(d => d.kind === "alert" || d.outcome === "state-not-saved" || d.outcome === "failed" || d.outcome === "state-unreadable")) return false;
    // A Discord found and skipped is the signature of every abandonment bug
    // (audit #43). Logged in full when the skipped set is new; the same set
    // again is one line, or a BetterDiscord user would get a full entry every
    // 5 minutes.
    if (report.found > report.managed && report.repeatUnmanaged !== true) return false;
    return healthIsQuiet(report);
}

/**
 * Health worth no more than one line: healthy, quiet, unknown, or a problem
 * status that has not changed and did not just escalate (audit #32: a sticky
 * "erroring" logged in full every 5 minutes rotated the install records out).
 */
function healthIsQuiet(report: HelperRunReport): boolean {
    const health = report.health;
    if (health === null) return true;
    if (health.status === "healthy" || health.status === "quiet" || health.status === "unknown") return true;
    return health.changed === false && !health.escalated;
}

/**
 * A run that only deferred, exactly as the previous run did, and changed or
 * told nobody anything else. A notification actually shown, a failure, an
 * update or a repair is always logged in full.
 */
export function isRepeatDeferralRun(report: HelperRunReport): boolean {
    if (report.repeatDeferral !== true || report.deferred.length === 0) return false;
    if (report.repatched.length > 0 || report.failed.length > 0) return false;
    if (report.updateChecked || report.updateInstalled !== null) return false;
    if (report.alerts.some(alert => alert.notified)) return false;
    if (report.decisions.some(d => d.outcome === "state-not-saved" || d.outcome === "failed" || d.outcome.endsWith(":resolved"))) return false;
    if (report.found > report.managed && report.repeatUnmanaged !== true) return false;
    return healthIsQuiet(report);
}

/**
 * The Resources directory of every Discord install the helper looks after:
 * one that carries Subline's patch now, or that Subline has patched before
 * (its stable id is in the helper's memory: after an update wipes the patch,
 * that memory is the only thing that still says it is ours). Another mod's
 * install is never included. Sorted, so the same installs always give the same
 * list. Never throws: an install that cannot be read is simply left out.
 */
export function managedResourcesPaths(
    locate: () => Result<DiscordInstall[]>,
    inspect: (install: DiscordInstall) => Result<InstallState>,
    rememberedStableIds: ReadonlySet<string>,
    /** Leaves out a Discord another account set up: this account's agent must not watch (and fight over) it. */
    isOtherAccountLoader?: (loaderPath: string) => boolean
): string[] {
    let located: Result<DiscordInstall[]>;
    try {
        located = locate();
    } catch {
        return [];
    }
    if (!located.ok) return [];
    const out = new Set<string>();
    for (const install of located.value) {
        let state: Result<InstallState>;
        try {
            state = inspect(install);
        } catch {
            continue;
        }
        if (!state.ok || state.value.kind === "patched-by-other") continue;
        const loader = state.value.marker?.loaderPath ?? state.value.loaderPath;
        if (loader !== null && loader !== undefined && isOtherAccountLoader?.(loader) === true) continue;
        if (state.value.kind === "patched-by-us" || rememberedStableIds.has(install.stableId)) out.add(install.resourcesPath);
    }
    return [...out].sort();
}

/**
 * Write what a finished run is worth: ONE line (helper.idle) for an idle run,
 * otherwise the header and everything held back, in order. Returns whether the
 * run was idle, so the caller knows whether to add its own summary line.
 * `force` (a registration rewrite or failure) always writes everything.
 */
export function concludeHelperLog(
    report: HelperRunReport,
    held: BufferedLogger,
    target: FlowLogger,
    writeHeader: () => void,
    force = false
): boolean {
    if (!force && isIdleRun(report)) {
        // found beside managed: even the one line shows a skipped Discord.
        target.info("helper.idle", { summary: report.summary, found: report.found, managed: report.managed, health: report.health?.status ?? null });
        return true;
    }
    // The same deferral as last run (Windows: Discord still open after an
    // update, every 5 minutes for hours). One line, so the rotated log keeps
    // the install and uninstall records that "Copy diagnostics" needs.
    if (!force && isRepeatDeferralRun(report)) {
        target.info("helper.deferred", { summary: report.summary, found: report.found, managed: report.managed, deferred: report.deferred.length });
        return true;
    }
    writeHeader();
    held.flush();
    return false;
}
