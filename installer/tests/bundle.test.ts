import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectModBundle, removeModBundle } from "../src/bundle/bundle.js";
import { modBundleDirFor, MOD_DIR_NAME, productDirFor } from "../src/bundle/layout.js";
import {
    LOADER_ENTRY_NAME,
    manifestPathFor,
    MOD_MANIFEST_FILENAME,
    REQUIRED_ENTRIES,
    SOURCE_NOTICE_NAME,
    STAMPED_ENTRY_NAME
} from "../src/bundle/spec.js";
import { beaconDirFor, beaconPathFor } from "../src/verify/beacon.js";
import type { ModBundleFixture } from "./fixture.js";
import { FIXTURE_VENCORD_COMMIT, makeModBundleFixture } from "./fixture.js";

const BUILD_ID = "1f2e3d4c5b6a7980";

let bundle: ModBundleFixture | null = null;
let scratch: string | null = null;

afterEach(() => {
    bundle?.cleanup();
    bundle = null;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = null;
});

function editManifest(dir: string, edit: (raw: Record<string, unknown>) => void): void {
    const path = manifestPathFor(dir);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    edit(raw);
    writeFileSync(path, JSON.stringify(raw, null, 4));
}

function refuses(dir: string): string {
    const result = inspectModBundle(dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the bundle to be refused");
    expect(result.error.code).toBe("MOD_BUNDLE_INVALID");
    return result.error.message;
}

describe("inspectModBundle", () => {
    it("reads identity and provenance out of a bundle shaped like a real build", () => {
        bundle = makeModBundleFixture({ buildId: BUILD_ID, pluginVersion: "0.1.0" });

        const result = inspectModBundle(bundle.dir);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.buildId).toBe(BUILD_ID);
        expect(result.value.pluginVersion).toBe("0.1.0");
        expect(result.value.vencordCommit).toBe(FIXTURE_VENCORD_COMMIT);
        expect(result.value.vencordVersion).toBe("1.15.0");
        // The loader is derived, never supplied: it is the bundle's own entry.
        expect(result.value.loaderPath).toBe(join(bundle.dir, LOADER_ENTRY_NAME));
    });

    it("refuses a bundle whose manifest names a build the code does not carry", () => {
        // THE HOLE THIS WHOLE MECHANISM EXISTS TO CLOSE. Everything is present,
        // every digest matches, every file is the right size — and the id the
        // installer would record is not the id the running plugin will report.
        // That install works perfectly and verifies as `foreign-beacon` forever.
        bundle = makeModBundleFixture({ buildId: BUILD_ID, stampedBuildId: "0011223344556677" });

        const message = refuses(bundle.dir);
        expect(message).toContain(STAMPED_ENTRY_NAME);
        expect(message).toContain(BUILD_ID);
    });

    it("accepts the same bundle once the stamp and the manifest agree", () => {
        // The mirror of the case above, so that "refused" is attributable to the
        // disagreement and not to something else the fixture happens to do.
        bundle = makeModBundleFixture({ buildId: BUILD_ID, stampedBuildId: "0011223344556677" });
        expect(inspectModBundle(bundle.dir).ok).toBe(false);

        bundle.rebuild({ stampedBuildId: BUILD_ID });
        expect(inspectModBundle(bundle.dir).ok).toBe(true);
    });

    it("refuses a directory that is not a mod bundle at all", () => {
        scratch = mkdtempSync(join(tmpdir(), "subline-notabundle-"));
        expect(refuses(scratch)).toContain(MOD_MANIFEST_FILENAME);
    });

    it.each(REQUIRED_ENTRIES.map(entry => entry.name))("refuses a bundle missing %s", name => {
        bundle = makeModBundleFixture({ buildId: BUILD_ID });
        rmSync(join(bundle.dir, name));
        expect(refuses(bundle.dir)).toContain(`${name} is missing`);
    });

    it.each(REQUIRED_ENTRIES.map(entry => entry.name))("refuses a truncated %s", name => {
        // "Present" is not "usable". A half-written artefact installs perfectly
        // and then does nothing, which is the failure mode with no visible error.
        bundle = makeModBundleFixture({ buildId: BUILD_ID });
        writeFileSync(join(bundle.dir, name), "");
        bundle.restamp();
        expect(refuses(bundle.dir)).toContain("too small to be a real build artefact");
    });

    it("refuses an artefact that was swapped for something else of the same length", () => {
        // Size alone cannot catch this; only the digest can. It is the shape a
        // corrupted download takes.
        bundle = makeModBundleFixture({ buildId: BUILD_ID });
        const path = join(bundle.dir, "renderer.css");
        const size = statSync(path).size;
        writeFileSync(path, "z".repeat(size));

        const message = refuses(bundle.dir);
        expect(message).toContain("renderer.css");
        expect(message).toContain("does not match the digest");
    });

    it("refuses a bundle whose manifest does not record one of the entries", () => {
        bundle = makeModBundleFixture({ buildId: BUILD_ID });
        editManifest(bundle.dir, raw => {
            delete (raw.entries as Record<string, unknown>)[SOURCE_NOTICE_NAME];
        });
        expect(refuses(bundle.dir)).toContain(`does not record ${SOURCE_NOTICE_NAME}`);
    });

    it("refuses a manifest that is not ours, or a format this installer does not understand", () => {
        bundle = makeModBundleFixture({ buildId: BUILD_ID });
        editManifest(bundle.dir, raw => { raw.product = "someone-else"; });
        expect(refuses(bundle.dir)).toContain("not written by Subline");

        bundle.restamp();
        editManifest(bundle.dir, raw => { raw.format = 99; });
        expect(refuses(bundle.dir)).toContain("format 99");
    });

    it("refuses a manifest whose build id could never match a beacon", () => {
        // The marker's build id decides whether a running plugin counts as ours.
        // A value that is not a hex digest can match nothing, so accepting one
        // would guarantee every verification reads as foreign.
        for (const buildId of ["", "unknown", "*", "1F2E3D4C5B6A7980", "1f2e3d4", 7, null]) {
            bundle?.cleanup();
            bundle = makeModBundleFixture({ buildId: BUILD_ID });
            editManifest(bundle.dir, raw => { raw.buildId = buildId; });
            expect(refuses(bundle.dir)).toContain("usable build id");
        }
    });

    it("refuses a bundle that does not pin the Vencord commit it came from", () => {
        // Spec §6 makes this operational and GPL-3.0 makes it legal: a bundle
        // that cannot say which upstream it is cannot be shipped.
        for (const commit of [undefined, "", "1a8c3b7", "HEAD", FIXTURE_VENCORD_COMMIT.toUpperCase()]) {
            bundle?.cleanup();
            bundle = makeModBundleFixture({ buildId: BUILD_ID });
            editManifest(bundle.dir, raw => {
                (raw.vencord as Record<string, unknown>).commit = commit;
            });
            expect(refuses(bundle.dir)).toContain("does not pin the Vencord commit");
        }

        bundle?.cleanup();
        bundle = makeModBundleFixture({ buildId: BUILD_ID });
        editManifest(bundle.dir, raw => { delete raw.vencord; });
        expect(refuses(bundle.dir)).toContain("does not pin the Vencord commit");
    });

    it("refuses a manifest that is not readable JSON", () => {
        bundle = makeModBundleFixture({ buildId: BUILD_ID });
        writeFileSync(manifestPathFor(bundle.dir), "{ truncated");
        expect(refuses(bundle.dir)).toContain("not readable JSON");
    });
});

describe("removeModBundle", () => {
    it("removes a bundle we installed — spec §8 step 4", () => {
        bundle = makeModBundleFixture({ buildId: BUILD_ID });
        const dir = bundle.dir;
        expect(existsSync(join(dir, LOADER_ENTRY_NAME))).toBe(true);

        const result = removeModBundle(dir);
        expect(result.ok && result.value).toBe(true);
        expect(existsSync(dir)).toBe(false);
    });

    it("reports 'nothing to remove' for a bundle that is already gone", () => {
        scratch = mkdtempSync(join(tmpdir(), "subline-gone-"));
        const absent = join(scratch, "mod");
        const result = removeModBundle(absent);
        expect(result.ok && result.value).toBe(false);
    });

    it("refuses to recursively delete a directory that is not one of ours", () => {
        // This is an rm -rf whose path comes from configuration. A wrong path
        // must cost an error, not the user's files.
        scratch = mkdtempSync(join(tmpdir(), "subline-notours-"));
        writeFileSync(join(scratch, "important.txt"), "someone else's data");

        const result = removeModBundle(scratch);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("MOD_BUNDLE_INVALID");
        expect(existsSync(join(scratch, "important.txt"))).toBe(true);
    });
});

describe("where the bundle lives at runtime", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" };

    it("resolves a stable per-user directory, not one inside the app", () => {
        expect(modBundleDirFor("darwin", {}, "/Users/ada")).toBe(
            "/Users/ada/Library/Application Support/Subline/mod"
        );
        expect(modBundleDirFor("win32", env, "C:\\Users\\ada")).toBe(
            join("C:\\Users\\ada\\AppData\\Local", "Subline", MOD_DIR_NAME)
        );
    });

    it("has no location on a platform we do not support, rather than inventing one", () => {
        expect(modBundleDirFor("linux", {}, "/home/ada")).toBeNull();
        expect(productDirFor("linux", {}, "/home/ada")).toBeNull();
        // Windows without LOCALAPPDATA is not a guess either.
        expect(modBundleDirFor("win32", {}, "C:\\Users\\ada")).toBeNull();
    });

    it("puts the bundle beside the beacon, under one product directory", () => {
        // One per-platform table, not two: if these ever disagree, the installer
        // and the plugin are looking at different places for the same product.
        const root = productDirFor("darwin", {}, "/Users/ada");
        expect(beaconDirFor("darwin", {}, "/Users/ada")).toBe(root);
        expect(modBundleDirFor("darwin", {}, "/Users/ada")).toBe(join(root!, MOD_DIR_NAME));
        expect(beaconPathFor("darwin", {}, "/Users/ada")).toBe(join(root!, "status.json"));
    });
});
