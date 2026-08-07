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
import { existsSync, statSync } from "./realFs.js";
import { join } from "node:path";

import type { DiscordInstall } from "./locate.js";
import { readMarker } from "./marker.js";
import type { PatchMarker } from "./marker.js";
import type { Result } from "./result.js";
import { err, ok } from "./result.js";
import { readStub } from "./stub.js";
import type { StubContents } from "./stub.js";

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
    /** A marker file exists but is unreadable. */
    | "marker-unreadable";

export type StateWarning =
    /** A leftover `_app.asar` next to a genuine Discord `app.asar` — typically a Discord update that orphaned a patch (spec §7). */
    | "stale-backup"
    /** Our marker says one loader, the stub `require()`s another. */
    | "marker-loader-mismatch";

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

/** Identify a foreign mod from the path its stub loads. Never used to claim ownership *for us*. */
export function identifyModFromLoaderPath(loaderPath: string | null): KnownMod {
    if (!loaderPath) return "unknown";
    const lower = loaderPath.toLowerCase();
    if (lower.includes("betterdiscord")) return "betterdiscord";
    if (lower.includes("equicord")) return "equicord";
    if (lower.includes("vencord")) return "vencord";
    return "unknown";
}

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
 * Inspect one installation. Only genuinely unusable situations (the path is
 * not a Discord install at all) come back as an error — everything else is a
 * *reported state*, because the GUI has to explain it rather than fail.
 */
export function inspectInstall(install: DiscordInstall): Result<InstallState> {
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
                      "Discord's app.asar and its backup are both missing. Reinstall Discord to repair it."
                  )
        );
    }

    const markerResult = readMarker(install.resourcesPath);
    if (!markerResult.ok) {
        return ok(broken(install, "marker-unreadable", markerResult.error.message));
    }
    const marker = markerResult.value;

    const stubResult = readStub(install.asarPath);
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
                      + "probably fine — this is normally a permissions problem. "
                      + `(${stubResult.error.message})`
                    : `Discord's app.asar could not be read as an archive (${stubResult.error.message})`
            )
        );
    }
    const stub = stubResult.value;

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

    return classifyStub(install, stub, marker, hasBackup);
}

function classifyStub(
    install: DiscordInstall,
    stub: StubContents,
    marker: PatchMarker | null,
    hasBackup: boolean
): Result<InstallState> {
    const loaderPath = stub.loaderPath;
    const isOurs = marker !== null && loaderPath !== null && marker.loaderPath === loaderPath;

    if (isOurs) {
        if (!hasBackup) {
            return ok(
                broken(
                    install,
                    "our-patch-without-backup",
                    "Subline's patch is installed but Discord's original app.asar backup is missing, so it cannot be restored.",
                    { mod: "subline", modName: MOD_NAMES.subline, loaderPath, marker, asarIsStub: true }
                )
            );
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
            warnings: [],
            summary: "Subline is installed and Discord's original app.asar is backed up."
        });
    }

    const mod = identifyModFromLoaderPath(loaderPath);
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
                `${modName} has patched Discord here, but the original app.asar was not preserved. Reinstall Discord before continuing.`,
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
