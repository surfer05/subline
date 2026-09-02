import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultSearchRoots, findWindowsAppDirs, locateDiscordInstalls, locatePatchedResidue, uninstallTargets } from "../src/patcher/locate.js";
import { buildOriginalDiscordAsar } from "./fixture.js";

const roots: string[] = [];

function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "subline-locate-"));
    roots.push(root);
    return root;
}

/** Build a macOS-shaped app bundle inside `root`. */
function makeMacApp(root: string, appName: string, opts: { onlyBackup?: boolean; empty?: boolean } = {}): string {
    const appPath = join(root, appName);
    const resources = join(appPath, "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    if (!opts.empty) {
        writeFileSync(join(resources, opts.onlyBackup ? "_app.asar" : "app.asar"), buildOriginalDiscordAsar());
    }
    return appPath;
}

afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("locateDiscordInstalls", () => {
    it("finds a standard Stable install", () => {
        const root = tempRoot();
        const appPath = makeMacApp(root, "Discord.app");

        const result = locateDiscordInstalls({ platform: "darwin", searchRoots: [root] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(1);
        expect(result.value[0]!.rootPath).toBe(appPath);
        expect(result.value[0]!.branch).toBe("stable");
        expect(result.value[0]!.asarPath).toBe(join(appPath, "Contents", "Resources", "app.asar"));
        expect(result.value[0]!.backupPath).toBe(join(appPath, "Contents", "Resources", "_app.asar"));
        expect(result.value[0]!.buildInfoPath).toBe(join(appPath, "Contents", "Resources", "build_info.json"));
    });

    it("reports DISCORD_NOT_FOUND when nothing is installed", () => {
        const result = locateDiscordInstalls({ platform: "darwin", searchRoots: [tempRoot()] });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("DISCORD_NOT_FOUND");
    });

    it("finds multiple installs across several search roots", () => {
        const a = tempRoot();
        const b = tempRoot();
        makeMacApp(a, "Discord.app");
        makeMacApp(b, "Discord.app");

        const result = locateDiscordInstalls({ platform: "darwin", searchRoots: [a, b] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(2);
    });

    it("skips PTB and Canary by default but finds them when asked", () => {
        const root = tempRoot();
        makeMacApp(root, "Discord.app");
        makeMacApp(root, "Discord PTB.app");
        makeMacApp(root, "Discord Canary.app");

        const stableOnly = locateDiscordInstalls({ platform: "darwin", searchRoots: [root] });
        expect(stableOnly.ok).toBe(true);
        if (!stableOnly.ok) return;
        expect(stableOnly.value.map(i => i.branch)).toEqual(["stable"]);

        const all = locateDiscordInstalls({
            platform: "darwin",
            searchRoots: [root],
            branches: ["stable", "ptb", "canary"]
        });
        expect(all.ok).toBe(true);
        if (!all.ok) return;
        expect(all.value.map(i => i.branch).sort()).toEqual(["canary", "ptb", "stable"]);
    });

    it("accepts an explicit non-standard path", () => {
        const root = tempRoot();
        const appPath = makeMacApp(root, "Discord-Portable.app");

        const result = locateDiscordInstalls({
            platform: "darwin",
            searchRoots: [tempRoot()],
            explicitPaths: [appPath]
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(1);
        expect(result.value[0]!.rootPath).toBe(appPath);
        expect(result.value[0]!.fromExplicitPath).toBe(true);
    });

    it("rejects an explicit path that is not a Discord install", () => {
        const root = tempRoot();
        const appPath = makeMacApp(root, "NotDiscord.app", { empty: true });

        const result = locateDiscordInstalls({ platform: "darwin", explicitPaths: [appPath], searchRoots: [] });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("NOT_A_DISCORD_INSTALL");
    });

    it("still finds a half-patched install that only has _app.asar", () => {
        const root = tempRoot();
        makeMacApp(root, "Discord.app", { onlyBackup: true });

        const result = locateDiscordInstalls({ platform: "darwin", searchRoots: [root] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(1);
    });

    it("does not list the same install twice when a search root repeats it", () => {
        const root = tempRoot();
        const appPath = makeMacApp(root, "Discord.app");

        const result = locateDiscordInstalls({
            platform: "darwin",
            searchRoots: [root, root],
            explicitPaths: [appPath]
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(1);
    });

    it("resolves the Windows resources directory and newest versioned folder", () => {
        const root = tempRoot();
        const branchDir = join(root, "Discord");
        for (const version of ["1.0.9", "1.0.10", "1.0.2"]) {
            mkdirSync(join(branchDir, `app-${version}`, "resources"), { recursive: true });
            writeFileSync(join(branchDir, `app-${version}`, "resources", "app.asar"), buildOriginalDiscordAsar());
        }
        mkdirSync(join(branchDir, "not-an-app-dir"), { recursive: true });

        expect(findWindowsAppDirs(branchDir).map(p => p.split(/[\\/]/).pop())).toEqual([
            "app-1.0.10",
            "app-1.0.9",
            "app-1.0.2"
        ]);

        const result = locateDiscordInstalls({ platform: "win32", searchRoots: [root] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Exactly ONE. Discord leaves the previous app-1.0.xxxx behind after an
        // update; those are leftovers of a single install, not three Discords,
        // and surfacing them made the GUI ask "Which Discord?" on a machine
        // that only had one. Asserting value[0] alone did not catch that.
        expect(result.value).toHaveLength(1);
        expect(result.value[0]!.rootPath).toBe(join(branchDir, "app-1.0.10"));
        expect(result.value[0]!.asarPath).toBe(join(branchDir, "app-1.0.10", "resources", "app.asar"));
    });

    it("falls back to the next-newest Windows folder when the newest is not a Discord", () => {
        const root = tempRoot();
        const branchDir = join(root, "Discord");
        // A half-written folder from an update that never finished: it sorts
        // first but has no asar to patch. Stopping at it would report the
        // machine as having no usable Discord while a working one sits beside it.
        mkdirSync(join(branchDir, "app-1.0.11", "resources"), { recursive: true });
        mkdirSync(join(branchDir, "app-1.0.10", "resources"), { recursive: true });
        writeFileSync(join(branchDir, "app-1.0.10", "resources", "app.asar"), buildOriginalDiscordAsar());

        const result = locateDiscordInstalls({ platform: "win32", searchRoots: [root] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(1);
        expect(result.value[0]!.rootPath).toBe(join(branchDir, "app-1.0.10"));
    });

    it("uses /Applications on macOS and LOCALAPPDATA on Windows by default", () => {
        expect(defaultSearchRoots("darwin")[0]).toBe("/Applications");
        expect(defaultSearchRoots("win32", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })).toEqual([
            "C:\\Users\\x\\AppData\\Local"
        ]);
    });
});
// THE MACHINE OF 2026-09-02. Windows kept two app-1.0.xxxx folders, BOTH
// patched (a helper patches whichever is newest at the time, and an update
// creates a newer sibling). Uninstall restored only what locateDiscordInstalls
// returned — deliberately the newest folder ONLY, which is right for
// installing and catastrophically wrong for removing. The leftover shim's
// mod files were then deleted with the product dir, and the next Discord
// launch died on "Cannot find module ...patcher.js". The user repaired it by
// hand, in PowerShell. No user should ever have to do that.
//
// Uninstall's question is not "which Discord is live?" — it is "where did we
// ever leave a mark?" Different question, different function.
describe("locatePatchedResidue", () => {
    const patch = (appDir: string) => {
        // What patchInstall leaves behind: shim in place, backup beside it.
        writeFileSync(join(appDir, "resources", "_app.asar"), buildOriginalDiscordAsar());
        writeFileSync(join(appDir, "resources", "subline-patch.json"), "{}");
    };

    it("returns EVERY app dir carrying our patch, not just the newest", () => {
        const root = tempRoot();
        const branchDir = join(root, "Discord");
        for (const version of ["1.0.9250", "1.0.9252"]) {
            mkdirSync(join(branchDir, `app-${version}`, "resources"), { recursive: true });
            writeFileSync(join(branchDir, `app-${version}`, "resources", "app.asar"), buildOriginalDiscordAsar());
            patch(join(branchDir, `app-${version}`));
        }

        const residue = locatePatchedResidue({ platform: "win32", searchRoots: [root] });
        expect(residue.map(i => i.rootPath.split(/[\\/]/).pop())).toEqual([
            "app-1.0.9252",
            "app-1.0.9250"
        ]);
    });

    it("returns a dir whose only evidence is the backup", () => {
        // A half-removed patch: marker deleted, backup still there. The backup
        // IS the thing restore needs, so its presence alone makes the dir ours
        // to clean up.
        const root = tempRoot();
        const branchDir = join(root, "Discord");
        mkdirSync(join(branchDir, "app-1.0.1", "resources"), { recursive: true });
        writeFileSync(join(branchDir, "app-1.0.1", "resources", "app.asar"), buildOriginalDiscordAsar());
        writeFileSync(join(branchDir, "app-1.0.1", "resources", "_app.asar"), buildOriginalDiscordAsar());

        const residue = locatePatchedResidue({ platform: "win32", searchRoots: [root] });
        expect(residue).toHaveLength(1);
    });

    it("returns nothing for a clean machine", () => {
        const root = tempRoot();
        const branchDir = join(root, "Discord");
        mkdirSync(join(branchDir, "app-1.0.1", "resources"), { recursive: true });
        writeFileSync(join(branchDir, "app-1.0.1", "resources", "app.asar"), buildOriginalDiscordAsar());

        expect(locatePatchedResidue({ platform: "win32", searchRoots: [root] })).toEqual([]);
    });

    it("covers macOS by the same rule", () => {
        const root = tempRoot();
        const appPath = makeMacApp(root, "Discord.app");
        writeFileSync(join(appPath, "Contents", "Resources", "_app.asar"), buildOriginalDiscordAsar());

        const residue = locatePatchedResidue({ platform: "darwin", searchRoots: [root] });
        expect(residue.map(i => i.rootPath)).toEqual([appPath]);
    });
});

describe("uninstallTargets", () => {
    it("is the union of the live install and every patched leftover, deduped", () => {
        const root = tempRoot();
        const branchDir = join(root, "Discord");
        // Newest is patched (live), an older sibling is patched residue, an
        // even older one is clean and must NOT be touched.
        for (const version of ["1.0.1", "1.0.2", "1.0.3"]) {
            mkdirSync(join(branchDir, `app-${version}`, "resources"), { recursive: true });
            writeFileSync(join(branchDir, `app-${version}`, "resources", "app.asar"), buildOriginalDiscordAsar());
        }
        for (const version of ["1.0.2", "1.0.3"]) {
            writeFileSync(join(branchDir, `app-${version}`, "resources", "_app.asar"), buildOriginalDiscordAsar());
            writeFileSync(join(branchDir, `app-${version}`, "resources", "subline-patch.json"), "{}");
        }

        const targets = uninstallTargets({ platform: "win32", searchRoots: [root] });
        expect(targets.map(i => i.rootPath.split(/[\\/]/).pop()).sort()).toEqual([
            "app-1.0.2",
            "app-1.0.3"
        ]);
    });

    it("still lists the live install on a machine with no residue", () => {
        // keepSettings-style uninstalls need the live install even when it is
        // unpatched (marker removal, verification) — residue alone is not the
        // whole answer.
        const root = tempRoot();
        const branchDir = join(root, "Discord");
        mkdirSync(join(branchDir, "app-1.0.1", "resources"), { recursive: true });
        writeFileSync(join(branchDir, "app-1.0.1", "resources", "app.asar"), buildOriginalDiscordAsar());

        const targets = uninstallTargets({ platform: "win32", searchRoots: [root] });
        expect(targets).toHaveLength(1);
    });
});

