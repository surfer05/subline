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
 * the user quit it themselves.
 *
 * A forced quit exists, but ONLY behind an explicit request. The rule above
 * says never force-kill *silently*, and on Windows a strictly-polite escalation
 * is a dead end: `taskkill` without `/F` posts WM_CLOSE, Discord answers it by
 * minimising to the tray rather than exiting, and its windowless Electron
 * children ignore it outright. The user is then told "Discord is still running"
 * about a Discord they can see is closed, with no way forward.
 *
 * `escalate: true` says the CALLER has already been given consent — the button
 * that reached here said "Quit Discord" — so asking politely and then forcing
 * is one press rather than two. It is still an escalation: nothing is
 * force-closed that would have closed politely.
 *
 * THIS POLICY LIVES HERE, not in the callers. It was originally kept out on the
 * grounds that a pure module should hold no safety policy, and both adapters
 * then implemented it themselves, with near-identical comment blocks and
 * different details — one looped over every located branch and passed no
 * injected clock, so it blocked on the real fifteen-second grace. An invariant
 * enforced in two places is enforced in none.
 *
 * Everything here is pure given its ports. Enumerating processes and sending
 * the quit request are injected, so the escalation logic is testable without a
 * Discord.
 */

import type { DiscordBranch } from "../patcher/locate.js";

export interface RunningProcess {
    pid: number;
    /** The executable path or command name, as the platform reports it. */
    command: string;
}

/**
 * macOS process names per branch. The executable inside `Discord.app` is
 * `Discord`, and PTB/Canary carry their suffix through into the binary name.
 */
const MAC_PROCESS_NAMES: Record<DiscordBranch, string> = {
    stable: "Discord",
    ptb: "Discord PTB",
    canary: "Discord Canary"
};

/** Windows image names. */
const WINDOWS_PROCESS_NAMES: Record<DiscordBranch, string> = {
    stable: "Discord.exe",
    ptb: "DiscordPTB.exe",
    canary: "DiscordCanary.exe"
};

export function processNameFor(branch: DiscordBranch, platform: NodeJS.Platform): string {
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
export function findDiscordProcesses(
    processes: readonly RunningProcess[],
    branch: DiscordBranch,
    platform: NodeJS.Platform
): RunningProcess[] {
    const target = processNameFor(branch, platform);
    const wanted = platform === "win32" ? target.toLowerCase() : target;
    return processes.filter(process => {
        const segments = process.command.split(/[/\\]/);
        const name = segments[segments.length - 1] ?? "";
        return (platform === "win32" ? name.toLowerCase() : name) === wanted;
    });
}

/** Parse `ps -axo pid=,comm=` output. Tolerates the leading spaces `ps` pads pids with. */
export function parsePsOutput(stdout: string): RunningProcess[] {
    const processes: RunningProcess[] = [];
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const match = /^(\d+)\s+(.*)$/.exec(trimmed);
        if (match === null) continue;
        const pid = Number(match[1]);
        const command = (match[2] ?? "").trim();
        if (!Number.isFinite(pid) || command.length === 0) continue;
        processes.push({ pid, command });
    }
    return processes;
}

export type QuitOutcome =
    /** It was not running to begin with. */
    | "not-running"
    /** It quit after being asked. */
    | "quit"
    /** It was asked and is still there. The user has to deal with it. */
    | "still-running"
    /** We could not even ask — no scripting bridge, or the request errored. */
    | "quit-failed";

export interface QuitReport {
    outcome: QuitOutcome;
    /** True when it is now safe to patch. */
    clear: boolean;
    pids: number[];
    summary: string;
    /** True when this run used the forced path. Never inferred — set from the caller's request. */
    forced: boolean;
    /** Present when the quit request itself failed. */
    cause?: string;
}

export interface QuitDiscordOptions {
    branch: DiscordBranch;
    platform: NodeJS.Platform;
    /** Enumerate the process table. */
    listProcesses: () => Promise<readonly RunningProcess[]>;
    /** Ask Discord to quit — AppleScript on macOS. MUST NOT kill. */
    requestQuit: () => Promise<void>;
    /**
     * End Discord without asking. Called ONLY when `force` is true, which only
     * happens when the user clicked a button that says so.
     */
    forceQuit?: () => Promise<void>;
    /** Set by the user's explicit choice. Never defaulted to true anywhere. */
    force?: boolean;
    /**
     * Ask first, then force if asking did not work — in one call.
     *
     * For callers whose button already promised to close Discord. Never
     * defaulted to true: a caller that has not been given consent must not get
     * an escalation by forgetting a flag.
     */
    escalate?: boolean;
    /** How long to wait for it to go away after asking. */
    gracePeriodMs?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    clock?: () => number;
}

export const DEFAULT_QUIT_GRACE_MS = 15_000;
export const DEFAULT_QUIT_POLL_MS = 500;

export async function isDiscordRunning(options: {
    branch: DiscordBranch;
    platform: NodeJS.Platform;
    listProcesses: () => Promise<readonly RunningProcess[]>;
}): Promise<RunningProcess[]> {
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
/**
 * What to tell someone whose Discord did not go away.
 *
 * The Windows wording exists because the old single message was actively
 * misleading there: it told the user to quit an app that LOOKS quit. Closing
 * Discord's window on Windows minimises it to the tray, so "quit it yourself"
 * reads as an accusation of not having done the thing they just did. Name the
 * tray, and name the way out.
 */
function stillRunningSummary(platform: NodeJS.Platform, forced: boolean): string {
    if (forced) {
        return "Discord is still running even after being closed by force. Restarting your computer will clear it.";
    }
    if (platform === "win32") {
        return (
            "Discord is still running — closing its window only hides it in the system tray, near the clock. "
            + "Right-click the Discord icon there and choose Quit, then continue. Or let Subline close it."
        );
    }
    return (
        "Discord is still running. Quit it yourself — from the Discord menu, or right-click its "
        + "Dock icon and choose Quit — then continue. Or let Subline close it."
    );
}

export async function quitDiscord(options: QuitDiscordOptions): Promise<QuitReport> {
    const report = await attemptQuit(options);
    // Asking was not enough, and the caller told us it had consent to go further.
    if (report.clear || report.forced || options.escalate !== true) return report;
    return attemptQuit({ ...options, force: true });
}

async function attemptQuit(options: QuitDiscordOptions): Promise<QuitReport> {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const clock = options.clock ?? Date.now;
    const grace = options.gracePeriodMs ?? DEFAULT_QUIT_GRACE_MS;
    const interval = options.pollIntervalMs ?? DEFAULT_QUIT_POLL_MS;

    const forced = options.force === true;

    const running = await isDiscordRunning(options);
    if (running.length === 0) {
        return { outcome: "not-running", clear: true, pids: [], summary: "Discord is not running.", forced };
    }

    const pids = running.map(process => process.pid);
    // A forced run with no way to force is a bug, not a reason to quietly fall
    // back to asking politely — the caller already told the user it would end
    // Discord, and the polite path is what failed to.
    const attempt = forced ? options.forceQuit : options.requestQuit;
    if (attempt === undefined) {
        return {
            outcome: "quit-failed",
            clear: false,
            pids,
            forced,
            summary: "Subline cannot close Discord on this system. Quit Discord yourself, then continue."
        };
    }
    try {
        await attempt();
    } catch (cause) {
        return {
            outcome: "quit-failed",
            clear: false,
            pids,
            forced,
            summary: forced
                ? "Subline could not close Discord. Quit it yourself, then continue."
                : "Subline could not ask Discord to quit. Quit Discord yourself, then continue.",
            cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
        };
    }

    const startedAt = clock();
    for (;;) {
        const remaining = await isDiscordRunning(options);
        if (remaining.length === 0) {
            return { outcome: "quit", clear: true, pids, summary: "Discord has quit.", forced };
        }
        if (clock() - startedAt >= grace) {
            return {
                outcome: "still-running",
                clear: false,
                pids: remaining.map(process => process.pid),
                forced,
                summary: stillRunningSummary(options.platform, forced)
            };
        }
        await sleep(interval);
    }
}
