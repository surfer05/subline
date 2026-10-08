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
 *   2. make `_app.asar` a second name (a hard link, or a copy) for Discord's
 *      original `app.asar`. `app.asar` is never moved away, so there is no
 *      moment at which it does not exist (audit 2026-10-06 #10: a kill between
 *      two renames used to leave a Discord that could not start)
 *   3. rename the temp file onto `app.asar`, replacing it in one step
 *   4. write the ownership marker
 *   5. read everything back and compare bytes
 *   6. on any mismatch, undo 2–4
 *
 * When the install is *already* stubbed (by us or by another mod the user
 * chose to replace), step 2 is skipped: the existing `_app.asar` is the true
 * original and must not be overwritten with someone else's stub. The old stub
 * is held in memory instead, which is what rollback restores.
 */

// realFs, NOT node:fs: Electron treats any ".asar" path as a virtual archive to
// mount rather than a file, so the rename, the stub write and the verify
// read-back all misbehave inside the packaged app. See realFs.ts.
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, writeFileSync } from "./realFs.js";
import { renameRetrying, unlinkRetrying } from "./retry.js";
import type { RetryHooks } from "./retry.js";
import { join } from "node:path";

import { inspectModBundle } from "../bundle/bundle.js";
import type { ModBundle } from "../bundle/bundle.js";
import type { DiscordInstall } from "./locate.js";
import { markerPathFor, MARKER_FORMAT, readMarker, removeMarker, writeMarker } from "./marker.js";
import type { PatchMarker } from "./marker.js";
import type { Result } from "./result.js";
import { err, fsError, ok, rewrap } from "./result.js";
import { sameLoaderPath } from "./ownership.js";
import { hasUnpackedAppDir, inspectInstall } from "./state.js";
import type { InstallState, InstallStateKind, KnownMod } from "./state.js";
import { buildStubAsar, readIsOriginalAsar, readStub, STUB_PACKAGE_JSON, stubFormOf } from "./stub.js";
import { readDiscordVersion } from "./version.js";

const TEMP_FILENAME = ".subline-app.asar.tmp";

/** Fault-injection seam. Only tests pass these; production callers never do. */
export interface PatchHooks extends RetryHooks {
    /** Runs after the stub and marker are in place, immediately before verification. */
    afterWrite?: (paths: { asarPath: string; backupPath: string; markerPath: string }) => void;
    /** Runs after the backup is made and before the stub is moved into place. */
    afterBackup?: (paths: { asarPath: string; backupPath: string }) => void;
    /** The backup step. Tests inject a failing link to exercise the copy. */
    link?: (from: string, to: string) => void;
}

export interface PatchOptions {
    /**
     * The built mod bundle to install — a directory, not a file.
     *
     * BOTH the loader path and the build id are DERIVED from it, and neither can
     * be supplied by the caller. That is the whole design of this option:
     *
     *  - `loaderPath` is `<dir>/patcher.js`, so the stub cannot be pointed at
     *    one bundle while the marker records another's identity.
     *  - `buildId` is read out of the bundle's manifest and confirmed against
     *    the stamp compiled into its renderer, so the installer OBSERVES which
     *    build it is installing instead of ASSERTING it.
     *
     * The hole this closes: a caller that passed the right bundle and a stale id
     * produced a perfectly working install that every later verification read as
     * `foreign-beacon` — a dead-looking report for live code. There is no
     * argument here that can be got wrong, because there is no argument.
     */
    modBundleDir: string;
    /** Installer version, recorded in the marker. */
    productVersion: string;
    /**
     * Patch over another mod. Spec §3 step 4: detect, explain, let them choose —
     * so this is never the default, it is the user's answer.
     */
    overwriteForeignMod?: boolean;
    hooks?: PatchHooks;
}

/** What a patch claims to be, and what verification holds it to. */
export interface PatchIdentity {
    loaderPath: string;
    buildId: string;
}

export interface PatchReport {
    install: DiscordInstall;
    loaderPath: string;
    /**
     * The build id recorded in the marker — hand this to `verifyOnce` as
     * `expectedBuildId`, so post-install verification checks the beacon against
     * the build this very patch installed rather than against a guess.
     */
    pluginBuildId: string;
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
    /**
     * What was actually installed, as read from the bundle itself — plugin
     * version and the upstream Vencord commit included, which is what spec §7's
     * diagnostics header and §6's "which build are we shipping" both need.
     */
    bundle: ModBundle;
}

export function patchInstall(install: DiscordInstall, options: PatchOptions): Result<PatchReport> {
    // FIRST, before Discord is even looked at. The bundle is our own artefact:
    // if it is broken there is nothing to install, and finding that out after
    // moving Discord's app.asar would mean rolling back a patch we should never
    // have started.
    const bundleResult = inspectModBundle(options.modBundleDir);
    if (!bundleResult.ok) return bundleResult;
    const bundle = bundleResult.value;

    const stateResult = inspectInstall(install, { ownLoaderPaths: [bundle.loaderPath] });
    if (!stateResult.ok) return stateResult;

    // AN INTERRUPTED PATCH IS FINISHED, NOT REFUSED (audit 2026-10-06 #26,
    // #44). app.asar gone and _app.asar there is what a kill between the two
    // renames leaves, and what Vencord's host-update hook leaves when Discord
    // is closed mid-copy. Discord cannot start like that. When _app.asar is
    // provably Discord's own, it is put back first (so a patch that then fails
    // still leaves a Discord that starts), and the patch runs as on any
    // unpatched Discord.
    let state = stateResult.value;
    if (state.kind === "broken" && state.reason === "asar-missing-backup-present") {
        const resumed = putBackInterrupted(install, bundle.loaderPath, options.hooks);
        if (!resumed.ok) return resumed;
        state = resumed.value;
    }

    const guard = guardPatchable(state, options);
    if (guard) return guard;

    // "Nothing to do" requires the marker to agree about the BUILD too, not just
    // the path. The helper self-updates the bundle in place (spec §6), so a new
    // build routinely arrives behind an unchanged loaderPath — and short-
    // circuiting there would leave the marker naming the previous build's id,
    // which would then fail every verification of a perfectly good install.
    // A missing or disagreeing marker is never "nothing to do": the marker is
    // what the helper and every later verification read, so it is rewritten.
    // An older stub FORM is not "nothing to do" either (audit #4): the
    // installer runs with Discord closed, so it is the moment to upgrade it.
    const rewrite = markerRewriteReason(state, bundle);
    if (
        state.kind === "patched-by-us"
        && sameLoader(state.loaderPath, bundle.loaderPath)
        && rewrite === null
        && state.stubForm === "current"
    ) {
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

    // OUR stub, already loading this bundle, with only the marker missing or
    // wrong: write the marker and leave app.asar alone (a rename over it fails
    // on Windows while Discord runs, and there is nothing to change in it).
    // OUR CURRENT stub, already loading this bundle, with only the marker
    // missing, wrong, stale, or naming the previous build (a Subline-only
    // update, audit #31): write the marker and leave app.asar alone. An older
    // stub form goes through the full patch below, which rewrites it.
    if (state.kind === "patched-by-us" && rewrite !== null && sameLoader(state.loaderPath, bundle.loaderPath) && state.stubForm === "current") {
        const adopted = adoptPatch(install, { modBundleDir: options.modBundleDir, productVersion: options.productVersion });
        if (adopted.ok) {
            return ok({
                install,
                loaderPath: adopted.value.loaderPath,
                pluginBuildId: adopted.value.pluginBuildId,
                backupPath: install.backupPath,
                markerPath: adopted.value.markerPath,
                backupCreated: false,
                alreadyPatched: false,
                replacedMod: null,
                discordVersion: adopted.value.discordVersion,
                previousState: state.kind,
                bundle
            });
        }
        // Anything off (a damaged stub or backup): the full patch below decides.
    }

    return applyPatch(install, state, options, bundle);
}

/** Our stub with no marker, or a marker that spells or names the loader differently, or describes another folder. */
export function needsMarkerRewrite(state: InstallState): boolean {
    return markerRewriteReason(state) !== null;
}

export type MarkerRewriteReason = "marker-missing" | "marker-mismatch" | "marker-stale";

/**
 * Why only the marker beside our stub needs writing, or null. With a bundle,
 * a marker naming another build of the SAME loader is stale too: a Subline
 * update behind an unchanged loader path changes nothing Discord reads.
 */
export function markerRewriteReason(state: InstallState, bundle?: PatchIdentity): MarkerRewriteReason | null {
    if (state.kind !== "patched-by-us") return null;
    if (state.warnings.includes("marker-missing")) return "marker-missing";
    if (state.warnings.includes("marker-mismatch")) return "marker-mismatch";
    if (state.warnings.includes("marker-stale")) return "marker-stale";
    if (
        bundle !== undefined
        && state.marker !== null
        && sameLoader(state.loaderPath, bundle.loaderPath)
        && state.marker.pluginBuildId !== bundle.buildId
    ) return "marker-stale";
    return null;
}

/**
 * Finish what an interrupted patch left: put Discord's original back as
 * app.asar, and report the install as it now is. Only when _app.asar is
 * provably Discord's own code; a stub there (a stale foreign backup) is
 * refused, never moved into place.
 */
function putBackInterrupted(install: DiscordInstall, ownLoader: string, hooks: RetryHooks = {}): Result<InstallState> {
    const backup = readIsOriginalAsar(install.backupPath);
    if (!backup.ok || !backup.value) {
        return err<InstallState>(
            "BROKEN_INSTALL",
            "Discord's app.asar is missing and the copy beside it is not Discord's original, so Subline cannot repair it. Reinstall Discord.",
            { path: install.backupPath }
        );
    }
    discard(join(install.resourcesPath, TEMP_FILENAME), hooks);
    try {
        renameRetrying(install.backupPath, install.asarPath, hooks);
    } catch (cause) {
        return fsError<InstallState>(cause, install.asarPath, "put Discord's original app.asar back");
    }
    return inspectInstall(install, { ownLoaderPaths: [ownLoader] });
}

export interface AdoptOptions {
    /** The installed mod bundle; the loader path and build id are read from it, as in patchInstall. */
    modBundleDir: string;
    /** Installer version, recorded in the marker. */
    productVersion: string;
}

export interface AdoptReport {
    install: DiscordInstall;
    loaderPath: string;
    pluginBuildId: string;
    markerPath: string;
    discordVersion: string | null;
    /** Why the marker was rewritten: missing, disagreeing with the stub, or describing another folder or build. */
    warning: MarkerRewriteReason;
}

/**
 * RE-ADOPT our own stub: write the marker beside it, and touch nothing else.
 *
 * For an install whose app.asar already loads THIS bundle's loader (byte for
 * byte the stub we write, either form) and whose _app.asar is Discord's
 * original, but whose marker is missing or wrong. That is exactly what
 * Vencord's host-update repatch leaves in a new Windows app-x.y.z folder. Only
 * the marker is written, never app.asar, so it is safe while Discord is
 * running (Windows locks app.asar, not the folder). Anything else (a stub that
 * loads another Subline path, a damaged stub or backup) is refused with
 * NOT_ADOPTABLE and goes through a full patch instead.
 */
export function adoptPatch(install: DiscordInstall, options: AdoptOptions): Result<AdoptReport> {
    const bundleResult = inspectModBundle(options.modBundleDir);
    if (!bundleResult.ok) return bundleResult;
    const bundle = bundleResult.value;

    const stateResult = inspectInstall(install, { ownLoaderPaths: [bundle.loaderPath] });
    if (!stateResult.ok) return stateResult;
    const state = stateResult.value;
    const warning = markerRewriteReason(state, bundle);
    if (state.kind !== "patched-by-us" || warning === null || !sameLoader(state.loaderPath, bundle.loaderPath)) {
        return err<AdoptReport>(
            "NOT_ADOPTABLE",
            state.kind !== "patched-by-us"
                ? `This install is not carrying Subline's stub with a usable backup (${state.kind}).`
                : warning === null
                    ? "The marker already agrees with the stub."
                    : `The stub loads ${state.loaderPath ?? "nothing"}, not this bundle's loader, so it needs a full patch.`,
            { path: install.rootPath }
        );
    }

    // The stub and the backup are checked BEFORE the marker is touched: a
    // damaged one is refused with nothing written, and goes through a full
    // patch instead.
    const stubAndBackup = verifyStubAndBackup(install, bundle.loaderPath);
    if (!stubAndBackup.ok) {
        return rewrap<AdoptReport>(stubAndBackup.error, {
            code: "NOT_ADOPTABLE",
            message: `${stubAndBackup.error.message} It needs a full patch.`,
            path: install.rootPath
        });
    }

    const markerPath = markerPathFor(install.resourcesPath);
    let previousMarker: Buffer | null = null;
    try {
        if (existsSync(markerPath)) previousMarker = readFileSync(markerPath);
    } catch (cause) {
        return fsError<AdoptReport>(cause, markerPath, "read the patch marker");
    }

    const buildInfo = readDiscordVersion(install);
    const discordVersion = buildInfo.ok ? buildInfo.value.version : null;
    const written = writeMarker(install.resourcesPath, {
        format: MARKER_FORMAT,
        product: "subline",
        productVersion: options.productVersion,
        // The stub's own spelling, so the marker agrees with it exactly.
        loaderPath: state.loaderPath ?? bundle.loaderPath,
        pluginBuildId: bundle.buildId,
        discordVersion,
        backupPath: install.backupPath,
        patchedAt: new Date().toISOString()
    });
    if (!written.ok) return written;

    // Same standard as a patch: read everything back, and undo on a mismatch.
    const verified = verifyPatch(install, { loaderPath: bundle.loaderPath, buildId: bundle.buildId });
    if (!verified.ok) {
        try {
            if (previousMarker !== null) writeFileSync(markerPath, previousMarker);
            else removeMarker(install.resourcesPath);
        } catch {
            // The marker is a sidecar: Discord starts either way.
        }
        return rewrap<AdoptReport>(verified.error, {
            code: "VERIFICATION_FAILED",
            message: `${verified.error.message} The marker was put back as it was.`,
            path: install.asarPath
        });
    }

    return ok({ install, loaderPath: bundle.loaderPath, pluginBuildId: bundle.buildId, markerPath, discordVersion, warning });
}

/** All the reasons we refuse to touch an install, each with its own named error. */
function guardPatchable(state: InstallState, options: PatchOptions): Result<PatchReport> | null {
    // Our stub with another mod's resources/app in front of it (audit #9):
    // writing anything here would verify and do nothing.
    if (state.warnings.includes("shadowed-by-unpacked-app")) {
        return err<PatchReport>(
            "FOREIGN_MOD_PRESENT",
            `${shadowName(state)} loads from an unpacked resources/app folder, which Discord uses in preference to app.asar. Uninstall it first: patching under it would appear to work and do nothing.`,
            { path: state.install.resourcesPath }
        );
    }
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
                `${state.modName ?? "Another client mod"} loads from an unpacked resources/app folder, which Discord uses in preference to app.asar. Uninstall it first: patching over it would appear to work and do nothing.`,
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

    // THE BACKUP THE PATCH WILL KEEP must be Discord's own code (audit #13).
    // A stub over a stub (another tool left a damaged copy in _app.asar)
    // used to be found only by the verification after the write.
    if (state.asarIsStub && state.hasBackup) {
        const backup = readIsOriginalAsar(state.install.backupPath);
        if (!backup.ok || !backup.value) {
            return err<PatchReport>(
                "BACKUP_CORRUPT",
                "Another tool left a damaged copy of Discord's files in _app.asar, so Subline cannot add itself safely. Reinstall Discord from discord.com, then run Subline again.",
                { path: state.install.backupPath }
            );
        }
    }

    return null;
}

interface Undo {
    /** Bytes of the `app.asar` we replaced, when it was a stub small enough to hold. */
    previousAsar: Buffer | null;
    /** True when we made `_app.asar` (a link to or copy of the original). */
    backupCreated: boolean;
    /** True once the stub is at `app.asar`: the original then lives only at `_app.asar`. */
    installed: boolean;
    /** Bytes of a marker file we overwrote, so a re-point can be undone exactly. */
    previousMarker: Buffer | null;
    markerExisted: boolean;
}

function applyPatch(
    install: DiscordInstall,
    state: InstallState,
    options: PatchOptions,
    bundle: ModBundle
): Result<PatchReport> {
    const { asarPath, backupPath, resourcesPath } = install;
    const markerPath = markerPathFor(resourcesPath);
    const tempPath = join(resourcesPath, TEMP_FILENAME);
    const identity: PatchIdentity = { loaderPath: bundle.loaderPath, buildId: bundle.buildId };

    // Discord's version goes into the marker so the helper can notice updates.
    const buildInfo = readDiscordVersion(install);
    const discordVersion = buildInfo.ok ? buildInfo.value.version : null;

    // Derived from what `app.asar` actually *is*, never from the state label:
    // an unparseable foreign stub still must not be moved into `_app.asar`.
    const currentIsOriginal = !state.asarIsStub;
    const stub = buildStubAsar(identity.loaderPath);

    const undo: Undo = {
        previousAsar: null,
        backupCreated: false,
        installed: false,
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
    const hooks = options.hooks ?? {};
    try {
        writeFileSync(tempPath, stub);
    } catch (cause) {
        return fsError<PatchReport>(cause, tempPath, "write the new app.asar");
    }

    // 2. Preserve the original, but only when the current archive *is* the
    //    original. An existing _app.asar is Discord's real code and outranks
    //    whatever stub is sitting in app.asar right now.
    //
    //    A SECOND NAME, NOT A MOVE. app.asar stays where it is until step 3
    //    replaces it in one rename, so a kill, a crash or a power cut at any
    //    point leaves a Discord that starts.
    if (currentIsOriginal) {
        const backedUp = backUpOriginal(asarPath, backupPath, hooks);
        if (!backedUp.ok) {
            discard(tempPath, hooks);
            return backedUp as Result<PatchReport>;
        }
        undo.backupCreated = true;
        hooks.afterBackup?.({ asarPath, backupPath });
    }

    // 3. Move the staged archive into place.
    try {
        renameRetrying(tempPath, asarPath, hooks);
        undo.installed = true;
    } catch (cause) {
        const rolled = rollback(install, undo, tempPath, hooks);
        if (!rolled.ok) return rolled;
        return fsError<PatchReport>(cause, asarPath, "install the new app.asar");
    }

    // 4. Record ownership.
    const marker: PatchMarker = {
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
        const rolled = rollback(install, undo, tempPath, hooks);
        if (!rolled.ok) return rolled;
        return markerWrite;
    }

    options.hooks?.afterWrite?.({ asarPath, backupPath, markerPath });

    // 5. Read back what we wrote. "The file was written" is not evidence (spec §7).
    const verification = verifyPatch(install, identity, stub);
    if (!verification.ok) {
        const rolled = rollback(install, undo, tempPath, hooks);
        if (!rolled.ok) return rolled;
        return err<PatchReport>(
            "VERIFICATION_FAILED",
            `${verification.error.message} Discord was restored to how it was before.`,
            { path: asarPath, cause: verification.error.cause }
        );
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
export function verifyPatch(install: DiscordInstall, expected: PatchIdentity, expectedBytes?: Buffer): Result<true> {
    const { loaderPath, buildId } = expected;
    const stubAndBackup = verifyStubAndBackup(install, loaderPath, expectedBytes);
    if (!stubAndBackup.ok) return stubAndBackup;

    const marker = readMarker(install.resourcesPath);
    if (!marker.ok) {
        return rewrap<true>(marker.error, {
            code: "VERIFICATION_FAILED",
            message: `The patch marker is unreadable (${marker.error.message})`,
            path: markerPathFor(install.resourcesPath)
        });
    }
    if (marker.value === null || !sameLoader(marker.value.loaderPath, loaderPath)) {
        return err<true>("VERIFICATION_FAILED", "The patch marker is missing or points at a different loader.", {
            path: markerPathFor(install.resourcesPath)
        });
    }
    // The marker's build id is what post-install verification will compare the
    // beacon against. A marker that landed with the wrong one (or none) would
    // make every later verification of a healthy install fail, and the moment to
    // catch that is here, while the patch can still be rolled back.
    if (marker.value.pluginBuildId !== buildId) {
        return err<true>(
            "VERIFICATION_FAILED",
            `The patch marker records build ${marker.value.pluginBuildId ?? "none"} instead of ${buildId}.`,
            { path: markerPathFor(install.resourcesPath) }
        );
    }

    return ok(true);
}

/** Everything verifyPatch checks except the marker: our stub, for this loader, over Discord's own backup. */
export function verifyStubAndBackup(install: DiscordInstall, loaderPath: string, expectedBytes?: Buffer): Result<true> {
    let actual: Buffer;
    try {
        actual = readFileSync(install.asarPath);
    } catch (cause) {
        return fsError<true>(cause, install.asarPath, "read back the patched app.asar");
    }

    if (expectedBytes && !actual.equals(expectedBytes)) {
        return err<true>("VERIFICATION_FAILED", "The patched app.asar does not match what was written.", {
            path: install.asarPath
        });
    }

    const stub = readStub(install.asarPath);
    if (!stub.ok) {
        return rewrap<true>(stub.error, {
            code: "VERIFICATION_FAILED",
            message: `The patched app.asar is unreadable (${stub.error.message})`,
            path: install.asarPath
        });
    }
    if (stub.value === null) {
        return err<true>("VERIFICATION_FAILED", "The patched app.asar is not the loader stub.", {
            path: install.asarPath
        });
    }
    if (stub.value.loaderPath === null || !sameLoader(stub.value.loaderPath, loaderPath)) {
        return err<true>(
            "VERIFICATION_FAILED",
            `The patched app.asar loads ${stub.value.loaderPath ?? "nothing"} instead of ${loaderPath}.`,
            { path: install.asarPath }
        );
    }
    // Every stub form we ever wrote is ours: an install patched before 0.2.1
    // carries the one-line form and is not "damaged" (re-patching it for that
    // alone would write to Discord, and nag a running one to restart, for
    // nothing). An older form is upgraded when Discord is closed (helper
    // "stub-outdated", or the installer's own run).
    const knownSource = stubFormOf(stub.value.indexSource, stub.value.loaderPath) !== null;
    if (stub.value.packageJson !== STUB_PACKAGE_JSON || !knownSource) {
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

    return ok(true);
}

/**
 * Put everything back. A failure here is the only outcome worse than a failed
 * patch, so it gets its own loud error code with the backup's location in it.
 */
function rollback(install: DiscordInstall, undo: Undo, tempPath: string, hooks: RetryHooks = {}): Result<true> {
    discard(tempPath, hooks);

    try {
        if (undo.previousAsar !== null) {
            writeFileSync(install.asarPath, undo.previousAsar);
        } else if (undo.backupCreated && undo.installed) {
            // The stub is at app.asar; the original is only at _app.asar.
            renameRetrying(install.backupPath, install.asarPath, hooks);
        } else if (undo.backupCreated) {
            // The original never left app.asar: only the second name goes.
            // (A rename of one hard link onto the other does nothing on POSIX.)
            unlinkRetrying(install.backupPath, hooks);
        }
    } catch (cause) {
        // Discord still starts in every case that reaches here: either
        // app.asar is the original, or it is our stub over the original in
        // _app.asar. Try again finishes or undoes the change.
        return err<true>(
            "ROLLBACK_FAILED",
            `Patching failed and Subline could not finish undoing it, because another program is holding Discord's files. Discord still starts. Its original app.asar is safe at ${install.backupPath}. Wait a few seconds and press Try again. If it keeps failing, reinstall Discord.`,
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

/**
 * The same loader in any spelling (case, slashes, a trailing separator): an
 * installer started with LOCALAPPDATA spelt differently from the helper's
 * must not make the helper rewrite app.asar, which on Windows waits for
 * Discord to close and nags the user to quit it (audit #5).
 */
function sameLoader(a: string | null | undefined, b: string): boolean {
    return a !== null && a !== undefined && sameLoaderPath(a, b);
}

function shadowName(state: InstallState): string {
    switch (state.shadowedBy) {
        case "betterdiscord": return "BetterDiscord";
        case "vencord": return "Vencord";
        case "equicord": return "Equicord";
        default: return "Another client mod";
    }
}

function discard(path: string, hooks: RetryHooks = {}): void {
    try {
        if (existsSync(path)) unlinkRetrying(path, hooks);
    } catch {
        // A stranded temp file is cosmetic; never let it mask the real error.
        // patchInstall overwrites it on the next run.
    }
}

/**
 * Give Discord's original archive its second name, _app.asar.
 *
 * A hard link first: instant, and one copy of the data. A copy (flushed to
 * disk) where links are not possible (another volume, a filesystem without
 * them, or a leftover _app.asar already there, which the copy replaces just
 * as the old rename did).
 */
function backUpOriginal(asarPath: string, backupPath: string, hooks: PatchHooks): Result<true> {
    const link = hooks.link ?? linkSync;
    try {
        link(asarPath, backupPath);
        return ok(true);
    } catch {
        // Fall through to the copy.
    }
    try {
        copyFileSync(asarPath, backupPath);
        const fd = openSync(backupPath, "r+");
        try {
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        return ok(true);
    } catch (cause) {
        try {
            if (existsSync(backupPath) && !readFileSync(backupPath).equals(readFileSync(asarPath))) unlinkRetrying(backupPath, hooks);
        } catch {
            // Leave it: a partial _app.asar beside an intact app.asar is
            // refused by every later check (it is not Discord's original).
        }
        return fsError<true>(cause, asarPath, "back up Discord's original app.asar");
    }
}

export interface UnpatchOptions {
    /**
     * Remove another mod's patch. Off by default — restoring Discord out from
     * under Vencord is not something to do without the user saying so.
     */
    removeForeignMod?: boolean;
    /**
     * Loader paths known to be ours (the installed bundle's patcher.js), so a
     * stub that loads one is restored even with its marker missing. Any
     * `…/Subline/mod/patcher.js` is recognised without it.
     */
    ownLoaderPaths?: readonly string[];
    /**
     * Decide, but write nothing. Returns the exact error the real call would
     * return for every refusal that can be known before a write (another mod,
     * a missing or damaged backup, an unrecoverable broken install), and ok
     * otherwise. Uninstall runs this over every Discord before it stops the
     * helper, so a refusal leaves everything exactly as it was. Failures only
     * a write can find (a file held open) still surface from the real call.
     */
    dryRun?: boolean;
    /**
     * True for a loader inside ANOTHER account's home (ownership.ts
     * isOtherAccountLoader; wired on macOS, where /Applications/Discord.app is
     * shared). Such a Discord is that account's, and is never restored from
     * here: doing so took Subline away from the other account while saying
     * "put back to normal", and their helper patched it straight back.
     */
    isOtherAccountLoader?: (loaderPath: string) => boolean;
    /** Fault-injection seam for the restore rename. Only tests pass it. */
    hooks?: RetryHooks;
}

export interface UnpatchReport {
    install: DiscordInstall;
    /** True when Discord's original archive was moved back into place. */
    restored: boolean;
    /** True when there was nothing of ours to remove. */
    alreadyClean: boolean;
    removedArtifacts: string[];
    previousState: InstallStateKind;
    /**
     * Set when another client mod owns this Discord and it was left as it is
     * (its name, or null when unknown). Uninstall lists it instead of failing.
     */
    foreignMod?: string | null;
    /** One sentence the GUI can show verbatim. */
    summary: string;
}

export function unpatchInstall(install: DiscordInstall, options: UnpatchOptions = {}): Result<UnpatchReport> {
    const stateResult = inspectInstall(install, { ownLoaderPaths: options.ownLoaderPaths ?? [] });
    if (!stateResult.ok) return stateResult;
    const state = stateResult.value;

    const dryRun = options.dryRun === true;
    const loader = state.marker?.loaderPath ?? state.loaderPath;
    if (
        state.kind !== "patched-by-other"
        && state.kind !== "unpatched"
        && loader !== null
        && loader !== undefined
        && options.isOtherAccountLoader?.(loader) === true
    ) {
        return err<UnpatchReport>(
            "OTHER_ACCOUNT",
            "Another account on this Mac set up Subline for this Discord. Only that account can remove it. Nothing was changed.",
            { path: install.rootPath }
        );
    }
    switch (state.kind) {
        case "unpatched":
            return dryRun ? wouldSucceed(install, state) : cleanUpUnpatched(install, state);

        case "broken":
            return unpatchBroken(install, state, dryRun, options.hooks);

        case "patched-by-other":
            // NOT OURS, SO NOT A FAILURE (audit 2026-10-06 #2). Subline on
            // Stable and Vencord on Canary is common; refusing here made every
            // uninstall on such a machine fail, forever. Another mod's Discord
            // is left exactly as it is: its stub and its _app.asar (the stub
            // still boots from it). Only a marker of OURS beside it goes: the
            // stub Discord runs loads someone else's loader, so the marker is
            // stale by definition, and keeping it made the next uninstall
            // believe this Discord still needs Subline's files.
            if (!options.removeForeignMod) return leaveForeign(install, state, dryRun);
            return restoreOriginal(install, state, dryRun, options.hooks);

        case "patched-by-us":
            return restoreOriginal(install, state, dryRun, options.hooks);
    }
}

function leaveForeign(install: DiscordInstall, state: InstallState, dryRun: boolean): Result<UnpatchReport> {
    const removed: string[] = [];
    if (!dryRun) {
        const markerRemoved = removeMarker(install.resourcesPath);
        if (!markerRemoved.ok) return markerRemoved;
        if (markerRemoved.value) removed.push(markerPathFor(install.resourcesPath));
    }
    const mod = state.modName ?? null;
    return ok({
        install,
        restored: false,
        alreadyClean: removed.length === 0,
        removedArtifacts: removed,
        previousState: state.kind,
        foreignMod: mod,
        summary: `Subline is not installed here. ${mod ?? "Another client mod"} is, and it was left as it is.`
    });
}

/** A dry run that found nothing to refuse. Nothing was written. */
function wouldSucceed(install: DiscordInstall, state: InstallState): Result<UnpatchReport> {
    return ok({
        install,
        restored: false,
        // An untouched Discord with no marker of ours: the real call would
        // find nothing of Subline's to remove (see cleanUpUnpatched).
        alreadyClean: state.kind === "unpatched" && state.marker === null,
        removedArtifacts: [],
        previousState: state.kind,
        summary: "Dry run: Subline can be removed from this Discord."
    });
}

function cleanUpUnpatched(install: DiscordInstall, state: InstallState): Result<UnpatchReport> {
    const removed: string[] = [];

    // Only clear a leftover _app.asar when our own marker proves we made it.
    // Another mod's backup is not ours to delete.
    const ours = state.marker !== null;
    if (ours && state.hasBackup) {
        try {
            unlinkRetrying(install.backupPath);
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

function unpatchBroken(install: DiscordInstall, state: InstallState, dryRun = false, hooks: RetryHooks = {}): Result<UnpatchReport> {
    switch (state.reason) {
        // All three are "put the original back if it is there". restoreOriginal
        // finishes an interrupted patch when `_app.asar` survived, and reports
        // BACKUP_MISSING when it did not — one code path, one message.
        case "asar-missing-backup-present":
        case "our-patch-without-backup":
        case "asar-and-backup-missing":
            return restoreOriginal(install, state, dryRun, hooks);
        // app.asar unreadable (a truncated write) or our marker unreadable,
        // with OUR marker file beside it and a backup: the backup is ours, and
        // putting Discord's original back is the repair (audit #13).
        // restoreOriginal refuses a backup that is not Discord's original.
        case "asar-unreadable":
        case "marker-unreadable":
            if (existsSync(markerPathFor(install.resourcesPath)) && existsSync(install.backupPath)) {
                return restoreOriginal(install, state, dryRun, hooks);
            }
            return err<UnpatchReport>("BROKEN_INSTALL", state.summary, { path: install.rootPath });
        default:
            return err<UnpatchReport>("BROKEN_INSTALL", state.summary, { path: install.rootPath });
    }
}

function restoreOriginal(install: DiscordInstall, state: InstallState, dryRun = false, hooks: RetryHooks = {}): Result<UnpatchReport> {
    if (!existsSync(install.backupPath)) {
        return err<UnpatchReport>(
            "BACKUP_MISSING",
            `Discord's original app.asar backup (${install.backupPath}) is missing, so Subline cannot restore it. Use Discord's own repair or reinstall it, and do not delete anything by hand.`,
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
    // Every check a read can make has passed. The rest needs the write.
    if (dryRun) return wouldSucceed(install, state);

    try {
        renameRetrying(install.backupPath, install.asarPath, hooks);
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
