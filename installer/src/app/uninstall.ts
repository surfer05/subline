/**
 * Uninstall (spec §8) — one click, from inside the app.
 *
 * Being easy to remove is what makes people willing to try software that
 * modifies Discord, so the bar here is higher than "delete our files": the user
 * must end up with a Discord that starts and works, or with a clear statement of
 * what is wrong and who can fix it.
 *
 * ## The ordering is a safety property, not a style choice
 *
 * Every install is unpatched FIRST, and the shared mod bundle is removed only
 * once they have all succeeded. The stub inside `app.asar` is a literal
 * `require()` of a path in that bundle: delete the bundle while a Discord is
 * still patched and that Discord no longer STARTS. So a failed unpatch cancels
 * the bundle removal — the half-uninstalled state we leave behind is one where
 * Discord still works.
 *
 * `bundling.md` states the same rule from the other side: `removeModBundle` is
 * deliberately not wired into `unpatchInstall`, because unpatch is per-install
 * and the bundle is per-user.
 *
 * ## What we cannot delete, and say so instead of pretending
 *
 * Spec §8 offers to delete "settings and the translation cache". The settings
 * are ours to remove — a key in Vencord's `settings.json`. The CACHE IS NOT: the
 * plugin persists through Vencord's `DataStore`, which lives in Discord's own
 * IndexedDB. Deleting that would mean reaching into Discord's storage and
 * risking its own data, to reclaim a cache that is already unreachable once the
 * plugin is gone. So the report says where it is rather than claiming to have
 * removed it. An uninstaller that lies about what it deleted is worse than one
 * that leaves something behind.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { removeModBundle } from "../bundle/bundle.js";
import type { DiscordInstall } from "../patcher/locate.js";
import type { UnpatchReport } from "../patcher/patch.js";
import type { PatcherError, Result } from "../patcher/result.js";
import { err, fsError, ok } from "../patcher/result.js";
import { PLUGIN_SETTINGS_KEY } from "./language.js";

export interface UninstallPorts {
    unpatch(install: DiscordInstall, options: { removeForeignMod?: boolean }): Result<UnpatchReport>;
    /** Where the runtime mod bundle lives, or `null` on an unsupported platform. */
    modBundleDir: string | null;
    /** Subline's per-user directory — the beacon and anything else we own. */
    productDir: string | null;
    /** Vencord's settings.json, so our plugin's key can be removed from it. */
    vencordSettingsPath: string | null;
    log: {
        info(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
        warn(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
        error(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
    };
}

/**
 * What happened when the caller stopped the background helper (§8 step 3).
 *
 * REQUIRED, and for the same reason `VerifyOptions.expectedBuildId` is: the
 * invariant is an ORDERING, and an ordering a caller can forget is one that will
 * be forgotten. The helper re-patches Discord silently (spec §6). Restore
 * Discord's original `app.asar` while the agent is still registered and the next
 * interval puts the patch straight back — an uninstalled product that keeps
 * modifying Discord. So the helper is removed FIRST, by the caller (only it can
 * talk to `launchctl`), and its outcome is handed in here as a precondition.
 *
 * `applicable: false` is the honest answer on a platform with no helper, or when
 * one was never installed.
 */
export interface HelperRemoval {
    applicable: boolean;
    removed: boolean;
    error: PatcherError | null;
}

export interface UninstallOptions {
    installs: readonly DiscordInstall[];
    /** §8 step 5: the user's answer. Defaults to keeping, which is the safe direction. */
    keepSettings?: boolean;
    /** The result of stopping the background helper, which must already have happened. */
    helper: HelperRemoval;
}

export interface RestoreOutcome {
    install: DiscordInstall;
    ok: boolean;
    /** True when Discord's original archive is back in place. */
    restored: boolean;
    error: PatcherError | null;
}

export type TranslationCacheDisposition =
    /** Left where it is — inside Discord's own storage, orphaned and unread. */
    | "left-in-discord-storage";

export interface UninstallReport {
    restores: RestoreOutcome[];
    /** True when no background helper is left that could re-patch Discord. */
    helperStopped: boolean;
    /** True only when every Discord was returned to its original state. */
    discordRestored: boolean;
    modBundleRemoved: boolean;
    /** Left in place deliberately because a Discord is still patched. */
    modBundleKeptForSafety: boolean;
    settingsRemoved: boolean;
    productDataRemoved: boolean;
    translationCache: TranslationCacheDisposition;
    /** Every named failure encountered, in the order they happened. */
    problems: PatcherError[];
    /** True when nothing is left of Subline and Discord is untouched. */
    clean: boolean;
    summary: string;
}

/**
 * Remove our plugin's settings from Vencord's `settings.json`.
 *
 * Removes ONE KEY. Deleting the file would take every other plugin's settings
 * with it, and a user who had Vencord before us keeps their setup on the way out
 * exactly as they kept it on the way in.
 */
export function removePluginSettings(settingsPath: string | null): Result<boolean> {
    if (settingsPath === null || !existsSync(settingsPath)) return ok(false);

    let root: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return err<boolean>(
                "IO_ERROR",
                `Vencord's settings file at ${settingsPath} could not be read, so Subline's settings were left in place rather than risking the rest of the file.`,
                { path: settingsPath }
            );
        }
        root = parsed as Record<string, unknown>;
    } catch (cause) {
        return err<boolean>(
            "IO_ERROR",
            `Vencord's settings file at ${settingsPath} could not be read, so Subline's settings were left in place rather than risking the rest of the file.`,
            { path: settingsPath, cause }
        );
    }

    const plugins = root.plugins;
    if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return ok(false);
    const table = plugins as Record<string, unknown>;
    if (!(PLUGIN_SETTINGS_KEY in table)) return ok(false);
    delete table[PLUGIN_SETTINGS_KEY];

    try {
        const temp = `${settingsPath}.subline-tmp`;
        writeFileSync(temp, `${JSON.stringify(root, null, 4)}\n`, "utf8");
        renameSync(temp, settingsPath);
    } catch (cause) {
        return fsError<boolean>(cause, settingsPath, "remove Subline's settings from Vencord's settings file");
    }
    return ok(true);
}

/**
 * Uninstall Subline.
 *
 * Returns a report rather than throwing, because §8's hardest case — the backup
 * is gone — is a sentence the user has to read, not an exception.
 */
export function uninstall(ports: UninstallPorts, options: UninstallOptions): UninstallReport {
    const problems: PatcherError[] = [];
    const restores: RestoreOutcome[] = [];
    const keepSettings = options.keepSettings ?? true;

    // 0. THE PRECONDITION. Nothing is restored while a helper that re-patches
    //    Discord may still be registered — it would undo the uninstall at its
    //    next interval, and the user would be left with software they removed
    //    still modifying another application. Refusing here leaves everything
    //    exactly as it was, which is a state the user can retry from.
    const helperStopped = !options.helper.applicable || options.helper.error === null;
    if (!helperStopped) {
        const error = options.helper.error as PatcherError;
        ports.log.error("uninstall.helper-stop-failed", { code: error.code });
        return {
            restores: [],
            helperStopped: false,
            discordRestored: false,
            modBundleRemoved: false,
            modBundleKeptForSafety: true,
            settingsRemoved: false,
            productDataRemoved: false,
            translationCache: "left-in-discord-storage",
            problems: [error],
            clean: false,
            summary:
                "Subline could not stop its background updater, so nothing was removed. Removing Subline while "
                + "that is still running would put the changes to Discord straight back. Nothing has been changed; "
                + "restart your Mac and try again."
        };
    }
    ports.log.info("uninstall.helper-stopped", {
        applicable: options.helper.applicable,
        removed: options.helper.removed
    });

    // 1. Every Discord first (§8 steps 1–2: restore the archive, remove the
    //    sidecar — a stale one makes the NEXT install misread a foreign or
    //    absent patch as ours).
    for (const install of options.installs) {
        const result = ports.unpatch(install, {});
        if (!result.ok) {
            ports.log.error("uninstall.restore-failed", {
                code: result.error.code,
                branch: install.branch,
                path: install.rootPath
            });
            problems.push(result.error);
            restores.push({ install, ok: false, restored: false, error: result.error });
            continue;
        }
        ports.log.info("uninstall.restored", {
            branch: install.branch,
            restored: result.value.restored,
            alreadyClean: result.value.alreadyClean,
            artifacts: result.value.removedArtifacts.length
        });
        restores.push({ install, ok: true, restored: result.value.restored, error: null });
    }

    const discordRestored = restores.length > 0 && restores.every(entry => entry.ok);

    // 2. The shared bundle — ONLY once no Discord still requires it. Deleting it
    //    under a still-patched Discord stops that Discord from starting at all.
    let modBundleRemoved = false;
    let modBundleKeptForSafety = false;
    if (!discordRestored) {
        modBundleKeptForSafety = true;
        ports.log.warn("uninstall.bundle-kept", { reason: "a Discord is still patched and needs it to start" });
    } else if (ports.modBundleDir !== null) {
        const removed = removeModBundle(ports.modBundleDir);
        if (!removed.ok) {
            problems.push(removed.error);
            ports.log.error("uninstall.bundle-remove-failed", { code: removed.error.code });
        } else {
            modBundleRemoved = removed.value;
            ports.log.info("uninstall.bundle-removed", { removed: removed.value });
        }
    }

    // 3. Settings and our own per-user data (§8 step 5), only if asked.
    let settingsRemoved = false;
    let productDataRemoved = false;
    if (!keepSettings) {
        const removed = removePluginSettings(ports.vencordSettingsPath);
        if (!removed.ok) problems.push(removed.error);
        else settingsRemoved = removed.value;

        if (ports.productDir !== null && existsSync(ports.productDir)) {
            try {
                rmSync(ports.productDir, { recursive: true, force: true });
                productDataRemoved = true;
            } catch (cause) {
                const failure = fsError<boolean>(cause, ports.productDir, "remove Subline's data folder");
                if (!failure.ok) problems.push(failure.error);
            }
        }
    }

    const clean = discordRestored && problems.length === 0;
    return {
        restores,
        helperStopped,
        discordRestored,
        modBundleRemoved,
        modBundleKeptForSafety,
        settingsRemoved,
        productDataRemoved,
        translationCache: "left-in-discord-storage",
        problems,
        clean,
        summary: summarize({ restores, discordRestored, problems, keepSettings, modBundleKeptForSafety })
    };
}

function summarize(input: {
    restores: RestoreOutcome[];
    discordRestored: boolean;
    problems: PatcherError[];
    keepSettings: boolean;
    modBundleKeptForSafety: boolean;
}): string {
    if (input.restores.length === 0) {
        return "There was nothing to remove — Subline is not installed in any Discord we can find.";
    }

    if (!input.discordRestored) {
        // §8's explicit instruction: if the backup is missing, say so and point
        // at Discord's own repair rather than leaving a broken client behind.
        const missingBackup = input.problems.some(problem => problem.code === "BACKUP_MISSING");
        if (missingBackup) {
            return "Subline could not put Discord's original files back, because the backup copy is gone — "
                + "something other than Subline removed it. Discord will keep working as it is, but to return it "
                + "to normal you will need to reinstall Discord from discord.com. Subline's own files have been "
                + "left in place so Discord keeps starting until you do.";
        }
        return "Subline could not fully remove itself from Discord. Nothing has been deleted, so Discord "
            + "keeps working exactly as it does now. The diagnostics log has the details.";
    }

    const tail = input.keepSettings
        ? " Your settings and cached translations were kept, so reinstalling picks up where you left off."
        : " Your settings were removed. Cached translations live inside Discord's own storage and are no longer "
          + "read by anything.";
    return `Discord has been put back to normal and Subline has been removed.${tail}`;
}
