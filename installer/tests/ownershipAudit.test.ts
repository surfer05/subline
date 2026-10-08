/**
 * Install audit 2026-10-06, the ownership family, at the patcher layer.
 * Every case runs the real patcher on temp-directory Discords. Worst case
 * first: the inputs are the ones that used to destroy Discord's only copy of
 * its code, stop it starting, or take Subline from another account.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { uninstall } from "../src/app/uninstall.js";
import { buildAsar } from "../src/patcher/asar.js";
import { markerPathFor, readMarker, writeMarker } from "../src/patcher/marker.js";
import { adoptPatch, patchInstall, unpatchInstall, verifyPatch } from "../src/patcher/patch.js";
import { identifyModFromLoaderPath, inspectInstall } from "../src/patcher/state.js";
import { buildStubAsar, legacyStubIndexSource, previousStubIndexSource, readStub, stubIndexSource } from "../src/patcher/stub.js";
import { FIXTURE_BUILD_INFO, makeDiscordFixture, makeModBundleFixture, uninstallSystemFake } from "./fixture.js";
import type { Fixture, ModBundleFixture } from "./fixture.js";

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

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/* ------------------------------------------------------------------------ *
 * #6: what an archive IS is decided by its entry point
 * ------------------------------------------------------------------------ */

describe("audit #6: a loader with extra files is a loader, never Discord's original", () => {
    const threeEntryLoader = (main = "index.js"): Buffer => buildAsar([
        { name: main, content: Buffer.from('require("/opt/x/patcher.js")', "utf8") },
        { name: "package.json", content: Buffer.from(JSON.stringify({ name: "discord", main }), "utf8") },
        { name: "README.md", content: Buffer.from("A loader.\n".repeat(20), "utf8") }
    ]);

    it("a 3-entry, 300-byte loader archive is another mod's stub", () => {
        const f = fixture({ withBackup: true });
        writeFileSync(f.install.asarPath, threeEntryLoader());
        const state = inspectInstall(f.install);
        expect(state.ok && state.value.kind).toBe("patched-by-other");
        expect(state.ok && state.value.mod).toBe("unknown");
        expect(state.ok && state.value.asarIsStub).toBe(true);
        expect(state.ok && state.value.loaderPath).toBe("/opt/x/patcher.js");
    });

    it("the same loader with main loader.js instead of index.js is still a stub", () => {
        const f = fixture({ withBackup: true });
        writeFileSync(f.install.asarPath, threeEntryLoader("loader.js"));
        const state = inspectInstall(f.install);
        expect(state.ok && state.value.asarIsStub).toBe(true);
        expect(state.ok && state.value.loaderPath).toBe("/opt/x/patcher.js");
    });

    it("an archive whose main entry is missing is broken (asar-unrecognised), never unpatched", () => {
        const f = fixture();
        writeFileSync(f.install.asarPath, buildAsar([
            { name: "package.json", content: Buffer.from('{"name":"discord","main":"gone.js"}', "utf8") },
            { name: "other.js", content: Buffer.from("// x", "utf8") }
        ]));
        const state = inspectInstall(f.install);
        expect(state.ok && state.value.kind).toBe("broken");
        expect(state.ok && state.value.reason).toBe("asar-unrecognised");
    });

    it("an archive with no package.json is broken (asar-unrecognised)", () => {
        const f = fixture();
        writeFileSync(f.install.asarPath, buildAsar([{ name: "index.js", content: Buffer.from('require("/opt/x/patcher.js")', "utf8") }]));
        const state = inspectInstall(f.install);
        expect(state.ok && state.value.reason).toBe("asar-unrecognised");
    });

    it("OpenAsar-like (main index.js with real code, many files) is still Discord's original", () => {
        const f = fixture();
        writeFileSync(f.install.asarPath, buildAsar([
            { name: "index.js", content: Buffer.from(`const x=require("./bootstrap");\n${"x".repeat(2000)}`, "utf8") },
            { name: "package.json", content: Buffer.from('{"name":"discord","main":"index.js"}', "utf8") },
            { name: "bootstrap.js", content: Buffer.from("// b", "utf8") }
        ]));
        const state = inspectInstall(f.install);
        expect(state.ok && state.value.kind).toBe("unpatched");
    });

    it("a Windows-shaped original (main app_bootstrap/index.js, nested) is Discord's original", () => {
        const f = fixture();
        writeFileSync(f.install.asarPath, Buffer.concat([buildAsarWithDir()]));
        const state = inspectInstall(f.install);
        expect(state.ok && state.value.kind).toBe("unpatched");
    });

    it("patchInstall never moves the 3-entry loader over the real backup", () => {
        const b = bundle();
        const f = fixture({ withBackup: true });
        writeFileSync(f.install.asarPath, threeEntryLoader());
        const backup = sha(f.install.backupPath);
        const refused = patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" });
        expect(!refused.ok && refused.error.code).toBe("FOREIGN_MOD_PRESENT");
        expect(sha(f.install.backupPath)).toBe(backup);

        const replaced = patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.3", overwriteForeignMod: true });
        expect(replaced.ok && replaced.value.backupCreated).toBe(false);
        expect(sha(f.install.backupPath)).toBe(backup);
    });
});

/** An asar whose package.json main is nested (app_bootstrap/index.js), with that folder present. */
function buildAsarWithDir(): Buffer {
    const files = {
        "package.json": { size: 0, offset: "0" },
        app_bootstrap: { files: { "index.js": { size: 0, offset: "0" } } }
    };
    const pkg = Buffer.from('{"name":"discord","main":"app_bootstrap/index.js"}', "utf8");
    const index = Buffer.from("// bootstrap", "utf8");
    files["package.json"] = { size: pkg.length, offset: "0" };
    files.app_bootstrap.files["index.js"] = { size: index.length, offset: String(pkg.length) };
    const json = Buffer.from(JSON.stringify({ files }), "utf8");
    const aligned = Math.ceil(json.length / 4) * 4;
    const head = Buffer.alloc(16);
    head.writeUInt32LE(4, 0);
    head.writeUInt32LE(aligned + 8, 4);
    head.writeUInt32LE(aligned + 4, 8);
    head.writeUInt32LE(json.length, 12);
    return Buffer.concat([head, json, Buffer.alloc(aligned - json.length), pkg, index]);
}

/* ------------------------------------------------------------------------ *
 * #4: a stub whose loader is gone, and the stub forms we ever wrote
 * ------------------------------------------------------------------------ */

describe("audit #4: a missing loader and outdated stub forms", () => {
    it("our stub whose loader is gone is still ours, with loader-missing", () => {
        const f = fixture({ withBackup: true, stubLoaderPath: "/nowhere/Subline/mod/patcher.js" });
        const state = inspectInstall(f.install);
        expect(state.ok && state.value.kind).toBe("patched-by-us");
        expect(state.ok && state.value.warnings).toContain("loader-missing");
        expect(state.ok && state.value.loaderPresent).toBe(false);
    });

    it("a loader under ANOTHER account's home is not called missing (this account cannot look)", () => {
        const f = fixture({ withBackup: true, stubLoaderPath: "/Users/other/Library/Application Support/Subline/mod/patcher.js" });
        const state = inspectInstall(f.install, { platform: "darwin", home: "/Users/me" });
        expect(state.ok && state.value.warnings).not.toContain("loader-missing");
    });

    it("names each stub form we wrote", () => {
        const b = bundle();
        for (const [source, form] of [[stubIndexSource, "current"], [previousStubIndexSource, "previous"], [legacyStubIndexSource, "legacy"]] as const) {
            const f = fixture({ withBackup: true });
            writeFileSync(f.install.asarPath, buildStubAsar(b.loaderPath, source));
            const state = inspectInstall(f.install, { ownLoaderPaths: [b.loaderPath] });
            expect(state.ok && state.value.stubForm).toBe(form);
        }
    });

    it("the installer upgrades an older stub form even when the marker and build agree", () => {
        const b = bundle();
        const f = fixture();
        expect(patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.2" }).ok).toBe(true);
        writeFileSync(f.install.asarPath, buildStubAsar(b.loaderPath, legacyStubIndexSource));
        const result = patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" });
        expect(result.ok && result.value.alreadyPatched).toBe(false);
        const stub = readStub(f.install.asarPath);
        expect(stub.ok && stub.value?.indexSource).toBe(stubIndexSource(b.loaderPath));
    });

    it("every stub form we ever wrote still verifies", () => {
        const b = bundle();
        for (const source of [stubIndexSource, previousStubIndexSource, legacyStubIndexSource]) {
            const f = fixture();
            expect(patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" }).ok).toBe(true);
            writeFileSync(f.install.asarPath, buildStubAsar(b.loaderPath, source));
            expect(verifyPatch(f.install, { loaderPath: b.loaderPath, buildId: b.buildId }).ok).toBe(true);
        }
    });
});

/* ------------------------------------------------------------------------ *
 * #5: spelling variants and another account's Discord
 * ------------------------------------------------------------------------ */

describe("audit #5: one loader in any spelling; another account's Discord is never removed", () => {
    it("a username containing 'vencord' does not make our own loader Vencord's", () => {
        expect(identifyModFromLoaderPath("/Users/vencordfan/Library/Application Support/Subline/mod/patcher.js")).toBe("subline");
        expect(identifyModFromLoaderPath("C:\\Users\\vencordfan\\AppData\\Local\\Subline\\mod\\patcher.js")).toBe("subline");
    });

    it("a stub spelling our loader differently verifies, and adoption keeps app.asar's bytes", () => {
        const b = bundle();
        const f = fixture();
        expect(patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" }).ok).toBe(true);
        const variant = b.loaderPath.replace(/\/patcher\.js$/, "/./patcher.js");
        writeFileSync(f.install.asarPath, buildStubAsar(variant));
        const bytes = readFileSync(f.install.asarPath);
        // Verified as it is: the helper calls it "not needed", never "damaged".
        expect(verifyPatch(f.install, { loaderPath: b.loaderPath, buildId: b.buildId }).ok).toBe(true);
        const adopted = adoptPatch(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" });
        expect(adopted.ok).toBe(true);
        expect(readFileSync(f.install.asarPath).equals(bytes)).toBe(true);
        const marker = readMarker(f.install.resourcesPath);
        expect(marker.ok && marker.value?.loaderPath).toBe(variant);
        expect(verifyPatch(f.install, { loaderPath: b.loaderPath, buildId: b.buildId }).ok).toBe(true);
        const again = patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" });
        expect(again.ok && again.value.alreadyPatched).toBe(true);
    });

    for (const withMarker of [true, false]) {
        it(`macOS: another account's Subline (marker ${withMarker ? "present" : "absent"}) is refused with OTHER_ACCOUNT, nothing changed`, () => {
            const other = "/Users/other/Library/Application Support/Subline/mod/patcher.js";
            const f = fixture({ withBackup: true, stubLoaderPath: other });
            if (withMarker) {
                writeMarker(f.install.resourcesPath, {
                    format: 2, product: "subline", productVersion: "0.2.2", loaderPath: other, pluginBuildId: "x",
                    discordVersion: FIXTURE_BUILD_INFO.version, backupPath: f.install.backupPath, patchedAt: "2026-10-01T00:00:00.000Z"
                });
            }
            const before = { asar: sha(f.install.asarPath), backup: sha(f.install.backupPath), marker: existsSync(markerPathFor(f.install.resourcesPath)) };
            const isOther = (loader: string): boolean => loader.startsWith("/Users/other/");
            for (const dryRun of [true, false]) {
                const result = unpatchInstall(f.install, { dryRun, isOtherAccountLoader: isOther });
                expect(!result.ok && result.error.code).toBe("OTHER_ACCOUNT");
            }
            expect(sha(f.install.asarPath)).toBe(before.asar);
            expect(sha(f.install.backupPath)).toBe(before.backup);
            expect(existsSync(markerPathFor(f.install.resourcesPath))).toBe(before.marker);
        });
    }

    it("uninstall on the other account: says so, never 'put back to normal', and its own files still go", async () => {
        const other = "/Users/other/Library/Application Support/Subline/mod/patcher.js";
        const f = fixture({ withBackup: true, stubLoaderPath: other });
        const before = sha(f.install.asarPath);
        const mod = bundle();
        const sys = uninstallSystemFake();
        const report = await uninstall(
            {
                ...sys.ports,
                unpatch: (target, opts) => unpatchInstall(target, { ...opts, isOtherAccountLoader: loader => loader.startsWith("/Users/other/") }),
                modBundleDir: mod.dir,
                productDir: null,
                logDir: null,
                vencordSettingsPath: null,
                log: quiet
            },
            { installs: [f.install] }
        );
        expect(report.summary).toContain("Another account on this Mac");
        expect(report.summary).not.toContain("put back to normal");
        expect(sha(f.install.asarPath)).toBe(before);
        expect(report.restores[0]?.leftAlone).toEqual({ kind: "other-account" });
    });
});

/* ------------------------------------------------------------------------ *
 * #9: our stub shadowed by an unpacked resources/app
 * ------------------------------------------------------------------------ */

describe("audit #9: BetterDiscord installed after Subline", () => {
    for (const withMarker of [true, false]) {
        it(`our stub ${withMarker ? "with" : "without"} its marker, plus resources/app: still ours, flagged shadowed`, () => {
            const b = bundle();
            const f = fixture();
            expect(patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" }).ok).toBe(true);
            if (!withMarker) unlinkSync(markerPathFor(f.install.resourcesPath));
            mkdirSync(join(f.install.resourcesPath, "app"), { recursive: true });
            writeFileSync(join(f.install.resourcesPath, "app", "index.js"), 'require("C:/Users/x/AppData/Roaming/BetterDiscord/data/betterdiscord.asar")');
            const state = inspectInstall(f.install, { ownLoaderPaths: [b.loaderPath] });
            expect(state.ok && state.value.kind).toBe("patched-by-us");
            expect(state.ok && state.value.warnings).toContain("shadowed-by-unpacked-app");
            expect(state.ok && state.value.shadowedBy).toBe("betterdiscord");
        });
    }

    it("patchInstall refuses (never 'already patched'); unpatch restores and leaves resources/app alone", () => {
        const b = bundle();
        const f = fixture();
        expect(patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" }).ok).toBe(true);
        mkdirSync(join(f.install.resourcesPath, "app"), { recursive: true });
        writeFileSync(join(f.install.resourcesPath, "app", "package.json"), '{"name":"replugged"}');
        const refused = patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" });
        expect(!refused.ok && refused.error.code).toBe("FOREIGN_MOD_PRESENT");
        const restored = unpatchInstall(f.install, { ownLoaderPaths: [b.loaderPath] });
        expect(restored.ok && restored.value.restored).toBe(true);
        expect(readFileSync(f.install.asarPath).equals(f.originalAsar)).toBe(true);
        expect(readFileSync(join(f.install.resourcesPath, "app", "package.json"), "utf8")).toBe('{"name":"replugged"}');
    });
});

/* ------------------------------------------------------------------------ *
 * #30 / #31: a stale marker is rewritten alone
 * ------------------------------------------------------------------------ */

describe("audit #30, #31: a marker describing another folder or build is rewritten alone", () => {
    it("a marker carried verbatim from the old Windows folder is marker-stale; adoption rewrites version, backup and time", () => {
        const b = bundle();
        const f = fixture();
        expect(patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" }).ok).toBe(true);
        const m = readMarker(f.install.resourcesPath);
        if (!m.ok || m.value === null) throw new Error("no marker");
        writeMarker(f.install.resourcesPath, { ...m.value, discordVersion: "1.0.9259", backupPath: "C:\\old\\app-1.0.9259\\resources\\_app.asar", patchedAt: "2026-01-01T00:00:00.000Z" });
        const state = inspectInstall(f.install, { ownLoaderPaths: [b.loaderPath] });
        expect(state.ok && state.value.warnings).toEqual(["marker-stale"]);
        const inode = statSync(f.install.asarPath).ino;
        const adopted = adoptPatch(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" });
        expect(adopted.ok && adopted.value.warning).toBe("marker-stale");
        const after = readMarker(f.install.resourcesPath);
        expect(after.ok && after.value?.discordVersion).toBe(FIXTURE_BUILD_INFO.version);
        expect(after.ok && after.value?.backupPath).toBe(f.install.backupPath);
        expect(after.ok && Date.parse(after.value?.patchedAt ?? "") > Date.parse("2026-01-01")).toBe(true);
        expect(statSync(f.install.asarPath).ino).toBe(inode);
    });

    it("a Subline-only update writes only the marker (no app.asar write, no Discord quit needed)", () => {
        const b = bundle();
        const f = fixture();
        expect(patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.2" }).ok).toBe(true);
        b.rebuild({ buildId: "fedcba9876543210" });
        const inode = statSync(f.install.asarPath).ino;
        const bytes = readFileSync(f.install.asarPath);
        const result = patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" });
        expect(result.ok && result.value.alreadyPatched).toBe(false);
        expect(result.ok && result.value.pluginBuildId).toBe("fedcba9876543210");
        expect(readFileSync(f.install.asarPath).equals(bytes)).toBe(true);
        expect(statSync(f.install.asarPath).ino).toBe(inode);
    });

    it("adoption refuses a damaged backup BEFORE touching the marker", () => {
        const b = bundle();
        const f = fixture();
        expect(patchInstall(f.install, { modBundleDir: b.dir, productVersion: "0.2.2" }).ok).toBe(true);
        b.rebuild({ buildId: "fedcba9876543210" });
        writeFileSync(f.install.backupPath, buildStubAsar("/opt/other/patcher.js"));
        const marker = readFileSync(markerPathFor(f.install.resourcesPath));
        const adopted = adoptPatch(f.install, { modBundleDir: b.dir, productVersion: "0.2.3" });
        expect(!adopted.ok && adopted.error.code).toBe("NOT_ADOPTABLE");
        expect(readFileSync(markerPathFor(f.install.resourcesPath)).equals(marker)).toBe(true);
    });
});

/* ------------------------------------------------------------------------ *
 * #3 (betterFix b): a Canary whose app.asar is a folder (unpacked Vencord)
 * ------------------------------------------------------------------------ */

describe("audit #3: another mod's unreadable Discord never blocks Subline's uninstall", () => {
    it("Canary app.asar as a directory plus _app.asar, no marker: left alone, Stable restored, clean", async () => {
        const b = bundle();
        const stable = fixture();
        expect(patchInstall(stable.install, { modBundleDir: b.dir, productVersion: "0.2.3" }).ok).toBe(true);
        const canary = makeDiscordFixture({ appName: "Discord Canary.app", withoutAsar: true, withBackup: true });
        cleanups.push(canary.cleanup);
        mkdirSync(canary.install.asarPath, { recursive: true });
        writeFileSync(join(canary.install.asarPath, "index.js"), 'require("/x/Vencord/patcher.js")');
        writeFileSync(join(canary.install.asarPath, "package.json"), '{"name":"discord","main":"index.js"}');
        const canaryBackup = sha(canary.install.backupPath);
        const sys = uninstallSystemFake();
        const report = await uninstall(
            {
                ...sys.ports,
                unpatch: (target, opts) => unpatchInstall(target, { ...opts, ownLoaderPaths: [b.loaderPath] }),
                modBundleDir: null,
                productDir: null,
                logDir: null,
                vencordSettingsPath: null,
                log: quiet
            },
            { installs: [stable.install, { ...canary.install, branch: "canary" }] }
        );
        expect(report.clean).toBe(true);
        expect(readFileSync(stable.install.asarPath).equals(stable.originalAsar)).toBe(true);
        expect(statSync(canary.install.asarPath).isDirectory()).toBe(true);
        expect(sha(canary.install.backupPath)).toBe(canaryBackup);
    });
});
