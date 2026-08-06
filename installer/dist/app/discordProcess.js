/**
 * Is Discord running, and can we ask it to stop? (spec §3 step 5, §7).
 *
 * THE RULE, from spec §7's failure catalogue: "Discord running during patch —
 * offer to quit it; **never force-kill silently**." Patching underneath a
 * running Electron app produces a client that half-loads the old archive, and a
 * `SIGKILL` from an installer is how a user loses whatever they were typing.
 *
 * So the escalation is: ask nicely (AppleScript `quit`, which is the same thing
 * as choosing Quit from the menu), wait, and if it will not go, SAY SO and let
 * the user quit it themselves. There is no forced kill anywhere in this file,
 * and adding one later should require deleting this paragraph first.
 *
 * Everything here is pure given its ports. Enumerating processes and sending
 * the quit request are injected, so the escalation logic is testable without a
 * Discord.
 */
/**
 * macOS process names per branch. The executable inside `Discord.app` is
 * `Discord`, and PTB/Canary carry their suffix through into the binary name.
 */
const MAC_PROCESS_NAMES = {
    stable: "Discord",
    ptb: "Discord PTB",
    canary: "Discord Canary"
};
/** Windows image names. */
const WINDOWS_PROCESS_NAMES = {
    stable: "Discord.exe",
    ptb: "DiscordPTB.exe",
    canary: "DiscordCanary.exe"
};
export function processNameFor(branch, platform) {
    return platform === "win32" ? WINDOWS_PROCESS_NAMES[branch] : MAC_PROCESS_NAMES[branch];
}
/**
 * Which of these processes are the Discord we care about?
 *
 * Matching is on the LAST path segment and is exact, not a substring: `ps`
 * output contains helper processes whose command lines mention Discord
 * ("Discord Helper (Renderer)", and anything the user happens to have open with
 * "discord" in its path), and treating a helper as the app would leave us
 * waiting forever for a process that only exits when its parent does.
 */
export function findDiscordProcesses(processes, branch, platform) {
    const target = processNameFor(branch, platform);
    const wanted = platform === "win32" ? target.toLowerCase() : target;
    return processes.filter(process => {
        const segments = process.command.split(/[/\\]/);
        const name = segments[segments.length - 1] ?? "";
        return (platform === "win32" ? name.toLowerCase() : name) === wanted;
    });
}
/** Parse `ps -axo pid=,comm=` output. Tolerates the leading spaces `ps` pads pids with. */
export function parsePsOutput(stdout) {
    const processes = [];
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        const match = /^(\d+)\s+(.*)$/.exec(trimmed);
        if (match === null)
            continue;
        const pid = Number(match[1]);
        const command = (match[2] ?? "").trim();
        if (!Number.isFinite(pid) || command.length === 0)
            continue;
        processes.push({ pid, command });
    }
    return processes;
}
export const DEFAULT_QUIT_GRACE_MS = 15_000;
export const DEFAULT_QUIT_POLL_MS = 500;
export async function isDiscordRunning(options) {
    const processes = await options.listProcesses();
    return findDiscordProcesses(processes, options.branch, options.platform);
}
/**
 * Ask Discord to quit and wait for it to actually go.
 *
 * "Actually go" is checked against the process table rather than assumed from
 * the AppleScript returning: `tell application "Discord" to quit` returns as
 * soon as the request is delivered, and Discord may still be saving state — or
 * may be showing a "you have unsaved…" prompt and never quit at all. Patching on
 * the strength of the request having been *sent* is the same class of mistake as
 * declaring an install successful because a file was written.
 */
export async function quitDiscord(options) {
    const sleep = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    const clock = options.clock ?? Date.now;
    const grace = options.gracePeriodMs ?? DEFAULT_QUIT_GRACE_MS;
    const interval = options.pollIntervalMs ?? DEFAULT_QUIT_POLL_MS;
    const running = await isDiscordRunning(options);
    if (running.length === 0) {
        return { outcome: "not-running", clear: true, pids: [], summary: "Discord is not running." };
    }
    const pids = running.map(process => process.pid);
    try {
        await options.requestQuit();
    }
    catch (cause) {
        return {
            outcome: "quit-failed",
            clear: false,
            pids,
            summary: "Subline could not ask Discord to quit. Quit Discord yourself, then continue.",
            cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
        };
    }
    const startedAt = clock();
    for (;;) {
        const remaining = await isDiscordRunning(options);
        if (remaining.length === 0) {
            return { outcome: "quit", clear: true, pids, summary: "Discord has quit." };
        }
        if (clock() - startedAt >= grace) {
            return {
                outcome: "still-running",
                clear: false,
                pids: remaining.map(process => process.pid),
                // No kill offered. Deliberately.
                summary: "Discord is still running. Quit it yourself — from the Discord menu, or right-click its "
                    + "Dock icon and choose Quit — then continue. Subline will not force it to close."
            };
        }
        await sleep(interval);
    }
}
//# sourceMappingURL=discordProcess.js.map