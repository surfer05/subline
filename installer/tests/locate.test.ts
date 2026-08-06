import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultSearchRoots, findWindowsAppDirs, locateDiscordInstalls } from "../src/patcher/locate.js";
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
        expect(result.value[0]!.rootPath).toBe(join(branchDir, "app-1.0.10"));
        expect(result.value[0]!.asarPath).toBe(join(branchDir, "app-1.0.10", "resources", "app.asar"));
    });

    it("uses /Applications on macOS and LOCALAPPDATA on Windows by default", () => {
        expect(defaultSearchRoots("darwin")[0]).toBe("/Applications");
        expect(defaultSearchRoots("win32", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })).toEqual([
            "C:\\Users\\x\\AppData\\Local"
        ]);
    });
});
