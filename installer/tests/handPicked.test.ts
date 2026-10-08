/**
 * A Discord the user picked by hand (only PTB or Canary, or an unusual
 * folder). Detection never finds it again, so before patched-installs.json:
 * Uninstall said "There was nothing to remove" and left it patched, or found
 * an unrelated clean Stable and deleted the mod bundle the hand-picked Discord
 * still require()s. Each test fails on that code.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installModBundle } from "../src/app/modInstall.js";
import { forgetPatchedInstalls, readPatchedInstalls, releaseRestoredInstalls, rememberPatchedInstall } from "../src/app/patchedInstalls.js";
import { helperStatePathFor, readHelperState, writeHelperState, emptyHelperState } from "../src/helper/state.js";
import { uninstall } from "../src/app/uninstall.js";
import { locateDiscordInstalls, rememberedResourcesPath, uninstallTargets } from "../src/patcher/locate.js";
import { MARKER_FILENAME } from "../src/patcher/marker.js";
import { patchInstall, unpatchInstall } from "../src/patcher/patch.js";
import { isOtherAccountLoader } from "../src/patcher/ownership.js";
import { makeDiscordFixture, makeModBundleFixture, uninstallSystemFake } from "./fixture.js";
import { PLUGIN_SETTINGS_KEY } from "../src/app/language.js";
import { buildStubAsar } from "../src/patcher/stub.js";
import type { DiscordInstall } from "../src/patcher/locate.js";
import type { Fixture, ModBundleFixture } from "./fixture.js";

let ptb: Fixture;
let stable: Fixture;
let shipped: ModBundleFixture;
let productDir: string;
let modDir: string;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
    ptb = makeDiscordFixture({ appName: "Discord PTB.app" });
    stable = makeDiscordFixture();
    shipped = makeModBundleFixture();
    productDir = join(mkdtempSync(join(tmpdir(), "subline-product-")), "Subline");
    modDir = join(productDir, "mod");
    const installed = installModBundle({ sourceDir: shipped.dir, destDir: modDir });
    if (!installed.ok) throw new Error(installed.error.message);
});

afterEach(() => {
    ptb.cleanup();
    stable.cleanup();
    shipped.cleanup();
    rmSync(join(productDir, ".."), { recursive: true, force: true });
});

/** What the flow does for a hand-picked PTB: locate it by its path, patch it, remember it. */
function patchPickedPtb() {
    const located = locateDiscordInstalls({ platform: "darwin", searchRoots: [], explicitPaths: [ptb.install.rootPath] });
    if (!located.ok) throw new Error(located.error.message);
    const install = located.value[0]!;
    const patched = patchInstall(install, { modBundleDir: modDir, productVersion: "0.2.1" });
    if (!patched.ok) throw new Error(patched.error.message);
    expect(rememberPatchedInstall(productDir, install).ok).toBe(true);
    return install;
}

describe("a hand-picked Discord", () => {
    it("is found again by Uninstall, through the remembered list, and restored", async () => {
        const install = patchPickedPtb();
        expect(install.branch).toBe("ptb");
        const remembered = readPatchedInstalls(productDir);
        const targets = uninstallTargets({ platform: "darwin", searchRoots: [] }, remembered);
        expect(targets.map(t => t.rootPath)).toContain(ptb.install.rootPath);

        const report = await uninstall(
            { ...uninstallSystemFake({ helper: { applicable: false, removed: false, error: null } }).ports, unpatch: (target, opts) => unpatchInstall(target, opts), modBundleDir: modDir, productDir, logDir: null, vencordSettingsPath: null, log: quiet },
            {
                installs: targets,
                rememberedResources: remembered.map(entry => rememberedResourcesPath(entry, "darwin"))
            }
        );
        expect(report.discordRestored).toBe(true);
        expect(existsSync(join(ptb.install.resourcesPath, MARKER_FILENAME))).toBe(false);
        expect(report.modBundleRemoved).toBe(true);
    });

    it("keeps the bundle while a remembered Discord still carries Subline, even when every target restored", async () => {
        patchPickedPtb();
        const remembered = readPatchedInstalls(productDir);
        // Only the (clean) Stable is a target: the PTB was not restored.
        const report = await uninstall(
            { ...uninstallSystemFake({ helper: { applicable: false, removed: false, error: null } }).ports, unpatch: (target, opts) => unpatchInstall(target, opts), modBundleDir: modDir, productDir, logDir: null, vencordSettingsPath: null, log: quiet },
            {
                installs: [stable.install],
                keepSettings: false,
                rememberedResources: remembered.map(entry => rememberedResourcesPath(entry, "darwin"))
            }
        );
        expect(report.modBundleRemoved).toBe(false);
        expect(report.modBundleKeptForSafety).toBe(true);
        expect(existsSync(join(modDir, "patcher.js"))).toBe(true);
        expect(report.summary).not.toContain("put back to normal");
    });

    it("a remembered path that no longer exists is skipped and named, and hides nothing else", () => {
        patchPickedPtb();
        const skipped: Array<{ path: string; code: string }> = [];
        const remembered = [
            { rootPath: join(tmpdir(), "gone-discord", "Discord Canary.app"), stableId: join(tmpdir(), "gone-discord", "Discord Canary.app"), branch: "canary" as const },
            ...readPatchedInstalls(productDir)
        ];
        const targets = uninstallTargets({ platform: "darwin", searchRoots: [] }, remembered, detail => skipped.push(detail));
        expect(targets.map(t => t.rootPath)).toEqual([ptb.install.rootPath]);
        expect(skipped).toEqual([{ path: remembered[0]!.rootPath, code: "NOT_A_DISCORD_INSTALL" }]);
    });

    it("finds a patched PTB in a search root even with no list at all", () => {
        // The PTB fixture lives in its own temp root; search it as /Applications.
        patchPickedPtb();
        const root = join(ptb.install.rootPath, "..");
        const targets = uninstallTargets({ platform: "darwin", searchRoots: [root] });
        expect(targets.map(t => t.rootPath)).toContain(ptb.install.rootPath);
    });
});

describe("isOtherAccountLoader", () => {
    it("is another account only inside a sibling home folder", () => {
        expect(isOtherAccountLoader("/Users/alex/Library/Application Support/Subline/mod/patcher.js", "/Users/sam", "darwin")).toBe(true);
        expect(isOtherAccountLoader("/Users/sam/Library/Application Support/Subline/mod/patcher.js", "/Users/sam", "darwin")).toBe(false);
        expect(isOtherAccountLoader("/Users/samuel/x/patcher.js", "/Users/sam", "darwin")).toBe(true);
        // A developer checkout outside the homes folder is nobody's account.
        expect(isOtherAccountLoader("/opt/vencord/dist/patcher.js", "/Users/sam", "darwin")).toBe(false);
        expect(isOtherAccountLoader("C:\\Users\\Alex\\AppData\\Local\\Subline\\mod\\patcher.js", "C:\\Users\\sam", "win32")).toBe(true);
        expect(isOtherAccountLoader("c:\\users\\SAM\\AppData\\Local\\Subline\\mod\\patcher.js", "C:\\Users\\sam", "win32")).toBe(false);
    });
});

/* ------------------------------------------------------------------------ *
 * Audit 2026-10-06 #2, on real files: another mod's Discord never blocks
 * Subline's uninstall, and is never touched.
 * ------------------------------------------------------------------------ */

describe("uninstall next to another client mod (real files)", () => {
    const VENCORD = "/Users/someone/Library/Application Support/Vencord/dist/patcher.js";
    const hash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
    let extra: { cleanup(): void }[] = [];
    let settingsPath: string;

    beforeEach(() => {
        extra = [];
        settingsPath = join(productDir, "..", "Vencord", "settings.json");
        mkdirSync(join(productDir, "..", "Vencord"), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({ plugins: { [PLUGIN_SETTINGS_KEY]: { sublineCode: "slp_x" } } }), "utf8");
    });
    afterEach(() => { for (const fixture of extra) fixture.cleanup(); });

    function vencordCanary(): DiscordInstall {
        const canary = makeDiscordFixture({ appName: "Discord Canary.app", withBackup: true, stubLoaderPath: VENCORD });
        extra.push(canary);
        return { ...canary.install, branch: "canary" };
    }

    function run(installs: DiscordInstall[], remembered: string[] = []) {
        const sys = uninstallSystemFake();
        const ownLoader = join(modDir, "patcher.js");
        return {
            sys,
            report: uninstall(
                {
                    ...sys.ports,
                    unpatch: (target, opts) => unpatchInstall(target, { ...opts, ownLoaderPaths: [ownLoader] }),
                    modBundleDir: modDir,
                    productDir,
                    logDir: null,
                    vencordSettingsPath: settingsPath,
                    log: quiet
                },
                { installs, keepSettings: false, rememberedResources: remembered }
            )
        };
    }

    it("Stable ours + Canary with Vencord: Stable restored, Canary untouched and listed, Subline fully gone", async () => {
        expect(patchInstall(stable.install, { modBundleDir: modDir, productVersion: "0.2.2" }).ok).toBe(true);
        const canary = vencordCanary();
        const canaryAsar = hash(canary.asarPath);
        const canaryBackup = hash(canary.backupPath);

        const { sys, report } = run([stable.install, canary]);
        const done = await report;

        expect(done.clean).toBe(true);
        expect(readFileSync(stable.install.asarPath).equals(stable.originalAsar)).toBe(true);
        expect(hash(canary.asarPath)).toBe(canaryAsar);
        expect(hash(canary.backupPath)).toBe(canaryBackup);
        expect(done.modBundleRemoved).toBe(true);
        expect(done.settingsRemoved).toBe(true);
        expect(done.summary).toContain("Discord has been put back to normal and Subline has been removed.");
        expect(done.summary).toContain("Left alone: Discord Canary, another client mod");
        expect(sys.branches).toEqual([["stable"]]);
    });

    it("hand-picked PTB ours + Stable with Vencord: PTB restored, Stable untouched", async () => {
        const picked = patchPickedPtb();
        writeFileSync(stable.install.asarPath, buildStubAsar(VENCORD));
        writeFileSync(stable.install.backupPath, stable.originalAsar);
        const stableAsar = hash(stable.install.asarPath);
        const remembered = readPatchedInstalls(productDir).map(entry => rememberedResourcesPath(entry, "darwin"));

        const { report } = run([stable.install, picked], remembered);
        const done = await report;

        expect(done.clean).toBe(true);
        expect(existsSync(join(picked.resourcesPath, MARKER_FILENAME))).toBe(false);
        expect(hash(stable.install.asarPath)).toBe(stableAsar);
        expect(existsSync(stable.install.backupPath)).toBe(true);
        expect(done.summary).toContain("Left alone: Discord, another client mod");
    });

    it("only foreign Discords: nothing of theirs touched, Subline's own files removed", async () => {
        const canary = vencordCanary();
        const canaryAsar = hash(canary.asarPath);
        const { sys, report } = run([canary]);
        const done = await report;
        expect(done.clean).toBe(true);
        expect(hash(canary.asarPath)).toBe(canaryAsar);
        expect(existsSync(modDir)).toBe(false);
        expect(sys.calls).toEqual(["removeHelper"]);
        expect(done.summary).toContain("No Discord with Subline in it was found.");
    });
});

describe("forgetting Discords Uninstall put back", () => {
    it("drops only the named stable ids from the record and keeps the rest", () => {
        const a = makeDiscordFixture({ appName: "Discord PTB.app" });
        const b = makeDiscordFixture({ appName: "Discord Canary.app" });
        try {
            rememberPatchedInstall(productDir, a.install);
            rememberPatchedInstall(productDir, b.install);
            expect(forgetPatchedInstalls(productDir, [a.install.stableId]).ok).toBe(true);
            expect(readPatchedInstalls(productDir).map(entry => entry.stableId)).toEqual([b.install.stableId]);
            expect(forgetPatchedInstalls(productDir, ["nothing-like-it"])).toEqual({ ok: true, value: false });
        } finally {
            a.cleanup();
            b.cleanup();
        }
    });
});

describe("releasing the Discords Uninstall put back", () => {
    it("drops them from the record and the helper's memory, and marks them released", () => {
        const a = makeDiscordFixture({ appName: "Discord PTB.app" });
        try {
            rememberPatchedInstall(productDir, a.install);
            const state = emptyHelperState();
            state.installs[a.install.stableId] = { discordVersion: "1", buildId: "b", patchedAt: 1, failures: 0 };
            state.lastRunAt = 7;
            writeHelperState(helperStatePathFor(productDir), state);
            expect(releaseRestoredInstalls(productDir, [a.install.stableId])).toEqual({ ok: true, value: true });
            expect(readPatchedInstalls(productDir)).toEqual([]);
            const after = readHelperState(helperStatePathFor(productDir));
            expect(after.installs[a.install.stableId]).toBeUndefined();
            expect(after.released).toEqual([a.install.stableId]);
            expect(after.lastRunAt).toBe(7);
        } finally {
            a.cleanup();
        }
    });

    it("never creates Subline's folder to write it down", () => {
        const absent = join(productDir, "..", "NotThere");
        expect(releaseRestoredInstalls(absent, ["x"])).toEqual({ ok: true, value: false });
        expect(existsSync(absent)).toBe(false);
    });
});
