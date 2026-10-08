/**
 * Audit 2026-10-06 #1, #30, #48: Vencord's host-update hook (bundled in
 * Subline's patcher.js) copies our stub into a new Windows app-x.y.z folder
 * and nothing else. The build rewrites it to carry a FRESH marker too.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
    BEFORE_QUIT_ANCHOR,
    carryMarkerOnHostUpdate,
    MARKER_CARRY_BLOCK,
    PERSIST_ANCHOR,
    QUIT_HOOK_BLOCK,
    rewriteExactlyOnce
} from "../scripts/vencordRewrites.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const PINNED = readFileSync(join(here, "fixtures", "persistAfterDiscordUpdates.pinned.ts.txt"), "utf8");

describe("carryMarkerOnHostUpdate", () => {
    it("inserts the marker block right after the asar copy, in its own try", () => {
        const out = carryMarkerOnHostUpdate(PINNED);
        const copyAt = out.indexOf("copyFileSync(oldVencordAsar, newAppAsar);");
        const markerAt = out.indexOf("subline-patch.json");
        expect(copyAt).toBeGreaterThan(0);
        expect(markerAt).toBeGreaterThan(copyAt);
        // Its own try opens between the copy and the marker, and closes before
        // upstream's catch, so a marker failure never aborts the copy.
        const between = out.slice(copyAt, markerAt);
        expect(between).toContain("try {");
        const upstreamCatch = out.indexOf("[Vencord] Failed to repatch latest host update");
        expect(out.indexOf("[Subline] Could not carry the patch marker")).toBeLessThan(upstreamCatch);
        expect(out).toContain("readFileSync, renameSync, writeFileSync } from \"original-fs\"");
        // Upstream's guard against overwriting an existing _app.asar is kept.
        expect(out).toContain("existsSync(newAppAsarBackup)) return;");
        expect(out).toContain("Detected Host Update");
    });

    it("fails when the anchor is missing", () => {
        const moved = PINNED.replace(PERSIST_ANCHOR, PERSIST_ANCHOR.replace("copyFileSync", "copySync"));
        expect(() => carryMarkerOnHostUpdate(moved)).toThrow(/expected exactly one host-update rename and copy block, found 0/);
    });

    it("fails when the anchor appears twice", () => {
        const doubled = PINNED.replace(PERSIST_ANCHOR, PERSIST_ANCHOR + PERSIST_ANCHOR);
        expect(() => carryMarkerOnHostUpdate(doubled)).toThrow(/found 2/);
    });

    it("fails when the import line changed", () => {
        expect(() => carryMarkerOnHostUpdate(PINNED.replace("readdirSync, renameSync", "renameSync, readdirSync")))
            .toThrow(/original-fs import line, found 0/);
    });

    it("rewriteExactlyOnce does not interpret $ patterns in the replacement", () => {
        expect(rewriteExactlyOnce("a X b", "X", "$&$&", { file: "f", what: "x" })).toBe("a $&$& b");
    });
});

describe("the carried marker, executed", () => {
    let dir: string | null = null;
    afterEach(() => {
        if (dir !== null) rmSync(dir, { recursive: true, force: true });
        dir = null;
    });

    function runBlock(oldResources: string, resources: string): string[] {
        const errors: string[] = [];
        const fakeConsole = { error: (...args: unknown[]) => errors.push(String(args[0])) };
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const block = new Function(
            "existsSync", "readFileSync", "writeFileSync", "join", "oldResources", "resources", "newAppAsarBackup", "console",
            MARKER_CARRY_BLOCK
        );
        block(existsSync, readFileSync, writeFileSync, join, oldResources, resources, join(resources, "_app.asar"), fakeConsole);
        return errors;
    }

    function folders(): { oldResources: string; resources: string } {
        dir = mkdtempSync(join(tmpdir(), "subline-persist-"));
        const oldResources = join(dir, "app-1.0.9258", "resources");
        const resources = join(dir, "app-1.0.9259", "resources");
        for (const d of [oldResources, resources]) {
            rmSync(d, { recursive: true, force: true });
            mkdirSync(d, { recursive: true });
        }
        return { oldResources, resources };
    }

    const OLD_MARKER = {
        format: 2,
        product: "subline",
        productVersion: "0.2.2",
        loaderPath: "C:\\Users\\Ada\\AppData\\Local\\Subline\\mod\\patcher.js",
        pluginBuildId: "abc123",
        discordVersion: "1.0.9258",
        backupPath: "C:\\old\\_app.asar",
        patchedAt: "2026-09-01T00:00:00.000Z"
    };

    it("writes a fresh marker for the new folder: new version, new backup path, new time", () => {
        const { oldResources, resources } = folders();
        writeFileSync(join(oldResources, "subline-patch.json"), JSON.stringify(OLD_MARKER));
        writeFileSync(join(resources, "build_info.json"), JSON.stringify({ version: "1.0.9259", releaseChannel: "stable" }));
        const before = Date.now();
        expect(runBlock(oldResources, resources)).toEqual([]);
        const carried = JSON.parse(readFileSync(join(resources, "subline-patch.json"), "utf8"));
        expect(carried.discordVersion).toBe("1.0.9259");
        expect(carried.backupPath).toBe(join(resources, "_app.asar"));
        expect(Date.parse(carried.patchedAt)).toBeGreaterThanOrEqual(before - 1000);
        expect(carried.loaderPath).toBe(OLD_MARKER.loaderPath);
        expect(carried.pluginBuildId).toBe("abc123");
        expect(carried.format).toBe(2);
        expect(carried.productVersion).toBe("0.2.2");
    });

    it("keeps the old version when the new build_info.json cannot be read", () => {
        const { oldResources, resources } = folders();
        writeFileSync(join(oldResources, "subline-patch.json"), JSON.stringify(OLD_MARKER));
        expect(runBlock(oldResources, resources)).toEqual([]);
        const carried = JSON.parse(readFileSync(join(resources, "subline-patch.json"), "utf8"));
        expect(carried.discordVersion).toBe("1.0.9258");
        expect(carried.backupPath).toBe(join(resources, "_app.asar"));
    });

    it("writes nothing when there is no marker, an unparseable one, or someone else's", () => {
        const { oldResources, resources } = folders();
        expect(runBlock(oldResources, resources)).toEqual([]);
        expect(existsSync(join(resources, "subline-patch.json"))).toBe(false);

        writeFileSync(join(oldResources, "subline-patch.json"), "{ not json");
        const errors = runBlock(oldResources, resources);
        expect(errors[0]).toContain("[Subline] Could not carry the patch marker");
        expect(existsSync(join(resources, "subline-patch.json"))).toBe(false);

        writeFileSync(join(oldResources, "subline-patch.json"), JSON.stringify({ ...OLD_MARKER, product: "other" }));
        expect(runBlock(oldResources, resources)).toEqual([]);
        expect(existsSync(join(resources, "subline-patch.json"))).toBe(false);
    });

    it("never throws out of the block, so the stub copy before it stands", () => {
        const { oldResources } = folders();
        writeFileSync(join(oldResources, "subline-patch.json"), JSON.stringify(OLD_MARKER));
        // The new folder does not exist: the write fails inside the block's own try.
        const errors = runBlock(oldResources, join(dir!, "gone", "resources"));
        expect(errors[0]).toContain("[Subline] Could not carry the patch marker");
    });
});

describe("the quit hook (audit 2026-10-06 #28)", () => {
    let dir: string | null = null;
    afterEach(() => {
        if (dir !== null) rmSync(dir, { recursive: true, force: true });
        dir = null;
    });

    it("sits inside upstream's Windows/Linux block, right after before-quit", () => {
        const out = carryMarkerOnHostUpdate(PINNED);
        expect(out.indexOf("app.on(\"will-quit\"")).toBeGreaterThan(out.indexOf(BEFORE_QUIT_ANCHOR));
        expect(out).toContain('import { spawn as sublineSpawn } from "child_process";');
        expect(out).toContain('if (process.platform === "win32") app.on("will-quit"');
    });

    it("fails the build when the before-quit line moved", () => {
        expect(() => carryMarkerOnHostUpdate(PINNED.replace(BEFORE_QUIT_ANCHOR, ""))).toThrow(/before-quit line, found 0/);
    });

    function runHook(env: Record<string, string | undefined>, spawnImpl: (...args: unknown[]) => { unref(): void }): { errors: string[]; handler: (() => void) | null } {
        const errors: string[] = [];
        let handler: (() => void) | null = null;
        const app = { on: (event: string, fn: () => void) => { if (event === "will-quit") handler = fn; } };
        const fakeProcess = { platform: "win32", env, pid: 4242 };
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const block = new Function("app", "existsSync", "writeFileSync", "join", "sublineSpawn", "process", "console", QUIT_HOOK_BLOCK);
        block(app, existsSync, writeFileSync, join, spawnImpl, fakeProcess, { error: (...args: unknown[]) => errors.push(String(args[0])) });
        return { errors, get handler() { return handler; } } as { errors: string[]; handler: (() => void) | null };
    }

    it("on a real quit: notes the time in Subline's folder and starts the helper task, detached and hidden", () => {
        dir = mkdtempSync(join(tmpdir(), "subline-quit-"));
        mkdirSync(join(dir, "Subline"));
        const spawned: unknown[][] = [];
        const hook = runHook({ LOCALAPPDATA: dir }, (...args) => { spawned.push(args); return { unref: () => {} }; });
        hook.handler!();
        expect(hook.errors).toEqual([]);
        expect(spawned).toEqual([["schtasks.exe", ["/Run", "/TN", "\\Subline\\Helper"], { detached: true, stdio: "ignore", windowsHide: true }]]);
        const note = JSON.parse(readFileSync(join(dir, "Subline", "discord-quit.json"), "utf8"));
        expect(note.pid).toBe(4242);
        expect(typeof note.at).toBe("number");
    });

    it("does nothing for an account without Subline, and never throws", () => {
        dir = mkdtempSync(join(tmpdir(), "subline-quit-"));
        let spawned = 0;
        const none = runHook({ LOCALAPPDATA: dir }, () => { spawned += 1; return { unref: () => {} }; });
        none.handler!();
        expect(spawned).toBe(0);
        mkdirSync(join(dir, "Subline"));
        const failing = runHook({ LOCALAPPDATA: dir }, () => { throw new Error("ENOENT schtasks"); });
        expect(() => failing.handler!()).not.toThrow();
        expect(failing.errors[0]).toContain("[Subline] Could not start the background helper on quit");
    });
});

describe("the built loader", () => {
    const patcher = join(here, "..", "build", "mod", "patcher.js");
    it.skipIf(!existsSync(patcher))("carries the marker rewrite next to upstream's host-update repatch", () => {
        const source = readFileSync(patcher, "utf8");
        expect(source).toContain("Detected Host Update");
        expect(source).toContain("subline-patch.json");
        expect(source).toContain("[Subline] Could not carry the patch marker");
        expect(source).toContain("discord-quit.json");
    });
});
