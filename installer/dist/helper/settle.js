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
export function watchedPaths(install) {
    return [install.asarPath, install.backupPath, install.buildInfoPath, install.resourcesPath];
}
function sample(install, ports) {
    let newest = null;
    for (const path of watchedPaths(install)) {
        const mtime = ports.mtimeOf(path);
        if (mtime === null)
            continue;
        if (newest === null || mtime > newest)
            newest = mtime;
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
export async function awaitDiscordSettled(install, ports, options = {}) {
    const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    const confirmMs = options.confirmMs ?? DEFAULT_CONFIRM_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const startedAt = ports.now();
    const waited = () => ports.now() - startedAt;
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
    let lastReason;
    let lastStatus;
    let lastQuietFor = null;
    do {
        attempts += 1;
        if (await ports.discordRunning(install)) {
            lastStatus = "discord-running";
            lastReason = "Discord is running, so it may be updating itself and its app.asar is in use";
            lastQuietFor = null;
        }
        else {
            const first = sample(install, ports);
            const quietFor = first.newestMtime === null ? null : ports.now() - first.newestMtime;
            lastQuietFor = quietFor;
            if (quietFor === null || quietFor < quietMs) {
                lastStatus = "files-changing";
                lastReason = quietFor === null
                    ? "nothing under Resources could be dated, so we cannot say the update has finished"
                    : `Resources was written ${Math.round(quietFor / 1000)}s ago, inside the ${Math.round(quietMs / 1000)}s quiet window`;
            }
            else {
                // The confirmation. A gap between two of the updater's own writes
                // is indistinguishable from a finished update in one sample.
                await ports.sleep(confirmMs);
                const second = sample(install, ports);
                if (second.version !== first.version) {
                    lastStatus = "version-changing";
                    lastReason = "Discord's version changed while we were watching it";
                    lastQuietFor = null;
                }
                else if (second.newestMtime !== first.newestMtime) {
                    lastStatus = "files-changing";
                    lastReason = "a file under Resources changed while we were watching it";
                    lastQuietFor = second.newestMtime === null ? null : ports.now() - second.newestMtime;
                }
                else if (await ports.discordRunning(install)) {
                    // Discord can start during the confirmation delay — for
                    // instance because the user opened it, or because the
                    // updater relaunched it.
                    lastStatus = "discord-running";
                    lastReason = "Discord started while we were watching it";
                    lastQuietFor = null;
                }
                else {
                    return {
                        status: "settled",
                        settled: true,
                        version: second.version,
                        quietForMs: second.newestMtime === null ? null : ports.now() - second.newestMtime,
                        waitedMs: waited(),
                        attempts,
                        reason: "Discord is closed and nothing under Resources has changed across two observations"
                    };
                }
            }
        }
        if (attempts >= maxAttempts)
            break;
        await ports.sleep(pollMs);
    } while (true);
    return {
        status: lastStatus,
        settled: false,
        version: null,
        quietForMs: lastQuietFor,
        waitedMs: waited(),
        attempts,
        reason: lastReason
    };
}
//# sourceMappingURL=settle.js.map