/**
 * A Discord the user picked by hand (only PTB or Canary, or an unusual
 * folder). Detection never finds it again, so before patched-installs.json:
 * Uninstall said "There was nothing to remove" and left it patched, or found
 * an unrelated clean Stable and deleted the mod bundle the hand-picked Discord
 * still require()s. Each test fails on that code.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installModBundle } from "../src/app/modInstall.js";
import { readPatchedInstalls, rememberPatchedInstall } from "../src/app/patchedInstalls.js";
import { uninstall } from "../src/app/uninstall.js";
import { locateDiscordInstalls, rememberedResourcesPath, uninstallTargets } from "../src/patcher/locate.js";
import { MARKER_FILENAME } from "../src/patcher/marker.js";
import { patchInstall, unpatchInstall } from "../src/patcher/patch.js";
import { isOtherAccountLoader } from "../src/patcher/ownership.js";
import { makeDiscordFixture, makeModBundleFixture } from "./fixture.js";
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
    it("is found again by Uninstall, through the remembered list, and restored", () => {
        const install = patchPickedPtb();
        expect(install.branch).toBe("ptb");
        const remembered = readPatchedInstalls(productDir);
        const targets = uninstallTargets({ platform: "darwin", searchRoots: [] }, remembered);
        expect(targets.map(t => t.rootPath)).toContain(ptb.install.rootPath);

        const report = uninstall(
            { unpatch: (target, opts) => unpatchInstall(target, opts), modBundleDir: modDir, productDir, logDir: null, vencordSettingsPath: null, log: quiet },
            {
                installs: targets,
                helper: { applicable: false, removed: false, error: null },
                rememberedResources: remembered.map(entry => rememberedResourcesPath(entry, "darwin"))
            }
        );
        expect(report.discordRestored).toBe(true);
        expect(existsSync(join(ptb.install.resourcesPath, MARKER_FILENAME))).toBe(false);
        expect(report.modBundleRemoved).toBe(true);
    });

    it("keeps the bundle while a remembered Discord still carries Subline, even when every target restored", () => {
        patchPickedPtb();
        const remembered = readPatchedInstalls(productDir);
        // Only the (clean) Stable is a target: the PTB was not restored.
        const report = uninstall(
            { unpatch: (target, opts) => unpatchInstall(target, opts), modBundleDir: modDir, productDir, logDir: null, vencordSettingsPath: null, log: quiet },
            {
                installs: [stable.install],
                keepSettings: false,
                helper: { applicable: false, removed: false, error: null },
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
