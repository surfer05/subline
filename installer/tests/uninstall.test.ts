/**
 * §8. The property that matters most is an ORDERING one: the shared mod bundle
 * must outlive any Discord that is still patched, because the stub is a literal
 * require() of a path inside it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PLUGIN_SETTINGS_KEY } from "../src/app/language.js";
import { removePluginSettings, uninstall } from "../src/app/uninstall.js";
import type { HelperRemoval, UninstallPorts, UninstallSystemPorts } from "../src/app/uninstall.js";
import { manifestPathFor } from "../src/bundle/spec.js";
import type { DiscordInstall } from "../src/patcher/locate.js";
import type { UnpatchReport } from "../src/patcher/patch.js";
import type { PatcherErrorCode, Result } from "../src/patcher/result.js";
import { installModBundle } from "../src/app/modInstall.js";
import { makeModBundleFixture, uninstallSystemFake } from "./fixture.js";
import type { ModBundleFixture, UninstallSystemFake } from "./fixture.js";

const INSTALL: DiscordInstall = {
    branch: "stable",
    rootPath: "/Applications/Discord.app",
    stableId: "/Applications/Discord.app",
    resourcesPath: "/Applications/Discord.app/Contents/Resources",
    asarPath: "/Applications/Discord.app/Contents/Resources/app.asar",
    backupPath: "/Applications/Discord.app/Contents/Resources/_app.asar",
    buildInfoPath: "/Applications/Discord.app/Contents/Resources/build_info.json",
    fromExplicitPath: false
};
const PTB: DiscordInstall = { ...INSTALL, branch: "ptb", rootPath: "/Applications/Discord PTB.app", stableId: "/Applications/Discord PTB.app" };


let root: string;
let source: ModBundleFixture;
let modDir: string;
let productDir: string;
let settingsPath: string;
let logged: string[];
/** The system ports: Discord's processes, the quit, the helper. Fakes only. */
let sys: UninstallSystemFake;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subline-uninstall-"));
    source = makeModBundleFixture();
    productDir = join(root, "Subline");
    modDir = join(productDir, "mod");
    settingsPath = join(root, "Vencord", "settings", "settings.json");
    logged = [];
    sys = uninstallSystemFake();
    installModBundle({ sourceDir: source.dir, destDir: modDir });
    writeFileSync(join(productDir, "status.json"), '{"format":1}', "utf8");
});

afterEach(() => {
    source.cleanup();
    rmSync(root, { recursive: true, force: true });
});

function unpatchOk(install: DiscordInstall): Result<UnpatchReport> {
    return {
        ok: true,
        value: {
            install,
            restored: true,
            alreadyClean: false,
            removedArtifacts: [`${install.resourcesPath}/subline-patch.json`],
            previousState: "patched-by-us",
            summary: "restored"
        }
    };
}

function unpatchFail(code: PatcherErrorCode, message: string): Result<UnpatchReport> {
    return { ok: false, error: { code, message } };
}

/**
 * A failure only the write can find (a file held open, a refused rename):
 * the dry run passes, the real restore fails. Records every real attempt.
 */
function failsOnWrite(code: PatcherErrorCode, attempts: string[] = []): UninstallPorts["unpatch"] {
    return (install, options) => {
        if (options.dryRun === true) return unpatchOk(install);
        attempts.push(install.branch);
        return unpatchFail(code, `${code} on ${install.branch}`);
    };
}

function ports(overrides: Partial<UninstallPorts & UninstallSystemPorts> = {}): UninstallPorts & UninstallSystemPorts {
    return {
        ...sys.ports,
        unpatch: install => unpatchOk(install),
        modBundleDir: modDir,
        productDir,
        logDir: null,
        vencordSettingsPath: settingsPath,
        log: {
            info: event => logged.push(`info:${event}`),
            warn: event => logged.push(`warn:${event}`),
            error: event => logged.push(`error:${event}`)
        },
        ...overrides
    };
}

function writeSettings(value: unknown): void {
    mkdirSync(join(root, "Vencord", "settings"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(value, null, 2), "utf8");
}

describe("uninstall — the background helper must be stopped first (§8 step 3)", () => {
    it("changes NOTHING when the helper could not be stopped", async () => {
        // The helper re-patches Discord silently. Restoring Discord under a live
        // agent means it puts the patch straight back at its next interval.
        sys = uninstallSystemFake({
            helper: { applicable: true, removed: false, error: { code: "HELPER_REGISTRATION_FAILED", message: "launchctl refused" } }
        });
        writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { sublineCode: "slp_kept" } } });
        const attempted: string[] = [];
        const report = await uninstall(
            ports({ unpatch: (install, options) => { if (options.dryRun !== true) attempted.push(install.branch); return unpatchOk(install); } }),
            { installs: [INSTALL, PTB], keepSettings: false }
        );

        expect(attempted).toEqual([]);
        expect(report.helperStopped).toBe(false);
        expect(report.nothingChanged).toBe(true);
        expect(report.clean).toBe(false);
        expect(report.problems[0]?.code).toBe("HELPER_REGISTRATION_FAILED");
        expect(report.summary).toContain("background updater");
        // Whatever half of the removal happened is put back.
        expect(sys.calls).toContain("restoreHelper");
        // Nothing was deleted, so the user can retry from exactly here.
        expect(existsSync(manifestPathFor(modDir))).toBe(true);
        expect(existsSync(join(productDir, "status.json"))).toBe(true);
        expect(readFileSync(settingsPath, "utf8")).toContain("slp_kept");
    });

    // AUDIT 2026-10-06: "restart your Mac" was the only remedy, on Windows too.
    it("names the remedy for the platform when the helper could not be stopped", async () => {
        const error = { code: "HELPER_REGISTRATION_FAILED" as const, message: "schtasks refused" };
        sys = uninstallSystemFake({ platform: "win32", helper: { applicable: true, removed: false, error } });
        const windows = await uninstall(ports(), { installs: [INSTALL] });
        expect(windows.summary).toContain("Task Scheduler");
        expect(windows.summary).not.toContain("Mac");

        sys = uninstallSystemFake({ platform: "darwin", helper: { applicable: true, removed: false, error } });
        const mac = await uninstall(ports(), { installs: [INSTALL] });
        expect(mac.summary).toContain("Restart your Mac");
        expect(mac.summary).not.toContain("Task Scheduler");
    });

    it("proceeds when there is no helper to stop on this platform", async () => {
        sys = uninstallSystemFake({ helper: { applicable: false, removed: false, error: null } });
        const report = await uninstall(ports(), { installs: [INSTALL] });
        expect(report.helperStopped).toBe(true);
        expect(report.discordRestored).toBe(true);
    });

    it("proceeds when Discord is not running", async () => {
        const report = await uninstall(ports(), { installs: [INSTALL] });
        expect(report.discordRestored).toBe(true);
    });

    it("records that the helper is gone", async () => {
        const report = await uninstall(ports(), { installs: [INSTALL] });
        expect(report.helperStopped).toBe(true);
        expect(logged).toContain("info:uninstall.helper-stopped");
    });

    it("stops the helper only after every check, and before the first restore", async () => {
        const order: string[] = [];
        const report = await uninstall(
            ports({
                unpatch: (install, options) => { order.push(options.dryRun === true ? "dry" : "restore"); return unpatchOk(install); },
                removeHelper: async () => { order.push("removeHelper"); return { applicable: true, removed: true, error: null }; },
                listDiscordProcesses: async () => { order.push("list"); return []; }
            }),
            { installs: [INSTALL] }
        );
        expect(order).toEqual(["dry", "list", "removeHelper", "restore"]);
        expect(report.clean).toBe(true);
    });
});

/* ------------------------------------------------------------------------ *
 * I3 (field test 2026-10-08): Discord open at uninstall
 * ------------------------------------------------------------------------ */

describe("uninstall — Discord still open", () => {
    for (const platform of ["win32", "darwin"] as const) {
        it(`${platform}: refuses with nothing changed, helper and settings untouched`, async () => {
            sys = uninstallSystemFake({ platform, running: [[{ pid: 4242 }]] });
            writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { sublineCode: "slp_kept" } } });
            const attempts: string[] = [];
            const report = await uninstall(
                ports({ unpatch: (install, options) => { if (options.dryRun !== true) attempts.push(install.branch); return unpatchOk(install); } }),
                { installs: [INSTALL], keepSettings: false }
            );

            expect(report.problems[0]?.code).toBe("DISCORD_RUNNING");
            expect(report.nothingChanged).toBe(true);
            expect(attempts).toEqual([]);
            // THE FIELD BUG: the helper used to be removed before this check.
            expect(sys.calls).not.toContain("removeHelper");
            expect(sys.calls).not.toContain("quit:ask");
            expect(readFileSync(settingsPath, "utf8")).toContain("slp_kept");
            expect(existsSync(manifestPathFor(modDir))).toBe(true);
            expect(existsSync(join(productDir, "status.json"))).toBe(true);
            expect(report.summary).toContain("Nothing has been changed.");
            if (platform === "win32") {
                expect(report.summary).toContain("Discord is still open in the background, behind the ^ near the clock.");
            } else {
                // The Mac has no ^ and no tray: its wording must stay a Mac's.
                expect(report.summary).toContain("Discord is still open.");
                expect(report.summary).not.toMatch(/\^|clock|tray/);
            }
        });

        it(`${platform}: quits Discord first when asked, then removes`, async () => {
            sys = uninstallSystemFake({ platform, running: [[]] });
            const report = await uninstall(ports(), { installs: [INSTALL], closeDiscord: "ask" });
            expect(sys.calls).toEqual(["quit:ask", "list", "removeHelper"]);
            expect(report.clean).toBe(true);
        });

        it(`${platform}: the quit failed, or Discord started itself again: nothing changed`, async () => {
            // The quit port returns, but Discord is still in the process table.
            sys = uninstallSystemFake({ platform, running: [[{ pid: 7 }]] });
            writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { sublineCode: "slp_kept" } } });
            const report = await uninstall(ports(), { installs: [INSTALL], closeDiscord: "ask", keepSettings: false });
            expect(sys.calls).toEqual(["quit:ask", "list"]);
            expect(report.problems[0]?.code).toBe("DISCORD_RUNNING");
            expect(report.nothingChanged).toBe(true);
            expect(readFileSync(settingsPath, "utf8")).toContain("slp_kept");
            expect(report.summary).toContain("Subline could not quit it.");
            expect(report.summary).toContain(platform === "win32" ? "Quit Discord" : "from its menu");
        });
    }
});

/* ------------------------------------------------------------------------ *
 * I1 (field test 2026-10-08): a refused or failed uninstall changes nothing
 * ------------------------------------------------------------------------ */

describe("uninstall — a refused or failed uninstall keeps settings, code, data and helper", () => {
    const CODE_SETTINGS = { plugins: { [PLUGIN_SETTINGS_KEY]: { sublineCode: "slp_kept", installId: "a".repeat(32), targetLang: "tr" } } };

    for (const code of ["FOREIGN_MOD_PRESENT", "BACKUP_MISSING", "BACKUP_CORRUPT"] as const) {
        it(`${code} is found by the dry run: nothing written, helper never stopped`, async () => {
            writeSettings(CODE_SETTINGS);
            const before = readFileSync(settingsPath, "utf8");
            const writes: string[] = [];
            const report = await uninstall(
                ports({
                    unpatch: (install, options) => {
                        if (options.dryRun !== true) writes.push(install.branch);
                        return unpatchFail(code, `${code} here`);
                    }
                }),
                { installs: [INSTALL], keepSettings: false }
            );
            expect(report.problems[0]?.code).toBe(code);
            expect(report.nothingChanged).toBe(true);
            expect(writes).toEqual([]);
            expect(sys.calls).not.toContain("removeHelper");
            expect(readFileSync(settingsPath, "utf8")).toBe(before);
            expect(existsSync(join(productDir, "status.json"))).toBe(true);
            expect(existsSync(manifestPathFor(modDir))).toBe(true);
            expect(report.settingsRemoved).toBe(false);
            expect(report.summary).toContain("Nothing has been changed.");
        });
    }

    it("a dry-run refusal on the second of two Discords restores neither", async () => {
        const writes: string[] = [];
        const report = await uninstall(
            ports({
                unpatch: (install, options) => {
                    if (options.dryRun !== true) writes.push(install.branch);
                    return install.branch === "ptb" ? unpatchFail("FOREIGN_MOD_PRESENT", "Vencord is.") : unpatchOk(install);
                }
            }),
            { installs: [INSTALL, PTB], keepSettings: false }
        );
        expect(writes).toEqual([]);
        expect(report.nothingChanged).toBe(true);
        expect(sys.calls).not.toContain("removeHelper");
    });

    for (const code of ["FILE_IN_USE", "PERMISSION_DENIED"] as const) {
        it(`${code} at the write: settings, code and data kept, the helper is put back`, async () => {
            writeSettings(CODE_SETTINGS);
            const before = readFileSync(settingsPath, "utf8");
            const report = await uninstall(ports({ unpatch: failsOnWrite(code) }), { installs: [INSTALL], keepSettings: false });

            expect(report.problems[0]?.code).toBe(code);
            expect(readFileSync(settingsPath, "utf8")).toBe(before);
            expect(report.settingsRemoved).toBe(false);
            expect(report.productDataRemoved).toBe(false);
            expect(existsSync(join(productDir, "status.json"))).toBe(true);
            expect(existsSync(manifestPathFor(modDir))).toBe(true);
            expect(sys.calls).toEqual(["list", "removeHelper", "restoreHelper"]);
            expect(report.helperStopped).toBe(false);
            expect(logged).toContain("warn:uninstall.settings-kept");
            // Read from the outcomes: the helper WAS stopped, so "nothing has
            // been deleted" would be false.
            expect(report.summary).not.toMatch(/Nothing has been (changed|deleted)/);
            expect(report.summary).toContain("Your settings and code were kept.");
            expect(report.summary).toContain("keeps updating");
        });
    }

    it("partial restore across two Discords: one restored, one failed, says 1 of 2 and keeps everything", async () => {
        writeSettings(CODE_SETTINGS);
        const before = readFileSync(settingsPath, "utf8");
        const report = await uninstall(
            ports({
                unpatch: (install, options) =>
                    options.dryRun === true || install.branch === "stable"
                        ? unpatchOk(install)
                        : unpatchFail("FILE_IN_USE", "PTB is using app.asar.")
            }),
            { installs: [INSTALL, PTB], keepSettings: false }
        );
        expect(report.restores.map(entry => entry.ok)).toEqual([true, false]);
        expect(report.discordRestored).toBe(false);
        expect(readFileSync(settingsPath, "utf8")).toBe(before);
        expect(existsSync(join(productDir, "status.json"))).toBe(true);
        expect(existsSync(join(modDir, "patcher.js"))).toBe(true);
        expect(sys.calls).toContain("restoreHelper");
        expect(report.summary).toContain("1 of 2 Discords");
    });

    it("says so when the helper could not be put back", async () => {
        sys = uninstallSystemFake({ restoreHelper: { ok: false, error: { code: "HELPER_REGISTRATION_FAILED", message: "no" } } });
        const report = await uninstall(ports({ unpatch: failsOnWrite("FILE_IN_USE") }), { installs: [INSTALL] });
        expect(report.helperStopped).toBe(true);
        expect(report.problems.map(problem => problem.code)).toContain("HELPER_REGISTRATION_FAILED");
        expect(report.summary).toContain("Background updates could not be turned back on.");
    });

    it("a remembered Discord still marked keeps the settings and brings the helper back", async () => {
        const ptbResources = join(root, "PTB", "Resources");
        mkdirSync(ptbResources, { recursive: true });
        writeFileSync(join(ptbResources, "subline-patch.json"), "{}", "utf8");
        writeSettings(CODE_SETTINGS);
        const before = readFileSync(settingsPath, "utf8");
        const report = await uninstall(ports(), { installs: [INSTALL], keepSettings: false, rememberedResources: [ptbResources] });
        expect(report.discordRestored).toBe(false);
        expect(readFileSync(settingsPath, "utf8")).toBe(before);
        expect(sys.calls).toContain("restoreHelper");
    });

    it("a clean uninstall never brings the helper back", async () => {
        writeSettings(CODE_SETTINGS);
        const report = await uninstall(ports(), { installs: [INSTALL, PTB], keepSettings: false });
        expect(report.clean).toBe(true);
        expect(report.settingsRemoved).toBe(true);
        expect(sys.calls).not.toContain("restoreHelper");
    });
});

describe("uninstall", () => {
    it("restores Discord and removes the mod bundle", async () => {
        const report = await uninstall(ports(), { installs: [INSTALL] });
        expect(report.discordRestored).toBe(true);
        expect(report.modBundleRemoved).toBe(true);
        expect(report.clean).toBe(true);
        expect(existsSync(modDir)).toBe(false);
        expect(report.summary).toContain("put back to normal");
    });

    it("restores every install before removing the shared bundle", async () => {
        const order: string[] = [];
        const report = await uninstall(
            ports({
                unpatch: (install, options) => { if (options.dryRun !== true) order.push(install.branch); return unpatchOk(install); }
            }),
            { installs: [INSTALL, PTB] }
        );
        expect(order).toEqual(["stable", "ptb"]);
        expect(report.restores).toHaveLength(2);
        expect(existsSync(modDir)).toBe(false);
    });

    it("keeps it even when asked to remove settings, because the bundle lives inside that folder", async () => {
        // THE REGRESSION. The test above passed with keepSettings defaulting to
        // true, so the settings step never ran. With it false, step 3 removed
        // the product directory wholesale — and modBundleDirFor is
        // productDir/mod, so it deleted the bundle step 2 had just decided to
        // keep. The result on a real machine was Discord refusing to start:
        // "Cannot find module .../Subline/mod/patcher.js", a stub pointing at
        // a module that no longer existed. An uninstall that fails must leave
        // things working.
        const report = await uninstall(
            ports({ unpatch: failsOnWrite("FILE_IN_USE") }),
            { installs: [INSTALL], keepSettings: false }
        );

        expect(report.discordRestored).toBe(false);
        expect(report.modBundleKeptForSafety).toBe(true);
        // The patched Discord can still start.
        expect(existsSync(join(modDir, "patcher.js"))).toBe(true);
        expect(existsSync(manifestPathFor(modDir))).toBe(true);
        // And the folder that contains it survived with it.
        expect(report.productDataRemoved).toBe(false);
        expect(existsSync(productDir)).toBe(true);
    });

    it("does remove the product folder once every Discord is restored", async () => {
        const report = await uninstall(ports(), {
            installs: [INSTALL],
            keepSettings: false
        });
        expect(report.discordRestored).toBe(true);
        expect(report.productDataRemoved).toBe(true);
        expect(existsSync(productDir)).toBe(false);
    });

    it("KEEPS the bundle when any Discord is still patched — deleting it would stop Discord starting", async () => {
        const report = await uninstall(
            ports({
                unpatch: (install, options) =>
                    install.branch === "stable" || options.dryRun === true
                        ? unpatchOk(install)
                        : unpatchFail("PERMISSION_DENIED", "Not allowed to restore app.asar.")
            }),
            { installs: [INSTALL, PTB] }
        );

        expect(report.discordRestored).toBe(false);
        expect(report.modBundleKeptForSafety).toBe(true);
        expect(report.modBundleRemoved).toBe(false);
        // The bundle the still-patched Discord requires is still there.
        expect(existsSync(manifestPathFor(modDir))).toBe(true);
        expect(existsSync(join(modDir, "patcher.js"))).toBe(true);
        expect(report.clean).toBe(false);
    });

    it("says plainly what to do when the backup is gone, per §8", async () => {
        const report = await uninstall(
            ports({ unpatch: () => unpatchFail("BACKUP_MISSING", "Discord's original app.asar backup is missing.") }),
            { installs: [INSTALL] }
        );
        expect(report.discordRestored).toBe(false);
        expect(report.summary).toContain("backup copy is gone");
        expect(report.summary).toContain("reinstall Discord");
        expect(report.problems[0]?.code).toBe("BACKUP_MISSING");
        // And it does not leave a broken client: nothing was deleted.
        expect(existsSync(manifestPathFor(modDir))).toBe(true);
    });

    it("keeps settings and per-user data by default", async () => {
        writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { targetLang: "tr" } } });
        const report = await uninstall(ports(), { installs: [INSTALL] });
        expect(report.settingsRemoved).toBe(false);
        expect(report.productDataRemoved).toBe(false);
        expect(existsSync(settingsPath)).toBe(true);
        expect(existsSync(join(productDir, "status.json"))).toBe(true);
        expect(report.summary).toContain("kept");
    });

    it("removes settings and per-user data when asked", async () => {
        writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { targetLang: "tr" } } });
        const report = await uninstall(ports(), { installs: [INSTALL], keepSettings: false });
        expect(report.settingsRemoved).toBe(true);
        expect(report.productDataRemoved).toBe(true);
        expect(existsSync(productDir)).toBe(false);
    });

    it("says settings were kept when they were kept", async () => {
        const report = await uninstall(ports(), { installs: [INSTALL], keepSettings: true });
        expect(report.settingsRemoved).toBe(false);
        expect(report.summary).toContain("were kept");
        expect(report.summary).not.toContain("were removed");
    });

    it("never claims a removal that did not happen", async () => {
        // The summary used to read `keepSettings` — the REQUEST — so a removal
        // that was asked for and then did not happen still announced "your
        // settings were removed". A screen telling someone something untrue
        // about their own machine is worse than one that says nothing.
        const report = await uninstall(
            ports({ productDir: null, vencordSettingsPath: join(root, "nowhere", "settings.json") }),
            { installs: [INSTALL], keepSettings: false }
        );
        expect(report.settingsRemoved).toBe(false);
        expect(report.productDataRemoved).toBe(false);
        expect(report.summary).not.toContain("Your settings were removed");
    });

    it("is honest that the translation cache is not ours to delete", async () => {
        const report = await uninstall(ports(), { installs: [INSTALL], keepSettings: false });
        expect(report.translationCache).toBe("left-in-discord-storage");
        expect(report.summary).toContain("Discord's own storage");
        expect(report.summary).not.toContain("cache has been deleted");
    });

    it("reports having nothing to remove rather than claiming success", async () => {
        const report = await uninstall(ports(), { installs: [] });
        expect(report.discordRestored).toBe(false);
        expect(report.summary).toContain("nothing to remove");
    });

    it("tolerates a bundle that is already gone", async () => {
        rmSync(modDir, { recursive: true, force: true });
        const report = await uninstall(ports(), { installs: [INSTALL] });
        expect(report.modBundleRemoved).toBe(false);
        expect(report.problems).toHaveLength(0);
        expect(report.clean).toBe(true);
    });

    it("refuses to delete a mod directory that is not one of ours", async () => {
        rmSync(modDir, { recursive: true, force: true });
        mkdirSync(modDir, { recursive: true });
        writeFileSync(join(modDir, "not-ours.txt"), "someone else's", "utf8");

        const report = await uninstall(ports(), { installs: [INSTALL] });
        expect(report.problems[0]?.code).toBe("MOD_BUNDLE_INVALID");
        expect(existsSync(join(modDir, "not-ours.txt"))).toBe(true);
        expect(report.clean).toBe(false);
    });

    it("does nothing on an unsupported platform rather than deleting a null path", async () => {
        const report = await uninstall(ports({ modBundleDir: null, productDir: null }), {
            installs: [INSTALL],
            keepSettings: false
        });
        expect(report.modBundleRemoved).toBe(false);
        expect(report.productDataRemoved).toBe(false);
        expect(report.discordRestored).toBe(true);
    });

    it("logs every restore and every failure", async () => {
        await uninstall(ports({ unpatch: failsOnWrite("IO_ERROR") }), { installs: [INSTALL] });
        expect(logged).toContain("error:uninstall.restore-failed");
        expect(logged).toContain("warn:uninstall.bundle-kept");
    });
});

describe("removePluginSettings", () => {
    it("removes only our key, leaving every other plugin untouched", async () => {
        writeSettings({
            autoUpdate: false,
            plugins: {
                SomeOtherPlugin: { enabled: true, favouriteColour: "green" },
                [PLUGIN_SETTINGS_KEY]: { enabled: true, targetLang: "tr" }
            }
        });
        const result = removePluginSettings(settingsPath);
        expect(result.ok && result.value).toBe(true);

        const written = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(written.plugins[PLUGIN_SETTINGS_KEY]).toBeUndefined();
        expect(written.plugins.SomeOtherPlugin).toEqual({ enabled: true, favouriteColour: "green" });
        expect(written.autoUpdate).toBe(false);
    });

    it("removing settings also removes the install id and any code, so a reinstall starts clean", async () => {
        writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { installId: "0".repeat(32), sublineCode: "", clearedPurchaseCode: "LICENSE-OLD" } } });
        removePluginSettings(settingsPath);
        const written = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(written.plugins[PLUGIN_SETTINGS_KEY]).toBeUndefined();
    });

    it("never deletes the settings file itself", async () => {
        writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { targetLang: "tr" } } });
        removePluginSettings(settingsPath);
        expect(existsSync(settingsPath)).toBe(true);
    });

    it("reports false when there was nothing of ours in there", async () => {
        writeSettings({ plugins: { SomeOtherPlugin: { enabled: true } } });
        const result = removePluginSettings(settingsPath);
        expect(result.ok && result.value).toBe(false);
    });

    it("reports false rather than failing when there is no settings file at all", async () => {
        expect(removePluginSettings(join(root, "absent.json"))).toEqual({ ok: true, value: false });
        expect(removePluginSettings(null)).toEqual({ ok: true, value: false });
    });

    it("leaves an unparsable settings file alone instead of rewriting it", async () => {
        mkdirSync(join(root, "Vencord", "settings"), { recursive: true });
        writeFileSync(settingsPath, "{ not json", "utf8");
        const result = removePluginSettings(settingsPath);
        expect(result.ok).toBe(false);
        expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
    });

    it("refuses a settings file that PARSES but is not an object", async () => {
        // JSON.parse succeeds here, so the try/catch never fires and only the
        // shape check stands between us and rewriting somebody's file as
        // `{"plugins":…}`. A mutation deleting that check survived until this
        // test existed.
        for (const contents of ["[1,2,3]", '"a string"', "42", "null"]) {
            mkdirSync(join(root, "Vencord", "settings"), { recursive: true });
            writeFileSync(settingsPath, contents, "utf8");
            const result = removePluginSettings(settingsPath);
            expect(result.ok).toBe(false);
            expect(readFileSync(settingsPath, "utf8")).toBe(contents);
        }
    });

    it("leaves no temp file behind", async () => {
        writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { targetLang: "tr" } } });
        removePluginSettings(settingsPath);
        expect(existsSync(`${settingsPath}.subline-tmp`)).toBe(false);
    });
});

/* ------------------------------------------------------------------------ *
 * The invariant
 * ------------------------------------------------------------------------ */

/**
 * ONE RULE, ACROSS EVERY OUTCOME: an uninstall must never leave Discord unable
 * to start.
 *
 * Discord starts iff its `app.asar` is the original, OR our stub is still there
 * AND the bundle that stub requires still exists. There is no third state, and
 * the failure that produced this block was precisely the fourth: a stub with no
 * bundle, which Discord answers with "Cannot find module …/Subline/mod/patcher.js"
 * and then refuses to open at all.
 *
 * Every earlier test asserted a property of ONE path. This one sweeps the
 * combinations, because the bug lived in the interaction between two steps that
 * were each individually correct — step 2 kept the bundle, step 3 deleted the
 * folder containing it, and the only test covering step 2 never ran step 3.
 */
describe("whatever happens, Discord can still start", () => {
    const OUTCOMES = [
        { name: "restore succeeded", unpatch: unpatchOk },
        {
            name: "restore refused — file in use",
            unpatch: () => unpatchFail("FILE_IN_USE", "Discord is using app.asar.")
        },
        {
            name: "restore refused — permission",
            unpatch: failsOnWrite("PERMISSION_DENIED")
        },
        {
            name: "restore refused — backup missing",
            unpatch: () => unpatchFail("BACKUP_MISSING", "_app.asar is gone.")
        }
    ];

    const HELPERS: { name: string; helper: HelperRemoval }[] = [
        { name: "helper gone", helper: { applicable: true, removed: true, error: null } },
        { name: "no helper on this platform", helper: { applicable: false, removed: false, error: null } }
    ];

    for (const outcome of OUTCOMES) {
        for (const helper of HELPERS) {
            for (const keepSettings of [true, false]) {
                it(`${outcome.name}, ${helper.name}, keepSettings=${keepSettings}`, async () => {
                    sys = uninstallSystemFake({ helper: helper.helper });
                    writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { sublineCode: "slp_kept" } } });
                    const report = await uninstall(
                        ports({ unpatch: outcome.unpatch }),
                        { installs: [INSTALL], keepSettings }
                    );

                    // I1: Subline still in Discord means its settings (the code)
                    // are still there, and so is a helper to keep it working.
                    if (!report.discordRestored) {
                        expect(readFileSync(settingsPath, "utf8")).toContain("slp_kept");
                        expect(report.settingsRemoved).toBe(false);
                        if (helper.helper.removed) {
                            expect(report.nothingChanged === true || sys.calls.includes("restoreHelper")).toBe(true);
                        }
                    }

                    // THE INVARIANT. If Discord was not returned to its original
                    // state, whatever it still requires to start must still be
                    // on disk.
                    if (!report.discordRestored) {
                        expect(existsSync(join(modDir, "patcher.js"))).toBe(true);
                        expect(existsSync(manifestPathFor(modDir))).toBe(true);
                        expect(report.modBundleRemoved).toBe(false);
                        expect(report.productDataRemoved).toBe(false);
                    }

                    // And a report that claims to be clean must have earned it.
                    if (report.clean) {
                        expect(report.discordRestored).toBe(true);
                        expect(report.problems).toEqual([]);
                    }
                });
            }
        }
    }

    it("refuses before touching anything when Discord is running", async () => {
        // The precondition has to hold across the same matrix: nothing removed,
        // nothing restored, everything retryable.
        for (const keepSettings of [true, false]) {
            sys = uninstallSystemFake({ running: [[{ pid: 1 }]] });
            const report = await uninstall(ports(), { installs: [INSTALL], keepSettings });
            expect(sys.calls).not.toContain("removeHelper");
            expect(report.problems[0]?.code).toBe("DISCORD_RUNNING");
            expect(existsSync(join(modDir, "patcher.js"))).toBe(true);
            expect(existsSync(productDir)).toBe(true);
            expect(report.clean).toBe(false);
        }
    });
});

describe("the diagnostics log survives its own uninstall", () => {
    it("keeps the log directory when it sits inside the product folder", async () => {
        // WINDOWS. logDirFor puts the log at %LOCALAPPDATA%\Subline\logs, which
        // is INSIDE productDir, and step 3 removed productDir wholesale — so an
        // uninstall deleted the record of the very run doing the removing. The
        // folder then reappeared empty on the next append, and Copy diagnostics
        // returned only the lines written after the deletion.
        const logDir = join(productDir, "logs");
        mkdirSync(logDir, { recursive: true });
        writeFileSync(join(logDir, "subline.log"), "the run being reported\n", "utf8");

        const report = await uninstall(
            ports({ logDir }),
            { installs: [INSTALL], keepSettings: false }
        );

        expect(report.productDataRemoved).toBe(true);
        expect(existsSync(join(logDir, "subline.log"))).toBe(true);
        // Everything else of ours still went.
        expect(existsSync(join(productDir, "status.json"))).toBe(false);
    });

    it("removes the whole product folder when the log lives elsewhere", async () => {
        // macOS: ~/Library/Logs is outside, so there is nothing to preserve and
        // leaving an empty folder behind would just be litter.
        const report = await uninstall(
            ports({ logDir: null }),
            { installs: [INSTALL], keepSettings: false }
        );
        expect(report.productDataRemoved).toBe(true);
        expect(existsSync(productDir)).toBe(false);
    });
});
