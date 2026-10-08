/**
 * Waiting for Discord's updater to finish before touching anything.
 *
 * THIS IS STOLEN PRIOR ART, DELIBERATELY. Spec §5: every existing repatcher
 * ([VencordAutoRepair], [BetterVencordPatch], [VencordAutoUpdater]) waits for
 * Discord's updater to *settle* before re-patching, and each learned it the same
 * way — racing the updater produces a half-patched install. The failure is
 * asymmetric: patching too late costs one helper interval, patching too early
 * costs the user a Discord that does not start.
 *
 * ## What "settled" means here, and why each condition is separate
 *
 *  1. **Discord is not running.** Discord's updater runs *inside* Discord, so a
 *     running Discord is a possible in-flight update. It is also the ordinary
 *     reason not to patch: `app.asar` is open, and a Discord that is already
 *     running would keep the old code anyway. One check, two reasons.
 *  2. **The Resources directory has been quiet.** The newest mtime among
 *     `app.asar`, `_app.asar`, `build_info.json` and the directory itself must be
 *     older than the quiet window. An updater mid-swap is writing exactly these.
 *  3. **Two agreeing observations.** Everything above is re-read after a delay
 *     and must be unchanged. A quiet moment between two writes looks identical to
 *     a finished update in a single sample; it does not survive being asked
 *     twice.
 *
 * The whole module is driven through injected `now`, `sleep`, `listProcesses`
 * and `mtimeOf`, so the tests exercise a mid-update Discord without one existing.
 * Nothing here writes anything.
 *
 * [VencordAutoRepair]: https://github.com/Extrautior/VencordAutoRepair
 * [BetterVencordPatch]: https://github.com/AaronWijesinghe/BetterVencordPatch
 * [VencordAutoUpdater]: https://github.com/Febsho/VencordAutoUpdater
 */

import type { DiscordInstall } from "../patcher/locate.js";
import type { DiscordBuildInfo } from "../patcher/version.js";
import type { Result } from "../patcher/result.js";

export type SettleStatus =
    /** Nothing is moving; it is safe to patch. */
    | "settled"
    /** Discord is open. Possibly updating, certainly not ready to be patched. */
    | "discord-running"
    /** Files under Resources are still changing — an update is landing right now. */
    | "files-changing"
    /** The version changed between two observations. The updater is mid-flight. */
    | "version-changing";

export interface SettleReport {
    status: SettleStatus;
    /** True only for `"settled"` — the one value callers may act on. */
    settled: boolean;
    /** Discord's version as read once everything stopped moving. */
    version: string | null;
    /** How long the newest file under Resources has been untouched, when known. */
    quietForMs: number | null;
    /** How long we waited inside this run. */
    waitedMs: number;
    /** How many observations were made. Bounded by the budget — see below. */
    attempts: number;
    /** One line for the log, saying what we decided and why. */
    reason: string;
}

export interface SettlePorts {
    now(): number;
    sleep(ms: number): Promise<void>;
    /** Is the Discord this install belongs to running right now? */
    discordRunning(install: DiscordInstall): Promise<boolean>;
    /** Modification time in epoch ms, or `null` when the path does not exist. */
    mtimeOf(path: string): number | null;
    readDiscordVersion(install: DiscordInstall): Result<DiscordBuildInfo>;
}

export interface SettleOptions {
    /** How long everything must have been untouched. */
    quietMs?: number;
    /** How long to wait between the two agreeing observations. */
    confirmMs?: number;
    /** How often to re-check while something is still moving. */
    pollMs?: number;
    /** Total budget for this run. Exceeding it defers to the next run, silently. */
    maxWaitMs?: number;
    /**
     * Whether a RUNNING Discord has to be waited out.
     *
     * Defaults to true, which is correct on Windows and was wrong everywhere
     * else. Windows refuses to rename a file a running process holds open, so
     * there the patch genuinely cannot be written while Discord is up. macOS
     * has no such rule: the rename succeeds, the running Discord keeps the
     * archive it already opened, and the patch takes effect at its next launch.
     *
     * Waiting anyway looked cautious and was in fact fatal. Self-repair exists
     * for the user whose Discord updated underneath them — somebody who USES
     * Discord, and therefore has it open. Every hourly run on a real Mac
     * deferred, for days, and the product silently stopped translating with a
     * helper installed, registered and running perfectly.
     *
     * The UPDATER is still waited out either way. That was always the real
     * hazard: racing a half-written install, not touching a live one.
     */
    requireDiscordClosed?: boolean;
    /**
     * Wait this long for a running Discord to close before deferring
     * (requireDiscordClosed only). Zero by default: a run normally looks once
     * and goes. The helper sets it only right after it has asked the user to
     * quit Discord (audit 2026-10-06 #47): a user who quits and reopens at
     * once was otherwise never seen with Discord closed by a 5 minute task.
     */
    waitForCloseMs?: number;
    /** How often to look while waiting for Discord to close. */
    closePollMs?: number;
}

/*
 * A RUNNING DISCORD IS NOT WAITED OUT INSIDE A RUN. It used to be: 61 checks
 * over 5 minutes, then "deferred". On Windows, where the task already runs
 * every 5 minutes, that kept a helper (and a tasklist every 5 s) running all
 * day for anyone whose Discord sits in the tray, and repaired nothing sooner.
 * Discord is a user's app, open for hours; the NEXT run is the retry. So a
 * running Discord ends this run at once. Files still moving are polled as
 * before: an update lands in seconds.
 */

/**
 * 8s of quiet, then a second observation 5s later that must agree.
 *
 * This used to be 45s, chosen when the only trigger was an hourly run. Since
 * 0.2.1 the macOS helper is also started by launchd the moment Discord's
 * Resources change (WatchPaths), so it now usually wakes up IN THE MIDDLE of an
 * update, and the quiet window is what holds it back until the swap is done.
 * Discord's updater replaces a handful of files in well under a second; 8s of
 * nothing plus a confirming sample 5s later is ample margin for that, and puts
 * a repaired Discord ~15s after the update rather than a minute. A run that
 * fires while files are still moving polls every 5s within the same 5 minute
 * budget and otherwise defers silently to the next trigger.
 */
export const DEFAULT_QUIET_MS = 8_000;
export const DEFAULT_CONFIRM_MS = 5_000;
export const DEFAULT_POLL_MS = 5_000;
export const DEFAULT_MAX_WAIT_MS = 5 * 60_000;
export const DEFAULT_CLOSE_POLL_MS = 10_000;

/** The paths an updater touches while it replaces an install. */
export function watchedPaths(install: DiscordInstall): string[] {
    return [install.asarPath, install.backupPath, install.buildInfoPath, install.resourcesPath];
}

interface Sample {
    newestMtime: number | null;
    version: string | null;
}

function sample(install: DiscordInstall, ports: SettlePorts): Sample {
    let newest: number | null = null;
    for (const path of watchedPaths(install)) {
        const mtime = ports.mtimeOf(path);
        if (mtime === null) continue;
        if (newest === null || mtime > newest) newest = mtime;
    }
    const version = ports.readDiscordVersion(install);
    return { newestMtime: newest, version: version.ok ? version.value.version : null };
}

/**
 * Wait until this install has stopped moving, or give up for this run.
 *
 * Returns a report in every case and never throws. `settled: false` is a normal,
 * expected outcome — it means "not now", not "something is wrong", and the caller
 * logs it and tries again next time rather than alerting anybody.
 */
export async function awaitDiscordSettled(
    install: DiscordInstall,
    ports: SettlePorts,
    options: SettleOptions = {}
): Promise<SettleReport> {
    const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    const confirmMs = options.confirmMs ?? DEFAULT_CONFIRM_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

    const startedAt = ports.now();
    const waited = (): number => ports.now() - startedAt;

    /**
     * THE ONLY BOUND, and it is a COUNT rather than a deadline.
     *
     * An earlier version looped until the clock passed `maxWaitMs`, which made
     * termination depend on `now()` — a port the caller supplies. A clock that
     * does not advance (a coarse timer, a suspended machine reporting the same
     * instant, a caller injecting a fixed one) turned this into a loop that runs
     * forever inside a background process nobody is watching, starving the event
     * loop with microtasks so not even a timeout could fire. A mutation probe
     * found it by hanging the whole suite.
     *
     * It is derived from the budget, so the behaviour is unchanged: exactly as
     * many sleeps as fit in `maxWaitMs`, plus the observation that follows the
     * last one. No floor is applied to the result — the do/while already
     * guarantees that however small (or negative) the budget, one observation
     * happens, and a second guard that cannot change an observable outcome is
     * one nothing can test.
     */
    const maxAttempts = Math.floor(maxWaitMs / Math.max(1, pollMs)) + 1;
    let attempts = 0;

    const requireClosed = options.requireDiscordClosed ?? true;

    // A bounded wait for Discord to close, by COUNT like the loop below, so
    // a clock that does not move cannot make it endless.
    const waitForCloseMs = Math.max(0, options.waitForCloseMs ?? 0);
    if (requireClosed && waitForCloseMs > 0) {
        const closePollMs = Math.max(1, options.closePollMs ?? DEFAULT_CLOSE_POLL_MS);
        const maxPolls = Math.floor(waitForCloseMs / closePollMs);
        let polls = 0;
        while (await ports.discordRunning(install)) {
            if (polls >= maxPolls) {
                return {
                    status: "discord-running",
                    settled: false,
                    version: null,
                    quietForMs: null,
                    waitedMs: waited(),
                    attempts: polls + 1,
                    reason: `Discord stayed open for the whole ${Math.round(waitForCloseMs / 1000)}s wait`
                };
            }
            await ports.sleep(closePollMs);
            polls += 1;
        }
    }

    let lastReason: string;
    let lastStatus: SettleStatus;
    let lastQuietFor: number | null = null;

    const notSettled = (status: SettleStatus, reason: string, quietForMs: number | null): SettleReport => ({
        status,
        settled: false,
        version: null,
        quietForMs,
        waitedMs: waited(),
        attempts,
        reason
    });

    do {
        attempts += 1;
        if (requireClosed && await ports.discordRunning(install)) {
            return notSettled("discord-running", "Discord is running, so it may be updating itself and its app.asar is in use", null);
        } else {
            const first = sample(install, ports);
            const quietFor = first.newestMtime === null ? null : ports.now() - first.newestMtime;
            lastQuietFor = quietFor;

            if (quietFor === null || quietFor < quietMs) {
                lastStatus = "files-changing";
                lastReason = quietFor === null
                    ? "nothing under Resources could be dated, so we cannot say the update has finished"
                    : `Resources was written ${Math.round(quietFor / 1000)}s ago, inside the ${Math.round(quietMs / 1000)}s quiet window`;
            } else {
                // The confirmation. A gap between two of the updater's own writes
                // is indistinguishable from a finished update in one sample.
                await ports.sleep(confirmMs);
                const second = sample(install, ports);

                if (second.version !== first.version) {
                    lastStatus = "version-changing";
                    lastReason = "Discord's version changed while we were watching it";
                    lastQuietFor = null;
                } else if (second.newestMtime !== first.newestMtime) {
                    lastStatus = "files-changing";
                    lastReason = "a file under Resources changed while we were watching it";
                    lastQuietFor = second.newestMtime === null ? null : ports.now() - second.newestMtime;
                } else if (requireClosed && await ports.discordRunning(install)) {
                    // Discord can start during the confirmation delay — for
                    // instance because the user opened it, or because the
                    // updater relaunched it.
                    return notSettled("discord-running", "Discord started while we were watching it", null);
                } else {
                    return {
                        status: "settled",
                        settled: true,
                        version: second.version,
                        quietForMs: second.newestMtime === null ? null : ports.now() - second.newestMtime,
                        waitedMs: waited(),
                        attempts,
                        reason: requireClosed
                            ? "Discord is closed and nothing under Resources has changed across two observations"
                            : "nothing under Resources has changed across two observations"
                    };
                }
            }
        }

        if (attempts >= maxAttempts) break;
        await ports.sleep(pollMs);
    } while (true);

    return notSettled(lastStatus, lastReason, lastQuietFor);
}
