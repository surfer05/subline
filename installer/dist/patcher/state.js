/**
 * What state is this install in?
 *
 * Spec §3 step 4 and §7 make this the load-bearing question of the whole
 * installer: "silently patching over someone's setup can wipe their plugins.
 * That ends a product's reputation early." So "patched by someone else" is a
 * first-class outcome with the mod named, not a generic "already patched".
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readMarker } from "./marker.js";
import { err, ok } from "./result.js";
import { readStub } from "./stub.js";
const MOD_NAMES = {
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
export function hasUnpackedAppDir(resourcesPath) {
    const dir = join(resourcesPath, "app");
    try {
        return statSync(dir).isDirectory();
    }
    catch {
        return false;
    }
}
/** Identify a foreign mod from the path its stub loads. Never used to claim ownership *for us*. */
export function identifyModFromLoaderPath(loaderPath) {
    if (!loaderPath)
        return "unknown";
    const lower = loaderPath.toLowerCase();
    if (lower.includes("betterdiscord"))
        return "betterdiscord";
    if (lower.includes("equicord"))
        return "equicord";
    if (lower.includes("vencord"))
        return "vencord";
    return "unknown";
}
function broken(install, reason, summary, extra) {
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
export function inspectInstall(install) {
    if (!existsSync(install.resourcesPath)) {
        return err("NOT_A_DISCORD_INSTALL", `${install.resourcesPath} does not exist, so this is not a Discord installation.`, { path: install.rootPath });
    }
    const hasAsar = existsSync(install.asarPath);
    const hasBackup = existsSync(install.backupPath);
    if (!hasAsar) {
        return ok(hasBackup
            ? broken(install, "asar-missing-backup-present", "Discord is half-patched: its app.asar is missing but the original backup is still there. It can be repaired.")
            : broken(install, "asar-and-backup-missing", "Discord's app.asar and its backup are both missing. Reinstall Discord to repair it."));
    }
    const markerResult = readMarker(install.resourcesPath);
    if (!markerResult.ok) {
        return ok(broken(install, "marker-unreadable", markerResult.error.message));
    }
    const marker = markerResult.value;
    const stubResult = readStub(install.asarPath);
    if (!stubResult.ok) {
        return ok(broken(install, "asar-unreadable", `Discord's app.asar could not be read as an archive (${stubResult.error.message})`));
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
                summary: "BetterDiscord is installed here (it loads from an unpacked resources/app folder rather than app.asar)."
            });
        }
        const warnings = hasBackup ? ["stale-backup"] : [];
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
function classifyStub(install, stub, marker, hasBackup) {
    const loaderPath = stub.loaderPath;
    const isOurs = marker !== null && loaderPath !== null && marker.loaderPath === loaderPath;
    if (isOurs) {
        if (!hasBackup) {
            return ok(broken(install, "our-patch-without-backup", "Subline's patch is installed but Discord's original app.asar backup is missing, so it cannot be restored.", { mod: "subline", modName: MOD_NAMES.subline, loaderPath, marker, asarIsStub: true }));
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
    const warnings = marker !== null && loaderPath !== null && marker.loaderPath !== loaderPath
        ? ["marker-loader-mismatch"]
        : [];
    if (!hasBackup) {
        return ok(broken(install, "foreign-patch-without-backup", `${modName} has patched Discord here, but the original app.asar was not preserved. Reinstall Discord before continuing.`, { mod, modName, loaderPath, warnings, asarIsStub: true }));
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
        summary: mod === "unknown"
            ? `Discord has already been modified by another client mod (it loads ${loaderPath ?? "an unknown script"}).`
            : `${modName} is already installed here.`
    });
}
//# sourceMappingURL=state.js.map