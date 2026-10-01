/**
 * The bundle swap's worst case: the rename that puts the new bundle in place
 * fails (Windows antivirus scanning the fresh copy: EPERM or EBUSY). The old
 * code had already deleted the live bundle, so Discord's stub required a file
 * that no longer existed and Discord would not start. Each test here fails on
 * that code.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** When set, decides whether a rename throws (return an errno) or proceeds (return null). */
let renameFault: ((from: string, to: string) => string | null) | null = null;

vi.mock("node:fs", async importOriginal => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        renameSync: (from: string, to: string) => {
            const code = renameFault?.(String(from), String(to)) ?? null;
            if (code !== null) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
            return actual.renameSync(from, to);
        }
    };
});

const { installModBundle, recoverModBundle, renameWithRetry } = await import("../src/app/modInstall.js");
const { inspectModBundle } = await import("../src/bundle/bundle.js");
const { makeModBundleFixture } = await import("./fixture.js");

let source: ReturnType<typeof makeModBundleFixture>;
let root: string;
let destDir: string;

beforeEach(() => {
    renameFault = null;
    source = makeModBundleFixture();
    root = mkdtempSync(join(tmpdir(), "subline-swap-"));
    destDir = join(root, "Subline", "mod");
});

afterEach(() => {
    renameFault = null;
    source.cleanup();
    rmSync(root, { recursive: true, force: true });
});

function installV1ThenFailV2(fault: (from: string, to: string) => string | null) {
    const v1 = installModBundle({ sourceDir: source.dir, destDir });
    expect(v1.ok).toBe(true);
    const v1Build = v1.ok ? v1.value.buildId : "";
    source.rebuild({ buildId: "aaaabbbbccccdddd", pluginVersion: "0.2.1" });
    renameFault = fault;
    const v2 = installModBundle({ sourceDir: source.dir, destDir, platform: "darwin" });
    renameFault = null;
    return { v1Build, v2 };
}

describe("installModBundle's swap", () => {
    it("keeps the working bundle when the new one cannot be moved into place", () => {
        const { v1Build, v2 } = installV1ThenFailV2(from => (from.endsWith(".subline-staging") ? "EPERM" : null));
        expect(v2.ok).toBe(false);
        // Discord's stub requires this file. It must still be there.
        expect(existsSync(join(destDir, "patcher.js"))).toBe(true);
        const still = inspectModBundle(destDir);
        expect(still.ok && still.value.buildId).toBe(v1Build);
        expect(existsSync(`${destDir}.subline-staging`)).toBe(false);
    });

    it("when putting the old bundle back ALSO fails, it survives aside and the next run restores it", () => {
        const { v1Build, v2 } = installV1ThenFailV2(from =>
            (from.endsWith(".subline-staging") || from.endsWith(".subline-old") ? "EPERM" : null));
        expect(v2.ok).toBe(false);
        if (!v2.ok) expect(v2.error.cause).toContain("subline-old");
        expect(existsSync(`${destDir}.subline-old`)).toBe(true);
        expect(existsSync(destDir)).toBe(false);

        // The helper runs at login and calls this before it reads the bundle.
        const recovered = recoverModBundle(destDir);
        expect(recovered.ok && recovered.value).toBe(true);
        const back = inspectModBundle(destDir);
        expect(back.ok && back.value.buildId).toBe(v1Build);
    });

    it("a later install puts an aside bundle back before it swaps", () => {
        installV1ThenFailV2(from => (from.endsWith(".subline-staging") || from.endsWith(".subline-old") ? "EPERM" : null));
        expect(existsSync(destDir)).toBe(false);
        const again = installModBundle({ sourceDir: source.dir, destDir, platform: "darwin" });
        expect(again.ok).toBe(true);
        if (again.ok) {
            expect(again.value.buildId).toBe("aaaabbbbccccdddd");
            expect(again.value.replaced).toBe(true);
        }
        expect(existsSync(`${destDir}.subline-old`)).toBe(false);
    });

    it("retries a briefly locked rename on Windows, and succeeds", () => {
        let failures = 0;
        installModBundle({ sourceDir: source.dir, destDir });
        source.rebuild({ buildId: "aaaabbbbccccdddd", pluginVersion: "0.2.1" });
        renameFault = from => (from.endsWith(".subline-staging") && failures++ < 2 ? "EPERM" : null);
        const slept: number[] = [];
        const result = installModBundle({
            sourceDir: source.dir, destDir, platform: "win32", hooks: { sleepSync: ms => slept.push(ms) }
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.buildId).toBe("aaaabbbbccccdddd");
        expect(slept).toEqual([100, 200]);
    });

    it("does not retry off Windows", () => {
        let calls = 0;
        renameFault = () => { calls += 1; return "EPERM"; };
        expect(() => renameWithRetry(join(root, "a"), join(root, "b"), "darwin", () => {})).toThrow();
        expect(calls).toBe(1);
    });

    it("still refuses a folder that is not one of ours", () => {
        realFs.mkdirSync(destDir, { recursive: true });
        realFs.writeFileSync(join(destDir, "keep-me"), "x");
        const result = installModBundle({ sourceDir: source.dir, destDir });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("MOD_BUNDLE_INVALID");
        expect(existsSync(join(destDir, "keep-me"))).toBe(true);
    });
});
