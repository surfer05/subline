import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { worstAppManagementStatus } from "../src/app/appManagement.js";
import { readSublineCode } from "../src/app/language.js";

/* ------------------------------------------------------------------------ *
 * The uninstall permission gate folds one verdict out of every marked Discord
 * ------------------------------------------------------------------------ */

describe("worstAppManagementStatus — one verdict for every Discord uninstall must restore", () => {
    it("any blocked install blocks the whole removal", () => {
        expect(worstAppManagementStatus(["granted", "blocked", "granted"])).toBe("blocked");
    });
    it("unknown outranks granted, so the caller keeps polling rather than writing blind", () => {
        expect(worstAppManagementStatus(["granted", "unknown"])).toBe("unknown");
    });
    it("all granted is granted", () => {
        expect(worstAppManagementStatus(["granted", "granted"])).toBe("granted");
    });
    it("nothing to restore needs no permission", () => {
        expect(worstAppManagementStatus([])).toBe("not-required");
        expect(worstAppManagementStatus(["not-required"])).toBe("not-required");
    });
});

/* ------------------------------------------------------------------------ *
 * readSublineCode — what decides whether an UPDATE offers the code screen
 * ------------------------------------------------------------------------ */

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function settingsFile(plugin: Record<string, unknown> | null): string {
    dir = mkdtempSync(join(tmpdir(), "subline-settings-"));
    const path = join(dir, "settings.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(plugin === null ? {} : { plugins: { VcTranslate: plugin } }), "utf8");
    return path;
}

describe("readSublineCode", () => {
    it("returns the saved code", () => {
        expect(readSublineCode(settingsFile({ engine: "relay", sublineCode: "slp_abc" }))).toBe("slp_abc");
    });
    it("treats a blank code as none", () => {
        expect(readSublineCode(settingsFile({ sublineCode: "   " }))).toBeNull();
    });
    it("is null with no plugin block, no file, or no path", () => {
        expect(readSublineCode(settingsFile(null))).toBeNull();
        expect(readSublineCode(join(dir, "missing.json"))).toBeNull();
        expect(readSublineCode(null)).toBeNull();
    });
    it("never throws on a corrupt file", () => {
        dir = mkdtempSync(join(tmpdir(), "subline-settings-"));
        const path = join(dir, "settings.json");
        writeFileSync(path, "{not json", "utf8");
        expect(readSublineCode(path)).toBeNull();
    });
});
