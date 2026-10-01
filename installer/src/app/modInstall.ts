/**
 * Copying the mod bundle to where it will actually live (spec §2, `layout.ts`).
 *
 * THE POINT OF THIS FILE. The bundle ships inside the app; it must not RUN from
 * inside the app. `layout.ts` sets out why at length, and the short version is
 * that the loader path is a literal absolute path baked into Discord's
 * `app.asar`: under Gatekeeper's App Translocation a quarantined app runs from a
 * randomised read-only mount that disappears on quit, so a stub pointing inside
 * the app bundle would leave DISCORD UNABLE TO START — not "translation stops",
 * a broken Discord with a stub nobody can explain.
 *
 * So the flow copies here first, and `patchInstall` is pointed at the copy.
 * `bundling.md` names this as the missing step that kept the loader path a
 * developer path.
 *
 * The copy is staged and swapped rather than written in place. A half-copied
 * bundle at the runtime location is the worst possible artefact: `patchInstall`
 * would refuse it, but a bundle already referenced by an existing patch would
 * take Discord down with it until the next successful install.
 *
 * THE SWAP HAS A ROLLBACK. It used to delete the live bundle and THEN rename
 * the new one into place. On Windows an antivirus scanning the fresh staging
 * folder makes that rename fail with EPERM or EBUSY, and the user was left
 * with no bundle at all: Discord's stub still require()s <dest>/patcher.js,
 * so Discord would not start ("Cannot find module ...patcher.js"). Now the
 * live bundle is renamed aside to `<dest>.subline-old`, the new one renamed
 * in, and the old one put back if anything fails. The aside copy is deleted
 * only once the new bundle inspects OK. If even the put-back fails, the next
 * install (or the helper, which runs at login) restores it first.
 */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { inspectModBundle } from "../bundle/bundle.js";
import type { ModBundle } from "../bundle/bundle.js";
import { manifestPathFor, MOD_MANIFEST_FILENAME } from "../bundle/spec.js";
import type { Result } from "../patcher/result.js";
import { err, errnoOf, fsError, ok } from "../patcher/result.js";

/**
 * Fault-injection seam, mirroring `PatchOptions.hooks.afterWrite`.
 *
 * The staged copy is checked before it is promoted, and a valid source copied by
 * `cpSync` always produces a valid copy — so the failure the check exists for
 * cannot be reached from outside. Without a seam, that check is unfalsifiable:
 * a mutation deleting its cleanup left the suite green. Production callers never
 * pass this.
 */
export interface InstallModBundleHooks {
    /** Runs after the bundle is staged, immediately before it is inspected. */
    afterStage?: (stagingDir: string) => void;
    /** Replaces the blocking sleep between rename retries, so tests do not wait. */
    sleepSync?: (ms: number) => void;
}

export interface InstallModBundleOptions {
    /** The bundle shipped inside the app — `Subline.app/Contents/Resources/mod`. */
    sourceDir: string;
    /** Where it must end up — `~/Library/Application Support/Subline/mod`. */
    destDir: string;
    hooks?: InstallModBundleHooks;
    /** Decides whether a locked rename is retried (Windows only). Defaults to the running platform. */
    platform?: NodeJS.Platform;
}

export interface InstalledModBundle extends ModBundle {
    /** True when a previous bundle was replaced. */
    replaced: boolean;
}

const STAGING_SUFFIX = ".subline-staging";
/** Where the live bundle waits while a new one is swapped in. */
export const OLD_SUFFIX = ".subline-old";

/** Errnos a Windows antivirus or indexer lock produces for a moment. */
const TRANSIENT_LOCK_ERRNOS = new Set(["EPERM", "EACCES", "EBUSY"]);
/** 100, 200, 400, 800, 1600 ms: about 3 s in all, longer than a typical scan of a fresh folder. */
const RENAME_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600];

function blockingSleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * renameSync, retried on Windows while something holds the folder for a moment.
 * Throws the last error when it never succeeds. Exported for the tests.
 */
export function renameWithRetry(
    from: string,
    to: string,
    platform: NodeJS.Platform = process.platform,
    sleep: (ms: number) => void = blockingSleep
): void {
    for (let attempt = 0; ; attempt++) {
        try {
            renameSync(from, to);
            return;
        } catch (cause) {
            const delay = RENAME_RETRY_DELAYS_MS[attempt];
            if (platform !== "win32" || delay === undefined || !TRANSIENT_LOCK_ERRNOS.has(errnoOf(cause) ?? "")) throw cause;
            sleep(delay);
        }
    }
}

/**
 * Put back a bundle a failed swap left aside.
 *
 * Runs before every install and before the helper reads the bundle: the only
 * state it acts on is "no bundle at `destDir`, a good one at
 * `destDir.subline-old`", which only an interrupted swap produces. Discord's
 * stub cannot heal itself, so this is what keeps it starting. Returns whether
 * it restored anything.
 */
export function recoverModBundle(destDir: string, platform: NodeJS.Platform = process.platform): Result<boolean> {
    const old = `${destDir}${OLD_SUFFIX}`;
    if (existsSync(destDir) || !existsSync(old)) return ok(false);
    if (!inspectModBundle(old).ok) return ok(false);
    try {
        renameWithRetry(old, destDir, platform);
    } catch (cause) {
        return fsError<boolean>(cause, destDir, "put the previous Subline mod back", platform);
    }
    return ok(true);
}

/**
 * Put the shipped bundle at its runtime location and return what is now there.
 *
 * The returned `loaderPath` is under `destDir`, and that is the value the caller
 * must patch with. Returning the *inspected destination* rather than echoing the
 * source is deliberate: it makes "we patched against the copy" a fact this
 * function observed, not a convention the caller is trusted to follow.
 */
export function installModBundle(options: InstallModBundleOptions): Result<InstalledModBundle> {
    const { sourceDir, destDir } = options;

    // Validate the SOURCE before touching the destination. A broken shipped
    // bundle must not take out the working one already installed.
    const source = inspectModBundle(sourceDir);
    if (!source.ok) return source;

    if (destDir === sourceDir) {
        return err<InstalledModBundle>(
            "MOD_BUNDLE_INVALID",
            "The mod bundle's source and runtime locations are the same directory. The bundle must be copied out of the app, or Discord would load it from a path that disappears when the app quits.",
            { path: destDir }
        );
    }

    const platform = options.platform ?? process.platform;
    const sleep = options.hooks?.sleepSync;
    const rename = (from: string, to: string): void => renameWithRetry(from, to, platform, sleep);

    // An earlier swap that could not put the old bundle back left it aside.
    // Restore it before anything else, so "replaced" below sees the truth.
    recoverModBundle(destDir, platform);

    const replaced = existsSync(destDir);
    // A directory that is not one of ours is never replaced. This is the one
    // place that refuses it now that the swap no longer goes through
    // removeModBundle (its guard is the same check).
    if (replaced && !existsSync(manifestPathFor(destDir))) {
        return err<InstalledModBundle>(
            "MOD_BUNDLE_INVALID",
            `${destDir} has no ${MOD_MANIFEST_FILENAME}, so Subline will not delete it. It is not a mod bundle we installed.`,
            { path: destDir }
        );
    }

    const staging = `${destDir}${STAGING_SUFFIX}`;
    try {
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(dirname(destDir), { recursive: true });
        cpSync(sourceDir, staging, { recursive: true });
    } catch (cause) {
        rmSync(staging, { recursive: true, force: true });
        return fsError<InstalledModBundle>(cause, destDir, "copy the Subline mod into place", platform);
    }

    options.hooks?.afterStage?.(staging);

    // Check the COPY, before it becomes the live bundle. A truncated copy that
    // reached the runtime location would be found only by the patch that then
    // had to be rolled back.
    const staged = inspectModBundle(staging);
    if (!staged.ok) {
        rmSync(staging, { recursive: true, force: true });
        return err<InstalledModBundle>(
            "MOD_BUNDLE_INVALID",
            `The Subline mod did not survive being copied to ${destDir}: ${staged.error.message}`,
            { path: destDir }
        );
    }
    if (staged.value.buildId !== source.value.buildId) {
        rmSync(staging, { recursive: true, force: true });
        return err<InstalledModBundle>(
            "MOD_BUNDLE_INVALID",
            `The copied Subline mod reports build ${staged.value.buildId} but the shipped one is ${source.value.buildId}.`,
            { path: destDir }
        );
    }

    const old = `${destDir}${OLD_SUFFIX}`;
    const discardStaging = (): void => {
        try { rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    /** Put the live bundle back. Returns the cause when that ALSO failed. */
    const restoreOld = (): string | null => {
        try {
            if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
            rename(old, destDir);
            return null;
        } catch (cause) {
            return `${errnoOf(cause) ?? "no errno"}: ${cause instanceof Error ? cause.message : String(cause)}`;
        }
    };
    const withRollbackCause = (failed: Result<InstalledModBundle>, rollback: string | null): Result<InstalledModBundle> => {
        if (failed.ok || rollback === null) return failed;
        // Both causes, so the log says what happened (the old bundle stays at
        // `.subline-old` and the next install or helper run puts it back).
        return { ok: false, error: { ...failed.error, cause: `${failed.error.cause ?? "no cause"}; putting the old mod back also failed (${rollback}), it is kept at ${old}` } };
    };

    // 1. The live bundle aside. If THIS fails nothing has changed yet.
    if (replaced) {
        try { rmSync(old, { recursive: true, force: true }); } catch { /* a stale aside copy; the rename reports it */ }
        try {
            rename(destDir, old);
        } catch (cause) {
            discardStaging();
            return fsError<InstalledModBundle>(cause, destDir, "move the old Subline mod aside", platform);
        }
    }

    // 2. The new one in. On failure the old one goes straight back.
    try {
        rename(staging, destDir);
    } catch (cause) {
        discardStaging();
        const failed = fsError<InstalledModBundle>(cause, destDir, "move the Subline mod into place", platform);
        return withRollbackCause(failed, replaced ? restoreOld() : null);
    }

    // 3. Read it once more from its final path, so `loaderPath` is the real one.
    const installed = inspectModBundle(destDir);
    if (!installed.ok) return withRollbackCause(installed, replaced ? restoreOld() : null);

    // 4. Only now is the old one finished with. Failing to delete it is not a
    //    failed install: the next install removes it first.
    if (replaced) {
        try { rmSync(old, { recursive: true, force: true, maxRetries: 5 }); } catch { /* left for the next install */ }
    }
    return ok({ ...installed.value, replaced });
}

/** Where the bundle ships inside a packaged app. */
export function shippedModDirFor(resourcesPath: string): string {
    return join(resourcesPath, "mod");
}
