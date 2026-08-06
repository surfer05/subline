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

    it("refuses a bundle whose stamp merely SHARES A PREFIX with the manifest's id", () => {
        // Two builds one commit apart can share leading hex by chance, and a
        // digest compared loosely is not an identity at all — it would accept
        // the neighbouring build it exists to tell apart. Found by mutation:
        // comparing only the first two characters passed every other test here.
        bundle = makeModBundleFixture({ buildId: "1f2e3d4c5b6a7980", stampedBuildId: "1f2e3d4c00000000" });
        expect(refuses(bundle.dir)).toContain("1f2e3d4c5b6a7980");
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

    it("names the byte counts when an artefact arrives short, rather than just 'wrong digest'", () => {
        // A partially downloaded renderer.js is well over the minimum size, so
        // only the manifest can catch it — and "702 KB became 66 KB" is a
        // diagnosis someone can act on, where "the digest does not match" is
        // indistinguishable from corruption. The size check earns its place by
        // what it SAYS, so that is what is asserted.
        bundle = makeModBundleFixture({ buildId: BUILD_ID });
        const path = join(bundle.dir, STAMPED_ENTRY_NAME);
        const full = readFileSync(path);
        const truncated = 66_000;
        expect(full.length).toBeGreaterThan(truncated);
        // Written AFTER the manifest, so the manifest still records the full size.
        writeFileSync(path, full.subarray(0, truncated));

        const message = refuses(bundle.dir);
        expect(message).toContain(`is ${truncated} bytes but the manifest records ${full.length}`);
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
        for (const buildId of [
            "",
            "unknown",
            "*",
            "1F2E3D4C5B6A7980",
            "1f2e3d4",
            // Anchoring matters, not merely the alphabet: an id with a valid
            // digest buried in it would be recorded verbatim into the marker and
            // then compared, whole, against a beacon that can never carry it.
            "build 1f2e3d4c5b6a7980",
            "1f2e3d4c5b6a7980 (dev)",
            "1f2e3d4c5b6a7980\n",
            7,
            null
        ]) {
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

/**
 * The one test that runs against a REAL `pnpm build:mod` output rather than a
 * fixture.
 *
 * Skipped when nothing has been built, because building Vencord takes minutes
 * and needs the network — but when a bundle IS there, this is what proves the
 * fixtures above are not merely self-consistent. Every check in this file is
 * written against a shape we invented; this one holds that shape against the
 * artefact esbuild actually produces.
 */
const REAL_BUNDLE = join(import.meta.dirname, "..", "build", "mod");

describe.skipIf(!existsSync(manifestPathFor(REAL_BUNDLE)))("a real built bundle", () => {
    it("passes the same inspection the installer runs", () => {
        const result = inspectModBundle(REAL_BUNDLE);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.buildId).toMatch(/^[0-9a-f]{16}$/);
        expect(result.value.vencordCommit).toMatch(/^[0-9a-f]{40}$/);
        // The stamp is in the renderer and only in the renderer: the main
        // process validates a beacon someone else wrote and states no identity.
        expect(readFileSync(join(REAL_BUNDLE, STAMPED_ENTRY_NAME), "utf8")).toContain(result.value.buildId);
        expect(readFileSync(join(REAL_BUNDLE, LOADER_ENTRY_NAME), "utf8")).not.toContain(result.value.buildId);
    });

    it("agrees with the build id checked into the plugin", () => {
        // If these ever diverge, the bundle on disk is not the code in the repo.
        const stamp = readFileSync(
            join(import.meta.dirname, "..", "..", "src", "userplugins", "vcTranslate", "buildStamp.ts"),
            "utf8"
        );
        const result = inspectModBundle(REAL_BUNDLE);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(stamp).toContain(`BUILD_ID = "${result.value.buildId}"`);
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
