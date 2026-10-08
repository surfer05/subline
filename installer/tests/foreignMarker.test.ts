/**
 * OUR STUB WITHOUT OUR MARKER (field bug, Windows, 2026-10-04).
 *
 * Vencord's persistAfterDiscordUpdates, which ships inside our patcher.js, runs
 * on Discord's host update and on quit: it renames the new app-x.y.z folder's
 * app.asar to _app.asar and copies the OLD folder's app.asar (our stub) over
 * it. It copies nothing else, so the new folder has our stub, a good backup and
 * no subline-patch.json. Judged by the marker alone that was "another client
 * mod": the helper abandoned the install and uninstall refused it.
 *
 * These tests pin ownership by LOADER: a stub that loads Subline's own
 * patcher.js is ours, marker or not, and a genuine foreign stub is still not.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { markerPathFor, readMarker, writeMarker } from "../src/patcher/marker.js";
import type { DiscordInstall } from "../src/patcher/locate.js";
import { isSublineLoaderPath, normaliseLoaderPath, sameLoaderPath } from "../src/patcher/ownership.js";
import { adoptPatch, patchInstall, unpatchInstall } from "../src/patcher/patch.js";
import { identifyModFromLoaderPath, inspectInstall } from "../src/patcher/state.js";
import { buildStubAsar, legacyStubIndexSource, readStub } from "../src/patcher/stub.js";
import { buildOriginalDiscordAsar, makeDiscordFixture, makeModBundleFixture, REAL_VENCORD_LOADER_PATH } from "./fixture.js";
import type { Fixture, ModBundleFixture } from "./fixture.js";

const WIN_LOADER = "C:\\Users\\Ada\\AppData\\Local\\Subline\\mod\\patcher.js";
const WIN = { platform: "win32" as const, env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local", USERPROFILE: "C:\\Users\\Ada" } };

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(options: Parameters<typeof makeDiscordFixture>[0] = {}): Fixture {
    const f = makeDiscordFixture(options);
    cleanups.push(f.cleanup);
    return f;
}

function bundle(): ModBundleFixture {
    const b = makeModBundleFixture();
    cleanups.push(b.cleanup);
    return b;
}

function marker(f: Fixture, loaderPath: string, buildId = "0123456789abcdef"): void {
    const written = writeMarker(f.install.resourcesPath, {
        format: 2,
        product: "subline",
        productVersion: "0.2.1",
        loaderPath,
        pluginBuildId: buildId,
        discordVersion: "1.0.9259",
        backupPath: f.install.backupPath,
        patchedAt: "2026-10-04T12:00:00.000Z"
    });
    if (!written.ok) throw new Error(written.error.message);
}

describe("loader paths: one spelling for the same file", () => {
    it("folds case, slashes, trailing separators, dots, ~ and %VAR% on Windows", () => {
        const want = "c:/users/ada/appdata/local/subline/mod/patcher.js";
        expect(normaliseLoaderPath(WIN_LOADER, WIN)).toBe(want);
        expect(normaliseLoaderPath("c:/users/ada/appdata/local/subline/mod/patcher.js/", WIN)).toBe(want);
        expect(normaliseLoaderPath("C:\\Users\\Ada\\AppData\\Local\\Subline\\mod\\.\\x\\..\\patcher.js", WIN)).toBe(want);
        expect(normaliseLoaderPath("%LOCALAPPDATA%\\Subline\\mod\\patcher.js", WIN)).toBe(want);
        expect(normaliseLoaderPath("%localappdata%/Subline/mod/patcher.js", WIN)).toBe(want);
        expect(normaliseLoaderPath("~\\AppData\\Local\\Subline\\mod\\patcher.js", WIN)).toBe(want);
        expect(sameLoaderPath(WIN_LOADER, "C:/USERS/ADA/AppData/Local/Subline/mod/patcher.js", WIN)).toBe(true);
    });

    it("keeps case on Linux, where two spellings can be two files", () => {
        expect(sameLoaderPath("/home/ada/Subline/mod/patcher.js", "/home/ada/subline/mod/patcher.js", { platform: "linux" })).toBe(false);
    });

    it("an unknown %VAR% is left as written, never expanded to nothing", () => {
        expect(normaliseLoaderPath("%NOPE%\\Subline\\mod\\patcher.js", WIN)).toBe("%nope%/subline/mod/patcher.js");
    });
});

describe("which loaders are Subline's", () => {
    it("any …/Subline/mod/patcher.js, in any spelling, on any platform", () => {
        expect(isSublineLoaderPath(WIN_LOADER, [], WIN)).toBe(true);
        expect(isSublineLoaderPath("/Users/ada/Library/Application Support/Subline/mod/patcher.js", [], { platform: "darwin" })).toBe(true);
        expect(isSublineLoaderPath("c:/users/ada/appdata/local/SUBLINE/MOD/PATCHER.JS", [], WIN)).toBe(true);
    });

    it("a bundle elsewhere counts only when the caller names it", () => {
        expect(isSublineLoaderPath("/opt/dev/build/patcher.js", [], { platform: "darwin" })).toBe(false);
        expect(isSublineLoaderPath("/opt/dev/build/patcher.js", ["/opt/dev/build/patcher.js/"], { platform: "darwin" })).toBe(true);
    });

    it("never other mods, and never a folder that merely ends in 'subline'", () => {
        for (const foreign of [
            REAL_VENCORD_LOADER_PATH,
            "C:\\Users\\Ada\\AppData\\Roaming\\Vencord\\dist\\patcher.js",
            "C:\\Users\\Ada\\AppData\\Roaming\\Equicord\\dist\\patcher.js",
            "C:\\Users\\Ada\\AppData\\Roaming\\BetterDiscord\\data\\betterdiscord.asar",
            "C:\\Users\\Ada\\AppData\\Roaming\\replugged\\replugged.asar",
            "C:\\Users\\Ada\\AppData\\Local\\NotSubline\\mod\\patcher.js",
            "C:\\Users\\Ada\\AppData\\Local\\Subline\\mod\\other.js"
        ]) {
            expect(isSublineLoaderPath(foreign, [], WIN), foreign).toBe(false);
        }
        expect(identifyModFromLoaderPath(REAL_VENCORD_LOADER_PATH)).toBe("vencord");
    });

    it("identifyModFromLoaderPath names our own loader 'subline', never 'unknown'", () => {
        expect(identifyModFromLoaderPath(WIN_LOADER, WIN)).toBe("subline");
    });
});

describe("classifying our stub with the marker missing or wrong", () => {
    it("our loader, a backup, no marker: patched by us, with marker-missing", () => {
        const f = fixture({ stubLoaderPath: WIN_LOADER, withBackup: true });
        const state = inspectInstall(f.install, WIN);
        expect(state.ok && state.value.kind).toBe("patched-by-us");
        expect(state.ok && state.value.mod).toBe("subline");
        expect(state.ok && state.value.warnings).toEqual(["marker-missing"]);
    });

    it("a marker that spells the loader differently (case, slashes, trailing slash): still ours, marker-mismatch", () => {
        const f = fixture({ stubLoaderPath: WIN_LOADER, withBackup: true });
        marker(f, "c:/users/ada/appdata/local/subline/mod/patcher.js/");
        const state = inspectInstall(f.install, WIN);
        expect(state.ok && state.value.kind).toBe("patched-by-us");
        expect(state.ok && state.value.warnings).toEqual(["marker-mismatch"]);
    });

    it("a marker naming another path while the stub loads ours: still ours, marker-mismatch", () => {
        const f = fixture({ stubLoaderPath: WIN_LOADER, withBackup: true });
        marker(f, "C:\\Old\\place\\patcher.js");
        const state = inspectInstall(f.install, WIN);
        expect(state.ok && state.value.kind).toBe("patched-by-us");
        expect(state.ok && state.value.warnings).toEqual(["marker-mismatch"]);
    });

    it("the exact marker gives no warning (unchanged behaviour)", () => {
        const f = fixture({ stubLoaderPath: WIN_LOADER, withBackup: true });
        marker(f, WIN_LOADER);
        const state = inspectInstall(f.install, WIN);
        expect(state.ok && state.value.warnings).toEqual([]);
    });

    it("our loader with NO backup is our-patch-without-backup, never 'another client mod'", () => {
        const f = fixture({ stubLoaderPath: WIN_LOADER });
        const state = inspectInstall(f.install, WIN);
        expect(state.ok && state.value.kind).toBe("broken");
        expect(state.ok && state.value.reason).toBe("our-patch-without-backup");
        expect(state.ok && state.value.summary).not.toMatch(/client mod/);
    });

    it("genuine foreign stubs stay foreign, marker or not", () => {
        for (const loader of [REAL_VENCORD_LOADER_PATH, "C:\\Users\\Ada\\AppData\\Roaming\\Equicord\\dist\\patcher.js"]) {
            const f = fixture({ stubLoaderPath: loader, withBackup: true });
            const state = inspectInstall(f.install, WIN);
            expect(state.ok && state.value.kind, loader).toBe("patched-by-other");
        }
        // Our marker beside someone else's stub does not make the stub ours.
        const f = fixture({ stubLoaderPath: REAL_VENCORD_LOADER_PATH, withBackup: true });
        marker(f, WIN_LOADER);
        const state = inspectInstall(f.install, WIN);
        expect(state.ok && state.value.kind).toBe("patched-by-other");
        expect(state.ok && state.value.warnings).toEqual(["marker-loader-mismatch"]);
    });
});

describe("uninstall restores our stub whatever the marker says", () => {
    it("no marker, backup present: the original is put back", () => {
        const f = fixture({ stubLoaderPath: WIN_LOADER, withBackup: true });
        const result = unpatchInstall(f.install);
        expect(result.ok).toBe(true);
        expect(result.ok && result.value.restored).toBe(true);
        expect(readFileSync(f.install.asarPath).equals(f.originalAsar)).toBe(true);
        expect(existsSync(f.install.backupPath)).toBe(false);
    });

    it("a stub loading a bundle outside …/Subline/mod is restored when the caller names that loader", () => {
        const b = bundle();
        const f = fixture({ stubLoaderPath: b.loaderPath, withBackup: true });
        // Without the loader named it looks like another mod's: left alone.
        const unnamed = unpatchInstall(f.install);
        expect(unnamed.ok && unnamed.value.restored).toBe(false);
        expect(unnamed.ok && unnamed.value.foreignMod !== undefined).toBe(true);
        const result = unpatchInstall(f.install, { ownLoaderPaths: [b.loaderPath] });
        expect(result.ok && result.value.restored).toBe(true);
    });

    it("no backup: says the backup is missing, not that another mod is there", () => {
        const f = fixture({ stubLoaderPath: WIN_LOADER });
        const result = unpatchInstall(f.install);
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error.code).toBe("BACKUP_MISSING");
        expect(!result.ok && result.error.message).toMatch(/backup/);
        expect(!result.ok && result.error.message).not.toMatch(/client mod/);
    });

    it("a backup that is itself a stub (from a different Discord copy gone wrong) is refused, nothing changed", () => {
        const f = fixture({ stubLoaderPath: WIN_LOADER });
        writeFileSync(f.install.backupPath, buildStubAsar(WIN_LOADER));
        const before = readFileSync(f.install.asarPath);
        const result = unpatchInstall(f.install);
        expect(!result.ok && result.error.code).toBe("BACKUP_CORRUPT");
        expect(readFileSync(f.install.asarPath).equals(before)).toBe(true);
    });
});

describe("patch and adopt rewrite the marker", () => {
    it("patchInstall over our marker-less stub writes the marker and leaves app.asar's bytes alone", () => {
        const b = bundle();
        const f = fixture({ withBackup: true });
        // The one-line form an older Subline wrote: a full patch would rewrite
        // it to the current form, so unchanged bytes prove app.asar was not
        // touched (on Windows a rename over it fails while Discord runs).
        writeFileSync(f.install.asarPath, buildStubAsar(b.loaderPath, legacyStubIndexSource));
        const before = readFileSync(f.install.asarPath);
        const result = patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.2" });
        expect(result.ok).toBe(true);
        expect(result.ok && result.value.alreadyPatched).toBe(false);
        expect(readFileSync(f.install.asarPath).equals(before)).toBe(true);
        const m = readMarker(f.install.resourcesPath);
        expect(m.ok && m.value?.loaderPath).toBe(b.loaderPath);
        expect(m.ok && m.value?.pluginBuildId).toBe(b.buildId);
        const state = inspectInstall(f.install, { ownLoaderPaths: [b.loaderPath] });
        expect(state.ok && state.value.kind).toBe("patched-by-us");
        expect(state.ok && state.value.warnings).toEqual([]);
    });

    it("a mismatched marker with the right build id is still rewritten, not 'already patched'", () => {
        const b = bundle();
        const f = fixture({ stubLoaderPath: b.loaderPath, withBackup: true });
        marker(f, b.loaderPath.toUpperCase(), b.buildId);
        const result = patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.2" });
        expect(result.ok && result.value.alreadyPatched).toBe(false);
        const m = readMarker(f.install.resourcesPath);
        expect(m.ok && m.value?.loaderPath).toBe(b.loaderPath);
    });

    it("adoptPatch refuses a stub that loads another Subline path; patchInstall then repoints it in full", () => {
        const b = bundle();
        const f = fixture({ stubLoaderPath: WIN_LOADER, withBackup: true });
        const adopted = adoptPatch(f.install, { modBundleDir: b.dir, productVersion: "0.2.2" });
        expect(!adopted.ok && adopted.error.code).toBe("NOT_ADOPTABLE");
        expect(existsSync(markerPathFor(f.install.resourcesPath))).toBe(false);

        const patched = patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.2" });
        expect(patched.ok).toBe(true);
        const stub = readStub(f.install.asarPath);
        expect(stub.ok && stub.value?.loaderPath).toBe(b.loaderPath);
        expect(readFileSync(f.install.backupPath).equals(f.originalAsar)).toBe(true);
    });

    it("adoptPatch with a damaged backup writes nothing that stays", () => {
        const b = bundle();
        const f = fixture({ stubLoaderPath: b.loaderPath });
        writeFileSync(f.install.backupPath, buildStubAsar(b.loaderPath));
        const adopted = adoptPatch(f.install, { modBundleDir: b.dir, productVersion: "0.2.2" });
        expect(adopted.ok).toBe(false);
        expect(existsSync(markerPathFor(f.install.resourcesPath))).toBe(false);
    });

    it("adoptPatch never touches app.asar, so it works while Discord holds it open", () => {
        const b = bundle();
        const f = fixture({ stubLoaderPath: b.loaderPath, withBackup: true });
        const before = readFileSync(f.install.asarPath);
        const adopted = adoptPatch(f.install, { modBundleDir: b.dir, productVersion: "0.2.2" });
        expect(adopted.ok && adopted.value.warning).toBe("marker-missing");
        expect(readFileSync(f.install.asarPath).equals(before)).toBe(true);
    });
});

/**
 * The field sequence, on a Windows-shaped tree: Discord updates while running,
 * the helper defers, Vencord's host-update code copies our stub into the new
 * folder without the marker, Discord updates again, and uninstall runs. Every
 * folder must end up either ours-with-marker or restored.
 */
describe("a Windows update sequence", () => {
    function appFolder(discordRoot: string, version: string): DiscordInstall {
        const rootPath = join(discordRoot, `app-${version}`);
        const resourcesPath = join(rootPath, "resources");
        mkdirSync(resourcesPath, { recursive: true });
        writeFileSync(join(resourcesPath, "app.asar"), buildOriginalDiscordAsar(version));
        writeFileSync(join(resourcesPath, "build_info.json"), JSON.stringify({ releaseChannel: "stable", version }));
        return {
            branch: "stable",
            rootPath,
            stableId: discordRoot,
            resourcesPath,
            asarPath: join(resourcesPath, "app.asar"),
            backupPath: join(resourcesPath, "_app.asar"),
            buildInfoPath: join(resourcesPath, "build_info.json"),
            fromExplicitPath: false
        };
    }

    /** What Vencord's persistAfterDiscordUpdates does on host update / quit. */
    function vencordHostUpdateRepatch(from: DiscordInstall, to: DiscordInstall): void {
        if (!existsSync(from.asarPath) || !existsSync(to.asarPath) || existsSync(to.backupPath)) return;
        renameSync(to.asarPath, to.backupPath);
        copyFileSync(from.asarPath, to.asarPath);
    }

    it("ends with stub, marker and backup in the newest folder, and uninstall restores every folder", () => {
        const root = mkdtempSync(join(tmpdir(), "subline-winseq-"));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const b = bundle();
        const discordRoot = join(root, "Discord");

        const v9258 = appFolder(discordRoot, "1.0.9258");
        expect(patchInstall(v9258, { modBundleDir: b.dir, productVersion: "0.1.3" }).ok).toBe(true);

        // 9259 lands while Discord runs; then Discord quits and Vencord copies our stub over.
        const v9259 = appFolder(discordRoot, "1.0.9259");
        vencordHostUpdateRepatch(v9258, v9259);
        const s9259 = inspectInstall(v9259, { ownLoaderPaths: [b.loaderPath] });
        expect(s9259.ok && s9259.value.kind).toBe("patched-by-us");
        expect(s9259.ok && s9259.value.warnings).toEqual(["marker-missing"]);

        // Many updates in a row: 9260 is created from 9259 the same way.
        const v9260 = appFolder(discordRoot, "1.0.9260");
        vencordHostUpdateRepatch(v9259, v9260);

        // The helper (or the installer) re-adopts the newest folder: marker only.
        const adopted = adoptPatch(v9260, { modBundleDir: b.dir, productVersion: "0.2.2" });
        expect(adopted.ok).toBe(true);
        const m = readMarker(v9260.resourcesPath);
        expect(m.ok && m.value?.loaderPath).toBe(b.loaderPath);
        expect(m.ok && m.value?.discordVersion).toBe("1.0.9260");
        expect(readFileSync(v9260.backupPath).equals(buildOriginalDiscordAsar("1.0.9260"))).toBe(true);

        // Uninstall sweeps every folder that carries our mark, newest first.
        for (const install of [v9260, v9259, v9258]) {
            const result = unpatchInstall(install, { ownLoaderPaths: [b.loaderPath] });
            expect(result.ok, install.rootPath).toBe(true);
        }
        for (const [install, version] of [[v9260, "1.0.9260"], [v9259, "1.0.9259"], [v9258, "1.0.9258"]] as const) {
            expect(readFileSync(install.asarPath).equals(buildOriginalDiscordAsar(version)), version).toBe(true);
            expect(existsSync(install.backupPath)).toBe(false);
            expect(existsSync(markerPathFor(install.resourcesPath))).toBe(false);
        }
    });

    it("a new folder still half-written (no app.asar yet) is left alone, then adopted once it is complete", () => {
        const root = mkdtempSync(join(tmpdir(), "subline-winhalf-"));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const b = bundle();
        const discordRoot = join(root, "Discord");
        const v1 = appFolder(discordRoot, "1.0.1");
        expect(patchInstall(v1, { modBundleDir: b.dir, productVersion: "0.2.2" }).ok).toBe(true);
        const v2 = appFolder(discordRoot, "1.0.2");
        rmSync(v2.asarPath);
        vencordHostUpdateRepatch(v1, v2); // refuses: no app.asar to back up
        expect(existsSync(v2.asarPath)).toBe(false);
        const half = inspectInstall(v2, { ownLoaderPaths: [b.loaderPath] });
        expect(half.ok && half.value.kind).toBe("broken");
        expect(adoptPatch(v2, { modBundleDir: b.dir, productVersion: "0.2.2" }).ok).toBe(false);
        writeFileSync(v2.asarPath, buildOriginalDiscordAsar("1.0.2"));
        vencordHostUpdateRepatch(v1, v2);
        expect(adoptPatch(v2, { modBundleDir: b.dir, productVersion: "0.2.2" }).ok).toBe(true);
    });
});
