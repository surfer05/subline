/**
 * A rename (or unlink) of Discord's files, retried on Windows while something
 * holds them for a moment (audit 2026-10-06 #16).
 *
 * Windows Defender and most third-party antivirus open a freshly written or
 * freshly renamed file to scan it. While they hold it, a rename of that file
 * fails with EPERM, EACCES or EBUSY. modInstall.ts already retried for the mod
 * folder; the patch itself did not, so a scan of the new stub failed the
 * install, and a second scan during the rollback could leave Discord without
 * an app.asar. Same delays as modInstall: about 3 s in all.
 *
 * Only on Windows. macOS renames open files freely, so an error there is real
 * and is returned at once.
 */

import { renameSync, unlinkSync } from "./realFs.js";

/** Errnos a Windows antivirus or indexer lock produces for a moment. */
const TRANSIENT_LOCK_ERRNOS = new Set(["EPERM", "EACCES", "EBUSY"]);
/** 100, 200, 400, 800, 1600 ms. */
export const LOCK_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400, 800, 1600];

export interface RetryHooks {
    /** The rename to use. Tests inject a failing one; production uses realFs. */
    rename?: (from: string, to: string) => void;
    unlink?: (path: string) => void;
    /** A blocking sleep. Tests inject a counter so nothing waits. */
    sleepSync?: (ms: number) => void;
    /** Decides whether a lock is retried. Defaults to the running platform. */
    platform?: NodeJS.Platform;
}

function blockingSleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errnoOf(cause: unknown): string | null {
    const code = (cause as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : null;
}

function retrying(op: () => void, hooks: RetryHooks): void {
    const platform = hooks.platform ?? process.platform;
    const sleep = hooks.sleepSync ?? blockingSleep;
    for (let attempt = 0; ; attempt++) {
        try {
            op();
            return;
        } catch (cause) {
            const delay = LOCK_RETRY_DELAYS_MS[attempt];
            if (platform !== "win32" || delay === undefined || !TRANSIENT_LOCK_ERRNOS.has(errnoOf(cause) ?? "")) throw cause;
            sleep(delay);
        }
    }
}

/** renameSync, retried on Windows while a lock clears. Throws the last error. */
export function renameRetrying(from: string, to: string, hooks: RetryHooks = {}): void {
    const rename = hooks.rename ?? renameSync;
    retrying(() => rename(from, to), hooks);
}

/** unlinkSync, retried the same way. Throws the last error. */
export function unlinkRetrying(path: string, hooks: RetryHooks = {}): void {
    const unlink = hooks.unlink ?? unlinkSync;
    retrying(() => unlink(path), hooks);
}
