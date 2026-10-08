/**
 * The words of the uninstall, and what its first screen offers.
 *
 * Pure and free of `document`, like codeScreen.ts, so the suite can test what
 * the renderer draws: the renderer is the one module vitest never executes.
 * Every user-facing uninstall string lives here, so the owner rewrites copy in
 * one place. Short plain sentences, no em dashes.
 *
 * WINDOWS IS NAMED BY WHERE DISCORD HIDES. Closing Discord's window on Windows
 * only hides it, and on Windows 11 its tray icon sits behind the ^ overflow
 * arrow near the clock. Field test 2026-10-08: the user was sure Discord was
 * closed, because nothing on screen said otherwise. "Check the system tray"
 * did not help them find it; the ^ does.
 */

export const UNINSTALL_COPY = {
    /** The first screen, shown before anything is changed. */
    confirmTitle: "Remove Subline?",
    confirmDetail: "Subline will put Discord's original files back and remove itself.",
    /** Second sentence on the first screen when Discord is open. */
    willQuit: "Subline will quit it first, then remove itself.",
    removeSettings: "Also remove my settings and code",
    remove: "Remove",
    quitAndRemove: "Quit Discord and remove",
    cancel: "Cancel",
    back: "Back",
    /* Headings of the report screen. */
    titleRemoved: "Removed",
    titleNotFully: "Not fully removed",
    titleDiscordOpen: "Discord is still open",
    titleNotRemoved: "Subline was not removed",
    titleCancelled: "Cancelled",
    nothingChanged: "Nothing has been changed.",
    cannotWhileOpen: "Its files cannot be put back while it is open.",
    couldNotQuit: "Subline could not quit it.",
    quitYourselfWindows: "Right-click the Discord icon there, choose Quit Discord, then press Uninstall again.",
    quitYourselfMac: "Quit Discord from its menu, then press Uninstall again.",
    helperStopFailed: "Subline could not stop its background updater, so nothing was removed.",
    helperStopRemedyWindows:
        "Restart your computer and try again. If it still fails, open Task Scheduler, delete the task "
        + "Subline\\Helper, then press Uninstall again.",
    helperStopRemedyMac: "Restart your Mac and try again.",
    backupGone:
        "Subline cannot put Discord's original files back, because the backup copy is gone. Something other "
        + "than Subline removed it. To return Discord to normal, reinstall Discord from discord.com.",
    damaged: "Discord's files are damaged, so Subline cannot put them back. Reinstall Discord from discord.com.",
    couldNotRemove: "Subline could not remove itself from Discord.",
    keepsWorking: "Discord keeps working as it does now.",
    staysInstalled: "Subline stays installed, so Discord keeps working as it does now.",
    staysInstalledUpdating: "Subline stays installed and keeps updating, so Discord keeps working as it does now.",
    helperNotBack: "Background updates could not be turned back on. Open Subline again to fix that.",
    settingsKept: "Your settings and code were kept.",
    tryAgain: "Press Uninstall to try again. The diagnostics log has the details.",
    /* Discords that are not Subline's, listed and never touched (audit #2). */
    leftAlone: "Left alone:",
    leftAloneForeign: "another client mod",
    leftAloneUnreadable: "its files could not be read",
    leftAloneOtherAccount: "set up by another account on this Mac",
    /** Audit #5: a Discord another account on this Mac set up. */
    otherAccount: "Another account on this Mac set up Subline for this Discord. Only that account can remove it.",
    /* No Discord with Subline in it (audit #40). */
    nothingToRemove: "There was nothing to remove. Subline is not installed in any Discord we can find.",
    noDiscordWithSubline: "No Discord with Subline in it was found.",
    itsFiles: "its own files",
    itsUpdater: "its background updater",
    settingsRemoved: "Your settings were removed."
} as const;

/** Where Discord is when it is "still open". The Windows line is the field test's wording. */
export function discordOpenLine(platform: NodeJS.Platform): string {
    return platform === "win32"
        ? "Discord is still open in the background, behind the ^ near the clock."
        : "Discord is still open.";
}

/**
 * The DISCORD_RUNNING summary. `afterQuit`: Subline already tried to quit it
 * (the user pressed "Quit Discord and remove"), and it is still there, because
 * the quit failed or Discord started itself again.
 */
export function discordRunningSummary(platform: NodeJS.Platform, afterQuit: boolean): string {
    const where = discordOpenLine(platform);
    if (!afterQuit) return `${where} ${UNINSTALL_COPY.cannotWhileOpen} ${UNINSTALL_COPY.nothingChanged}`;
    const remedy = platform === "win32" ? UNINSTALL_COPY.quitYourselfWindows : UNINSTALL_COPY.quitYourselfMac;
    return `${where} ${UNINSTALL_COPY.couldNotQuit} ${remedy} ${UNINSTALL_COPY.nothingChanged}`;
}

/** The refusal when the background helper could not be stopped. Names the remedy for this platform. */
export function helperStopFailedSummary(platform: NodeJS.Platform): string {
    const remedy = platform === "win32" ? UNINSTALL_COPY.helperStopRemedyWindows : UNINSTALL_COPY.helperStopRemedyMac;
    return `${UNINSTALL_COPY.helperStopFailed} ${remedy}`;
}

export interface UninstallStartView {
    title: string;
    detail: string;
    /** The filled button. Its `closeDiscord` is what the uninstall is asked to do. */
    primary: { label: string; closeDiscord: "ask" | null };
    settingsLabel: string;
    cancel: string;
}

/**
 * The first uninstall screen. Same pattern as the install's "Quit Discord for
 * me": when Discord is open, the main button quits it and goes on, rather
 * than letting the user press Remove and only then telling them.
 */
export function uninstallStartView(input: { platform: NodeJS.Platform; discordRunning: boolean }): UninstallStartView {
    return {
        title: UNINSTALL_COPY.confirmTitle,
        detail: input.discordRunning
            ? `${discordOpenLine(input.platform)} ${UNINSTALL_COPY.willQuit}`
            : UNINSTALL_COPY.confirmDetail,
        primary: input.discordRunning
            ? { label: UNINSTALL_COPY.quitAndRemove, closeDiscord: "ask" }
            : { label: UNINSTALL_COPY.remove, closeDiscord: null },
        settingsLabel: UNINSTALL_COPY.removeSettings,
        cancel: UNINSTALL_COPY.cancel
    };
}

/** The heading of the report screen. */
export function uninstallReportTitle(report: {
    clean: boolean;
    cancelled?: boolean;
    nothingChanged?: boolean;
    problems: readonly { code: string }[];
}): string {
    if (report.cancelled === true) return UNINSTALL_COPY.titleCancelled;
    if (report.clean) return UNINSTALL_COPY.titleRemoved;
    if (report.problems[0]?.code === "DISCORD_RUNNING") return UNINSTALL_COPY.titleDiscordOpen;
    if (report.nothingChanged === true) return UNINSTALL_COPY.titleNotRemoved;
    return UNINSTALL_COPY.titleNotFully;
}
