/**
 * A BAD subline-patch.json (audit 2026-10-06, missed high item, verified by two
 * verifiers): truncated, hand-edited, another product's, empty, wrong types,
 * huge or unreadable. It used to make the install "broken" forever: the patch
 * refused, the helper alerted every run, uninstall refused (and, beside another
 * mod's stub with a backup, put Discord's original back over that mod).
 *
 * The rule pinned here: a bad marker proves nothing. Ownership is judged by
 * what app.asar is, exactly as with no marker.
 *   - beside OUR stub: ours. Install and helper rewrite the marker; uninstall restores.
 *   - beside ANOTHER mod's stub: that mod's. Never blocks; only a real uninstall removes the file.
 *   - beside Discord's ORIGINAL app.asar: unpatched. Install proceeds and overwrites it.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { uninstall } from "../src/app/uninstall.js";
import type { UninstallPorts, UninstallSystemPorts } from "../src/app/uninstall.js";
import { installModBundle } from "../src/app/modInstall.js";
import { MAX_MARKER_BYTES, markerPathFor, readMarker, writeMarker } from "../src/patcher/marker.js";
import { adoptPatch, patchInstall, unpatchInstall } from "../src/patcher/patch.js";
import { inspectInstall } from "../src/patcher/state.js";
import { makeDiscordFixture, makeModBundleFixture, uninstallSystemFake } from "./fixture.js";
import type { Fixture } from "./fixture.js";

const VENCORD_LOADER = "/Users/someone/dev/Vencord/dist/patcher.js";
const PRODUCT_VERSION = "0.2.3";

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
});

/** A bundle installed at …/Subline/mod, so its patcher.js is recognisably ours. */
function ourBundle(): { modDir: string; loaderPath: string; buildId: string; productDir: string } {
    const root = mkdtempSync(join(tmpdir(), "subline-badmarker-"));
    const source = makeModBundleFixture();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), source.cleanup);
    const productDir = join(root, "Subline");
    const modDir = join(productDir, "mod");
    mkdirSync(productDir, { recursive: true });
    const installed = installModBundle({ sourceDir: source.dir, destDir: modDir });
    if (!installed.ok) throw new Error(installed.error.message);
    return { modDir, loaderPath: join(modDir, "patcher.js"), buildId: source.buildId, productDir };
}

function fixture(options: Parameters<typeof makeDiscordFixture>[0] = {}): Fixture {
    const f = makeDiscordFixture(options);
    cleanups.push(f.cleanup);
    return f;
}

const canChmod = typeof process.getuid === "function" && process.getuid() !== 0;

/** Every flavour of bad marker. Each writes the file and returns nothing. */
const BAD_MARKERS: Array<[string, (path: string) => void]> = [
    ["empty", path => writeFileSync(path, "")],
    ["truncated JSON", path => writeFileSync(path, '{\n    "format": 2,\n    "product": "subl')],
    ["valid JSON, another product", path => writeFileSync(path, JSON.stringify({ format: 2, product: "other", loaderPath: "/x/patcher.js" }))],
    ["valid JSON, wrong types", path => writeFileSync(path, JSON.stringify({ format: "2", product: "subline", loaderPath: 42 }))],
    ["JSON null", path => writeFileSync(path, "null")],
    ["JSON array", path => writeFileSync(path, "[1,2,3]")],
    ["huge", path => writeFileSync(path, `{"product":"subline","loaderPath":"/x","pad":"${"x".repeat(MAX_MARKER_BYTES + 10)}"}`)],
    ...(canChmod
        ? [["unreadable (EACCES)", (path: string) => {
            writeFileSync(path, "{}");
            chmodSync(path, 0o000);
            cleanups.push(() => { try { chmodSync(path, 0o644); } catch { /* gone */ } });
        }] as [string, (path: string) => void]]
        : [])
];

describe("readMarker: a bad marker is an error to the reader, never a crash", () => {
    it.each(BAD_MARKERS)("%s", (_name, write) => {
        const f = fixture();
        write(markerPathFor(f.install.resourcesPath));
        const read = readMarker(f.install.resourcesPath);
        expect(read.ok).toBe(false);
    });

    it("a huge marker is refused by its size, without reading it whole", () => {
        const f = fixture();
        writeFileSync(markerPathFor(f.install.resourcesPath), "x".repeat(MAX_MARKER_BYTES + 1));
        const read = readMarker(f.install.resourcesPath);
        expect(!read.ok && read.error.message).toMatch(/too big/);
    });
});

describe("a bad marker beside OUR stub: still ours", () => {
    function patchedThenBad(write: (path: string) => void): { f: Fixture; bundle: ReturnType<typeof ourBundle> } {
        const bundle = ourBundle();
        const f = fixture();
        const patched = patchInstall(f.install, { modBundleDir: bundle.modDir, productVersion: PRODUCT_VERSION });
        if (!patched.ok) throw new Error(patched.error.message);
        write(markerPathFor(f.install.resourcesPath));
        return { f, bundle };
    }

    it.each(BAD_MARKERS)("%s: inspect says patched-by-us, marker to be rewritten, never broken", (_name, write) => {
        const { f } = patchedThenBad(write);
        const state = inspectInstall(f.install);
        expect(state.ok).toBe(true);
        if (!state.ok) return;
        expect(state.value.kind).toBe("patched-by-us");
        expect(state.value.marker).toBeNull();
        expect(state.value.warnings).toContain("marker-unreadable");
        expect(state.value.warnings).toContain("marker-missing");
        // The cause is kept for the log.
        expect(state.value.markerProblem).toBeTruthy();
    });

    it.each(BAD_MARKERS)("%s: install rewrites the marker and leaves app.asar alone", (_name, write) => {
        const { f, bundle } = patchedThenBad(write);
        const inode = statSync(f.install.asarPath).ino;
        const result = patchInstall(f.install, { modBundleDir: bundle.modDir, productVersion: PRODUCT_VERSION });
        expect(result.ok).toBe(true);
        const marker = readMarker(f.install.resourcesPath);
        expect(marker.ok && marker.value?.pluginBuildId).toBe(bundle.buildId);
        expect(statSync(f.install.asarPath).ino).toBe(inode);
    });

    it.each(BAD_MARKERS)("%s: the helper's adopt rewrites the marker", (_name, write) => {
        const { f, bundle } = patchedThenBad(write);
        const adopted = adoptPatch(f.install, { modBundleDir: bundle.modDir, productVersion: PRODUCT_VERSION });
        expect(adopted.ok).toBe(true);
        expect(adopted.ok && adopted.value.warning).toBe("marker-missing");
        expect(readMarker(f.install.resourcesPath).ok).toBe(true);
    });

    it.each(BAD_MARKERS)("%s: uninstall's dry run passes and the real one restores Discord", (_name, write) => {
        const { f } = patchedThenBad(write);
        const dry = unpatchInstall(f.install, { dryRun: true });
        expect(dry.ok).toBe(true);
        expect(dry.ok && dry.value.alreadyClean).toBe(false);
        const real = unpatchInstall(f.install);
        expect(real.ok).toBe(true);
        expect(real.ok && real.value.restored).toBe(true);
        expect(readFileSync(f.install.asarPath).equals(f.originalAsar)).toBe(true);
        expect(existsSync(markerPathFor(f.install.resourcesPath))).toBe(false);
        expect(existsSync(f.install.backupPath)).toBe(false);
    });
});

describe("a bad marker beside ANOTHER mod's stub: that mod's, never a blocker", () => {
    function vencordWithBad(write: (path: string) => void): Fixture {
        const f = fixture({ stubLoaderPath: VENCORD_LOADER, withBackup: true });
        write(markerPathFor(f.install.resourcesPath));
        return f;
    }

    it.each(BAD_MARKERS)("%s: inspect says patched-by-other (Vencord), never broken", (_name, write) => {
        const f = vencordWithBad(write);
        const state = inspectInstall(f.install);
        expect(state.ok && state.value.kind).toBe("patched-by-other");
        expect(state.ok && state.value.mod).toBe("vencord");
        expect(state.ok && state.value.warnings).toContain("marker-unreadable");
    });

    it.each(BAD_MARKERS)("%s: install asks about Vencord as usual, and replaces it when told to", (_name, write) => {
        const bundle = ourBundle();
        const f = vencordWithBad(write);
        const refused = patchInstall(f.install, { modBundleDir: bundle.modDir, productVersion: PRODUCT_VERSION });
        expect(!refused.ok && refused.error.code).toBe("FOREIGN_MOD_PRESENT");
        const replaced = patchInstall(f.install, { modBundleDir: bundle.modDir, productVersion: PRODUCT_VERSION, overwriteForeignMod: true });
        expect(replaced.ok).toBe(true);
        expect(readMarker(f.install.resourcesPath).ok).toBe(true);
    });

    it.each(BAD_MARKERS)("%s: the dry run touches nothing; the real uninstall removes only the marker", (_name, write) => {
        const f = vencordWithBad(write);
        const stub = readFileSync(f.install.asarPath);
        const dry = unpatchInstall(f.install, { dryRun: true });
        expect(dry.ok && dry.value.foreignMod).toBe("Vencord");
        expect(existsSync(markerPathFor(f.install.resourcesPath))).toBe(true);

        const real = unpatchInstall(f.install);
        expect(real.ok && real.value.foreignMod).toBe("Vencord");
        expect(real.ok && real.value.restored).toBe(false);
        expect(existsSync(markerPathFor(f.install.resourcesPath))).toBe(false);
        // Vencord is exactly as it was: its stub in place, its backup kept.
        expect(readFileSync(f.install.asarPath).equals(stub)).toBe(true);
        expect(existsSync(f.install.backupPath)).toBe(true);
    });
});

describe("a bad marker beside Discord's ORIGINAL app.asar: unpatched, never broken", () => {
    it.each(BAD_MARKERS)("%s: inspect says unpatched, and install proceeds and overwrites it", (_name, write) => {
        const bundle = ourBundle();
        const f = fixture();
        write(markerPathFor(f.install.resourcesPath));
        const state = inspectInstall(f.install);
        expect(state.ok && state.value.kind).toBe("unpatched");

        const patched = patchInstall(f.install, { modBundleDir: bundle.modDir, productVersion: PRODUCT_VERSION });
        expect(patched.ok).toBe(true);
        const marker = readMarker(f.install.resourcesPath);
        expect(marker.ok && marker.value?.loaderPath).toBe(bundle.loaderPath);
    });

    it.each(BAD_MARKERS)("%s, with a leftover _app.asar: install proceeds, and uninstall never deletes that backup", (_name, write) => {
        const bundle = ourBundle();
        const f = fixture({ withBackup: true });
        write(markerPathFor(f.install.resourcesPath));
        const state = inspectInstall(f.install);
        expect(state.ok && state.value.kind).toBe("unpatched");

        // Uninstall first: the bad marker goes, the backup it does not prove is ours stays.
        const cleaned = unpatchInstall(f.install);
        expect(cleaned.ok && cleaned.value.alreadyClean).toBe(false);
        expect(existsSync(markerPathFor(f.install.resourcesPath))).toBe(false);
        expect(existsSync(f.install.backupPath)).toBe(true);

        write(markerPathFor(f.install.resourcesPath));
        const patched = patchInstall(f.install, { modBundleDir: bundle.modDir, productVersion: PRODUCT_VERSION });
        expect(patched.ok).toBe(true);
    });

    it("the dry run says there is something to remove (the bad file), never alreadyClean", () => {
        const f = fixture();
        writeFileSync(markerPathFor(f.install.resourcesPath), "{ not json");
        const dry = unpatchInstall(f.install, { dryRun: true });
        expect(dry.ok && dry.value.alreadyClean).toBe(false);
    });
});

describe("marker writes are atomic", () => {
    it("a write replaces a marker this process cannot read, and leaves no temp file", () => {
        if (!canChmod) return;
        const f = fixture();
        const path = markerPathFor(f.install.resourcesPath);
        writeFileSync(path, "{}");
        chmodSync(path, 0o000);
        cleanups.push(() => { try { chmodSync(path, 0o644); } catch { /* gone */ } });
        const written = writeMarker(f.install.resourcesPath, {
            format: 2,
            product: "subline",
            productVersion: PRODUCT_VERSION,
            loaderPath: "/Users/a/Library/Application Support/Subline/mod/patcher.js",
            pluginBuildId: "0123456789abcdef",
            discordVersion: null,
            backupPath: f.install.backupPath,
            patchedAt: "2026-10-08T00:00:00.000Z"
        });
        expect(written.ok).toBe(true);
        expect(readMarker(f.install.resourcesPath).ok).toBe(true);
        expect(existsSync(`${path}.tmp`)).toBe(false);
    });
});

describe("uninstall() end to end with a bad marker (real unpatch, fake system)", () => {
    function realPorts(bundle: ReturnType<typeof ourBundle>, logged: string[]): UninstallPorts & UninstallSystemPorts {
        return {
            ...uninstallSystemFake().ports,
            unpatch: (install, options) => unpatchInstall(install, options),
            hasOurMarker: install => {
                const marker = readMarker(install.resourcesPath);
                return marker.ok && marker.value !== null;
            },
            modBundleDir: bundle.modDir,
            productDir: bundle.productDir,
            logDir: null,
            vencordSettingsPath: null,
            log: {
                info: event => logged.push(`info:${event}`),
                warn: event => logged.push(`warn:${event}`),
                error: event => logged.push(`error:${event}`)
            }
        };
    }

    it("our stub + truncated marker: Discord restored, clean", async () => {
        const bundle = ourBundle();
        const f = fixture();
        patchInstall(f.install, { modBundleDir: bundle.modDir, productVersion: PRODUCT_VERSION });
        writeFileSync(markerPathFor(f.install.resourcesPath), '{"format":2,"pro');
        const report = await uninstall(realPorts(bundle, []), { installs: [f.install] });
        expect(report.nothingChanged).not.toBe(true);
        expect(report.discordRestored).toBe(true);
        expect(report.clean).toBe(true);
        expect(readFileSync(f.install.asarPath).equals(f.originalAsar)).toBe(true);
    });

    it("Vencord + another product's marker: never refused, Vencord untouched, the marker removed", async () => {
        const bundle = ourBundle();
        const f = fixture({ stubLoaderPath: VENCORD_LOADER, withBackup: true });
        writeFileSync(markerPathFor(f.install.resourcesPath), JSON.stringify({ product: "other" }));
        const stub = readFileSync(f.install.asarPath);
        const logged: string[] = [];
        const report = await uninstall(realPorts(bundle, logged), { installs: [f.install] });
        expect(report.nothingChanged).not.toBe(true);
        expect(report.clean).toBe(true);
        expect(report.restores[0]?.leftAlone).toEqual({ kind: "foreign", mod: "Vencord" });
        expect(readFileSync(f.install.asarPath).equals(stub)).toBe(true);
        expect(existsSync(f.install.backupPath)).toBe(true);
        expect(existsSync(markerPathFor(f.install.resourcesPath))).toBe(false);
        expect(logged).toContain("info:uninstall.foreign-marker-removed");
    });

    it("an unreadable app.asar + a bad marker and no backup: left alone, never a refusal", async () => {
        const bundle = ourBundle();
        const f = fixture();
        writeFileSync(f.install.asarPath, Buffer.from("not an archive at all"));
        writeFileSync(markerPathFor(f.install.resourcesPath), "");
        const report = await uninstall(realPorts(bundle, []), { installs: [f.install] });
        expect(report.nothingChanged).not.toBe(true);
        expect(report.restores[0]?.leftAlone).toEqual({ kind: "unreadable" });
    });

    it("Discord's original + an empty marker: uninstall removes the file and finishes clean", async () => {
        const bundle = ourBundle();
        const f = fixture();
        writeFileSync(markerPathFor(f.install.resourcesPath), "");
        const report = await uninstall(realPorts(bundle, []), { installs: [f.install] });
        expect(report.clean).toBe(true);
        expect(existsSync(markerPathFor(f.install.resourcesPath))).toBe(false);
        expect(readFileSync(f.install.asarPath).equals(f.originalAsar)).toBe(true);
    });
});

