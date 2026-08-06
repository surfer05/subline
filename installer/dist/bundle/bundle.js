/**
 * The mod bundle, as the rest of the installer sees it.
 *
 * `spec.ts` holds the rules (and is shared verbatim with the build script);
 * this file is the thin layer that turns them into the `Result` every other
 * patcher export returns, plus the one destructive operation §8 needs.
 */
import { existsSync, rmSync } from "node:fs";
import { err, fsError, ok } from "../patcher/result.js";
import { inspectBundleDir, MOD_MANIFEST_FILENAME, manifestPathFor } from "./spec.js";
/**
 * Read a mod bundle and prove it is usable, not merely present.
 *
 * Every failure is one error code, `MOD_BUNDLE_INVALID`, with every problem
 * found named in the message: the caller's remedy is the same in all cases
 * (rebuild or re-download the bundle), and a build that is broken in four ways
 * should say so once rather than over four runs.
 */
export function inspectModBundle(bundleDir) {
    const facts = inspectBundleDir(bundleDir);
    if (facts.manifest === null || facts.problems.length > 0) {
        return err("MOD_BUNDLE_INVALID", `The Subline mod bundle at ${bundleDir} is not usable: ${facts.problems.join(" ")}`, { path: bundleDir });
    }
    const { manifest } = facts;
    return ok({
        dir: bundleDir,
        loaderPath: facts.loaderPath,
        buildId: manifest.buildId,
        pluginVersion: manifest.pluginVersion,
        vencordCommit: manifest.vencord.commit,
        vencordVersion: manifest.vencord.version,
        builtAt: manifest.builtAt,
        manifest
    });
}
/**
 * Delete an installed mod bundle — spec §8 step 4, "remove the bundled mod".
 *
 * REFUSES ANY DIRECTORY THAT IS NOT ONE OF OURS. This is a recursive delete
 * whose path comes from configuration, so the guard is not defensive politeness:
 * without it, a wrong or empty path would take whatever is there with it. A
 * directory without our manifest is somebody else's, and `ok(false)` — "nothing
 * of ours to remove" — is the honest answer for a bundle that was already gone.
 */
export function removeModBundle(bundleDir) {
    if (!existsSync(bundleDir))
        return ok(false);
    if (!existsSync(manifestPathFor(bundleDir))) {
        return err("MOD_BUNDLE_INVALID", `${bundleDir} has no ${MOD_MANIFEST_FILENAME}, so Subline will not delete it — it is not a mod bundle we installed.`, { path: bundleDir });
    }
    try {
        rmSync(bundleDir, { recursive: true, force: true });
    }
    catch (cause) {
        return fsError(cause, bundleDir, "remove the installed mod bundle");
    }
    return ok(true);
}
//# sourceMappingURL=bundle.js.map