/**
 * `app-version.json`: the installed app tells the plugin its version.
 *
 * The contract crosses two codebases (the installer writes, the plugin reads),
 * so the round trip below runs the PLUGIN's own reader against the file this
 * writer produced, and the alert codes the plugin treats as "could not repair"
 * are checked against the helper's closed list.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_VERSION_FILENAME, appVersionPathFor, writeAppVersionFile, writeAppVersionFromLaunch } from "../src/app/appVersionFile.js";
import { temporaryAppLocation } from "../src/helper/launchAgent.js";
import { raiseAlert } from "../src/helper/alerts.js";
import { emptyHelperState } from "../src/helper/state.js";
import { minAppVersionProblem, readMinAppVersion, versionAtLeast } from "../packaging/minAppVersion.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_DIR = join(REPO_ROOT, "src", "userplugins", "vcTranslate");

interface PluginSignals { managed: boolean; appVersion: string | null; cannotRepair: boolean }
interface PluginAppSignals {
    APP_VERSION_FILENAME: string;
    CANNOT_REPAIR_CODES: readonly string[];
    readAppSignalsSync(options: { dir: string }): PluginSignals;
}

/** The plugin's reader, loaded at run time (the installer cannot compile plugin files). */
async function pluginReader(): Promise<PluginAppSignals> {
    const url = pathToFileURL(join(PLUGIN_DIR, "appSignals.ts")).href;
    return await import(/* @vite-ignore */ url) as PluginAppSignals;
}

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subline-appversion-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("writeAppVersionFile", () => {
    it("writes the version, and a later run replaces it, leaving no temp file", () => {
        const first = writeAppVersionFile(dir, "0.2.3", "app", 1);
        expect(first).toEqual({ ok: true, value: appVersionPathFor(dir) });
        expect(JSON.parse(readFileSync(appVersionPathFor(dir), "utf8"))).toEqual({
            format: 1, product: "subline", appVersion: "0.2.3", writtenBy: "app", writtenAt: 1
        });
        writeAppVersionFile(dir, "0.2.4", "helper", 2);
        expect(JSON.parse(readFileSync(appVersionPathFor(dir), "utf8")).appVersion).toBe("0.2.4");
        expect(readdirSync(dir)).toEqual([APP_VERSION_FILENAME]);
    });

    it("creates the product directory when it is missing", () => {
        const nested = join(dir, "Subline");
        expect(writeAppVersionFile(nested, "0.2.3", "helper").ok).toBe(true);
        expect(existsSync(appVersionPathFor(nested))).toBe(true);
    });

    it("an unsupported platform (no product dir) writes nothing", () => {
        expect(writeAppVersionFile(null, "0.2.3", "app")).toEqual({ ok: true, value: null });
    });

    it("a write that cannot land is returned with its cause, never thrown", () => {
        const blocked = join(dir, "file");
        writeFileSync(blocked, "x");
        const result = writeAppVersionFile(blocked, "0.2.3", "app");
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.cause).toBeTruthy();
    });
});

describe("the app launch records its version only from an installed copy", () => {
    const onImage = () => temporaryAppLocation("/Volumes/Subline 0.2.3/Subline.app", async () => ({ ok: true, value: ["/Volumes/Subline 0.2.3"] }));
    const translocated = () => temporaryAppLocation("/private/var/folders/x/AppTranslocation/ABC/d/Subline.app");
    const installed = () => temporaryAppLocation("/Applications/Subline.app");

    it("run off the disk image with no file yet: the file stays absent", async () => {
        expect(await writeAppVersionFromLaunch(dir, "0.2.3", onImage)).toEqual({ kind: "skipped", reason: "disk-image" });
        expect(existsSync(appVersionPathFor(dir))).toBe(false);
    });

    it("a translocated copy leaves the installed app's 0.2.2 as it is", async () => {
        writeAppVersionFile(dir, "0.2.2", "helper", 1);
        const before = readFileSync(appVersionPathFor(dir), "utf8");
        expect(await writeAppVersionFromLaunch(dir, "0.2.3", translocated)).toEqual({ kind: "skipped", reason: "translocated" });
        expect(readFileSync(appVersionPathFor(dir), "utf8")).toBe(before);
    });

    it("a location check that fails writes nothing", async () => {
        writeAppVersionFile(dir, "0.2.2", "helper", 1);
        const outcome = await writeAppVersionFromLaunch(dir, "0.2.3", () => Promise.reject(new Error("hdiutil gone")));
        expect(outcome.kind).toBe("location-failed");
        expect(JSON.parse(readFileSync(appVersionPathFor(dir), "utf8")).appVersion).toBe("0.2.2");
    });

    it("the installed app writes its version", async () => {
        const outcome = await writeAppVersionFromLaunch(dir, "0.2.3", installed, 5);
        expect(outcome).toEqual({ kind: "written", result: { ok: true, value: appVersionPathFor(dir) } });
        expect(JSON.parse(readFileSync(appVersionPathFor(dir), "utf8"))).toMatchObject({ appVersion: "0.2.3", writtenBy: "app" });
    });

    it("main.ts writes at launch only through the location check", () => {
        const main = readFileSync(join(REPO_ROOT, "installer", "src", "main", "main.ts"), "utf8");
        expect(main).not.toMatch(/recordAppVersion\("app"\)/);
        expect(main).toMatch(/writeAppVersionFromLaunch\(productDirFor\(\), app\.getVersion\(\), \(\) => appLocationFor\(helperWiring\(\)\)\)/);
    });
});

describe("the plugin reads what the installer writes", () => {
    it("same file name on both sides", async () => {
        expect((await pluginReader()).APP_VERSION_FILENAME).toBe(APP_VERSION_FILENAME);
    });

    it("a written version round-trips through the plugin's reader", async () => {
        const { readAppSignalsSync } = await pluginReader();
        mkdirSync(join(dir, "mod"));
        writeFileSync(join(dir, "mod", "subline-mod.json"), "{}");
        expect(readAppSignalsSync({ dir })).toEqual({ managed: true, appVersion: null, cannotRepair: false });
        writeAppVersionFile(dir, "0.2.3", "helper");
        expect(readAppSignalsSync({ dir })).toEqual({ managed: true, appVersion: "0.2.3", cannotRepair: false });
    });

    it("a repatch-failed alert the helper raises reads as could-not-repair in the plugin", async () => {
        const { readAppSignalsSync } = await pluginReader();
        const state = emptyHelperState();
        await raiseAlert(state, { code: "repatch-failed", message: "m", detail: {}, at: 5 }, {
            notify: async () => { }, productDir: dir, now: () => 5
        });
        expect(readAppSignalsSync({ dir }).cannotRepair).toBe(true);
    });

    it("every could-not-repair code the plugin knows is a code the helper can raise", async () => {
        const source = readFileSync(join(REPO_ROOT, "installer", "src", "helper", "alerts.ts"), "utf8");
        const union = /export type AlertCode =([\s\S]*?);/.exec(source)![1]!;
        const codes = [...union.matchAll(/\| "([a-z-]+)"/g)].map(m => m[1]);
        for (const code of (await pluginReader()).CANNOT_REPAIR_CODES) expect(codes, code).toContain(code);
    });
});

describe("the release guard (packaging/minAppVersion.ts)", () => {
    it("finds the plugin's MIN_APP_VERSION", () => {
        expect(readMinAppVersion(REPO_ROOT)).toBe("0.2.3");
    });

    it("compares versions numerically", () => {
        expect(versionAtLeast("0.2.3", "0.2.3")).toBe(true);
        expect(versionAtLeast("0.2.10", "0.2.3")).toBe(true);
        expect(versionAtLeast("0.2.2", "0.2.3")).toBe(false);
        expect(versionAtLeast("0.2", "0.2.0")).toBe(true);
    });

    it("refuses an app below the minimum, and a source it cannot read", () => {
        expect(minAppVersionProblem("0.2.3", REPO_ROOT)).toBeNull();
        expect(minAppVersionProblem("0.2.2", REPO_ROOT)).toMatch(/MIN_APP_VERSION is 0\.2\.3/);
        expect(minAppVersionProblem("0.2.3", dir)).toMatch(/could not read/);
    });
});
