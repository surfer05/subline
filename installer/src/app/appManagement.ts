/**
 * macOS App Management (spec §4) — the step this project keeps losing days to.
 *
 * ## Why this is not just "handle EPERM"
 *
 * Modifying `Discord.app` needs App Management, and our Team ID does not exempt
 * us: the exemption applies only when the modifier is signed by the same team as
 * the app being modified, or when the target ships an `NSUpdateSecurityPolicy`
 * authorising us. Discord does neither.
 *
 * Worse, it is not an Allow/Deny dialog. The write is BLOCKED, a notification
 * appears, and the user has to go to System Settings and flip a toggle. Spec §4:
 * "this is exactly the round trip that happened three times during development
 * and each time it read as a failure rather than a step."
 *
 * ## So the design, in the order the spec states it
 *
 *  1. **Anticipate.** `probeAppManagement` finds out BEFORE we start patching,
 *     by attempting one harmless write into the app bundle and removing it. The
 *     alternative — attempt the real patch and interpret the error — means the
 *     user meets the wall as a failed install.
 *  2. **Explain, then deep-link.** `APP_MANAGEMENT_SETTINGS_URL` opens the exact
 *     pane, not the top of System Settings.
 *  3. **Poll and continue automatically.** `awaitAppManagement` re-probes on an
 *     interval. Never "quit Subline and run it again": that is the step that
 *     turns into a dead end.
 *  4. **Waiting is not failing.** There is no timeout. `blocked` is polled
 *     until the grant or a Cancel; only a probe that keeps failing for some
 *     other reason (`unknown`) ends the wait with an error.
 *
 * ## The honest part
 *
 * macOS offers "Quit & Reopen" after the toggle is flipped. It is not needed:
 * field evidence (2026-09-24) is a user who chose Later and whose very next
 * probe returned granted. So the copy says to choose Later, and the poll does
 * the rest.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { errnoOf } from "../patcher/result.js";

/** The deep link spec §4 requires, verbatim. */
export const APP_MANAGEMENT_SETTINGS_URL =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles";

export type AppManagementStatus =
    /** Not macOS: there is no such gate. Windows needs no permission at all (§5). */
    | "not-required"
    /** We can write inside the app bundle. */
    | "granted"
    /** The write was refused — App Management, or a plain permission problem. */
    | "blocked"
    /** Something else went wrong; we cannot say either way. */
    | "unknown";

/** The name of the file the probe writes. Distinctive, so a leftover is identifiable. */
export const PROBE_FILENAME = ".subline-permission-probe";

/**
 * One verdict for several installs (uninstall restores EVERY Discord we ever
 * marked). The pessimistic fold: any `blocked` blocks, any `unknown` is unknown,
 * and only all-clear is clear. An empty list needs no permission at all.
 */
export function worstAppManagementStatus(statuses: readonly AppManagementStatus[]): AppManagementStatus {
    if (statuses.includes("blocked")) return "blocked";
    if (statuses.includes("unknown")) return "unknown";
    if (statuses.includes("granted")) return "granted";
    return "not-required";
}

export interface ProbeOptions {
    /** The directory holding `app.asar` — the thing we will actually be writing to. */
    resourcesPath: string;
    platform?: NodeJS.Platform;
    /** Injected by tests; production uses a real write-and-delete. */
    attemptWrite?: (path: string) => void;
    /**
     * Told why a probe came back `unknown`: the errno and message. The status
     * alone says only "not a permission refusal", and a log that cannot say
     * what DID happen turns debugging into guessing.
     */
    onUnknown?: (cause: string) => void;
}

/**
 * Can we modify this app bundle?
 *
 * The probe writes and immediately removes a file INSIDE the app bundle, because
 * that is precisely the operation TCC gates — checking `access()` or the
 * directory's mode would answer a different, easier question and answer it
 * wrongly, since App Management denies writes to directories the user owns.
 *
 * The file is removed on every path, including the failure paths, so a probe
 * never leaves anything behind in the app it was inspecting.
 */
export function probeAppManagement(options: ProbeOptions): AppManagementStatus {
    const platform = options.platform ?? process.platform;
    if (platform !== "darwin") return "not-required";

    const probePath = join(options.resourcesPath, PROBE_FILENAME);
    const attempt = options.attemptWrite ?? defaultAttemptWrite;
    try {
        attempt(probePath);
    } catch (cause) {
        const errno = errnoOf(cause);
        if (errno === "EPERM" || errno === "EACCES") return "blocked";
        options.onUnknown?.(`${errno ?? "no errno"}: ${cause instanceof Error ? cause.message : String(cause)}`);
        return "unknown";
    } finally {
        try {
            rmSync(probePath, { force: true });
        } catch {
            // Nothing to do: the write either failed (so there is no file) or
            // the same permission wall stops the cleanup, and the caller's
            // remedy is identical either way.
        }
    }
    return "granted";
}

function defaultAttemptWrite(path: string): void {
    writeFileSync(path, "subline permission probe\n", "utf8");
}

export interface AppManagementReport {
    status: AppManagementStatus;
    /** `granted` or `not-required` — i.e. it is safe to patch. */
    permitted: boolean;
    /** How many probes were made. */
    attempts: number;
    /** True when the caller stopped the wait (the user pressed Cancel). */
    cancelled: boolean;
    /**
     * True when the probe kept failing for a reason that is NOT "macOS is
     * blocking us" (`unknown`). The only way a wait ends without a grant or a
     * cancel, and the only one that earns an error screen.
     */
    failed: boolean;
    summary: string;
}

export const DEFAULT_PERMISSION_POLL_INTERVAL_MS = 1_000;
/** The slower pace once the user has clearly stepped away. */
export const DEFAULT_PERMISSION_SLOW_POLL_INTERVAL_MS = 3_000;
/** How long to poll at the fast pace before backing off. */
export const DEFAULT_PERMISSION_SLOW_AFTER_MS = 120_000;
/**
 * How many `unknown` probes IN A ROW end the wait with an error.
 *
 * `blocked` never ends it: that is macOS waiting for the toggle, and the
 * toggle is the user's to flip in their own time. `unknown` is an errno that
 * is not a permission refusal (the folder vanished, the disk went read-only),
 * and polling that forever would hide a real failure behind a spinner.
 */
export const MAX_CONSECUTIVE_UNKNOWN = 30;

/**
 * Which attempts get a log line: the first, then every 30th.
 *
 * The wait has no timeout, so one line per probe would be one line per second
 * for as long as someone leaves the window open. The result is logged
 * separately by the caller, so the count is never lost.
 */
export function isLoggedAttempt(attempt: number): boolean {
    return attempt === 1 || attempt % 30 === 0;
}

export interface AwaitAppManagementOptions {
    probe: () => AppManagementStatus;
    pollIntervalMs?: number;
    slowPollIntervalMs?: number;
    slowAfterMs?: number;
    maxConsecutiveUnknown?: number;
    sleep?: (ms: number) => Promise<void>;
    clock?: () => number;
    /**
     * Checked before every probe. True ends the wait with `cancelled`, and no
     * further probe is made, so a grant that lands after Cancel never starts
     * a patch nobody asked for any more.
     */
    isCancelled?: () => boolean;
    /** Called after every probe. Callers log through `isLoggedAttempt`. */
    onAttempt?: (status: AppManagementStatus, attempt: number) => void;
}

function describe(status: AppManagementStatus): string {
    if (status === "granted") return "macOS is allowing Subline to update Discord.";
    if (status === "not-required") return "This platform does not require permission to update Discord.";
    if (status === "unknown") {
        return "Subline could not check whether macOS allows it to update Discord.";
    }
    return "Waiting for permission to update Discord.";
}

function toReport(
    status: AppManagementStatus,
    attempts: number,
    flags: { cancelled?: boolean; failed?: boolean } = {}
): AppManagementReport {
    return {
        status,
        permitted: status === "granted" || status === "not-required",
        attempts,
        cancelled: flags.cancelled ?? false,
        failed: flags.failed ?? false,
        summary: describe(status)
    };
}

/**
 * Poll until permission arrives, spec §4's "continue automatically".
 *
 * NO TIMEOUT. Field log, 2026-09-24: the old two-minute limit expired while
 * the user was still in System Settings, and put a "Permission not granted"
 * error in front of them with a button to open the window they already had
 * open. They flipped the toggle, chose Later, pressed Try again, and the very
 * first probe said granted. Nothing about the grant needs a relaunch or a
 * deadline, so the wait simply lasts until the grant, a Cancel, or a probe
 * that keeps failing for some other reason.
 *
 * Returns a report in every case — there is no throw here, because every
 * outcome is a screen.
 */
export async function awaitAppManagement(options: AwaitAppManagementOptions): Promise<AppManagementReport> {
    const fast = options.pollIntervalMs ?? DEFAULT_PERMISSION_POLL_INTERVAL_MS;
    const slow = options.slowPollIntervalMs ?? DEFAULT_PERMISSION_SLOW_POLL_INTERVAL_MS;
    const slowAfter = options.slowAfterMs ?? DEFAULT_PERMISSION_SLOW_AFTER_MS;
    const maxUnknown = options.maxConsecutiveUnknown ?? MAX_CONSECUTIVE_UNKNOWN;
    const clock = options.clock ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const cancelled = options.isCancelled ?? (() => false);
    const startedAt = clock();

    let attempts = 0;
    let unknownRun = 0;
    let status: AppManagementStatus = "blocked";

    for (;;) {
        if (cancelled()) return toReport(status, attempts, { cancelled: true });
        status = options.probe();
        attempts += 1;
        options.onAttempt?.(status, attempts);

        if (status === "granted" || status === "not-required") return toReport(status, attempts);

        // `unknown` is polled too, for a while: the commonest cause is a
        // transient filesystem state. A long unbroken run of it is not.
        unknownRun = status === "unknown" ? unknownRun + 1 : 0;
        if (unknownRun >= maxUnknown) return toReport(status, attempts, { failed: true });

        await sleep(clock() - startedAt >= slowAfter ? slow : fast);
    }
}
