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
import type { HelperRemoval, UninstallPorts } from "../src/app/uninstall.js";
import { manifestPathFor } from "../src/bundle/spec.js";
import type { DiscordInstall } from "../src/patcher/locate.js";
import type { UnpatchReport } from "../src/patcher/patch.js";
import type { PatcherErrorCode, Result } from "../src/patcher/result.js";
import { installModBundle } from "../src/app/modInstall.js";
import { makeModBundleFixture } from "./fixture.js";
import type { ModBundleFixture } from "./fixture.js";

const INSTALL: DiscordInstall = {
    branch: "stable",
    rootPath: "/Applications/Discord.app",
    resourcesPath: "/Applications/Discord.app/Contents/Resources",
    asarPath: "/Applications/Discord.app/Contents/Resources/app.asar",
    backupPath: "/Applications/Discord.app/Contents/Resources/_app.asar",
    buildInfoPath: "/Applications/Discord.app/Contents/Resources/build_info.json",
    fromExplicitPath: false
};
const PTB: DiscordInstall = { ...INSTALL, branch: "ptb", rootPath: "/Applications/Discord PTB.app" };

/** The ordinary precondition: the caller stopped the helper before calling us. */
const HELPER_GONE: HelperRemoval = { applicable: true, removed: true, error: null };

let root: string;
let source: ModBundleFixture;
let modDir: string;
let productDir: string;
let settingsPath: string;
let logged: string[];

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subline-uninstall-"));
    source = makeModBundleFixture();
    productDir = join(root, "Subline");
    modDir = join(productDir, "mod");
    settingsPath = join(root, "Vencord", "settings", "settings.json");
    logged = [];
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

function ports(overrides: Partial<UninstallPorts> = {}): UninstallPorts {
    return {
        unpatch: install => unpatchOk(install),
        modBundleDir: modDir,
        productDir,
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
    it("changes NOTHING when the helper could not be stopped", () => {
        // The helper re-patches Discord silently. Restoring Discord under a live
        // agent means it puts the patch straight back at its next interval —
        // software the user removed, still modifying another application.
        const attempted: string[] = [];
        const report = uninstall(
            ports({ unpatch: install => { attempted.push(install.branch); return unpatchOk(install); } }),
            {
                installs: [INSTALL, PTB],
                keepSettings: false,
                helper: {
                    applicable: true,
                    removed: false,
                    error: { code: "HELPER_REGISTRATION_FAILED", message: "launchctl refused" }
                }
            }
        );

        expect(attempted).toEqual([]);
        expect(report.helperStopped).toBe(false);
        expect(report.clean).toBe(false);
        expect(report.discordRestored).toBe(false);
        expect(report.problems[0]?.code).toBe("HELPER_REGISTRATION_FAILED");
        expect(report.summary).toContain("background updater");
        // Nothing was deleted, so the user can retry from exactly here.
        expect(existsSync(manifestPathFor(modDir))).toBe(true);
        expect(existsSync(join(productDir, "status.json"))).toBe(true);
    });

    it("proceeds when there is no helper to stop on this platform", () => {
        const report = uninstall(ports(), {
            installs: [INSTALL],
            helper: { applicable: false, removed: false, error: null }
        });
        expect(report.helperStopped).toBe(true);
        expect(report.discordRestored).toBe(true);
    });

    it("records that the helper is gone", () => {
        const report = uninstall(ports(), { installs: [INSTALL], helper: HELPER_GONE });
        expect(report.helperStopped).toBe(true);
        expect(logged).toContain("info:uninstall.helper-stopped");
    });
});

describe("uninstall", () => {
    it("restores Discord and removes the mod bundle", () => {
        const report = uninstall(ports(), { installs: [INSTALL], helper: HELPER_GONE });
        expect(report.discordRestored).toBe(true);
        expect(report.modBundleRemoved).toBe(true);
        expect(report.clean).toBe(true);
        expect(existsSync(modDir)).toBe(false);
        expect(report.summary).toContain("put back to normal");
    });

    it("restores every install before removing the shared bundle", () => {
        const order: string[] = [];
        const report = uninstall(
            ports({
                unpatch: install => { order.push(install.branch); return unpatchOk(install); }
            }),
            { installs: [INSTALL, PTB], helper: HELPER_GONE }
        );
        expect(order).toEqual(["stable", "ptb"]);
        expect(report.restores).toHaveLength(2);
        expect(existsSync(modDir)).toBe(false);
    });

    it("KEEPS the bundle when any Discord is still patched — deleting it would stop Discord starting", () => {
        const report = uninstall(
            ports({
                unpatch: install =>
                    install.branch === "stable"
                        ? unpatchOk(install)
                        : unpatchFail("PERMISSION_DENIED", "Not allowed to restore app.asar.")
            }),
            { installs: [INSTALL, PTB], helper: HELPER_GONE }
        );

        expect(report.discordRestored).toBe(false);
        expect(report.modBundleKeptForSafety).toBe(true);
        expect(report.modBundleRemoved).toBe(false);
        // The bundle the still-patched Discord requires is still there.
        expect(existsSync(manifestPathFor(modDir))).toBe(true);
        expect(existsSync(join(modDir, "patcher.js"))).toBe(true);
        expect(report.clean).toBe(false);
    });

    it("says plainly what to do when the backup is gone, per §8", () => {
        const report = uninstall(
            ports({ unpatch: () => unpatchFail("BACKUP_MISSING", "Discord's original app.asar backup is missing.") }),
            { installs: [INSTALL], helper: HELPER_GONE }
        );
        expect(report.discordRestored).toBe(false);
        expect(report.summary).toContain("backup copy is gone");
        expect(report.summary).toContain("reinstall Discord");
        expect(report.problems[0]?.code).toBe("BACKUP_MISSING");
        // And it does not leave a broken client: nothing was deleted.
        expect(existsSync(manifestPathFor(modDir))).toBe(true);
    });

    it("keeps settings and per-user data by default", () => {
        writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { targetLang: "tr" } } });
        const report = uninstall(ports(), { installs: [INSTALL], helper: HELPER_GONE });
        expect(report.settingsRemoved).toBe(false);
        expect(report.productDataRemoved).toBe(false);
        expect(existsSync(settingsPath)).toBe(true);
        expect(existsSync(join(productDir, "status.json"))).toBe(true);
        expect(report.summary).toContain("kept");
    });

    it("removes settings and per-user data when asked", () => {
        writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { targetLang: "tr" } } });
        const report = uninstall(ports(), { installs: [INSTALL], keepSettings: false, helper: HELPER_GONE });
        expect(report.settingsRemoved).toBe(true);
        expect(report.productDataRemoved).toBe(true);
        expect(existsSync(productDir)).toBe(false);
    });

    it("is honest that the translation cache is not ours to delete", () => {
        const report = uninstall(ports(), { installs: [INSTALL], keepSettings: false, helper: HELPER_GONE });
        expect(report.translationCache).toBe("left-in-discord-storage");
        expect(report.summary).toContain("Discord's own storage");
        expect(report.summary).not.toContain("cache has been deleted");
    });

    it("reports having nothing to remove rather than claiming success", () => {
        const report = uninstall(ports(), { installs: [], helper: HELPER_GONE });
        expect(report.discordRestored).toBe(false);
        expect(report.summary).toContain("nothing to remove");
    });

    it("tolerates a bundle that is already gone", () => {
        rmSync(modDir, { recursive: true, force: true });
        const report = uninstall(ports(), { installs: [INSTALL], helper: HELPER_GONE });
        expect(report.modBundleRemoved).toBe(false);
        expect(report.problems).toHaveLength(0);
        expect(report.clean).toBe(true);
    });

    it("refuses to delete a mod directory that is not one of ours", () => {
        rmSync(modDir, { recursive: true, force: true });
        mkdirSync(modDir, { recursive: true });
        writeFileSync(join(modDir, "not-ours.txt"), "someone else's", "utf8");

        const report = uninstall(ports(), { installs: [INSTALL], helper: HELPER_GONE });
        expect(report.problems[0]?.code).toBe("MOD_BUNDLE_INVALID");
        expect(existsSync(join(modDir, "not-ours.txt"))).toBe(true);
        expect(report.clean).toBe(false);
    });

    it("does nothing on an unsupported platform rather than deleting a null path", () => {
        const report = uninstall(ports({ modBundleDir: null, productDir: null }), {
            installs: [INSTALL],
            keepSettings: false,
            helper: HELPER_GONE
        });
        expect(report.modBundleRemoved).toBe(false);
        expect(report.productDataRemoved).toBe(false);
        expect(report.discordRestored).toBe(true);
    });

    it("logs every restore and every failure", () => {
        uninstall(ports({ unpatch: () => unpatchFail("IO_ERROR", "nope") }), { installs: [INSTALL], helper: HELPER_GONE });
        expect(logged).toContain("error:uninstall.restore-failed");
        expect(logged).toContain("warn:uninstall.bundle-kept");
    });
});

describe("removePluginSettings", () => {
    it("removes only our key, leaving every other plugin untouched", () => {
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

    it("never deletes the settings file itself", () => {
        writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { targetLang: "tr" } } });
        removePluginSettings(settingsPath);
        expect(existsSync(settingsPath)).toBe(true);
    });

    it("reports false when there was nothing of ours in there", () => {
        writeSettings({ plugins: { SomeOtherPlugin: { enabled: true } } });
        const result = removePluginSettings(settingsPath);
        expect(result.ok && result.value).toBe(false);
    });

    it("reports false rather than failing when there is no settings file at all", () => {
        expect(removePluginSettings(join(root, "absent.json"))).toEqual({ ok: true, value: false });
        expect(removePluginSettings(null)).toEqual({ ok: true, value: false });
    });

    it("leaves an unparsable settings file alone instead of rewriting it", () => {
        mkdirSync(join(root, "Vencord", "settings"), { recursive: true });
        writeFileSync(settingsPath, "{ not json", "utf8");
        const result = removePluginSettings(settingsPath);
        expect(result.ok).toBe(false);
        expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
    });

    it("refuses a settings file that PARSES but is not an object", () => {
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

    it("leaves no temp file behind", () => {
        writeSettings({ plugins: { [PLUGIN_SETTINGS_KEY]: { targetLang: "tr" } } });
        removePluginSettings(settingsPath);
        expect(existsSync(`${settingsPath}.subline-tmp`)).toBe(false);
    });
});
