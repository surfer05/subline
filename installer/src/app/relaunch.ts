/**
 * Restarting into a newer bundle that appeared under a running app.
 *
 * OBSERVED: a newer `Subline.app` was written to disk (a local rebuild landing
 * on `release/mac-arm64/Subline.app`) while an older copy of the app was still
 * running. `open` on macOS does not launch a second copy — it re-activates the
 * process that is already there — so the window that came forward was the OLD
 * run, showing the OLD run's screen, and the only way to see the new build was
 * to quit and open it again by hand. Real users hit the same thing when they
 * download a newer installer over the old one while it is open: nothing looks
 * broken, it just silently is not the version they just downloaded.
 *
 * The identity we compare is the mod bundle's `buildId`, read out of
 * `<resources>/mod/subline-mod.json`: it changes on every build, and it is the
 * same id the installer records and verifies against, so "a different id" means
 * "a different bundle" with no version-string guesswork.
 *
 * BOTH SIDES MUST BE KNOWN. A null on either side is not evidence of anything:
 * it means the bundle could not be read at startup, or cannot be read now (a
 * half-written copy mid-download, a missing resources dir in a dev run). The
 * cost of guessing wrong is a relaunch loop, which is far worse than a stale
 * screen, so no evidence means do nothing.
 */
export function shouldRelaunchForNewerBundle(
    startedWith: string | null,
    onDisk: string | null
): boolean {
    if (typeof startedWith !== "string" || typeof onDisk !== "string") return false;
    return startedWith !== onDisk;
}
