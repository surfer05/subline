/**
 * Whether the install flow may run, once Uninstall has been pressed (audit
 * 2026-10-06 #40).
 *
 * Uninstall stops the install flow for good, so a poll or a payment landing
 * cannot patch Discord in the middle of the restore. But a refusal that
 * changed nothing (Discord open, Cancel on the permission screen, a check that
 * failed) used to leave the window dead: nothing could be pressed without
 * quitting Subline. Such a report hands the window back; a report that
 * changed anything does not, because Discord may be half restored.
 */
export class UninstallSession {
    private started = false;

    /** Uninstall pressed: the install flow stops. */
    begin(): void {
        this.started = true;
    }

    /** Read the report. One that changed nothing gives the flow back. Returns the report. */
    finish<T extends { nothingChanged?: boolean }>(report: T): T {
        if (report.nothingChanged === true) this.started = false;
        return report;
    }

    /** May flow:start, flow:send or flow:restart run? */
    get mayDriveFlow(): boolean {
        return !this.started;
    }
}
