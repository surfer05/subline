import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { usingOriginalFs } from "../src/patcher/realFs.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * These tests are SOURCE-LEVEL on purpose, and that limitation IS the point.
 *
 * Electron patches `node:fs` so any ".asar" path becomes a virtual archive
 * mount instead of a file. vitest runs in plain Node, where no such patching
 * happens — so a test that merely calls our reader against a real asar passes
 * whether or not the fix is present. That is exactly how this shipped: the
 * whole suite was green while the packaged app could not open Discord's asar
 * at all, and told the user a healthy install needed repairing.
 *
 * What these DO cover: every module that touches an ".asar" path takes its
 * filesystem calls from `realFs`, so a refactor cannot quietly restore
 * `node:fs` and reintroduce a failure no other test can see.
 *
 * What they DO NOT cover: that `original-fs` behaves correctly inside a real
 * Electron process. Only launching the app proves that.
 */

/** Modules that read or write a path containing ".asar". */
const ASAR_TOUCHING = [
    "patcher/asar.ts",
    "patcher/patch.ts",
    "patcher/state.ts",
    "app/uninstall.ts"
];

/** Calls that would hit Electron's patched module if imported from node:fs. */
const ASAR_SENSITIVE = [
    "openSync", "readSync", "closeSync",
    "renameSync", "writeFileSync", "readFileSync",
    "existsSync", "statSync", "unlinkSync"
];

describe("asar-touching modules use the unpatched filesystem", () => {
    for (const rel of ASAR_TOUCHING) {
        it(`${rel} takes its asar-sensitive fs calls from realFs`, () => {
            const source = readFileSync(join(SRC, rel), "utf8");

            // Asserted on the imported NAMES, not on the mere presence of a
            // "node:fs" string: uninstall.ts legitimately keeps `rmSync` there,
            // because it only ever removes our own bundle directory and no
            // ".asar" appears in that path.
            const m = /import \{([^}]*)\} from "node:fs";/.exec(source);
            const fromNodeFs = m?.[1] ? m[1].split(",").map(s => s.trim()) : [];

            expect(fromNodeFs.filter(n => ASAR_SENSITIVE.includes(n))).toEqual([]);
            expect(source).toContain("realFs.js");
        });
    }

    it("falls back to the ordinary module outside Electron", () => {
        // `original-fs` does not exist in plain Node, and the fallback must be
        // silent rather than an import-time throw — the test suite and any CLI
        // use run here.
        expect(usingOriginalFs).toBe(false);
    });
});
