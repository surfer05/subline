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
 *  4. **A denial is not a death.** Timing out returns a report, not an error,
 *     and the caller offers a retry.
 *
 * ## The honest part
 *
 * macOS sometimes wants an app restarted before a newly-granted App Management
 * right takes effect ("Quit & Reopen"). Polling picks the grant up without a
 * restart in the common case, but we cannot promise it always will — so after
 * `RELAUNCH_ADVICE_AFTER_ATTEMPTS` fruitless probes the report's `advice`
 * switches to `"relaunch"` and the UI says so. Telling the user to restart after
 * we have watched thirty seconds of nothing is not the dead end §4 forbids; it
 * is the only remaining true thing to say, and saying it beats polling forever
 * behind a spinner.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errnoOf } from "../patcher/result.js";
/** The deep link spec §4 requires, verbatim. */
export const APP_MANAGEMENT_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles";
/** The name of the file the probe writes. Distinctive, so a leftover is identifiable. */
export const PROBE_FILENAME = ".subline-permission-probe";
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
export function probeAppManagement(options) {
    const platform = options.platform ?? process.platform;
    if (platform !== "darwin")
        return "not-required";
    const probePath = join(options.resourcesPath, PROBE_FILENAME);
    const attempt = options.attemptWrite ?? defaultAttemptWrite;
    try {
        attempt(probePath);
    }
    catch (cause) {
        const errno = errnoOf(cause);
        if (errno === "EPERM" || errno === "EACCES")
            return "blocked";
        return "unknown";
    }
    finally {
        try {
            rmSync(probePath, { force: true });
        }
        catch {
            // Nothing to do: the write either failed (so there is no file) or
            // the same permission wall stops the cleanup, and the caller's
            // remedy is identical either way.
        }
    }
    return "granted";
}
function defaultAttemptWrite(path) {
    writeFileSync(path, "subline permission probe\n", "utf8");
}
export const DEFAULT_PERMISSION_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
/** After this many fruitless probes, stop implying that waiting alone will fix it. */
export const RELAUNCH_ADVICE_AFTER_ATTEMPTS = 30;
function describe(status, advice, timedOut) {
    if (status === "granted")
        return "macOS is allowing Subline to update Discord.";
    if (status === "not-required")
        return "This platform does not require permission to update Discord.";
    if (status === "unknown") {
        return "Subline could not tell whether macOS will allow it to update Discord. Try again, or pick Discord's location by hand.";
    }
    if (advice === "relaunch") {
        return "macOS is still blocking Subline from updating Discord. If you have already turned Subline on under Privacy & Security › App Management, quit Subline and open it again — macOS sometimes only applies the change to a fresh launch.";
    }
    return timedOut
        ? "macOS is blocking Subline from updating Discord. Open System Settings › Privacy & Security › App Management, turn Subline on, then try again."
        : "Waiting for permission to update Discord.";
}
function toReport(status, attempts, timedOut) {
    const permitted = status === "granted" || status === "not-required";
    const advice = !permitted && attempts >= RELAUNCH_ADVICE_AFTER_ATTEMPTS ? "relaunch" : "grant";
    return {
        status,
        permitted,
        attempts,
        advice,
        timedOut,
        summary: describe(status, advice, timedOut)
    };
}
/**
 * Poll until permission arrives, spec §4's "continue automatically".
 *
 * Returns a report in every case — there is no throw here, because every
 * outcome is a screen. A timeout leaves `permitted` false and the caller offers
 * retry; nothing about this makes the user start over.
 */
export async function awaitAppManagement(options) {
    const interval = options.pollIntervalMs ?? DEFAULT_PERMISSION_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    const clock = options.clock ?? Date.now;
    const sleep = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    const startedAt = clock();
    let attempts = 0;
    let status = options.probe();
    attempts += 1;
    options.onAttempt?.(status, attempts);
    // `unknown` is polled too: the commonest cause is a transient filesystem
    // state, and giving up on the first one would strand a user whose next
    // probe would have succeeded.
    while (status !== "granted" && status !== "not-required") {
        if (clock() - startedAt >= timeoutMs)
            return toReport(status, attempts, true);
        await sleep(interval);
        status = options.probe();
        attempts += 1;
        options.onAttempt?.(status, attempts);
    }
    return toReport(status, attempts, false);
}
//# sourceMappingURL=appManagement.js.map