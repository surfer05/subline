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
}

/**
 * 45s of quiet. Long enough that an updater swapping a 3.6 MB archive and its
 * sidecars has finished; short enough that a login-time helper run still repairs
 * the install before the user has finished opening Discord.
 */
export const DEFAULT_QUIET_MS = 45_000;
export const DEFAULT_CONFIRM_MS = 10_000;
export const DEFAULT_POLL_MS = 15_000;
export const DEFAULT_MAX_WAIT_MS = 5 * 60_000;

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

    let lastReason: string;
    let lastStatus: SettleStatus;
    let lastQuietFor: number | null = null;

    // A do/while, not a while: however small the budget, exactly one observation
    // always happens. A helper that could return without having looked would
    // report a blocking reason it never saw.
    do {
        if (await ports.discordRunning(install)) {
            lastStatus = "discord-running";
            lastReason = "Discord is running, so it may be updating itself and its app.asar is in use";
            lastQuietFor = null;
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
                } else if (await ports.discordRunning(install)) {
                    // Discord can start during the confirmation delay — for
                    // instance because the user opened it, or because the
                    // updater relaunched it.
                    lastStatus = "discord-running";
                    lastReason = "Discord started while we were watching it";
                    lastQuietFor = null;
                } else {
                    return {
                        status: "settled",
                        settled: true,
                        version: second.version,
                        quietForMs: second.newestMtime === null ? null : ports.now() - second.newestMtime,
                        waitedMs: waited(),
                        reason: "Discord is closed and nothing under Resources has changed across two observations"
                    };
                }
            }
        }

        if (waited() + pollMs > maxWaitMs) break;
        await ports.sleep(pollMs);
    } while (waited() <= maxWaitMs);

    return {
        status: lastStatus,
        settled: false,
        version: null,
        quietForMs: lastQuietFor,
        waitedMs: waited(),
        reason: lastReason
    };
}
