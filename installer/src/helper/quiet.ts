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
    if (report.decisions.some(d => d.kind === "alert" || d.outcome === "state-not-saved" || d.outcome === "failed")) return false;
    const health = report.health?.status ?? null;
    if (health !== null && health !== "healthy" && health !== "quiet" && health !== "unknown") return false;
    return true;
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
    rememberedStableIds: ReadonlySet<string>
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
        target.info("helper.idle", { summary: report.summary, managed: report.managed });
        return true;
    }
    writeHeader();
    held.flush();
    return false;
}
