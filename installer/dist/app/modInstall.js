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
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspectModBundle, removeModBundle } from "../bundle/bundle.js";
import { manifestPathFor } from "../bundle/spec.js";
import { err, fsError, ok } from "../patcher/result.js";
const STAGING_SUFFIX = ".subline-staging";
/**
 * Put the shipped bundle at its runtime location and return what is now there.
 *
 * The returned `loaderPath` is under `destDir`, and that is the value the caller
 * must patch with. Returning the *inspected destination* rather than echoing the
 * source is deliberate: it makes "we patched against the copy" a fact this
 * function observed, not a convention the caller is trusted to follow.
 */
export function installModBundle(options) {
    const { sourceDir, destDir } = options;
    // Validate the SOURCE before touching the destination. A broken shipped
    // bundle must not take out the working one already installed.
    const source = inspectModBundle(sourceDir);
    if (!source.ok)
        return source;
    if (destDir === sourceDir) {
        return err("MOD_BUNDLE_INVALID", "The mod bundle's source and runtime locations are the same directory. The bundle must be copied out of the app, or Discord would load it from a path that disappears when the app quits.", { path: destDir });
    }
    // Refuse to replace a directory that is not one of ours, for the same
    // reason `removeModBundle` does: this path comes from configuration and the
    // operation is a recursive delete.
    const replaced = existsSync(destDir);
    if (replaced && !existsSync(manifestPathFor(destDir))) {
        return err("MOD_BUNDLE_INVALID", `${destDir} already exists and is not a Subline mod bundle, so Subline will not replace it.`, { path: destDir });
    }
    const staging = `${destDir}${STAGING_SUFFIX}`;
    try {
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(dirname(destDir), { recursive: true });
        cpSync(sourceDir, staging, { recursive: true });
    }
    catch (cause) {
        rmSync(staging, { recursive: true, force: true });
        return fsError(cause, destDir, "copy the Subline mod into place");
    }
    // Check the COPY, before it becomes the live bundle. A truncated copy that
    // reached the runtime location would be found only by the patch that then
    // had to be rolled back.
    const staged = inspectModBundle(staging);
    if (!staged.ok) {
        rmSync(staging, { recursive: true, force: true });
        return err("MOD_BUNDLE_INVALID", `The Subline mod did not survive being copied to ${destDir}: ${staged.error.message}`, { path: destDir });
    }
    if (staged.value.buildId !== source.value.buildId) {
        rmSync(staging, { recursive: true, force: true });
        return err("MOD_BUNDLE_INVALID", `The copied Subline mod reports build ${staged.value.buildId} but the shipped one is ${source.value.buildId}.`, { path: destDir });
    }
    if (replaced) {
        const removed = removeModBundle(destDir);
        if (!removed.ok) {
            rmSync(staging, { recursive: true, force: true });
            return err(removed.error.code, removed.error.message, {
                path: destDir,
                cause: removed.error.cause
            });
        }
    }
    try {
        renameSync(staging, destDir);
    }
    catch (cause) {
        rmSync(staging, { recursive: true, force: true });
        return fsError(cause, destDir, "move the Subline mod into place");
    }
    // Read it once more from its final path, so `loaderPath` is the real one.
    const installed = inspectModBundle(destDir);
    if (!installed.ok)
        return installed;
    return ok({ ...installed.value, replaced });
}
/** Where the bundle ships inside a packaged app. */
export function shippedModDirFor(resourcesPath) {
    return join(resourcesPath, "mod");
}
//# sourceMappingURL=modInstall.js.map