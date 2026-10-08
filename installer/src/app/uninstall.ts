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

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
// realFs for everything that touches an ".asar" path: Electron treats those as
// virtual archives rather than files, so restoring _app.asar over app.asar
// fails inside the packaged app. `rmSync` stays on node:fs — it only ever
// removes our own bundle directory, which has no ".asar" in its path.
import { existsSync, readFileSync, renameSync, writeFileSync } from "../patcher/realFs.js";

import { removeModBundle } from "../bundle/bundle.js";
import { recoverModBundle } from "./modInstall.js";
import { MARKER_FILENAME } from "../patcher/marker.js";
import type { DiscordBranch, DiscordInstall } from "../patcher/locate.js";
import type { UnpatchReport } from "../patcher/patch.js";
import type { PatcherError, Result } from "../patcher/result.js";
import { err, fsError, ok } from "../patcher/result.js";
import { isInstallId } from "./activation.js";
import { CLEARED_CODE_KEY, INSTALL_ID_KEY, PLUGIN_SETTINGS_KEY } from "./language.js";
import { UNINSTALL_COPY, discordRunningSummary, helperStopFailedSummary } from "./uninstallScreen.js";

export interface UninstallPorts {
    /** `dryRun`: decide and write nothing (see UnpatchOptions.dryRun). */
    unpatch(install: DiscordInstall, options: { removeForeignMod?: boolean; dryRun?: boolean }): Result<UnpatchReport>;
    /** For the copy only: where Discord hides when it is "closed" differs. */
    platform: NodeJS.Platform;
    /** Where the runtime mod bundle lives, or `null` on an unsupported platform. */
    modBundleDir: string | null;
    /** Subline's per-user directory — the beacon and anything else we own. */
    productDir: string | null;
    /**
     * The diagnostics log directory, when it sits INSIDE `productDir`.
     *
     * Passed in rather than derived, for the same reason every other path here
     * is: this module does no I/O and knows no layout. `null` means the log
     * lives somewhere else entirely — macOS keeps it under ~/Library/Logs — in
     * which case there is nothing here to preserve.
     */
    logDir: string | null;
    /** Vencord's settings.json, so our plugin's key can be removed from it. */
    vencordSettingsPath: string | null;
    log: {
        info(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
        warn(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
        error(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
    };
}


/**
 * What happened when the helper was stopped (§8 step 3).
 *
 * `applicable: false` is the honest answer on a platform with no helper, or
 * when one was never installed.
 */
export interface HelperRemoval {
    applicable: boolean;
    removed: boolean;
    error: PatcherError | null;
}

/**
 * The steps of an uninstall that talk to the system, as ports.
 *
 * THE ORDERING LIVES IN `uninstall()`, NOT IN ITS CALLER. It used to be split:
 * main.ts removed the helper first and handed the outcome in, and only then
 * did anything check whether Discord was running or whether its files could be
 * put back. Field logs (2026-10-06, 2026-10-08) show the result five times: the
 * helper gone, the uninstall refused (DISCORD_RUNNING, FOREIGN_MOD_PRESENT),
 * and Discord left patched with nothing to repair it. An ordering only one
 * function enforces is one a test can hold it to.
 */
export interface UninstallSystemPorts {
    /**
     * Discord processes running now, for these branches. Only the branches
     * Subline is in: a Canary running Vencord is none of our business.
     */
    listDiscordProcesses(branches: readonly DiscordBranch[]): Promise<readonly { pid: number }[]>;
    /**
     * Close Discord on the user's behalf (ask, then force). Only called when
     * the user pressed the button that says so.
     */
    quitDiscord(mode: "ask" | "force", branches: readonly DiscordBranch[]): Promise<void>;
    /** Stop the background helper. Called only once every check has passed. */
    removeHelper(): Promise<HelperRemoval>;
    /**
     * Register the helper again. Called when a restore failed after the helper
     * was stopped, so no Discord that still loads Subline is left without it.
     */
    restoreHelper(): Promise<Result<unknown>>;
    /**
     * Stop managing these Discords (stable ids): Uninstall put them back to
     * normal. Removes them from the helper's memory and the installer's
     * record, and marks them released, so a helper brought back for another
     * Discord never puts Subline back into them.
     */
    forgetInstalls?(stableIds: readonly string[]): Result<unknown>;
}

export interface UninstallOptions {
    installs: readonly DiscordInstall[];
    /** §8 step 5: the user's answer. Defaults to keeping, which is the safe direction. */
    keepSettings?: boolean;
    /** The user pressed "Quit Discord and remove": close Discord before anything else. */
    closeDiscord?: "ask" | "force";
    /**
     * Resources folders of every Discord Subline remembers patching
     * (patched-installs.json), checked again before the shared bundle is
     * deleted. A Discord still carrying our marker there still require()s the
     * bundle, whatever happened to the others.
     */
    rememberedResources?: readonly string[];
}

export interface RestoreOutcome {
    install: DiscordInstall;
    ok: boolean;
    /** True when Discord's original archive is back in place. */
    restored: boolean;
    error: PatcherError | null;
    /**
     * Why this Discord was left as it is, when Subline is not in it: another
     * client mod owns it, its files could not be read and carry no marker of
     * ours, or Subline was never there. Never touched, never a blocker.
     */
    leftAlone: LeftAloneReason | null;
}

export type LeftAloneReason =
    | { kind: "foreign"; mod: string | null }
    | { kind: "unreadable" }
    | { kind: "not-ours" }
    /** Another account on this Mac set Subline up here (audit #5). Only that account may remove it. */
    | { kind: "other-account" };

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
    /**
     * True when the uninstall was refused before it wrote anything: the
     * helper, Discord, the settings and Subline's files are exactly as they
     * were. The install flow may carry on from here (see main.ts).
     */
    nothingChanged?: boolean;
    /** True when the user pressed Cancel before anything was changed. */
    cancelled?: boolean;
    /** True when the App Management check itself kept failing, before anything was changed. */
    permissionCheckFailed?: boolean;
    summary: string;
}

/** A report for a refusal that changed nothing. */
export function refusedReport(problems: PatcherError[], summary: string): UninstallReport {
    return {
        restores: [],
        helperStopped: false,
        discordRestored: false,
        modBundleRemoved: false,
        modBundleKeptForSafety: false,
        settingsRemoved: false,
        productDataRemoved: false,
        translationCache: "left-in-discord-storage",
        problems,
        clean: false,
        nothingChanged: true,
        summary
    };
}

/**
 * Remove our plugin's settings from Vencord's `settings.json`, all but the install id
 * (and a cleared code, see below).
 *
 * Touches ONE KEY. Deleting the file would take every other plugin's settings
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

    // THE INSTALL ID STAYS (owner decision, audit 2026-10-06 #38). The relay
    // ties a purchase and one of the account's three computer slots to it, so
    // deleting it made every reinstall a new computer: a paying user who
    // uninstalled with the box ticked a few times was locked out for 30 days.
    // Kept, a reinstall is recognised and the plan comes back by itself. It is
    // 16 random bytes tied to nothing else, so keeping it costs nothing.
    // `clearedPurchaseCode` stays with it: it is the reader's own "do not bring
    // this code back" (flow.ts checkSavedInstall), and the kept id is exactly
    // what lets the relay offer that code again. Everything else goes: the
    // code, the language, the engine. readPriorUse ignores both kept keys, so
    // the reinstall is a fresh install again (language asked, paid gate).
    const block = table[PLUGIN_SETTINGS_KEY];
    const kept: Record<string, unknown> = {};
    let removedSomething = true;
    if (typeof block === "object" && block !== null && !Array.isArray(block)) {
        const entries = block as Record<string, unknown>;
        if (isInstallId(entries[INSTALL_ID_KEY])) kept[INSTALL_ID_KEY] = entries[INSTALL_ID_KEY];
        const cleared = entries[CLEARED_CODE_KEY];
        if (typeof cleared === "string" && cleared.trim() !== "") kept[CLEARED_CODE_KEY] = cleared;
        removedSomething = Object.keys(entries).some(key => !(key in kept));
    }
    // Only what is kept was there: nothing to remove, and nothing to rewrite.
    if (!removedSomething) return ok(false);
    if (Object.keys(kept).length === 0) delete table[PLUGIN_SETTINGS_KEY];
    else table[PLUGIN_SETTINGS_KEY] = kept;

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
 *
 * THE RULE (field test 2026-10-08, I1): a refused or failed uninstall changes
 * nothing the user would miss. Every check that can refuse runs BEFORE the
 * first write, in this order:
 *
 *   1. dry run of every restore (another mod, a missing or damaged backup),
 *   2. close Discord, if the user asked, and check it is really gone,
 *   3. stop the helper (a live helper would put the patch straight back).
 *
 * Only then is anything restored. A restore that still fails (a file held
 * open) brings the helper back, and the settings, the code and Subline's own
 * files are removed only once no Discord loads Subline any more. Observed on
 * Windows: the uninstall was refused with FOREIGN_MOD_PRESENT, the settings
 * (with the code) were already gone, and Discord kept running Subline as
 * "Not activated".
 */
export async function uninstall(
    ports: UninstallPorts & UninstallSystemPorts,
    options: UninstallOptions
): Promise<UninstallReport> {
    const problems: PatcherError[] = [];
    const restores: RestoreOutcome[] = [];
    const keepSettings = options.keepSettings ?? true;

    // 1. THE DRY RUN. Everything a read can tell, before Discord is closed and
    //    before the helper is touched. Another mod, a missing backup, a
    //    damaged one: each refuses here with nothing changed, rather than
    //    after the helper is gone and half the Discords are restored.
    //
    //    ONLY SUBLINE'S DISCORDS TAKE PART (audit 2026-10-06 #2). Subline on
    //    Stable with Vencord on Canary is common in this audience; a Discord
    //    another mod owns, one whose files cannot be read and carry no marker
    //    of ours, or one Subline was never in, is left exactly as it is and
    //    listed. It never blocks the uninstall of the Discords that ARE ours.
    const ours: DiscordInstall[] = [];
    const leftAlone = new Map<DiscordInstall, LeftAloneReason>();
    for (const install of options.installs) {
        const verdict = ports.unpatch(install, { dryRun: true });
        if (verdict.ok) {
            if (verdict.value.foreignMod !== undefined) {
                leftAlone.set(install, { kind: "foreign", mod: verdict.value.foreignMod });
            } else if (verdict.value.alreadyClean) {
                leftAlone.set(install, { kind: "not-ours" });
            } else {
                ours.push(install);
            }
            continue;
        }
        if (verdict.error.code === "OTHER_ACCOUNT") {
            leftAlone.set(install, { kind: "other-account" });
            continue;
        }
        if (verdict.error.code === "BROKEN_INSTALL" && !existsSync(join(install.resourcesPath, MARKER_FILENAME))) {
            leftAlone.set(install, { kind: "unreadable" });
            continue;
        }
        ports.log.error("uninstall.refused", {
            code: verdict.error.code,
            branch: install.branch,
            path: install.rootPath
        });
        return refusedReport([verdict.error], refusalSummary(verdict.error));
    }
    for (const [install, reason] of leftAlone) {
        ports.log.info("uninstall.left-alone", {
            branch: install.branch,
            path: install.rootPath,
            reason: reason.kind,
            mod: reason.kind === "foreign" ? reason.mod : null
        });
    }
    const ourBranches = [...new Set(ours.map(install => install.branch))];

    // 2. DISCORD MUST BE CLOSED. Restoring Discord renames _app.asar back over
    //    app.asar, and Windows refuses to rename a file a running process holds
    //    open. Checked again after a quit, because a quit can fail and Discord
    //    can start itself again.
    if (options.closeDiscord !== undefined && ourBranches.length > 0) {
        await ports.quitDiscord(options.closeDiscord, ourBranches);
    }
    const running = ourBranches.length > 0 ? await ports.listDiscordProcesses(ourBranches) : [];
    if (running.length > 0) {
        ports.log.error("uninstall.discord-running", {
            pids: running.map(p => p.pid).join(","),
            afterQuit: options.closeDiscord !== undefined
        });
        return refusedReport(
            [{ code: "DISCORD_RUNNING", message: "Discord is running, so its files cannot be changed back." }],
            discordRunningSummary(ports.platform, options.closeDiscord !== undefined)
        );
    }

    // 3. THE HELPER. Nothing is restored while a helper that re-patches Discord
    //    may still be registered: it would undo the uninstall at its next
    //    interval.
    const helper = await ports.removeHelper();
    if (helper.applicable && helper.error !== null) {
        ports.log.error("uninstall.helper-stop-failed", { code: helper.error.code, message: helper.error.message });
        // Whatever half of the removal happened, put it back.
        const back = await restoreHelperLogged(ports);
        const report = refusedReport([helper.error], helperStopFailedSummary(ports.platform));
        return back ? report : { ...report, nothingChanged: false };
    }
    ports.log.info("uninstall.helper-stopped", { applicable: helper.applicable, removed: helper.removed });

    // 3b. A BUNDLE AN INTERRUPTED SWAP LEFT ASIDE goes back first (audit
    //     2026-10-06 #45). If a restore below fails, the bundle is kept for
    //     the Discord that still loads it, and it must be really there. The
    //     helper that would have put it back at its next run was just stopped.
    if (ports.modBundleDir !== null) {
        const recovered = recoverModBundle(ports.modBundleDir, ports.platform);
        if (!recovered.ok) {
            problems.push(recovered.error);
            ports.log.error("uninstall.bundle-recover-failed", { code: recovered.error.code, path: recovered.error.path ?? null, cause: recovered.error.cause ?? null });
        } else if (recovered.value) {
            ports.log.info("uninstall.bundle-recovered", { dir: ports.modBundleDir });
        }
    }

    // 4. Every Discord (§8 steps 1–2: restore the archive, remove the sidecar
    //    — a stale one makes the NEXT install misread a foreign or absent patch
    //    as ours).
    for (const install of options.installs) {
        const reason = leftAlone.get(install);
        if (reason !== undefined) {
            restores.push({ install, ok: true, restored: false, error: null, leftAlone: reason });
            continue;
        }
        const result = ports.unpatch(install, {});
        if (!result.ok) {
            ports.log.error("uninstall.restore-failed", {
                code: result.error.code,
                branch: install.branch,
                path: install.rootPath
            });
            problems.push(result.error);
            restores.push({ install, ok: false, restored: false, error: result.error, leftAlone: null });
            continue;
        }
        ports.log.info("uninstall.restored", {
            branch: install.branch,
            restored: result.value.restored,
            alreadyClean: result.value.alreadyClean,
            artifacts: result.value.removedArtifacts.length
        });
        restores.push({
            install,
            ok: true,
            restored: result.value.restored,
            error: null,
            leftAlone: result.value.foreignMod !== undefined ? { kind: "foreign", mod: result.value.foreignMod } : null
        });
    }

    // "Every target restored" is not "no Discord needs Subline": an unrelated
    // clean Stable restores fine while a hand-picked PTB elsewhere still loads
    // Subline. Every Discord we remember patching that was NOT just restored
    // is checked by its marker.
    const restoredHere = new Set(restores.filter(entry => entry.ok).map(entry => entry.install.resourcesPath));
    const stillMarked = [...new Set(options.rememberedResources ?? [])]
        .filter(resources => !restoredHere.has(resources) && existsSync(join(resources, MARKER_FILENAME)));
    if (stillMarked.length > 0) {
        ports.log.warn("uninstall.still-patched", {
            reason: "a Discord Subline patched still carries its marker",
            paths: stillMarked.join(", ")
        });
    }
    // True for an empty list: with no Discord at all, nothing loads Subline,
    // and Subline's own files and helper go (audit 2026-10-06 #40: they used
    // to be kept forever, "for safety", with no Discord to keep them for).
    const nothingLoadsSubline = restores.every(entry => entry.ok) && stillMarked.length === 0;
    const discordRestored = nothingLoadsSubline;

    // 5a. THE DISCORDS PUT BACK ARE RELEASED. A partial uninstall brings the
    //     helper back for the Discord that kept Subline, and its memory still
    //     named the ones just restored: an unpatched Discord it remembers is
    //     "an update wiped the injection", and it patched Subline straight
    //     back in. A branch with any failed restore stays managed (on Windows
    //     the stable id is the branch folder, shared by its app-x folders).
    const failedIds = new Set(restores.filter(entry => !entry.ok).map(entry => entry.install.stableId));
    const releasedIds = [...new Set(restores
        .filter(entry => entry.ok && entry.leftAlone === null)
        .map(entry => entry.install.stableId))]
        .filter(id => !failedIds.has(id));
    if (releasedIds.length > 0 && ports.forgetInstalls !== undefined) {
        try {
            const forgot = ports.forgetInstalls(releasedIds);
            if (forgot.ok) ports.log.info("uninstall.released", { installs: releasedIds.length });
            else ports.log.error("uninstall.release-failed", { code: forgot.error.code, message: forgot.error.message });
        } catch (cause) {
            ports.log.error("uninstall.release-failed", { cause: String(cause) });
        }
    }

    // 5. A DISCORD STILL LOADS SUBLINE: the helper comes back. Without it the
    //    next Discord update ends translation silently and nothing repairs it.
    let helperStopped = true;
    let helperBack: boolean | null = null;
    if (!nothingLoadsSubline && helper.applicable && helper.removed) {
        helperBack = await restoreHelperLogged(ports);
        if (helperBack) helperStopped = false;
        else problems.push({ code: "HELPER_REGISTRATION_FAILED", message: UNINSTALL_COPY.helperNotBack });
    }

    // 6. The shared bundle — ONLY once no Discord still requires it. Deleting it
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

    // 7. Settings and our own per-user data (§8 step 5), only if asked, and
    //    ONLY ONCE NO DISCORD LOADS SUBLINE. The settings hold the code: a
    //    Subline still running in Discord without them is "Not activated".
    let settingsRemoved = false;
    let productDataRemoved = false;
    if (!keepSettings && !nothingLoadsSubline) {
        ports.log.warn("uninstall.settings-kept", { reason: "a Discord still loads Subline" });
    } else if (!keepSettings) {
        const removed = removePluginSettings(ports.vencordSettingsPath);
        if (!removed.ok) problems.push(removed.error);
        else settingsRemoved = removed.value;
        ports.log.info("uninstall.settings", { removed: settingsRemoved, ok: removed.ok });

        // THE BUNDLE LIVES INSIDE THIS DIRECTORY. `modBundleDirFor` is
        // `productDir/mod`, so removing the product directory wholesale
        // deletes the very thing step 6 has just decided to keep.
        //
        // That is not hypothetical. A restore failed with the file in use, the
        // bundle was kept so the still-patched Discord could start, and then
        // this ran and deleted it — leaving a stub in Discord's app.asar
        // pointing at a module that no longer existed. Discord refused to start
        // at all, with "Cannot find module .../Subline/mod/patcher.js".
        if (modBundleKeptForSafety) {
            ports.log.warn("uninstall.product-data-kept", {
                reason: "the mod bundle inside it is still required by a patched Discord"
            });
        } else if (ports.productDir !== null && existsSync(ports.productDir)) {
            try {
                // EVERYTHING EXCEPT THE LOG BEING WRITTEN RIGHT NOW.
                //
                // On Windows the diagnostics log lives INSIDE this folder
                // (%LOCALAPPDATA%\Subline\logs), so removing it wholesale
                // deleted the record of the very run doing the removing.
                if (ports.logDir === null) {
                    // macOS keeps the log under ~/Library/Logs, so the folder
                    // goes too.
                    rmSync(ports.productDir, { recursive: true, force: true });
                } else {
                    for (const entry of readdirSync(ports.productDir)) {
                        if (join(ports.productDir, entry) === ports.logDir) continue;
                        rmSync(join(ports.productDir, entry), { recursive: true, force: true });
                    }
                }
                productDataRemoved = true;
            } catch (cause) {
                const failure = fsError<boolean>(cause, ports.productDir, "remove Subline's data folder");
                if (!failure.ok) problems.push(failure.error);
            }
        }
    }

    const clean = nothingLoadsSubline && problems.length === 0;
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
        nothingChanged: false,
        summary: summarize({
            restores,
            discordRestored,
            helperRemoved: helper.removed,
            filesRemoved: modBundleRemoved || productDataRemoved,
            settingsRemoved,
            productDataRemoved,
            settingsAskedToGo: !keepSettings,
            helperBack,
            bundlePresent: ports.modBundleDir === null || existsSync(ports.modBundleDir)
        })
    };
}

async function restoreHelperLogged(ports: UninstallPorts & UninstallSystemPorts): Promise<boolean> {
    try {
        const back = await ports.restoreHelper();
        if (back.ok) ports.log.info("uninstall.helper-restored", {});
        else ports.log.error("uninstall.helper-restore-failed", { code: back.error.code, message: back.error.message });
        return back.ok;
    } catch (cause) {
        ports.log.error("uninstall.helper-restore-failed", { cause: String(cause) });
        return false;
    }
}

/** What a refusal found by the dry run says. Nothing was changed. */
function refusalSummary(error: PatcherError): string {
    const unchanged = `${UNINSTALL_COPY.nothingChanged} ${UNINSTALL_COPY.keepsWorking}`;
    // §8's explicit instruction: if the backup is missing, say so and point at
    // Discord's own repair rather than leaving a broken client behind.
    if (error.code === "BACKUP_MISSING") return `${UNINSTALL_COPY.backupGone} ${unchanged}`;
    if (error.code === "BACKUP_CORRUPT" || error.code === "BROKEN_INSTALL") return `${UNINSTALL_COPY.damaged} ${unchanged}`;
    return `${UNINSTALL_COPY.couldNotRemove} ${unchanged} ${UNINSTALL_COPY.tryAgain}`;
}

const BRANCH_NAMES: Record<DiscordBranch, string> = {
    stable: "Discord",
    ptb: "Discord PTB",
    canary: "Discord Canary"
};

/** "Left alone: Discord Canary, another client mod (Vencord)." Only the ones worth saying. */
function leftAloneLine(restores: readonly RestoreOutcome[]): string | null {
    const items = restores.flatMap(entry => {
        const reason = entry.leftAlone;
        if (reason === null || reason.kind === "not-ours") return [];
        const name = BRANCH_NAMES[entry.install.branch];
        if (reason.kind === "unreadable") return [`${name}, ${UNINSTALL_COPY.leftAloneUnreadable}`];
        if (reason.kind === "other-account") return [`${name}, ${UNINSTALL_COPY.leftAloneOtherAccount}`];
        return [`${name}, ${UNINSTALL_COPY.leftAloneForeign}${reason.mod === null ? "" : ` (${reason.mod})`}`];
    });
    return items.length === 0 ? null : `${UNINSTALL_COPY.leftAlone} ${items.join("; ")}.`;
}

function summarize(input: {
    restores: RestoreOutcome[];
    discordRestored: boolean;
    helperRemoved: boolean;
    /** The mod bundle or the product folder went. */
    filesRemoved: boolean;
    /** What ACTUALLY happened, not what was asked for. */
    settingsRemoved: boolean;
    productDataRemoved: boolean;
    settingsAskedToGo: boolean;
    /** null: the helper was not stopped or did not need to come back. */
    helperBack: boolean | null;
    /** The mod bundle is on disk (or there is no bundle folder on this platform). */
    bundlePresent: boolean;
}): string {
    const aside = leftAloneLine(input.restores);
    const withAside = (parts: string[]): string => [...parts, ...(aside === null ? [] : [aside])].join(" ");
    // The Discords Subline was actually in. The others were left alone.
    const ours = input.restores.filter(entry => entry.leftAlone === null);

    if (!input.discordRestored) {
        // Read from the outcomes. This used to say "Nothing has been deleted"
        // after the helper was gone and, sometimes, after the settings were.
        const total = ours.length;
        const done = ours.filter(entry => entry.ok).length;
        const parts = [
            done > 0 && done < total
                ? `Subline was removed from ${done} of ${total} Discords, but not from the rest.`
                : UNINSTALL_COPY.couldNotRemove,
            !input.bundlePresent
                ? UNINSTALL_COPY.bundleMissing
                : input.helperBack === true ? UNINSTALL_COPY.staysInstalledUpdating : UNINSTALL_COPY.staysInstalled
        ];
        if (input.helperBack === false) parts.push(UNINSTALL_COPY.helperNotBack);
        if (input.settingsAskedToGo) parts.push(UNINSTALL_COPY.settingsKept);
        if (aside !== null) parts.push(aside);
        parts.push(UNINSTALL_COPY.tryAgain);
        return parts.join(" ");
    }

    if (ours.length === 0) {
        // No Discord had Subline in it. Say what of Subline's own did go.
        // A Discord another account set up is that account's, said first.
        const lead = input.restores.some(entry => entry.leftAlone?.kind === "other-account")
            ? [UNINSTALL_COPY.otherAccount]
            : [];
        const removed = [
            ...(input.filesRemoved ? [UNINSTALL_COPY.itsFiles] : []),
            ...(input.helperRemoved ? [UNINSTALL_COPY.itsUpdater] : [])
        ];
        if (removed.length === 0 && !input.settingsRemoved) {
            return withAside([...lead, ...(lead.length > 0 ? [] : [UNINSTALL_COPY.nothingToRemove])]);
        }
        return withAside([
            ...lead,
            UNINSTALL_COPY.noDiscordWithSubline,
            ...(removed.length > 0 ? [`Subline removed ${removed.join(" and ")}.`] : []),
            ...(input.settingsRemoved ? [UNINSTALL_COPY.settingsRemoved] : [])
        ]);
    }

    // Reads the OUTCOME, not the request. It used to read `keepSettings`, so a
    // removal that was asked for and then did not happen still announced "your
    // settings were removed" — a screen telling the user something about their
    // own machine that was not true.
    // Either counts: a machine with no settings file still had its product
    // folder removed, and "nothing was there to delete" is not the same
    // statement as "we kept your settings".
    const tail = input.settingsRemoved || input.productDataRemoved
        ? "Your settings were removed. Cached translations live inside Discord's own storage and are no longer "
          + "read by anything."
        : "Your settings and cached translations were kept, so reinstalling picks up where you left off.";
    return withAside(["Discord has been put back to normal and Subline has been removed.", tail]);
}
