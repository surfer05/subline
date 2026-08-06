/**
 * The copy-into-place step. Its whole reason for existing is that the loader
 * path baked into Discord must NOT point inside the app bundle, so the tests
 * that matter most are the ones about which path comes back.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installModBundle, shippedModDirFor } from "../src/app/modInstall.js";
import { manifestPathFor } from "../src/bundle/spec.js";
import { makeModBundleFixture } from "./fixture.js";
import type { ModBundleFixture } from "./fixture.js";

let source: ModBundleFixture;
let root: string;
let destDir: string;

beforeEach(() => {
    source = makeModBundleFixture();
    root = mkdtempSync(join(tmpdir(), "subline-runtime-"));
    destDir = join(root, "Subline", "mod");
});

afterEach(() => {
    source.cleanup();
    rmSync(root, { recursive: true, force: true });
});

describe("installModBundle", () => {
    it("copies the bundle to the runtime location", () => {
        const result = installModBundle({ sourceDir: source.dir, destDir });
        expect(result.ok).toBe(true);
        expect(existsSync(manifestPathFor(destDir))).toBe(true);
        expect(readdirSync(destDir).sort()).toEqual(readdirSync(source.dir).sort());
    });

    it("returns a loaderPath under the runtime directory, never inside the app bundle", () => {
        const result = installModBundle({ sourceDir: source.dir, destDir });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.loaderPath).toBe(join(destDir, "patcher.js"));
        expect(result.value.loaderPath.startsWith(source.dir)).toBe(false);
        expect(result.value.dir).toBe(destDir);
    });

    it("carries the build id through, so the patch records what was actually installed", () => {
        const result = installModBundle({ sourceDir: source.dir, destDir });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.buildId).toBe(source.buildId);
    });

    it("creates missing parent directories", () => {
        const deep = join(root, "a", "b", "c", "mod");
        expect(installModBundle({ sourceDir: source.dir, destDir: deep }).ok).toBe(true);
        expect(existsSync(manifestPathFor(deep))).toBe(true);
    });

    it("reports replaced=false on a first install and true on an upgrade", () => {
        const first = installModBundle({ sourceDir: source.dir, destDir });
        expect(first.ok && first.value.replaced).toBe(false);
        const second = installModBundle({ sourceDir: source.dir, destDir });
        expect(second.ok && second.value.replaced).toBe(true);
    });

    it("replaces an older bundle wholesale, leaving no file from the previous build behind", () => {
        installModBundle({ sourceDir: source.dir, destDir });
        writeFileSync(join(destDir, "leftover-from-old-build.js"), "// stale\n", "utf8");
        source.rebuild({ buildId: "aaaabbbbccccdddd", pluginVersion: "0.2.0" });

        const result = installModBundle({ sourceDir: source.dir, destDir });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.buildId).toBe("aaaabbbbccccdddd");
        expect(existsSync(join(destDir, "leftover-from-old-build.js"))).toBe(false);
    });

    it("refuses a broken source bundle without touching the destination", () => {
        installModBundle({ sourceDir: source.dir, destDir });
        rmSync(join(source.dir, "renderer.js"));

        const result = installModBundle({ sourceDir: source.dir, destDir });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("MOD_BUNDLE_INVALID");
        // The working install is still there.
        expect(existsSync(manifestPathFor(destDir))).toBe(true);
        expect(existsSync(join(destDir, "renderer.js"))).toBe(true);
    });

    it("refuses to replace a directory that is not one of ours", () => {
        mkdirSync(destDir, { recursive: true });
        writeFileSync(join(destDir, "someone-elses-important-file"), "do not delete me", "utf8");

        const result = installModBundle({ sourceDir: source.dir, destDir });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("MOD_BUNDLE_INVALID");
        expect(existsSync(join(destDir, "someone-elses-important-file"))).toBe(true);
    });

    it("refuses to 'install' a bundle onto itself — that is the translocation bug", () => {
        const result = installModBundle({ sourceDir: source.dir, destDir: source.dir });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("MOD_BUNDLE_INVALID");
            expect(result.error.message).toContain("disappears when the app quits");
        }
    });

    it("reports a named error, not a throw, when the source does not exist", () => {
        const result = installModBundle({ sourceDir: join(root, "nowhere"), destDir });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("MOD_BUNDLE_INVALID");
    });

    it("leaves no staging directory behind on success", () => {
        installModBundle({ sourceDir: source.dir, destDir });
        expect(existsSync(`${destDir}.subline-staging`)).toBe(false);
    });

    it("leaves no staging directory behind on failure", () => {
        rmSync(join(source.dir, "preload.js"));
        installModBundle({ sourceDir: source.dir, destDir });
        expect(existsSync(`${destDir}.subline-staging`)).toBe(false);
    });

    it("clears a staging directory left by an interrupted earlier run", () => {
        const staging = `${destDir}.subline-staging`;
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "half-copied.js"), "// interrupted\n", "utf8");

        expect(installModBundle({ sourceDir: source.dir, destDir }).ok).toBe(true);
        expect(existsSync(join(destDir, "half-copied.js"))).toBe(false);
        expect(existsSync(staging)).toBe(false);
    });
});

describe("shippedModDirFor", () => {
    it("names the mod directory inside a packaged app's Resources", () => {
        expect(shippedModDirFor("/Applications/Subline.app/Contents/Resources"))
            .toBe("/Applications/Subline.app/Contents/Resources/mod");
    });
});
