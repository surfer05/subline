/**
 * The stub Discord runs FAILS OPEN. Worst cases this covers, each of which used
 * to leave a Discord that would not start at all:
 *  - two accounts on one Mac: the loader is in the other account's private home;
 *  - the mod bundle is gone (a failed update, a manual delete).
 * The stub is run for real in a child Node process, with a stand-in `electron`
 * module, against a directory laid out like Discord's Resources.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { legacyStubIndexSource, parseRequirePath, stubIndexSource } from "../src/patcher/stub.js";

let root: string;
let resources: string;
let out: string;

beforeEach(() => {
    // Real path: macOS /var is a link to /private/var, and the stub reports __dirname resolved.
    root = realpathSync(mkdtempSync(join(tmpdir(), "subline-stub-")));
    resources = join(root, "Resources");
    out = join(root, "out");
    mkdirSync(join(resources, "app.asar"), { recursive: true });
    mkdirSync(join(resources, "_app.asar"), { recursive: true });
    // Discord's own archive: its main script records that stock Discord booted.
    writeFileSync(join(resources, "_app.asar", "package.json"), JSON.stringify({ name: "discord", main: "app_bootstrap/index.js" }));
    mkdirSync(join(resources, "_app.asar", "app_bootstrap"), { recursive: true });
    writeFileSync(
        join(resources, "_app.asar", "app_bootstrap", "index.js"),
        `require("fs").appendFileSync(${JSON.stringify(out)}, "stock:" + require.main.filename + "\\n");`
    );
    // A stand-in for Electron's app.setAppPath.
    mkdirSync(join(root, "node_modules", "electron"), { recursive: true });
    writeFileSync(
        join(root, "node_modules", "electron", "index.js"),
        `module.exports = { app: { setAppPath: p => require("fs").appendFileSync(${JSON.stringify(out)}, "appPath:" + p + "\\n") } };`
    );
});

afterEach(() => {
    try { chmodSync(join(root, "loader"), 0o755); } catch { /* not made */ }
    rmSync(root, { recursive: true, force: true });
});

function runStub(loaderPath: string): string[] {
    const index = join(resources, "app.asar", "index.js");
    writeFileSync(index, stubIndexSource(loaderPath));
    const result = spawnSync(process.execPath, [index], {
        env: { ...process.env, NODE_PATH: join(root, "node_modules") },
        encoding: "utf8"
    });
    expect(result.status, result.stderr).toBe(0);
    return existsSync(out) ? readFileSync(out, "utf8").trim().split("\n") : [];
}

describe("the fail-open stub", () => {
    it("loads Subline when the loader can be read", () => {
        const loader = join(root, "loader", "patcher.js");
        mkdirSync(join(root, "loader"), { recursive: true });
        writeFileSync(loader, `require("fs").appendFileSync(${JSON.stringify(out)}, "subline\\n");`);
        expect(runStub(loader)).toEqual(["subline"]);
    });

    it("boots Discord's own archive when the loader is missing (no 'Cannot find module')", () => {
        const lines = runStub(join(root, "gone", "patcher.js"));
        expect(lines).toEqual([
            `appPath:${join(resources, "_app.asar")}`,
            `stock:${join(resources, "_app.asar", "app_bootstrap", "index.js")}`
        ]);
    });

    it.skipIf(userInfo().uid === 0)("boots Discord's own archive when the loader is in a folder this user cannot read", () => {
        const loader = join(root, "loader", "patcher.js");
        mkdirSync(join(root, "loader"), { recursive: true });
        writeFileSync(loader, `require("fs").appendFileSync(${JSON.stringify(out)}, "subline\\n");`);
        chmodSync(join(root, "loader"), 0o000);
        const lines = runStub(loader);
        expect(lines).not.toContain("subline");
        expect(lines.some(line => line.startsWith("stock:"))).toBe(true);
    });

    it("parses back to its loader path, quotes and spaces included, and still parses the old one-line form", () => {
        const path = "/Users/a b/Library/Application Support/Subline/\"odd\"/patcher.js";
        expect(parseRequirePath(stubIndexSource(path))).toBe(path);
        expect(parseRequirePath(legacyStubIndexSource(path))).toBe(path);
        const windows = "C:\\Users\\x\\AppData\\Local\\Subline\\mod\\patcher.js";
        expect(parseRequirePath(stubIndexSource(windows))).toBe(windows);
    });
});
