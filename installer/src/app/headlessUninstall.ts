/**
 * Uninstall with no window, for Windows' own uninstaller (audit 2026-10-06
 * #14, #42).
 *
 * Settings > Apps > Subline > Uninstall ran electron-builder's NSIS
 * uninstaller, which deleted Subline.exe and nothing else: Discord stayed
 * patched, the helper task fired every 5 minutes at a missing exe, and there
 * was no uninstaller left. packaging/installer.nsh now runs
 * `Subline.exe --uninstall` from customUnInit, BEFORE any file is removed,
 * and reads the exit code. It is the same uninstall() the window runs, with
 * the same order: nothing changes unless every check passes.
 *
 * Settings are kept (the NSIS uninstaller asks nothing about them), and
 * Discord is closed only when the uninstaller passes --close-discord, which
 * it does only after the user pressed OK on a box that says so.
 */

import type { UninstallReport } from "./uninstall.js";

export const UNINSTALL_FLAG = "--uninstall";
export const CLOSE_DISCORD_FLAG = "--close-discord";

/** What installer.nsh reads. Keep in step with packaging/installer.nsh. */
export const UNINSTALL_EXIT = {
    /** Discord no longer loads Subline (or never did): the files may go. */
    removed: 0,
    /** The run itself failed before it could say anything. */
    crashed: 1,
    /** Discord is open (or would not close). Nothing was changed. */
    discordRunning: 2,
    /** A Discord still loads Subline. Removing Subline.exe now would orphan it. */
    notRemoved: 3
} as const;

export function isHeadlessUninstall(argv: readonly string[]): boolean {
    return argv.includes(UNINSTALL_FLAG);
}

/** The exit code for a report. */
export function uninstallExitCode(report: UninstallReport): number {
    if (report.problems[0]?.code === "DISCORD_RUNNING" && report.nothingChanged === true) return UNINSTALL_EXIT.discordRunning;
    // No Discord loads Subline any more. A leftover file of Subline's own
    // (a bundle that would not delete) is not a reason to keep Subline.exe.
    if (report.discordRestored) return UNINSTALL_EXIT.removed;
    return UNINSTALL_EXIT.notRemoved;
}

export interface HeadlessUninstallDeps {
    argv: readonly string[];
    /** The same uninstall the window runs, permission gate included. */
    run(options: { keepSettings: true; closeDiscord?: "ask" }): Promise<UninstallReport>;
    log: {
        info(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
        error(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
    };
}

/** Run it and return the exit code. Never throws. */
export async function runHeadlessUninstall(deps: HeadlessUninstallDeps): Promise<number> {
    const closeDiscord = deps.argv.includes(CLOSE_DISCORD_FLAG);
    try {
        const report = await deps.run(closeDiscord ? { keepSettings: true, closeDiscord: "ask" } : { keepSettings: true });
        const code = uninstallExitCode(report);
        deps.log.info("uninstall.headless", {
            exit: code,
            clean: report.clean,
            nothingChanged: report.nothingChanged === true,
            problem: report.problems[0]?.code ?? null,
            summary: report.summary
        });
        return code;
    } catch (cause) {
        deps.log.error("uninstall.headless-crashed", { cause: String(cause) });
        return UNINSTALL_EXIT.crashed;
    }
}
