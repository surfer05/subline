/**
 * What state is this install in?
 *
 * Spec §3 step 4 and §7 make this the load-bearing question of the whole
 * installer: "silently patching over someone's setup can wipe their plugins.
 * That ends a product's reputation early." So "patched by someone else" is a
 * first-class outcome with the mod named, not a generic "already patched".
 */

// realFs, NOT node:fs: Electron treats any ".asar" path as a virtual archive,
// so even existsSync/statSync on app.asar answer about a mount rather than the
// file. See realFs.ts.
import { existsSync, readFileSync, statSync } from "./realFs.js";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DiscordInstall } from "./locate.js";
import { readMarker } from "./marker.js";
import type { PatchMarker } from "./marker.js";
import type { Result } from "./result.js";
import { err, ok } from "./result.js";
import { isOtherAccountLoader, isSublineLoaderPath, sameLoaderPath } from "./ownership.js";
import type { LoaderPathContext } from "./ownership.js";
import { classifyAsar, stubFormOf } from "./stub.js";
import type { StubContents, StubForm } from "./stub.js";
import { readDiscordVersion } from "./version.js";

export type InstallStateKind =
    /** Discord's own `app.asar` is in place and nothing has injected into it. */
    | "unpatched"
    /** Our stub, our marker, and a usable backup. */
    | "patched-by-us"
    /** Someone else's client mod owns this install. */
    | "patched-by-other"
    /** Half-patched or damaged. Do not patch on top of this. */
    | "broken";

export type KnownMod = "subline" | "vencord" | "equicord" | "betterdiscord" | "unknown";

export type BrokenReason =
    /** `app.asar` is gone but `_app.asar` is there — an interrupted patch. Recoverable. */
    | "asar-missing-backup-present"
    /** Neither archive exists. Only Discord's own repair/reinstall fixes this. */
    | "asar-and-backup-missing"
    /** `app.asar` exists but is not a readable asar archive. Genuine damage. */
    | "asar-unreadable"
    /**
     * `app.asar` is there and may be perfectly fine — we simply could not OPEN
     * it. Permissions, a sandboxed process, or Electron's own asar
     * interception. NOT damage, and must never be presented as such: doing so
     * steered a user with a healthy Vencord install toward repair/uninstall.
     */
    | "asar-inaccessible"
    /** Our marker and stub are present but `_app.asar` is gone — we cannot restore Discord. */
    | "our-patch-without-backup"
    /** Someone else's stub is present but the original was not preserved. */
    | "foreign-patch-without-backup"
    /**
     * `app.asar` reads as an archive but is neither Discord's code nor a
     * loader stub: no package.json, or its main entry is missing (audit
     * 2026-10-06 #6). Never treated as Discord's original.
     */
    | "asar-unrecognised";

export type StateWarning =
    /** A leftover `_app.asar` next to a genuine Discord `app.asar` — typically a Discord update that orphaned a patch (spec §7). */
    | "stale-backup"
    /** Our marker says one loader, the stub `require()`s another. */
    | "marker-loader-mismatch"
    /**
     * A subline-patch.json is there but is not a marker of ours: empty,
     * truncated, hand-edited, another product's, too big, or unreadable. It
     * proves nothing, so the state is judged by app.asar alone, exactly as with
     * no marker (marker is null): beside our stub it is still ours and is
     * rewritten ("marker-missing" too), beside another mod's stub it is that
     * mod's, beside Discord's own archive it is unpatched. NEVER "broken": that
     * refused every install, alerted every helper run and refused uninstall.
     */
    | "marker-unreadable"
    /**
     * The stub loads Subline's own loader but no marker sits beside it. On
     * Windows this is what Vencord's host-update repatch leaves in a new
     * app-x.y.z folder (it copies app.asar and nothing else). Still ours; the
     * marker is rewritten by the next patch, repatch or helper run.
     */
    | "marker-missing"
    /** The stub loads Subline's loader, but the marker spells it differently or names another path. Still ours; rewritten. */
    | "marker-mismatch"
    /**
     * The marker names the right loader but describes another folder: its
     * backupPath is not this folder's _app.asar, or its Discord version is not
     * this folder's. A marker carried across a Windows host update (or copied
     * by hand). Still ours; only the marker is rewritten.
     */
    | "marker-stale"
    /**
     * Our stub loads a loader that is not on disk (the bundle was deleted,
     * quarantined or left aside). Discord still starts (the stub fails open),
     * but without Subline. Still ours; the installer reinstalls the bundle.
     */
    | "loader-missing"
    /**
     * Our stub is in place, but an unpacked resources/app folder (BetterDiscord,
     * Replugged, Moonlight) loads in front of it, so Discord ignores Subline.
     */
    | "shadowed-by-unpacked-app";

export interface InstallState {
    kind: InstallStateKind;
    install: DiscordInstall;
    /** Which mod owns the install, when one does. */
    mod: KnownMod | null;
    /** Display name for `mod`, e.g. "BetterDiscord". */
    modName: string | null;
    /** The absolute path the stub `require()`s, when there is a stub. */
    loaderPath: string | null;
    /**
     * True when `app.asar` is a small loader stub rather than Discord's real
     * archive. Load-bearing: patching must never move a *stub* into `_app.asar`,
     * because that would destroy the only copy of Discord's original code.
     */
    asarIsStub: boolean;
    /** True when `_app.asar` exists. */
    hasBackup: boolean;
    /** Our marker, when we wrote one. */
    marker: PatchMarker | null;
    reason: BrokenReason | null;
    warnings: StateWarning[];
    /** One sentence the GUI can show verbatim. */
    summary: string;
    /** Which of OUR stub forms app.asar is (see stubFormOf); null when it is not ours or not a stub. */
    stubForm?: StubForm | null;
    /** For our stub: whether its loader file exists. */
    loaderPresent?: boolean | null;
    /** For our stub: the mod whose unpacked resources/app loads in front of it. */
    shadowedBy?: KnownMod | null;
    /** Why a subline-patch.json was set aside as not ours (see "marker-unreadable"), for the log. */
    markerProblem?: string | null;
}

const MOD_NAMES: Record<KnownMod, string> = {
    subline: "Subline",
    vencord: "Vencord",
    equicord: "Equicord",
    betterdiscord: "BetterDiscord",
    unknown: "another client mod"
};

/**
 * BetterDiscord does not replace `app.asar` at all — it drops an unpacked
 * `resources/app/` directory, which Electron prefers over the archive. Checking
 * for it is the only way to see BD on an otherwise pristine install.
 */
export function hasUnpackedAppDir(resourcesPath: string): boolean {
    const dir = join(resourcesPath, "app");
    try {
        return statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Identify a mod from the path its stub loads. Subline's own loader is named as
 * such (see isSublineLoaderPath), so our stub can never be labelled foreign.
 */
export function identifyModFromLoaderPath(loaderPath: string | null, context: InspectOptions = {}): KnownMod {
    if (!loaderPath) return "unknown";
    if (isSublineLoaderPath(loaderPath, context.ownLoaderPaths ?? [], context)) return "subline";
    const lower = loaderPath.toLowerCase();
    if (lower.includes("betterdiscord")) return "betterdiscord";
    if (lower.includes("equicord")) return "equicord";
    if (lower.includes("vencord")) return "vencord";
    return "unknown";
}

/**
 * What the user can do about a broken Discord (audit 2026-10-06 #13). Every
 * broken screen names one, so nobody is left on "Discord needs repairing" with
 * a button that cannot repair it.
 */
export const BROKEN_REMEDY = {
    reinstall: "Reinstall Discord from discord.com, then run Subline again.",
    uninstall: "Press Uninstall at the bottom to put Discord's original files back."
} as const;

function broken(
    install: DiscordInstall,
    reason: BrokenReason,
    summary: string,
    extra?: Partial<InstallState>
): InstallState {
    return {
        kind: "broken",
        install,
        mod: null,
        modName: null,
        loaderPath: null,
        asarIsStub: false,
        hasBackup: existsSync(install.backupPath),
        marker: null,
        reason,
        warnings: [],
        summary,
        ...extra
    };
}

/**
 * What the caller knows about its own loader. `ownLoaderPaths` is the installed
 * bundle's loader (patcher.js), so a dev build outside the standard
 * `…/Subline/mod` folder is recognised too. The rest is for tests.
 */
export interface InspectOptions extends LoaderPathContext {
    ownLoaderPaths?: readonly string[];
}

/**
 * Which mod an unpacked resources/app folder belongs to, from its own files.
 * Never assumes BetterDiscord: Replugged and Moonlight use the same folder.
 */
export function identifyUnpackedAppMod(resourcesPath: string): KnownMod {
    const dir = join(resourcesPath, "app");
    for (const name of ["package.json", "index.js"]) {
        try {
            const text = readFileSync(join(dir, name), "utf8").slice(0, 4096).toLowerCase();
            if (text.includes("betterdiscord")) return "betterdiscord";
            if (text.includes("equicord")) return "equicord";
            if (text.includes("vencord")) return "vencord";
        } catch {
            // Not there or unreadable: the other file may still say.
        }
    }
    return "unknown";
}

/**
 * Inspect one installation. Only genuinely unusable situations (the path is
 * not a Discord install at all) come back as an error — everything else is a
 * *reported state*, because the GUI has to explain it rather than fail.
 */
export function inspectInstall(install: DiscordInstall, options: InspectOptions = {}): Result<InstallState> {
    const markerResult = readMarker(install.resourcesPath);
    const marker = markerResult.ok ? markerResult.value : null;
    const result = inspectWithMarker(install, options, marker, !markerResult.ok);
    if (markerResult.ok || !result.ok) return result;
    // A bad marker: judged as if absent, and said so.
    return ok({
        ...result.value,
        warnings: [...result.value.warnings, "marker-unreadable"],
        markerProblem: markerResult.error.message
    });
}

function inspectWithMarker(
    install: DiscordInstall,
    options: InspectOptions,
    marker: PatchMarker | null,
    markerFileBad: boolean
): Result<InstallState> {
    if (!existsSync(install.resourcesPath)) {
        return err<InstallState>(
            "NOT_A_DISCORD_INSTALL",
            `${install.resourcesPath} does not exist, so this is not a Discord installation.`,
            { path: install.rootPath }
        );
    }

    const hasAsar = existsSync(install.asarPath);
    const hasBackup = existsSync(install.backupPath);

    if (!hasAsar) {
        return ok(
            hasBackup
                ? broken(
                      install,
                      "asar-missing-backup-present",
                      "Discord is half-patched: its app.asar is missing but the original backup is still there. It can be repaired."
                  )
                : broken(
                      install,
                      "asar-and-backup-missing",
                      `Discord's app.asar and its backup are both missing. ${BROKEN_REMEDY.reinstall}`
                  )
        );
    }

    const stubResult = classifyAsar(install.asarPath);
    if (stubResult.ok && stubResult.value.kind === "unrecognised") {
        return ok(
            broken(
                install,
                "asar-unrecognised",
                `Discord's app.asar is neither Discord's own code nor a loader Subline knows (${stubResult.value.why}). Subline will not move it. ${BROKEN_REMEDY.reinstall}`,
                { marker }
            )
        );
    }
    if (!stubResult.ok) {
        // Two very different failures, and collapsing them into one told a user
        // with a perfectly healthy Vencord install that Discord "needs
        // repairing" — pointing them at repair and uninstall for a file that
        // was never damaged. IO_ERROR means we could not OPEN it (permissions,
        // sandboxing, Electron's asar interception); only a parse failure means
        // the archive itself is bad.
        const inaccessible = stubResult.error.code === "IO_ERROR";
        return ok(
            broken(
                install,
                inaccessible ? "asar-inaccessible" : "asar-unreadable",
                inaccessible
                    ? "Subline could not open Discord's app.asar. Discord itself is "
                      + "probably fine. This is normally a permissions problem. "
                      + `(${stubResult.error.message})`
                    : `Discord's app.asar could not be read as an archive (${stubResult.error.message}). ${(marker !== null || markerFileBad) && hasBackup ? BROKEN_REMEDY.uninstall : BROKEN_REMEDY.reinstall}`
            )
        );
    }
    const stub = stubResult.value.kind === "stub" ? stubResult.value.stub : null;

    if (stub === null) {
        // A real Discord archive. BetterDiscord can still own the install via
        // an unpacked resources/app directory.
        if (hasUnpackedAppDir(install.resourcesPath)) {
            return ok({
                kind: "patched-by-other",
                install,
                mod: "betterdiscord",
                modName: MOD_NAMES.betterdiscord,
                loaderPath: null,
                asarIsStub: false,
                hasBackup,
                marker,
                reason: null,
                warnings: [],
                summary:
                    "BetterDiscord is installed here (it loads from an unpacked resources/app folder rather than app.asar)."
            });
        }
        const warnings: StateWarning[] = hasBackup ? ["stale-backup"] : [];
        return ok({
            kind: "unpatched",
            install,
            mod: null,
            modName: null,
            loaderPath: null,
            asarIsStub: false,
            hasBackup,
            marker,
            reason: null,
            warnings,
            summary: hasBackup
                ? "Discord is unmodified, but a leftover _app.asar from a previous patch is still present."
                : "Discord is unmodified."
        });
    }

    return classifyStub(install, stub, marker, hasBackup, options);
}

/**
 * A marker for the right loader that describes another folder: a backup that
 * is not this folder's _app.asar, or a Discord version that is not this
 * folder's. Only judged when both sides are known.
 */
function markerIsStale(install: DiscordInstall, marker: PatchMarker, options: InspectOptions): boolean {
    if (marker.backupPath && !sameLoaderPath(marker.backupPath, install.backupPath, options)) return true;
    if (marker.discordVersion !== null && marker.discordVersion !== undefined) {
        const version = readDiscordVersion(install);
        if (version.ok && version.value.version !== marker.discordVersion) return true;
    }
    return false;
}

function classifyStub(
    install: DiscordInstall,
    stub: StubContents,
    marker: PatchMarker | null,
    hasBackup: boolean,
    options: InspectOptions
): Result<InstallState> {
    const loaderPath = stub.loaderPath;
    // OWNERSHIP BY LOADER. The marker agreeing (in any spelling) proves it, and
    // so does the stub loading Subline's own loader with no marker or a
    // disagreeing one: that is the file Discord actually runs.
    const markerAgrees = marker !== null && loaderPath !== null && sameLoaderPath(marker.loaderPath, loaderPath, options);
    const isOurs = loaderPath !== null
        && (markerAgrees || isSublineLoaderPath(loaderPath, options.ownLoaderPaths ?? [], options));

    if (isOurs) {
        const warnings: StateWarning[] = marker === null
            ? ["marker-missing"]
            : marker.loaderPath !== loaderPath
                ? ["marker-mismatch"]
                : markerIsStale(install, marker, options) ? ["marker-stale"] : [];
        const stubForm = stubFormOf(stub.indexSource, loaderPath);
        // An unreadable loader under ANOTHER account's home is healthy for that
        // account: existsSync is false only because this one cannot look.
        const loaderPresent = existsSync(loaderPath);
        const platform = options.platform ?? process.platform;
        const env = options.env ?? process.env;
        const home = options.home ?? (platform === "win32" ? env.USERPROFILE : env.HOME) ?? homedir();
        if (!loaderPresent && !isOtherAccountLoader(loaderPath, home, platform)) {
            warnings.push("loader-missing");
        }
        const shadowedBy = hasUnpackedAppDir(install.resourcesPath) ? identifyUnpackedAppMod(install.resourcesPath) : null;
        if (shadowedBy !== null) warnings.push("shadowed-by-unpacked-app");
        const extra = { stubForm, loaderPresent, shadowedBy };
        if (!hasBackup) {
            return ok(
                broken(
                    install,
                    "our-patch-without-backup",
                    `Subline's patch is installed but Discord's original app.asar backup is missing, so it cannot be restored. ${BROKEN_REMEDY.reinstall}`,
                    { mod: "subline", modName: MOD_NAMES.subline, loaderPath, marker, asarIsStub: true, warnings, ...extra }
                )
            );
        }
        if (shadowedBy !== null) {
            const name = shadowedBy === "unknown" ? "Another client mod" : MOD_NAMES[shadowedBy];
            return ok({
                kind: "patched-by-us",
                install,
                mod: "subline",
                modName: MOD_NAMES.subline,
                loaderPath,
                asarIsStub: true,
                hasBackup,
                marker,
                reason: null,
                warnings,
                summary: `Subline is installed, but ${name}'s resources/app folder loads in front of it, so Discord ignores it.`,
                ...extra
            });
        }
        return ok({
            kind: "patched-by-us",
            install,
            mod: "subline",
            modName: MOD_NAMES.subline,
            loaderPath,
            asarIsStub: true,
            hasBackup,
            marker,
            reason: null,
            warnings,
            summary: "Subline is installed and Discord's original app.asar is backed up.",
            ...extra
        });
    }

    const mod = identifyModFromLoaderPath(loaderPath, options);
    const modName = MOD_NAMES[mod];
    const warnings: StateWarning[] =
        marker !== null && loaderPath !== null && marker.loaderPath !== loaderPath
            ? ["marker-loader-mismatch"]
            : [];

    if (!hasBackup) {
        return ok(
            broken(
                install,
                "foreign-patch-without-backup",
                `${modName} has patched Discord here, but the original app.asar was not preserved. ${BROKEN_REMEDY.reinstall}`,
                { mod, modName, loaderPath, warnings, asarIsStub: true }
            )
        );
    }

    return ok({
        kind: "patched-by-other",
        install,
        mod,
        modName,
        loaderPath,
        asarIsStub: true,
        hasBackup,
        marker,
        reason: null,
        warnings,
        summary:
            mod === "unknown"
                ? `Discord has already been modified by another client mod (it loads ${loaderPath ?? "an unknown script"}).`
                : `${modName} is already installed here.`
    });
}
