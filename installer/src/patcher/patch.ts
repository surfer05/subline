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

import type { DiscordInstall } from "./locate.js";
import { markerPathFor, MARKER_FORMAT, readMarker, removeMarker, writeMarker } from "./marker.js";
import type { PatchMarker } from "./marker.js";
import type { Result } from "./result.js";
import { err, fsError, ok } from "./result.js";
import { hasUnpackedAppDir, inspectInstall } from "./state.js";
import type { InstallState, InstallStateKind, KnownMod } from "./state.js";
import { buildStubAsar, readIsOriginalAsar, readStub, STUB_PACKAGE_JSON, stubIndexSource } from "./stub.js";
import { readDiscordVersion } from "./version.js";

const TEMP_FILENAME = ".subline-app.asar.tmp";

/** Fault-injection seam. Only tests pass these; production callers never do. */
export interface PatchHooks {
    /** Runs after the stub and marker are in place, immediately before verification. */
    afterWrite?: (paths: { asarPath: string; backupPath: string; markerPath: string }) => void;
}

export interface PatchOptions {
    /** Absolute path to our built loader JS — what the stub will `require()`. */
    loaderPath: string;
    /** Installer version, recorded in the marker. */
    productVersion: string;
    /**
     * Patch over another mod. Spec §3 step 4: detect, explain, let them choose —
     * so this is never the default, it is the user's answer.
     */
    overwriteForeignMod?: boolean;
    hooks?: PatchHooks;
}

export interface PatchReport {
    install: DiscordInstall;
    loaderPath: string;
    backupPath: string;
    markerPath: string;
    /** True when Discord's original archive was moved to `_app.asar` during this run. */
    backupCreated: boolean;
    /** True when the install already carried this exact patch and nothing was written. */
    alreadyPatched: boolean;
    /** The mod we were asked to replace, when there was one. */
    replacedMod: KnownMod | null;
    discordVersion: string | null;
    previousState: InstallStateKind;
}

export function patchInstall(install: DiscordInstall, options: PatchOptions): Result<PatchReport> {
    const stateResult = inspectInstall(install);
    if (!stateResult.ok) return stateResult;
    const state = stateResult.value;

    const guard = guardPatchable(state, options);
    if (guard) return guard;

    if (state.kind === "patched-by-us" && state.loaderPath === options.loaderPath) {
        return ok({
            install,
            loaderPath: options.loaderPath,
            backupPath: install.backupPath,
            markerPath: markerPathFor(install.resourcesPath),
            backupCreated: false,
            alreadyPatched: true,
            replacedMod: null,
            discordVersion: state.marker?.discordVersion ?? null,
            previousState: state.kind
        });
    }

    return applyPatch(install, state, options);
}

/** All the reasons we refuse to touch an install, each with its own named error. */
function guardPatchable(state: InstallState, options: PatchOptions): Result<PatchReport> | null {
    if (state.kind === "broken") {
        return err<PatchReport>("BROKEN_INSTALL", state.summary, { path: state.install.rootPath });
    }

    if (state.kind === "patched-by-other") {
        // BetterDiscord's unpacked resources/app directory takes precedence over
        // app.asar in Electron's module resolution, so patching the archive
        // underneath it would apply cleanly and then silently do nothing —
        // exactly the failure mode §7 says we must not ship.
        if (hasUnpackedAppDir(state.install.resourcesPath)) {
            return err<PatchReport>(
                "FOREIGN_MOD_PRESENT",
                `${state.modName ?? "Another client mod"} loads from an unpacked resources/app folder, which Discord uses in preference to app.asar. Uninstall it first — patching over it would appear to work and do nothing.`,
                { path: state.install.resourcesPath }
            );
        }
        if (!options.overwriteForeignMod) {
            return err<PatchReport>(
                "FOREIGN_MOD_PRESENT",
                `${state.modName ?? "Another client mod"} is already installed here. Continuing will replace it and may disable its plugins.`,
                { path: state.install.rootPath }
            );
        }
    }

    return null;
}

interface Undo {
    /** Bytes of the `app.asar` we replaced, when it was a stub small enough to hold. */
    previousAsar: Buffer | null;
    /** True when we moved the original archive to `_app.asar` and can move it back. */
    backupCreated: boolean;
    /** Bytes of a marker file we overwrote, so a re-point can be undone exactly. */
    previousMarker: Buffer | null;
    markerExisted: boolean;
}

function applyPatch(install: DiscordInstall, state: InstallState, options: PatchOptions): Result<PatchReport> {
    const { asarPath, backupPath, resourcesPath } = install;
    const markerPath = markerPathFor(resourcesPath);
    const tempPath = join(resourcesPath, TEMP_FILENAME);

    // Discord's version goes into the marker so the helper can notice updates.
    const buildInfo = readDiscordVersion(install);
    const discordVersion = buildInfo.ok ? buildInfo.value.version : null;

    // Derived from what `app.asar` actually *is*, never from the state label:
    // an unparseable foreign stub still must not be moved into `_app.asar`.
    const currentIsOriginal = !state.asarIsStub;
    const stub = buildStubAsar(options.loaderPath);

    const undo: Undo = {
        previousAsar: null,
        backupCreated: false,
        previousMarker: null,
        markerExisted: existsSync(markerPath)
    };

    try {
        if (undo.markerExisted) undo.previousMarker = readFileSync(markerPath);
        if (!currentIsOriginal) undo.previousAsar = readFileSync(asarPath);
    } catch (cause) {
        return fsError<PatchReport>(cause, asarPath, "read the current Discord files");
    }

    // 1. Stage the new archive beside the target.
    try {
        writeFileSync(tempPath, stub);
    } catch (cause) {
        return fsError<PatchReport>(cause, tempPath, "write the new app.asar");
    }

    // 2. Preserve the original, but only when the current archive *is* the
    //    original. An existing _app.asar is Discord's real code and outranks
    //    whatever stub is sitting in app.asar right now.
    if (currentIsOriginal) {
        try {
            renameSync(asarPath, backupPath);
            undo.backupCreated = true;
        } catch (cause) {
            discard(tempPath);
            return fsError<PatchReport>(cause, asarPath, "back up Discord's original app.asar");
        }
    }

    // 3. Move the staged archive into place.
    try {
        renameSync(tempPath, asarPath);
    } catch (cause) {
        const rolled = rollback(install, undo, tempPath);
        if (!rolled.ok) return rolled;
        return fsError<PatchReport>(cause, asarPath, "install the new app.asar");
    }

    // 4. Record ownership.
    const marker: PatchMarker = {
        format: MARKER_FORMAT,
        product: "subline",
        productVersion: options.productVersion,
        loaderPath: options.loaderPath,
        discordVersion,
        backupPath,
        patchedAt: new Date().toISOString()
    };
    const markerWrite = writeMarker(resourcesPath, marker);
    if (!markerWrite.ok) {
        const rolled = rollback(install, undo, tempPath);
        if (!rolled.ok) return rolled;
        return markerWrite;
    }

    options.hooks?.afterWrite?.({ asarPath, backupPath, markerPath });

    // 5. Read back what we wrote. "The file was written" is not evidence (spec §7).
    const verification = verifyPatch(install, options.loaderPath, stub);
    if (!verification.ok) {
        const rolled = rollback(install, undo, tempPath);
        if (!rolled.ok) return rolled;
        return err<PatchReport>(
            "VERIFICATION_FAILED",
            `${verification.error.message} Discord was restored to how it was before.`,
            { path: asarPath, cause: verification.error.cause }
        );
    }

    return ok({
        install,
        loaderPath: options.loaderPath,
        backupPath,
        markerPath,
        backupCreated: undo.backupCreated,
        alreadyPatched: false,
        replacedMod: state.kind === "patched-by-other" ? state.mod : null,
        discordVersion,
        previousState: state.kind
    });
}

/** Read the patch back off disk and prove it is exactly what we meant to write. */
export function verifyPatch(install: DiscordInstall, loaderPath: string, expected?: Buffer): Result<true> {
    let actual: Buffer;
    try {
        actual = readFileSync(install.asarPath);
    } catch (cause) {
        return fsError<true>(cause, install.asarPath, "read back the patched app.asar");
    }

    if (expected && !actual.equals(expected)) {
        return err<true>("VERIFICATION_FAILED", "The patched app.asar does not match what was written.", {
            path: install.asarPath
        });
    }

    const stub = readStub(install.asarPath);
    if (!stub.ok) {
        return err<true>("VERIFICATION_FAILED", `The patched app.asar is unreadable (${stub.error.message})`, {
            path: install.asarPath
        });
    }
    if (stub.value === null) {
        return err<true>("VERIFICATION_FAILED", "The patched app.asar is not the loader stub.", {
            path: install.asarPath
        });
    }
    if (stub.value.loaderPath !== loaderPath) {
        return err<true>(
            "VERIFICATION_FAILED",
            `The patched app.asar loads ${stub.value.loaderPath ?? "nothing"} instead of ${loaderPath}.`,
            { path: install.asarPath }
        );
    }
    if (stub.value.packageJson !== STUB_PACKAGE_JSON || stub.value.indexSource !== stubIndexSource(loaderPath)) {
        return err<true>("VERIFICATION_FAILED", "The patched app.asar contents are not what was written.", {
            path: install.asarPath
        });
    }

    if (!existsSync(install.backupPath)) {
        return err<true>("VERIFICATION_FAILED", "Discord's original app.asar backup is missing after patching.", {
            path: install.backupPath
        });
    }
    const backupIsOriginal = readIsOriginalAsar(install.backupPath);
    if (!backupIsOriginal.ok || !backupIsOriginal.value) {
        return err<true>("VERIFICATION_FAILED", "The preserved _app.asar is not Discord's original archive.", {
            path: install.backupPath
        });
    }

    const marker = readMarker(install.resourcesPath);
    if (!marker.ok) {
        return err<true>("VERIFICATION_FAILED", `The patch marker is unreadable (${marker.error.message})`, {
            path: markerPathFor(install.resourcesPath)
        });
    }
    if (marker.value === null || marker.value.loaderPath !== loaderPath) {
        return err<true>("VERIFICATION_FAILED", "The patch marker is missing or points at a different loader.", {
            path: markerPathFor(install.resourcesPath)
        });
    }

    return ok(true);
}

/**
 * Put everything back. A failure here is the only outcome worse than a failed
 * patch, so it gets its own loud error code with the backup's location in it.
 */
function rollback(install: DiscordInstall, undo: Undo, tempPath: string): Result<true> {
    discard(tempPath);

    try {
        if (undo.previousAsar !== null) {
            writeFileSync(install.asarPath, undo.previousAsar);
        } else if (undo.backupCreated) {
            renameSync(install.backupPath, install.asarPath);
        }
    } catch (cause) {
        return err<true>(
            "ROLLBACK_FAILED",
            `Patching failed and Discord could not be restored automatically. Its original app.asar is at ${install.backupPath} — move it back to ${install.asarPath}, or reinstall Discord.`,
            { path: install.asarPath, cause }
        );
    }

    try {
        if (undo.markerExisted && undo.previousMarker !== null) {
            writeFileSync(markerPathFor(install.resourcesPath), undo.previousMarker);
        } else {
            const removed = removeMarker(install.resourcesPath);
            if (!removed.ok) return removed;
        }
    } catch (cause) {
        return fsError<true>(cause, markerPathFor(install.resourcesPath), "restore the patch marker");
    }

    return ok(true);
}

function discard(path: string): void {
    try {
        if (existsSync(path)) unlinkSync(path);
    } catch {
        // A stranded temp file is cosmetic; never let it mask the real error.
    }
}

export interface UnpatchOptions {
    /**
     * Remove another mod's patch. Off by default — restoring Discord out from
     * under Vencord is not something to do without the user saying so.
     */
    removeForeignMod?: boolean;
}

export interface UnpatchReport {
    install: DiscordInstall;
    /** True when Discord's original archive was moved back into place. */
    restored: boolean;
    /** True when there was nothing of ours to remove. */
    alreadyClean: boolean;
    removedArtifacts: string[];
    previousState: InstallStateKind;
    /** One sentence the GUI can show verbatim. */
    summary: string;
}

export function unpatchInstall(install: DiscordInstall, options: UnpatchOptions = {}): Result<UnpatchReport> {
    const stateResult = inspectInstall(install);
    if (!stateResult.ok) return stateResult;
    const state = stateResult.value;

    switch (state.kind) {
        case "unpatched":
            return cleanUpUnpatched(install, state);

        case "broken":
            return unpatchBroken(install, state);

        case "patched-by-other":
            if (!options.removeForeignMod) {
                return err<UnpatchReport>(
                    "FOREIGN_MOD_PRESENT",
                    `Subline is not installed here — ${state.modName ?? "another client mod"} is. Remove it with its own uninstaller.`,
                    { path: install.rootPath }
                );
            }
            return restoreOriginal(install, state);

        case "patched-by-us":
            return restoreOriginal(install, state);
    }
}

function cleanUpUnpatched(install: DiscordInstall, state: InstallState): Result<UnpatchReport> {
    const removed: string[] = [];

    // Only clear a leftover _app.asar when our own marker proves we made it.
    // Another mod's backup is not ours to delete.
    const ours = state.marker !== null;
    if (ours && state.hasBackup) {
        try {
            unlinkSync(install.backupPath);
            removed.push(install.backupPath);
        } catch (cause) {
            return fsError<UnpatchReport>(cause, install.backupPath, "remove the leftover _app.asar");
        }
    }

    const markerRemoved = removeMarker(install.resourcesPath);
    if (!markerRemoved.ok) return markerRemoved;
    if (markerRemoved.value) removed.push(markerPathFor(install.resourcesPath));

    return ok({
        install,
        restored: false,
        alreadyClean: removed.length === 0,
        removedArtifacts: removed,
        previousState: state.kind,
        summary:
            removed.length === 0
                ? "Discord is already unmodified; there was nothing to remove."
                : "Discord was already unmodified; leftover Subline files were removed."
    });
}

function unpatchBroken(install: DiscordInstall, state: InstallState): Result<UnpatchReport> {
    switch (state.reason) {
        // All three are "put the original back if it is there". restoreOriginal
        // finishes an interrupted patch when `_app.asar` survived, and reports
        // BACKUP_MISSING when it did not — one code path, one message.
        case "asar-missing-backup-present":
        case "our-patch-without-backup":
        case "asar-and-backup-missing":
            return restoreOriginal(install, state);
        default:
            return err<UnpatchReport>("BROKEN_INSTALL", state.summary, { path: install.rootPath });
    }
}

function restoreOriginal(install: DiscordInstall, state: InstallState): Result<UnpatchReport> {
    if (!existsSync(install.backupPath)) {
        return err<UnpatchReport>(
            "BACKUP_MISSING",
            `Discord's original app.asar backup (${install.backupPath}) is missing, so Subline cannot restore it. Use Discord's own repair or reinstall it — do not delete anything by hand.`,
            { path: install.backupPath }
        );
    }

    // Refuse to move a corrupt backup over a working-ish install.
    const backupIsOriginal = readIsOriginalAsar(install.backupPath);
    if (!backupIsOriginal.ok) {
        return err<UnpatchReport>(
            "BACKUP_CORRUPT",
            `Discord's backup at ${install.backupPath} is not a readable archive (${backupIsOriginal.error.message}) Nothing was changed; reinstall Discord to repair it.`,
            { path: install.backupPath }
        );
    }
    if (!backupIsOriginal.value) {
        return err<UnpatchReport>(
            "BACKUP_CORRUPT",
            `Discord's backup at ${install.backupPath} is another loader stub, not Discord's original code. Nothing was changed; reinstall Discord to repair it.`,
            { path: install.backupPath }
        );
    }

    try {
        renameSync(install.backupPath, install.asarPath);
    } catch (cause) {
        return fsError<UnpatchReport>(cause, install.asarPath, "restore Discord's original app.asar");
    }

    const removed: string[] = [];
    const markerRemoved = removeMarker(install.resourcesPath);
    if (!markerRemoved.ok) return markerRemoved;
    if (markerRemoved.value) removed.push(markerPathFor(install.resourcesPath));

    // Read back: the same standard we hold the patch to.
    const restored = readIsOriginalAsar(install.asarPath);
    if (!restored.ok || !restored.value) {
        return err<UnpatchReport>(
            "VERIFICATION_FAILED",
            `Discord's app.asar was restored but does not look like the original. Reinstall Discord to be sure.`,
            { path: install.asarPath }
        );
    }
    if (existsSync(install.backupPath)) {
        return err<UnpatchReport>("VERIFICATION_FAILED", "The backup file is still present after restoring.", {
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
