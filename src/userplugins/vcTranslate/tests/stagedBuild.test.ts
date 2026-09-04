import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseStagedBuildId, readStagedBuildIdSync } from "../stagedBuild";

const VALID = "76241bd61131b98c";

const manifest = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
        format: 1,
        product: "subline",
        buildId: VALID,
        pluginVersion: "0.1.0",
        ...overrides
    });

describe("parseStagedBuildId", () => {
    it("returns the buildId of a well-formed manifest", () => {
        expect(parseStagedBuildId(manifest())).toBe(VALID);
    });

    it("is null for text that is not JSON", () => {
        expect(parseStagedBuildId("not json {")).toBeNull();
    });

    it("is null for JSON that is not an object", () => {
        expect(parseStagedBuildId('"a string"')).toBeNull();
        expect(parseStagedBuildId("42")).toBeNull();
        expect(parseStagedBuildId("null")).toBeNull();
    });

    it("is null when buildId is missing or the wrong type", () => {
        expect(parseStagedBuildId(manifest({ buildId: undefined }))).toBeNull();
        expect(parseStagedBuildId(manifest({ buildId: 123 }))).toBeNull();
    });

    it("is null for a buildId that does not match the id shape", () => {
        // Uppercase, too short, and non-hex are all rejected: a garbage value
        // on disk must never be mistaken for a real build and prompt a restart.
        expect(parseStagedBuildId(manifest({ buildId: "NOTHEX!!" }))).toBeNull();
        expect(parseStagedBuildId(manifest({ buildId: "abc" }))).toBeNull();
        expect(parseStagedBuildId(manifest({ buildId: "ABCDEF0123456789" }))).toBeNull();
    });
});

describe("readStagedBuildIdSync", () => {
    let root: string;
    let path: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "subline-staged-"));
        path = join(root, "subline-mod.json");
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it("reads the staged buildId from the given path", () => {
        writeFileSync(path, manifest());
        expect(readStagedBuildIdSync({ path })).toBe(VALID);
    });

    it("is null when the manifest file does not exist", () => {
        expect(readStagedBuildIdSync({ path })).toBeNull();
    });

    it("is null for a corrupt manifest, never throwing", () => {
        writeFileSync(path, "{ half a fi");
        expect(readStagedBuildIdSync({ path })).toBeNull();
    });

    it("is null on a platform with no data directory", () => {
        // No `path` override, and a platform absent from statusFile's table:
        // resolution yields null and the read is skipped.
        expect(readStagedBuildIdSync({ platform: "freebsd" as NodeJS.Platform })).toBeNull();
    });

    it("resolves the manifest under <productDir>/mod on macOS", () => {
        // Point HOME at our temp root and lay the bundle out where the helper
        // stages it, to prove the default path resolution — not just the test
        // override — finds it.
        const dir = join(root, "Library", "Application Support", "Subline", "mod");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "subline-mod.json"), manifest());
        expect(readStagedBuildIdSync({ platform: "darwin", home: root })).toBe(VALID);
    });
});
