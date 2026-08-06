/**
 * Applying and removing the patch.
 *
 * The one non-negotiable here: **never leave Discord in a broken state.**
 * Every write path either completes or rolls back, and every failure returns a
 * named error (spec §7) rather than throwing.
 *
 * Ordering is chosen to keep the window in which `app.asar` does not exist as
 * short as possible:
 *
 *   1. build the stub in memory and write it to a temp file in the same
 *      directory (so the final move is a same-filesystem rename)
 *   2. move Discord's original `app.asar` to `_app.asar`
 *   3. rename the temp file onto `app.asar`
 *   4. write the ownership marker
 *   5. read everything back and compare bytes
 *   6. on any mismatch, undo 2–4
 *
 * When the install is *already* stubbed (by us or by another mod the user
 * chose to replace), step 2 is skipped: the existing `_app.asar` is the true
 * original and must not be overwritten with someone else's stub. The old stub
 * is held in memory instead, which is what rollback restores.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectModBundle } from "../bundle/bundle.js";
import { markerPathFor, MARKER_FORMAT, readMarker, removeMarker, writeMarker } from "./marker.js";
import { err, fsError, ok } from "./result.js";
import { hasUnpackedAppDir, inspectInstall } from "./state.js";
import { buildStubAsar, readIsOriginalAsar, readStub, STUB_PACKAGE_JSON, stubIndexSource } from "./stub.js";
import { readDiscordVersion } from "./version.js";
const TEMP_FILENAME = ".subline-app.asar.tmp";
export function patchInstall(install, options) {
    // FIRST, before Discord is even looked at. The bundle is our own artefact:
    // if it is broken there is nothing to install, and finding that out after
    // moving Discord's app.asar would mean rolling back a patch we should never
    // have started.
    const bundleResult = inspectModBundle(options.modBundleDir);
    if (!bundleResult.ok)
        return bundleResult;
    const bundle = bundleResult.value;
    const stateResult = inspectInstall(install);
    if (!stateResult.ok)
        return stateResult;
    const state = stateResult.value;
    const guard = guardPatchable(state, options);
    if (guard)
        return guard;
    // "Nothing to do" requires the marker to agree about the BUILD too, not just
    // the path. The helper self-updates the bundle in place (spec §6), so a new
    // build routinely arrives behind an unchanged loaderPath — and short-
    // circuiting there would leave the marker naming the previous build's id,
    // which would then fail every verification of a perfectly good install.
    if (state.kind === "patched-by-us"
        && state.loaderPath === bundle.loaderPath
        && state.marker?.pluginBuildId === bundle.buildId) {
        return ok({
            install,
            loaderPath: bundle.loaderPath,
            pluginBuildId: bundle.buildId,
            backupPath: install.backupPath,
            markerPath: markerPathFor(install.resourcesPath),
            backupCreated: false,
            alreadyPatched: true,
            replacedMod: null,
            discordVersion: state.marker?.discordVersion ?? null,
            previousState: state.kind,
            bundle
        });
    }
    return applyPatch(install, state, options, bundle);
}
/** All the reasons we refuse to touch an install, each with its own named error. */
function guardPatchable(state, options) {
    if (state.kind === "broken") {
        return err("BROKEN_INSTALL", state.summary, { path: state.install.rootPath });
    }
    if (state.kind === "patched-by-other") {
        // BetterDiscord's unpacked resources/app directory takes precedence over
        // app.asar in Electron's module resolution, so patching the archive
        // underneath it would apply cleanly and then silently do nothing —
        // exactly the failure mode §7 says we must not ship.
        if (hasUnpackedAppDir(state.install.resourcesPath)) {
            return err("FOREIGN_MOD_PRESENT", `${state.modName ?? "Another client mod"} loads from an unpacked resources/app folder, which Discord uses in preference to app.asar. Uninstall it first — patching over it would appear to work and do nothing.`, { path: state.install.resourcesPath });
        }
        if (!options.overwriteForeignMod) {
            return err("FOREIGN_MOD_PRESENT", `${state.modName ?? "Another client mod"} is already installed here. Continuing will replace it and may disable its plugins.`, { path: state.install.rootPath });
        }
    }
    return null;
}
function applyPatch(install, state, options, bundle) {
    const { asarPath, backupPath, resourcesPath } = install;
    const markerPath = markerPathFor(resourcesPath);
    const tempPath = join(resourcesPath, TEMP_FILENAME);
    const identity = { loaderPath: bundle.loaderPath, buildId: bundle.buildId };
    // Discord's version goes into the marker so the helper can notice updates.
    const buildInfo = readDiscordVersion(install);
    const discordVersion = buildInfo.ok ? buildInfo.value.version : null;
    // Derived from what `app.asar` actually *is*, never from the state label:
    // an unparseable foreign stub still must not be moved into `_app.asar`.
    const currentIsOriginal = !state.asarIsStub;
    const stub = buildStubAsar(identity.loaderPath);
    const undo = {
        previousAsar: null,
        backupCreated: false,
        previousMarker: null,
        markerExisted: existsSync(markerPath)
    };
    try {
        if (undo.markerExisted)
            undo.previousMarker = readFileSync(markerPath);
        if (!currentIsOriginal)
            undo.previousAsar = readFileSync(asarPath);
    }
    catch (cause) {
        return fsError(cause, asarPath, "read the current Discord files");
    }
    // 1. Stage the new archive beside the target.
    try {
        writeFileSync(tempPath, stub);
    }
    catch (cause) {
        return fsError(cause, tempPath, "write the new app.asar");
    }
    // 2. Preserve the original, but only when the current archive *is* the
    //    original. An existing _app.asar is Discord's real code and outranks
    //    whatever stub is sitting in app.asar right now.
    if (currentIsOriginal) {
        try {
            renameSync(asarPath, backupPath);
            undo.backupCreated = true;
        }
        catch (cause) {
            discard(tempPath);
            return fsError(cause, asarPath, "back up Discord's original app.asar");
        }
    }
    // 3. Move the staged archive into place.
    try {
        renameSync(tempPath, asarPath);
    }
    catch (cause) {
        const rolled = rollback(install, undo, tempPath);
        if (!rolled.ok)
            return rolled;
        return fsError(cause, asarPath, "install the new app.asar");
    }
    // 4. Record ownership.
    const marker = {
        format: MARKER_FORMAT,
        product: "subline",
        productVersion: options.productVersion,
        loaderPath: identity.loaderPath,
        pluginBuildId: identity.buildId,
        discordVersion,
        backupPath,
        patchedAt: new Date().toISOString()
    };
    const markerWrite = writeMarker(resourcesPath, marker);
    if (!markerWrite.ok) {
        const rolled = rollback(install, undo, tempPath);
        if (!rolled.ok)
            return rolled;
        return markerWrite;
    }
    options.hooks?.afterWrite?.({ asarPath, backupPath, markerPath });
    // 5. Read back what we wrote. "The file was written" is not evidence (spec §7).
    const verification = verifyPatch(install, identity, stub);
    if (!verification.ok) {
        const rolled = rollback(install, undo, tempPath);
        if (!rolled.ok)
            return rolled;
        return err("VERIFICATION_FAILED", `${verification.error.message} Discord was restored to how it was before.`, { path: asarPath, cause: verification.error.cause });
    }
    return ok({
        install,
        loaderPath: identity.loaderPath,
        pluginBuildId: identity.buildId,
        backupPath,
        markerPath,
        backupCreated: undo.backupCreated,
        alreadyPatched: false,
        replacedMod: state.kind === "patched-by-other" ? state.mod : null,
        discordVersion,
        previousState: state.kind,
        bundle
    });
}
/** Read the patch back off disk and prove it is exactly what we meant to write. */
export function verifyPatch(install, expected, expectedBytes) {
    const { loaderPath, buildId } = expected;
    let actual;
    try {
        actual = readFileSync(install.asarPath);
    }
    catch (cause) {
        return fsError(cause, install.asarPath, "read back the patched app.asar");
    }
    if (expectedBytes && !actual.equals(expectedBytes)) {
        return err("VERIFICATION_FAILED", "The patched app.asar does not match what was written.", {
            path: install.asarPath
        });
    }
    const stub = readStub(install.asarPath);
    if (!stub.ok) {
        return err("VERIFICATION_FAILED", `The patched app.asar is unreadable (${stub.error.message})`, {
            path: install.asarPath
        });
    }
    if (stub.value === null) {
        return err("VERIFICATION_FAILED", "The patched app.asar is not the loader stub.", {
            path: install.asarPath
        });
    }
    if (stub.value.loaderPath !== loaderPath) {
        return err("VERIFICATION_FAILED", `The patched app.asar loads ${stub.value.loaderPath ?? "nothing"} instead of ${loaderPath}.`, { path: install.asarPath });
    }
    if (stub.value.packageJson !== STUB_PACKAGE_JSON || stub.value.indexSource !== stubIndexSource(loaderPath)) {
        return err("VERIFICATION_FAILED", "The patched app.asar contents are not what was written.", {
            path: install.asarPath
        });
    }
    if (!existsSync(install.backupPath)) {
        return err("VERIFICATION_FAILED", "Discord's original app.asar backup is missing after patching.", {
            path: install.backupPath
        });
    }
    const backupIsOriginal = readIsOriginalAsar(install.backupPath);
    if (!backupIsOriginal.ok || !backupIsOriginal.value) {
        return err("VERIFICATION_FAILED", "The preserved _app.asar is not Discord's original archive.", {
            path: install.backupPath
        });
    }
    const marker = readMarker(install.resourcesPath);
    if (!marker.ok) {
        return err("VERIFICATION_FAILED", `The patch marker is unreadable (${marker.error.message})`, {
            path: markerPathFor(install.resourcesPath)
        });
    }
    if (marker.value === null || marker.value.loaderPath !== loaderPath) {
        return err("VERIFICATION_FAILED", "The patch marker is missing or points at a different loader.", {
            path: markerPathFor(install.resourcesPath)
        });
    }
    // The marker's build id is what post-install verification will compare the
    // beacon against. A marker that landed with the wrong one (or none) would
    // make every later verification of a healthy install fail, and the moment to
    // catch that is here, while the patch can still be rolled back.
    if (marker.value.pluginBuildId !== buildId) {
        return err("VERIFICATION_FAILED", `The patch marker records build ${marker.value.pluginBuildId ?? "none"} instead of ${buildId}.`, { path: markerPathFor(install.resourcesPath) });
    }
    return ok(true);
}
/**
 * Put everything back. A failure here is the only outcome worse than a failed
 * patch, so it gets its own loud error code with the backup's location in it.
 */
function rollback(install, undo, tempPath) {
    discard(tempPath);
    try {
        if (undo.previousAsar !== null) {
            writeFileSync(install.asarPath, undo.previousAsar);
        }
        else if (undo.backupCreated) {
            renameSync(install.backupPath, install.asarPath);
        }
    }
    catch (cause) {
        return err("ROLLBACK_FAILED", `Patching failed and Discord could not be restored automatically. Its original app.asar is at ${install.backupPath} — move it back to ${install.asarPath}, or reinstall Discord.`, { path: install.asarPath, cause });
    }
    try {
        if (undo.markerExisted && undo.previousMarker !== null) {
            writeFileSync(markerPathFor(install.resourcesPath), undo.previousMarker);
        }
        else {
            const removed = removeMarker(install.resourcesPath);
            if (!removed.ok)
                return removed;
        }
    }
    catch (cause) {
        return fsError(cause, markerPathFor(install.resourcesPath), "restore the patch marker");
    }
    return ok(true);
}
function discard(path) {
    try {
        if (existsSync(path))
            unlinkSync(path);
    }
    catch {
        // A stranded temp file is cosmetic; never let it mask the real error.
    }
}
export function unpatchInstall(install, options = {}) {
    const stateResult = inspectInstall(install);
    if (!stateResult.ok)
        return stateResult;
    const state = stateResult.value;
    switch (state.kind) {
        case "unpatched":
            return cleanUpUnpatched(install, state);
        case "broken":
            return unpatchBroken(install, state);
        case "patched-by-other":
            if (!options.removeForeignMod) {
                return err("FOREIGN_MOD_PRESENT", `Subline is not installed here — ${state.modName ?? "another client mod"} is. Remove it with its own uninstaller.`, { path: install.rootPath });
            }
            return restoreOriginal(install, state);
        case "patched-by-us":
            return restoreOriginal(install, state);
    }
}
function cleanUpUnpatched(install, state) {
    const removed = [];
    // Only clear a leftover _app.asar when our own marker proves we made it.
    // Another mod's backup is not ours to delete.
    const ours = state.marker !== null;
    if (ours && state.hasBackup) {
        try {
            unlinkSync(install.backupPath);
            removed.push(install.backupPath);
        }
        catch (cause) {
            return fsError(cause, install.backupPath, "remove the leftover _app.asar");
        }
    }
    const markerRemoved = removeMarker(install.resourcesPath);
    if (!markerRemoved.ok)
        return markerRemoved;
    if (markerRemoved.value)
        removed.push(markerPathFor(install.resourcesPath));
    return ok({
        install,
        restored: false,
        alreadyClean: removed.length === 0,
        removedArtifacts: removed,
        previousState: state.kind,
        summary: removed.length === 0
            ? "Discord is already unmodified; there was nothing to remove."
            : "Discord was already unmodified; leftover Subline files were removed."
    });
}
function unpatchBroken(install, state) {
    switch (state.reason) {
        // All three are "put the original back if it is there". restoreOriginal
        // finishes an interrupted patch when `_app.asar` survived, and reports
        // BACKUP_MISSING when it did not — one code path, one message.
        case "asar-missing-backup-present":
        case "our-patch-without-backup":
        case "asar-and-backup-missing":
            return restoreOriginal(install, state);
        default:
            return err("BROKEN_INSTALL", state.summary, { path: install.rootPath });
    }
}
function restoreOriginal(install, state) {
    if (!existsSync(install.backupPath)) {
        return err("BACKUP_MISSING", `Discord's original app.asar backup (${install.backupPath}) is missing, so Subline cannot restore it. Use Discord's own repair or reinstall it — do not delete anything by hand.`, { path: install.backupPath });
    }
    // Refuse to move a corrupt backup over a working-ish install.
    const backupIsOriginal = readIsOriginalAsar(install.backupPath);
    if (!backupIsOriginal.ok) {
        return err("BACKUP_CORRUPT", `Discord's backup at ${install.backupPath} is not a readable archive (${backupIsOriginal.error.message}) Nothing was changed; reinstall Discord to repair it.`, { path: install.backupPath });
    }
    if (!backupIsOriginal.value) {
        return err("BACKUP_CORRUPT", `Discord's backup at ${install.backupPath} is another loader stub, not Discord's original code. Nothing was changed; reinstall Discord to repair it.`, { path: install.backupPath });
    }
    try {
        renameSync(install.backupPath, install.asarPath);
    }
    catch (cause) {
        return fsError(cause, install.asarPath, "restore Discord's original app.asar");
    }
    const removed = [];
    const markerRemoved = removeMarker(install.resourcesPath);
    if (!markerRemoved.ok)
        return markerRemoved;
    if (markerRemoved.value)
        removed.push(markerPathFor(install.resourcesPath));
    // Read back: the same standard we hold the patch to.
    const restored = readIsOriginalAsar(install.asarPath);
    if (!restored.ok || !restored.value) {
        return err("VERIFICATION_FAILED", `Discord's app.asar was restored but does not look like the original. Reinstall Discord to be sure.`, { path: install.asarPath });
    }
    if (existsSync(install.backupPath)) {
        return err("VERIFICATION_FAILED", "The backup file is still present after restoring.", {
            path: install.backupPath
        });
    }
    return ok({
        install,
        restored: true,
        alreadyClean: false,
        removedArtifacts: removed,
        previousState: state.kind,
        summary: "Discord's original app.asar was restored."
    });
}
//# sourceMappingURL=patch.js.map