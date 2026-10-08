/**
 * What the helper said while the app was closed, as the app shows it.
 *
 * alerts.ts writes alerts.json as the durable half of every alert: a
 * notification missed under Do Not Disturb or sleep is gone, and this file is
 * the record that survives it. Until 0.2.3 nothing read it (audit 2026-10-06
 * #29 and #33): the IPC handler existed, the preload did not expose it, and
 * the renderer never asked. This is the mapping the renderer draws from.
 *
 * Pure and DOM-free, so it is tested in Node. Fixed sentences only: the file
 * carries codes, never text, so nothing in it can become copy.
 */

/** The screens that show pending alerts. */
export type PendingAlertScreen = "welcome" | "already-installed";

/**
 * One sentence per code. Codes not listed are not shown: restart-required and
 * quit-required are about a Discord that is open right now and repeat as a
 * notification while they hold; update-failed retries on its own.
 */
export const PENDING_ALERT_COPY = {
    "repatch-failed": "Discord updated and Subline could not turn itself back on. Press Continue to repair it.",
    "rollback-failed": "Subline could not repair Discord after an update. Reinstall Discord, then run Subline again.",
    "backup-missing": "Discord's original files are gone, so Subline cannot repair it. Reinstall Discord, then run Subline again.",
    "mod-stale": "Subline is translating but nothing reaches Discord's screen. Discord has probably changed, and a Subline update is not out yet.",
    "bundle-missing": "Subline's files are missing. Press Continue to put them back.",
    "discord-unstartable": "Discord cannot start until Subline repairs it. Press Continue to repair it.",
    "shadowed": "Another client mod was installed after Subline and loads in front of it, so Discord ignores Subline."
} as const;

type ShownCode = keyof typeof PENDING_ALERT_COPY;

/**
 * Codes about the patch itself. "Subline is already set up" is reached only
 * when the patch is in place and verified, so those alerts are already out of
 * date on that screen (the helper's next run clears them). Saying "repair it"
 * beside "there is nothing left to do" would contradict the screen.
 */
const PATCH_CODES: readonly ShownCode[] = ["repatch-failed", "rollback-failed", "backup-missing", "bundle-missing", "discord-unstartable"];

/** The sentences to show on `screen`, in the order the alerts were raised, each once. */
export function pendingAlertLines(
    alerts: readonly { code: string }[],
    screen: PendingAlertScreen
): string[] {
    const lines: string[] = [];
    for (const { code } of alerts) {
        if (!Object.hasOwn(PENDING_ALERT_COPY, code)) continue;
        const shown = code as ShownCode;
        if (screen === "already-installed" && PATCH_CODES.includes(shown)) continue;
        const line = PENDING_ALERT_COPY[shown];
        if (!lines.includes(line)) lines.push(line);
    }
    return lines;
}
