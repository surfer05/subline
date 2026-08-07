/**
 * Telling the user about something the helper could not fix.
 *
 * Spec §6 makes both triggers **silent**, and that is right: nobody wants a
 * dialog because Discord updated. But silence has a boundary. A failure the
 * helper cannot repair — a patch that failed and rolled back, a missing backup, a
 * download that will not verify, a mod that has stopped rendering — must reach
 * the user somewhere they will actually see, not only a log file nobody knows
 * exists.
 *
 * ## Two surfaces, because either alone fails
 *
 *  1. **A system notification.** Seen immediately — and missed entirely if the
 *     Mac is in Do Not Disturb, or asleep, or the user is not at it. A
 *     notification is not a record.
 *  2. **A durable alert file** in Subline's own directory, which the app reads
 *     and shows on the next open. This is the one that survives being missed.
 *
 * ## Not crying wolf is part of the contract
 *
 * Spec §6: an updater that warns falsely gets ignored when it warns truthfully.
 * So:
 *
 *  - an alert is raised at most once per `DEFAULT_REPEAT_MS`, however many times
 *    its condition is observed;
 *  - `resolve()` clears an alert the moment its condition goes away, so a
 *    transient failure leaves nothing behind for the app to show;
 *  - and the *messages are fixed strings* with only scalars interpolated. This
 *    module composes text that goes to a notification centre and to a file, and
 *    spec §7's rule — never message text — applies to it exactly as it applies to
 *    the log.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Result } from "../patcher/result.js";
import { fsError, ok } from "../patcher/result.js";
import type { AlertMemory, HelperState } from "./state.js";

export const ALERTS_FILENAME = "alerts.json";
export const ALERTS_FORMAT = 1;

/**
 * Every condition the helper can surface. A closed set, because each one has its
 * own sentence and its own remedy — spec §7's "a specific, named error state, not
 * a generic failure".
 */
export type AlertCode =
    /** Re-patching failed and Discord was put back as it was. */
    | "repatch-failed"
    /** Re-patching failed AND the rollback failed. The loud one. */
    | "rollback-failed"
    /** Discord's original archive is gone, so we cannot repair or remove anything. */
    | "backup-missing"
    /** Update checks keep failing, or a download will not verify. */
    | "update-failed"
    /** The mod loads, translates, and renders nothing — and there is no new build. */
    | "mod-stale";

export interface Alert {
    code: AlertCode;
    /** One sentence, shown verbatim. Fixed text plus scalars only. */
    message: string;
    /** Scalars for the log and the app: versions, counts, codes. Never text. */
    detail: Record<string, string | number | boolean | null>;
    at: number;
}

/** How long before the same unresolved condition is worth notifying about again. */
export const DEFAULT_REPEAT_MS = 24 * 60 * 60 * 1000;

export interface AlertPorts {
    /** Show a system notification. Failure to notify is never fatal. */
    notify(alert: Alert): Promise<void>;
    /** Subline's per-user directory, or `null` on a platform we do not support. */
    productDir: string | null;
    now(): number;
}

export function alertsPathFor(productDir: string): string {
    return join(productDir, ALERTS_FILENAME);
}

export interface AlertRaised {
    alert: Alert;
    /** True when a notification was actually shown (rather than suppressed as a repeat). */
    notified: boolean;
    /** Why it was or was not shown — for the log. */
    reason: string;
}

/**
 * Record an alert, and notify unless we have said the same thing recently.
 *
 * Mutates `state.alerts`; the caller persists the state. Returns what happened
 * so the run report can say it out loud.
 */
export async function raiseAlert(
    state: HelperState,
    alert: Alert,
    ports: AlertPorts,
    repeatMs: number = DEFAULT_REPEAT_MS
): Promise<AlertRaised> {
    const previous: AlertMemory | undefined = state.alerts[alert.code];
    const dueAgain = previous === undefined || alert.at - previous.lastNotifiedAt >= repeatMs;

    state.alerts[alert.code] = {
        firstAt: previous?.firstAt ?? alert.at,
        lastNotifiedAt: dueAgain ? alert.at : previous.lastNotifiedAt,
        count: (previous?.count ?? 0) + 1
    };

    // The durable surface is written EVERY time, even when the notification is
    // suppressed: the file is what the app shows, and suppressing the popup must
    // not suppress the record.
    writePendingAlerts(state, ports);

    if (!dueAgain) {
        return {
            alert,
            notified: false,
            reason: `already notified about ${alert.code} within the last ${Math.round(repeatMs / 3_600_000)}h`
        };
    }

    try {
        await ports.notify(alert);
    } catch {
        // A notification that will not display is not a reason to fail a helper
        // run, and the alert file has the same content.
        return { alert, notified: false, reason: "the system notification could not be shown" };
    }
    return { alert, notified: true, reason: "notified" };
}

/**
 * Clear an alert whose condition no longer holds.
 *
 * Returns whether anything was cleared. This is what makes a transient failure
 * transient: the app must not still be showing "the update could not be
 * downloaded" a week after the download succeeded.
 */
export function resolveAlert(state: HelperState, code: AlertCode, ports: AlertPorts): boolean {
    if (state.alerts[code] === undefined) return false;
    delete state.alerts[code];
    writePendingAlerts(state, ports);
    return true;
}

/** The alerts currently outstanding, newest first. */
export function pendingAlertCodes(state: HelperState): AlertCode[] {
    return (Object.keys(state.alerts) as AlertCode[]).sort(
        (a, b) => (state.alerts[b]?.firstAt ?? 0) - (state.alerts[a]?.firstAt ?? 0)
    );
}

interface PendingAlertsFile {
    format: number;
    product: "subline";
    updatedAt: number;
    alerts: { code: string; firstAt: number; lastNotifiedAt: number; count: number }[];
}

function writePendingAlerts(state: HelperState, ports: AlertPorts): Result<boolean> {
    if (ports.productDir === null) return ok(false);
    const path = alertsPathFor(ports.productDir);

    const entries = Object.entries(state.alerts);
    if (entries.length === 0) {
        // An empty file would be indistinguishable from a file we failed to
        // write. Absent means "nothing outstanding".
        try {
            if (existsSync(path)) rmSync(path, { force: true });
        } catch (cause) {
            return fsError<boolean>(cause, path, `remove ${ALERTS_FILENAME}`);
        }
        return ok(true);
    }

    const document: PendingAlertsFile = {
        format: ALERTS_FORMAT,
        product: "subline",
        updatedAt: ports.now(),
        alerts: entries.map(([code, memory]) => ({
            code,
            firstAt: memory.firstAt,
            lastNotifiedAt: memory.lastNotifiedAt,
            count: memory.count
        }))
    };

    const temp = `${path}.tmp`;
    try {
        mkdirSync(ports.productDir, { recursive: true });
        writeFileSync(temp, `${JSON.stringify(document, null, 4)}\n`, "utf8");
        renameSync(temp, path);
    } catch (cause) {
        return fsError<boolean>(cause, path, `write ${ALERTS_FILENAME}`);
    }
    return ok(true);
}

/** What the app reads on launch to show what happened while it was closed. */
export function readPendingAlerts(productDir: string | null): { code: string; firstAt: number; count: number }[] {
    if (productDir === null) return [];
    try {
        const parsed: unknown = JSON.parse(readFileSync(alertsPathFor(productDir), "utf8"));
        if (typeof parsed !== "object" || parsed === null) return [];
        const alerts = (parsed as { alerts?: unknown }).alerts;
        if (!Array.isArray(alerts)) return [];
        return alerts.flatMap(entry => {
            if (typeof entry !== "object" || entry === null) return [];
            const record = entry as Record<string, unknown>;
            if (typeof record.code !== "string" || typeof record.firstAt !== "number") return [];
            return [{
                code: record.code,
                firstAt: record.firstAt,
                count: typeof record.count === "number" ? record.count : 1
            }];
        });
    } catch {
        return [];
    }
}
