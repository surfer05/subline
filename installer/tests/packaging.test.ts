/**
 * The packaging configuration and the checks that guard it.
 *
 * ## What is testable here, and what deliberately is not
 *
 * NOTHING IN THIS FILE SIGNS, NOTARIZES, PUBLISHES OR RUNS `xcrun`. Those need
 * the user's Developer ID certificate and Apple credentials, which are theirs and
 * are not in this repository. What IS testable is everything that decides what
 * those steps will be handed:
 *
 *   · the build-id agreement check, against real bundle fixtures on disk
 *   · the release manifest's shape, round-tripped through the SHIPPED reader
 *   · checksum computation, against files that really exist
 *   · the electron-builder config's internal consistency — every path it names
 *     resolving to something that is actually there
 *
 * That last one matters more than it looks. A packaging configuration is a set of
 * promises, and every one of them is silent when it does not happen: an
 * `entitlements` path that no longer exists makes electron-builder fall back to
 * its own defaults, an `extraResources.from` that moved ships an app with no mod
 * bundle in it, and a hook path with a typo means the build-id check never runs
 * at all. Each produces a build that looks fine and is not.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    assertBundleIdentity, checkBundleIdentity, PACKAGED_MOD_DIR_NAME, packagedModDir, packagedResourcesDir
} from "../packaging/bundleIdentity.js";
import {
    buildReleaseManifest, CHECKSUMS_ASSET_NAME, digestFile, modArtifactName, parseRepository,
    releaseAssetUrl, releaseFeedUrl, RELEASE_MANIFEST_ASSET_NAME, RELEASE_MANIFEST_FORMAT_WRITTEN,
    releaseTagFor, renderChecksums, renderReleaseManifest, sha256OfFile
} from "../packaging/manifest.js";
import {
    isNotarizationRequested, notarizeAndStaple, notarytoolArgs, readNotarizeAuth
} from "../packaging/notarize.js";
import { inspectBundleDir } from "../src/bundle/spec.js";
import {
    RELEASE_FEED_ENABLED, RELEASE_FEED_URL, RELEASE_MANIFEST_ASSET_NAME as FEED_ASSET_NAME,
    RELEASE_REPOSITORY, releaseManifestUrl
} from "../src/helper/feed.js";
import {
    ALLOWED_RELEASE_HOSTS, assertTrustedUrl, parseReleaseManifest, RELEASE_MANIFEST_FORMAT
} from "../src/helper/release.js";
import { makeModBundleFixture } from "./fixture.js";
import type { ModBundleFixture } from "./fixture.js";

const INSTALLER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

interface PackagingConfig {
    appId: string;
    productName: string;
    directories: { output: string; buildResources: string };
    files: string[];
    extraResources: Array<{ from: string; to: string }>;
    beforePack: string;
    afterPack: string;
    afterSign: string;
    mac: {
        hardenedRuntime: boolean;
        entitlements: string;
        entitlementsInherit: string;
        notarize: boolean;
        identity?: string;
        target: Array<{ target: string; arch: string[] }>;
        extendInfo: Record<string, string>;
    };
    win: {
        target: Array<{ target: string; arch: string[] }>;
        certificateFile?: string;
        certificateSubjectName?: string;
        certificatePassword?: string;
    };
    nsis: { perMachine: boolean; allowElevation: boolean; oneClick: boolean; include?: string };
}

/**
 * THE FILE ELECTRON-BUILDER ACTUALLY READS.
 *
 * Not a copy, not package.json's `build` field — which is deliberately absent,
 * because it takes priority over this file and a leftover one would silently win.
 * Asserting on a duplicate would be asserting on something the build never sees.
 */
const config: PackagingConfig =
    ((await import("../electron-builder.js" as string)) as { default: PackagingConfig }).default;

function packageJson(): { build?: PackagingConfig; version: string; scripts: Record<string, string> } {
    return JSON.parse(readFileSync(join(INSTALLER_DIR, "package.json"), "utf8"));
}

/**
 * The entitlements macOS would actually SEE.
 *
 * Parsed with the system's own `plutil`, not read as text: the files carry long
 * comments naming the entitlements that are deliberately ABSENT and why, and a
 * substring search would find those and conclude the opposite of the truth. It
 * also means a malformed plist fails here rather than at `codesign`, which takes
 * the file and quietly produces the wrong entitlements.
 */
function entitlements(name: string): Record<string, unknown> {
    const path = join(INSTALLER_DIR, "packaging", name);
    const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" });
    return JSON.parse(json) as Record<string, unknown>;
}

/* ------------------------------------------------------------------------ *
 * The build-id agreement check
 * ------------------------------------------------------------------------ */

describe("the shipped bundle must be the build this checkout produces", () => {
    let bundle: ModBundleFixture;

    beforeEach(() => { bundle = makeModBundleFixture({ buildId: "aaaa1111bbbb2222", pluginVersion: "0.1.0" }); });
    afterEach(() => { bundle.cleanup(); });

    it("agrees when the bundle's id is the expected one", () => {
        const report = checkBundleIdentity({
            bundleDir: bundle.dir,
            expectedBuildId: "aaaa1111bbbb2222",
            expectedPluginVersion: "0.1.0",
            inspect: inspectBundleDir
        });
        expect(report.agrees).toBe(true);
        expect(report.problems).toEqual([]);
        expect(report.buildId).toBe("aaaa1111bbbb2222");
    });

    it("REFUSES a stale bundle — the exact case build/mod surviving a branch switch produces", () => {
        const report = checkBundleIdentity({
            bundleDir: bundle.dir,
            // The plugin sources moved on; nobody re-ran build:mod.
            expectedBuildId: "cccc3333dddd4444",
            inspect: inspectBundleDir
        });
        expect(report.agrees).toBe(false);
        expect(report.buildId).toBe("aaaa1111bbbb2222");
        expect(report.problems.join(" ")).toContain("cccc3333dddd4444");
        expect(report.problems.join(" ")).toContain("pnpm build:mod");
    });

    it("refuses a bundle whose renderer does not carry the id its manifest claims", () => {
        // A bundle that is internally inconsistent: the manifest says one build,
        // the code that will actually run says another.
        bundle.rebuild({ buildId: "aaaa1111bbbb2222", stampedBuildId: "9999888877776666" });
        const report = checkBundleIdentity({
            bundleDir: bundle.dir,
            expectedBuildId: "aaaa1111bbbb2222",
            inspect: inspectBundleDir
        });
        expect(report.agrees).toBe(false);
        expect(report.problems.join(" ")).toContain("renderer.js");
    });

    it("refuses a directory that is not a bundle at all", () => {
        const empty = mkdtempSync(join(tmpdir(), "subline-empty-bundle-"));
        try {
            const report = checkBundleIdentity({
                bundleDir: empty,
                expectedBuildId: "aaaa1111bbbb2222",
                inspect: inspectBundleDir
            });
            expect(report.agrees).toBe(false);
            expect(report.buildId).toBeNull();
            expect(report.problems.length).toBeGreaterThan(0);
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });

    it("treats an inspector that throws as a failure, never as a pass", () => {
        const report = checkBundleIdentity({
            bundleDir: "/nowhere",
            expectedBuildId: "aaaa1111bbbb2222",
            inspect: () => { throw new Error("disk went away"); }
        });
        expect(report.agrees).toBe(false);
        expect(report.problems.join(" ")).toContain("disk went away");
    });

    it("notices a plugin version that disagrees even when the id matches", () => {
        const report = checkBundleIdentity({
            bundleDir: bundle.dir,
            expectedBuildId: "aaaa1111bbbb2222",
            expectedPluginVersion: "0.2.0",
            inspect: inspectBundleDir
        });
        expect(report.agrees).toBe(false);
        expect(report.problems.join(" ")).toContain("0.2.0");
    });

    it("THROWS on disagreement, because a returned false is what a hook ignores", () => {
        expect(() => assertBundleIdentity({
            bundleDir: bundle.dir,
            expectedBuildId: "cccc3333dddd4444",
            inspect: inspectBundleDir
        })).toThrow(/will not package/);
    });

    it("returns the report on agreement, so the hook can log what it proved", () => {
        const report = assertBundleIdentity({
            bundleDir: bundle.dir,
            expectedBuildId: "aaaa1111bbbb2222",
            inspect: inspectBundleDir
        });
        expect(report.buildId).toBe("aaaa1111bbbb2222");
    });
});

describe("where the bundle lands inside a packed app", () => {
    it("is Contents/Resources/mod on macOS", () => {
        expect(packagedModDir({
            electronPlatformName: "darwin",
            appOutDir: "/out/mac-arm64",
            productName: "Subline"
        })).toBe("/out/mac-arm64/Subline.app/Contents/Resources/mod");
    });

    it("is resources/mod on Windows", () => {
        expect(packagedModDir({
            electronPlatformName: "win32",
            appOutDir: "/out/win-unpacked",
            productName: "Subline"
        })).toBe("/out/win-unpacked/resources/mod");
    });

    it("uses the same directory name the config copies to", () => {
                expect(config.extraResources.some(entry => entry.to === PACKAGED_MOD_DIR_NAME)).toBe(true);
        expect(packagedResourcesDir({
            electronPlatformName: "darwin",
            appOutDir: "/out",
            productName: "Subline"
        }).endsWith("Contents/Resources")).toBe(true);
    });
});

/* ------------------------------------------------------------------------ *
 * The release manifest
 * ------------------------------------------------------------------------ */

describe("the release manifest", () => {
    let dir: string;
    let artifactPath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "subline-release-"));
        artifactPath = join(dir, modArtifactName("aaaa1111bbbb2222"));
        writeFileSync(artifactPath, Buffer.from("a pretend zip of a mod bundle"));
    });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    function manifest() {
        return buildReleaseManifest({
            repository: parseRepository("surfer05/vctranslate"),
            tag: "v0.1.0",
            buildId: "aaaa1111bbbb2222",
            pluginVersion: "0.1.0",
            artifact: digestFile(artifactPath),
            publishedAt: "2026-08-07T09:00:00.000Z"
        });
    }

    it("is accepted by the reader that SHIPS — the only definition of the shape that counts", () => {
        const parsed = parseReleaseManifest(renderReleaseManifest(manifest()), "test");
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error(parsed.error.message);
        expect(parsed.value.buildId).toBe("aaaa1111bbbb2222");
        expect(parsed.value.pluginVersion).toBe("0.1.0");
        expect(parsed.value.signature).toBeNull();
    });

    it("writes the format the shipped reader understands", () => {
        expect(RELEASE_MANIFEST_FORMAT_WRITTEN).toBe(RELEASE_MANIFEST_FORMAT);
    });

    it("records the artefact's real byte count and digest, not a claim", () => {
        const built = manifest();
        expect(built.artifact.bytes).toBe(readFileSync(artifactPath).byteLength);
        expect(built.artifact.sha256).toBe(sha256OfFile(artifactPath));
        expect(built.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("names an artefact URL on a host the helper is allowed to download from", () => {
        const url = manifest().artifact.url;
        const trusted = assertTrustedUrl(url, "release artefact");
        expect(trusted.ok).toBe(true);
        expect(ALLOWED_RELEASE_HOSTS).toContain(new URL(url).hostname);
    });

    it("puts the build id in the artefact's NAME, so a stale asset is visible", () => {
        expect(manifest().artifact.name).toBe("subline-mod-aaaa1111bbbb2222.zip");
    });

    it("refuses to describe an empty artefact rather than emitting an unparseable manifest", () => {
        writeFileSync(artifactPath, Buffer.alloc(0));
        expect(() => manifest()).toThrow(/nothing to release/);
    });

    it("carries a signature through when one is supplied", () => {
        // `REQUIRE_SIGNATURE` in release.ts is the switch that makes an unsigned
        // release refuse to install once there is a key. A writer that silently
        // dropped the field would make that switch impossible to turn on.
        const signed = buildReleaseManifest({
            repository: parseRepository("surfer05/vctranslate"),
            tag: "v0.1.0",
            buildId: "aaaa1111bbbb2222",
            pluginVersion: "0.1.0",
            artifact: digestFile(artifactPath),
            publishedAt: "2026-08-07T09:00:00.000Z",
            signature: { algorithm: "ed25519", keyId: "subline-1", value: "c2ln" }
        });
        expect(signed.signature).toEqual({ algorithm: "ed25519", keyId: "subline-1", value: "c2ln" });

        const parsed = parseReleaseManifest(renderReleaseManifest(signed), "test");
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error(parsed.error.message);
        expect(parsed.value.signature?.keyId).toBe("subline-1");
    });

    it("ends with a newline, so the published asset is a well-formed text file", () => {
        expect(renderReleaseManifest(manifest()).endsWith("}\n")).toBe(true);
    });
});

describe("release URLs", () => {
    it("accepts owner/name, an https URL and an ssh URL as the same repository", () => {
        const expected = { owner: "surfer05", name: "vctranslate" };
        expect(parseRepository("surfer05/vctranslate")).toEqual(expected);
        expect(parseRepository("https://github.com/surfer05/vctranslate.git")).toEqual(expected);
        expect(parseRepository("git@github.com:surfer05/vctranslate")).toEqual(expected);
    });

    it("refuses something that is not a repository, rather than building a URL from it", () => {
        expect(() => parseRepository("not a repo")).toThrow();
        expect(() => parseRepository("https://evil.example/a/b")).toThrow();
        expect(() => parseRepository("surfer05/vctranslate/extra")).toThrow();
    });

    it("builds the tagged asset URL", () => {
        expect(releaseAssetUrl(parseRepository("surfer05/vctranslate"), "v0.1.0", "subline-mod-abc.zip"))
            .toBe("https://github.com/surfer05/vctranslate/releases/download/v0.1.0/subline-mod-abc.zip");
    });

    it("builds the untagged feed URL — the one a shipped build polls forever", () => {
        expect(releaseFeedUrl(parseRepository("surfer05/vctranslate")))
            .toBe("https://github.com/surfer05/vctranslate/releases/latest/download/subline-release.json");
    });

    it("PROVES the URL the release script publishes to is the URL the app polls", () => {
        // Two modules derive it: `feed.ts` compiles into the app, `manifest.ts`
        // only ever runs at release time. A release published one character away
        // from the address every installed copy watches looks exactly like a
        // release nobody made.
        expect(releaseFeedUrl(parseRepository(RELEASE_REPOSITORY))).toBe(RELEASE_FEED_URL);
        expect(FEED_ASSET_NAME).toBe(RELEASE_MANIFEST_ASSET_NAME);
    });

    it("names the repository this code is actually in", () => {
        // Every release URL is derived from RELEASE_REPOSITORY, so a wrong value
        // is self-consistent and invisible: the feed-agreement test above would
        // still pass. package.json's `repository` is the independent witness.
        const declared = JSON.parse(readFileSync(join(INSTALLER_DIR, "package.json"), "utf8")).repository.url;
        expect(parseRepository(RELEASE_REPOSITORY)).toEqual(parseRepository(declared));
    });

    it("tags a version once, whether or not it already starts with v", () => {
        expect(releaseTagFor("0.1.0")).toBe("v0.1.0");
        expect(releaseTagFor("v0.1.0")).toBe("v0.1.0");
    });

    it("has the feed on, now that the first release exists", () => {
        // Flipped from false in the v0.1.0 release commit - the same commit that
        // published the first GitHub release, so the URL it points at resolves
        // rather than 404s (see feed.ts). Before that commit this asserted the
        // flag was OFF; a 404 on every hourly check would have raised a false
        // "cannot check for updates" for a feature that had not shipped.
        expect(RELEASE_FEED_ENABLED).toBe(true);
        expect(releaseManifestUrl()).toBe(RELEASE_FEED_URL);
        // The switch is still only a switch: forced off, the URL is null.
        expect(releaseManifestUrl({ enabled: false })).toBeNull();
    });

    it("offers no way to point the feed somewhere else", () => {
        // `releaseManifestUrl` takes no URL, reads no environment variable and no
        // file. The manifest decides which code is installed under the App
        // Management grant; a redirectable feed would be the easiest possible
        // way to abuse that, requiring no exploit at all.
        const source = readFileSync(join(INSTALLER_DIR, "src", "helper", "feed.ts"), "utf8");
        expect(source).not.toContain("process.env");
        expect(releaseManifestUrl({ enabled: true })).toBe(RELEASE_FEED_URL);
    });
});

describe("checksums", () => {
    let dir: string;

    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "subline-sums-")); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    function write(name: string, content: string): string {
        const path = join(dir, name);
        writeFileSync(path, content);
        return path;
    }

    it("agrees with the system's own shasum, digit for digit", () => {
        const path = write("Subline-0.1.0-arm64.dmg", "not really a disk image");
        const ours = sha256OfFile(path);
        const theirs = execFileSync("/usr/bin/shasum", ["-a", "256", path], { encoding: "utf8" }).split(" ")[0];
        expect(ours).toBe(theirs);
    });

    it("renders lines `shasum -a 256 -c` can check, with names and never paths", () => {
        const a = digestFile(write("b.dmg", "bbb"));
        const b = digestFile(write("a.zip", "aaa"));
        const text = renderChecksums([a, b]);

        expect(text).toBe(`${b.sha256}  a.zip\n${a.sha256}  b.dmg\n`);
        expect(text).not.toContain(dir);
        expect(text).not.toContain("/");
    });

    it("is verifiable by the real shasum", () => {
        write("one.dmg", "one");
        write("two.zip", "two");
        writeFileSync(join(dir, CHECKSUMS_ASSET_NAME), renderChecksums([
            digestFile(join(dir, "one.dmg")),
            digestFile(join(dir, "two.zip"))
        ]));
        // Runs in `dir`, so the bare names in the file are what get checked —
        // which is the whole point of not writing paths into it.
        const output = execFileSync("/usr/bin/shasum", ["-a", "256", "-c", CHECKSUMS_ASSET_NAME], {
            cwd: dir,
            encoding: "utf8"
        });
        expect(output).toContain("one.dmg: OK");
        expect(output).toContain("two.zip: OK");
    });

    it("refuses to write a checksum file for nothing", () => {
        expect(() => renderChecksums([])).toThrow(/nothing to checksum/);
    });
});

/* ------------------------------------------------------------------------ *
 * The electron-builder configuration itself
 * ------------------------------------------------------------------------ */

describe("the packaging configuration is internally consistent", () => {
    it("the custom NSIS include is a path that actually resolves", () => {
        // `nsis.include` resolves relative to directories.buildResources, NOT to
        // the project root. Getting that wrong is silent: electron-builder does
        // not warn about an include it cannot find, it simply builds an
        // installer without the customisation — which is how a build shipped
        // still carrying the "Subline cannot be closed" dialog this file exists
        // to remove. Nothing about the artefact reveals the difference.
        expect(config.nsis.include).toBeDefined();
        const resolved = join(INSTALLER_DIR, config.directories.buildResources, config.nsis.include as string);
        expect(existsSync(resolved)).toBe(true);
    });

    it("that include overrides the running-app check", () => {
        const nsh = readFileSync(
            join(INSTALLER_DIR, config.directories.buildResources, config.nsis.include as string),
            "utf8"
        );
        // The macro name is electron-builder's, not ours: misspell it and the
        // file is included, compiles cleanly, and overrides nothing.
        expect(nsh).toContain("!macro customCheckAppRunning");
        expect(nsh).toContain("!macroend");
    });


    it("names entitlements files that exist", () => {
        const { mac } = config;
        expect(existsSync(join(INSTALLER_DIR, mac.entitlements))).toBe(true);
        expect(existsSync(join(INSTALLER_DIR, mac.entitlementsInherit))).toBe(true);
    });

    it("names hook files that exist and export the hook electron-builder will look for", async () => {
                const hooks = { beforePack: config.beforePack, afterPack: config.afterPack, afterSign: config.afterSign };
        for (const [name, path] of Object.entries(hooks)) {
            expect(existsSync(join(INSTALLER_DIR, path))).toBe(true);
            // electron-builder resolves the NAMED export first and falls back to
            // `default`. A file that exists but exports neither is a hook that
            // silently never runs — which is the failure this whole check is for.
            const loaded = await import(join(INSTALLER_DIR, path));
            expect(typeof loaded[name]).toBe("function");
        }
    });

    it("ships the mod bundle from the directory build:mod writes", () => {
                const entry = config.extraResources.find(candidate => candidate.to === "mod");
        expect(entry).toBeDefined();
        expect(entry?.from).toBe("build/mod");
        // `buildMod.mjs` writes `installer/build/mod`, and the path is relative to
        // the installer directory.
        expect(join(INSTALLER_DIR, entry?.from ?? "")).toBe(join(INSTALLER_DIR, "build", "mod"));
    });

    it("ships the compiled app and nothing else", () => {
        const { files } = config;
        expect(files).toContain("dist/**/*");
        // `src/**`, `tests/**` and `packaging/**` are NOT shipped: the packaging
        // code has no business inside the artefact it packages.
        expect(files.some(pattern => pattern.startsWith("src"))).toBe(false);
        expect(files.some(pattern => pattern.startsWith("tests"))).toBe(false);
        expect(files.some(pattern => pattern.startsWith("packaging"))).toBe(false);
    });

    it("keeps buildResources away from the gitignored build output", () => {
        const { directories } = config;
        // `build/` holds the assembled mod bundle AND a full Vencord checkout.
        expect(directories.buildResources).toBe("packaging");
        expect(directories.output).toBe("release");
    });

    it("uses the app id the LaunchAgent's label is derived from", async () => {
        const { HELPER_LABEL } = await import("../src/helper/launchAgent.js");
        expect(config.appId).toBe("com.subline.installer");
        expect(HELPER_LABEL).toBe("com.subline.helper");
        // Same reverse-DNS root, so the two are recognisably one product.
        expect(HELPER_LABEL.startsWith("com.subline.")).toBe(true);
    });

    it("names an executable the LaunchAgent's ProgramArguments will actually find", async () => {
        const { helperProgramArguments } = await import("../src/helper/launchAgent.js");
        const productName = config.productName;
        // The agent runs `<App>/Contents/MacOS/<productName>`; electron-builder
        // names the executable after `productName`. A mismatch here is a helper
        // launchd can never start, and it would be silent forever.
        expect(helperProgramArguments("/Applications/Subline.app")[0])
            .toBe(`/Applications/Subline.app/Contents/MacOS/${productName}`);
    });
});

describe("macOS signing configuration", () => {
    it("turns the hardened runtime ON — Gatekeeper before App Management is two walls (§4)", () => {
        expect(config.mac.hardenedRuntime).toBe(true);
    });

    it("leaves notarization to the hook, and says so", () => {
        // `false` here is not "do not notarize": the afterSign hook runs
        // notarytool itself so the ticket is stapled to the .app before the DMG
        // wraps it. electron-builder's own step would not do that.
        expect(config.mac.notarize).toBe(false);
        expect(config.afterSign).toContain("hooks");
        // And package.json carries NO `build` field: it takes priority over
        // electron-builder.js, so a leftover one would silently win.
        expect(packageJson().build).toBeUndefined();
    });

    it("DOES NOT SIGN unless it was asked to, and does not reach the keychain", () => {
        // electron-builder's own default is to search the login keychain for any
        // usable identity and sign with it. That raises an authorisation prompt on
        // somebody's machine for a build nobody asked to be signed, and signs the
        // artefact with whatever certificate happens to be installed. It happened
        // once during this task, which is why the guard exists.
        //
        // This suite runs without SUBLINE_SIGN, so the config it imported is the
        // unsigned one, and `null` is electron-builder's explicit "do not sign".
        expect(process.env.SUBLINE_SIGN).toBeUndefined();
        expect(config.mac.identity).toBeNull();
        // Belt and braces: importing the config turns discovery off outright, so
        // no code path inside electron-builder can reach the keychain.
        expect(process.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    });

    it("makes signing opt-in from exactly one place", () => {
        const source = readFileSync(join(INSTALLER_DIR, "electron-builder.js"), "utf8");
        expect(source).toContain("SUBLINE_SIGN");
        expect(source).toContain("CSC_IDENTITY_AUTO_DISCOVERY");

        // Every build script must be unsigned by default; only the release script
        // opts in, and only after notarization has been opted into as well.
        const scripts = packageJson().scripts;
        expect(scripts["pack:dir"]).toContain("CSC_IDENTITY_AUTO_DISCOVERY=false");
        expect(scripts.dist).toContain("CSC_IDENTITY_AUTO_DISCOVERY=false");
        expect(scripts["dist:mac"]).not.toContain("SUBLINE_SIGN");
        expect(readFileSync(join(INSTALLER_DIR, "scripts", "release.mjs"), "utf8")).toContain("SIGN_FLAG_VAR");
    });

    it("pins no signing identity by NAME, so no Team ID is committed", () => {
        const source = readFileSync(join(INSTALLER_DIR, "electron-builder.js"), "utf8");
        // `identity: null` is a refusal, not a name. A pinned name would put a
        // Team ID in the repository and break every other machine.
        expect(source).not.toMatch(/identity:\s*"/);
        expect(source).not.toMatch(/Developer ID Application:/);
        // And no credential of any kind is anywhere in the packaging inputs.
        for (const file of ["electron-builder.js", "package.json", "scripts/release.mjs", "packaging/notarize.ts"]) {
            const text = readFileSync(join(INSTALLER_DIR, file), "utf8");
            expect(text).not.toMatch(/-----BEGIN/);
            expect(text).not.toMatch(/APPLE_APP_SPECIFIC_PASSWORD\s*[:=]\s*['"][^'"]/);
        }
    });

    it("builds for both Apple silicon and Intel", () => {
        const dmg = config.mac.target.find(entry => entry.target === "dmg");
        expect(dmg?.arch).toEqual(["arm64", "x64"]);
    });

    it("declares the Apple-events usage string the automation entitlement needs", () => {
        // `requestQuit` runs osascript. Under the hardened runtime the entitlement
        // makes it possible and THIS string is what the user reads.
        expect(config.mac.extendInfo.NSAppleEventsUsageDescription).toContain("Discord");
    });
});

describe("the entitlements", () => {
    it("are EXACTLY the three the app needs, and nothing else", () => {
        // Listed exhaustively rather than checked one at a time. Every entitlement
        // is a hole in the hardened runtime and Apple's notary reads the list, so
        // the assertion worth having is that nothing was ADDED — a test that only
        // checks the three are present passes just as happily with the sandbox
        // disabled and library validation off.
        expect(entitlements("entitlements.mac.plist")).toEqual({
            // V8 compiles JS at runtime; without these the renderer aborts on
            // launch. A crash, not a permission dialog.
            "com.apple.security.cs.allow-jit": true,
            "com.apple.security.cs.allow-unsigned-executable-memory": true,
            // `osascript … tell application "Discord" to quit` (§7: offer, never
            // force-kill) and the helper's notifications.
            "com.apple.security.automation.apple-events": true
        });
    });

    it("DO NOT sandbox the app — a sandboxed app cannot hold App Management", () => {
        // THE entitlement question this product turns on. There is NO entitlement
        // that grants the right to modify another application: App Management is
        // a user grant in System Settings, keyed to the signing identity. Adding
        // the sandbox would not tighten Subline, it would stop it working, and
        // no entitlement would bring it back.
        expect(entitlements("entitlements.mac.plist")["com.apple.security.app-sandbox"]).toBeUndefined();
        expect(entitlements("entitlements.mac.inherit.plist")["com.apple.security.app-sandbox"]).toBeUndefined();
    });

    it("do not disable library validation or allow DYLD injection", () => {
        const plist = entitlements("entitlements.mac.plist");
        // Subline edits another application's bundle. An entitlement that lets a
        // library be injected into THIS process is worth more to an attacker here
        // than in almost any other app, and nothing we ship needs either.
        expect(plist["com.apple.security.cs.disable-library-validation"]).toBeUndefined();
        expect(plist["com.apple.security.cs.allow-dyld-environment-variables"]).toBeUndefined();
    });

    it("keep Apple events away from the child processes that inherit", () => {
        const inherit = entitlements("entitlements.mac.inherit.plist");
        expect(inherit["com.apple.security.inherit"]).toBe(true);
        // The renderer runs with `sandbox: true` and never sends Apple events;
        // only the main process runs osascript.
        expect(inherit["com.apple.security.automation.apple-events"]).toBeUndefined();
    });

    it("are valid property lists as far as the system's own parser is concerned", () => {
        for (const name of ["entitlements.mac.plist", "entitlements.mac.inherit.plist"]) {
            const path = join(INSTALLER_DIR, "packaging", name);
            // A malformed plist is not a build error — codesign takes the file and
            // the entitlements silently come out wrong.
            const printed = execFileSync("/usr/bin/plutil", ["-lint", path], { encoding: "utf8" });
            expect(printed).toContain("OK");
        }
    });
});

describe("Windows packaging", () => {
    it("produces an NSIS installer for x64", () => {
        const target = config.win.target.find(entry => entry.target === "nsis");
        expect(target?.arch).toEqual(["x64"]);
    });

    it("is unsigned, with no certificate committed anywhere", () => {
        // Deliberate, per spec §1 and §10 — and a certificate is added by setting
        // CSC_LINK/CSC_KEY_PASSWORD, with no edit to the config at all.
        expect(config.win.certificateFile).toBeUndefined();
        expect(config.win.certificateSubjectName).toBeUndefined();
        expect(config.win.certificatePassword).toBeUndefined();
    });

    it("never asks for elevation — Discord is per-user on Windows (§5)", () => {
        const { nsis } = config;
        expect(nsis.perMachine).toBe(false);
        expect(nsis.allowElevation).toBe(false);
        // An unsigned installer that also demands admin is close to a textbook
        // Defender heuristic, which §10 names as the one thing that changes the
        // Windows plan.
        expect(nsis.oneClick).toBe(false);
    });
});

describe("the release script", () => {
    it("exists and is what `pnpm release` runs", () => {
        expect(packageJson().scripts.release).toBe("node scripts/release.mjs");
        expect(existsSync(join(INSTALLER_DIR, "scripts", "release.mjs"))).toBe(true);
    });

    it("marks the steps that need the user's credentials, and does not publish", () => {
        const source = readFileSync(join(INSTALLER_DIR, "scripts", "release.mjs"), "utf8");
        expect(source).toContain("[SIGNING]");
        expect(source).toContain("[NOTARIZING]");
        // It PRINTS `gh release create`; it never runs it.
        expect(source).toContain("gh release create");
        expect(source).not.toMatch(/sh\("gh"/);
    });

    it("refuses to build a release that would not be notarized", () => {
        const source = readFileSync(join(INSTALLER_DIR, "scripts", "release.mjs"), "utf8");
        expect(source).toContain("isNotarizationRequested");
    });
});

/* ------------------------------------------------------------------------ *
 * Notarization — commands constructed, never run
 * ------------------------------------------------------------------------ */

describe("notarization", () => {
    /** Every call is recorded and nothing is executed. No test here runs xcrun. */
    function recorder() {
        const calls: Array<{ file: string; args: string[] }> = [];
        return {
            calls,
            exec: async (file: string, args: readonly string[]) => { calls.push({ file, args: [...args] }); }
        };
    }

    const NOTARIZE: NodeJS.ProcessEnv = { SUBLINE_NOTARIZE: "1", APPLE_KEYCHAIN_PROFILE: "subline-notary" };

    it("does nothing at all on a local build", async () => {
        const { calls, exec } = recorder();
        const outcome = await notarizeAndStaple({ path: "/x/Subline.app", env: {}, exec });

        expect(outcome.status).toBe("skipped");
        expect(outcome.reason).toContain("SUBLINE_NOTARIZE");
        expect(calls).toEqual([]);
    });

    it("REFUSES when it was asked to notarize and there is no credential", async () => {
        const { calls, exec } = recorder();
        // Silently skipping here is how a release goes out unnotarized, which is
        // invisible until a stranger downloads it.
        await expect(notarizeAndStaple({ path: "/x/Subline.app", env: { SUBLINE_NOTARIZE: "1" }, exec }))
            .rejects.toThrow(/APPLE_KEYCHAIN_PROFILE/);
        expect(calls).toEqual([]);
    });

    it("archives a .app first, because notarytool will not take a bundle", async () => {
        const { calls, exec } = recorder();
        const removed: string[] = [];
        const outcome = await notarizeAndStaple({
            path: "/x/Subline.app",
            env: NOTARIZE,
            exec,
            archivePathFor: app => `${app}.zip`,
            cleanup: archive => { removed.push(archive); }
        });

        expect(outcome.status).toBe("notarized");
        expect(calls.map(call => call.file)).toEqual(["/usr/bin/ditto", "/usr/bin/xcrun", "/usr/bin/xcrun"]);
        expect(calls[0]?.args).toEqual(["-c", "-k", "--sequesterRsrc", "--keepParent", "/x/Subline.app", "/x/Subline.app.zip"]);
        // Submitted: the archive. Stapled: the app itself — the ticket has to
        // travel with the thing the user opens.
        expect(calls[1]?.args).toContain("/x/Subline.app.zip");
        expect(calls[2]?.args).toEqual(["stapler", "staple", "/x/Subline.app"]);
        expect(removed).toEqual(["/x/Subline.app.zip"]);
    });

    it("submits a .dmg as it is", async () => {
        const { calls, exec } = recorder();
        await notarizeAndStaple({ path: "/x/Subline.dmg", env: NOTARIZE, exec });

        expect(calls.map(call => call.file)).toEqual(["/usr/bin/xcrun", "/usr/bin/xcrun"]);
        expect(calls[0]?.args).toEqual([
            "notarytool", "submit", "/x/Subline.dmg", "--wait", "--keychain-profile", "subline-notary"
        ]);
    });

    it("always waits, because stapling a ticket that has not been issued fails obscurely", async () => {
        expect(notarytoolArgs("/x/a.dmg", { kind: "keychain-profile", profile: "p" })).toContain("--wait");
    });

    it("prefers the credential form that leaks least", () => {
        const all: NodeJS.ProcessEnv = {
            APPLE_KEYCHAIN_PROFILE: "p",
            APPLE_API_KEY_ID: "k", APPLE_API_ISSUER: "i", APPLE_API_KEY: "/key.p8",
            APPLE_ID: "a@b.c", APPLE_APP_SPECIFIC_PASSWORD: "pw", APPLE_TEAM_ID: "T"
        };
        // A keychain profile passes only a NAME; an API key passes a path; an
        // Apple ID puts the password in argv where `ps` can read it.
        expect(readNotarizeAuth(all).auth?.kind).toBe("keychain-profile");

        const withoutProfile: NodeJS.ProcessEnv = { ...all };
        delete withoutProfile.APPLE_KEYCHAIN_PROFILE;
        expect(readNotarizeAuth(withoutProfile).auth?.kind).toBe("api-key");

        expect(readNotarizeAuth({
            APPLE_ID: "a@b.c", APPLE_APP_SPECIFIC_PASSWORD: "pw", APPLE_TEAM_ID: "T"
        }).auth?.kind).toBe("apple-id");
    });

    it("treats a blank variable as absent rather than as a credential", () => {
        expect(readNotarizeAuth({ APPLE_KEYCHAIN_PROFILE: "   " }).auth).toBeNull();
        // A half-set Apple ID triple is not a credential either.
        expect(readNotarizeAuth({ APPLE_ID: "a@b.c", APPLE_TEAM_ID: "T" }).auth).toBeNull();
    });

    it("names every variable it looked for when it found none", () => {
        const { missing } = readNotarizeAuth({});
        expect(missing).toContain("APPLE_KEYCHAIN_PROFILE");
        expect(missing).toContain("APPLE_API_KEY_ID");
        expect(missing).toContain("APPLE_APP_SPECIFIC_PASSWORD");
    });

    it("removes the submission archive even when the submission failed", async () => {
        const removed: string[] = [];
        await expect(notarizeAndStaple({
            path: "/x/Subline.app",
            env: NOTARIZE,
            exec: async (file: string) => { if (file === "/usr/bin/xcrun") throw new Error("Apple said no"); },
            archivePathFor: app => `${app}.zip`,
            cleanup: archive => { removed.push(archive); }
        })).rejects.toThrow(/Apple said no/);
        // Otherwise a retry staples yesterday's zip.
        expect(removed).toEqual(["/x/Subline.app.zip"]);
    });

    it("only notarizes when the flag is exactly on", () => {
        expect(isNotarizationRequested({ SUBLINE_NOTARIZE: "1" })).toBe(true);
        expect(isNotarizationRequested({ SUBLINE_NOTARIZE: "true" })).toBe(true);
        expect(isNotarizationRequested({ SUBLINE_NOTARIZE: "0" })).toBe(false);
        expect(isNotarizationRequested({})).toBe(false);
    });
});

describe("the NSIS CRC repair hook", () => {
    // On macOS electron-builder cannot execute the 32-bit NSIS stub that
    // writes the uninstaller with a correct checksum; it byte-slices instead
    // (UninstallerReader), and the result failed Windows' integrity check on
    // three consecutive real installs. packaging/fixNsisCrc.cjs recomputes the
    // checksum in the signing hook, which runs on the uninstaller right before
    // it is embedded. These pin the wiring and the algorithm.
    it("is wired as the win signing hook", async () => {
        const config = (await import("../electron-builder.js")).default;
        expect(config.win?.sign).toBe("./packaging/fixNsisCrc.cjs");
    });

    it("repairs a mismatched checksum and leaves a correct one alone", async () => {
        const { default: fix } = await import("../packaging/fixNsisCrc.cjs");
        const zlib = await import("node:zlib");
        const dir = mkdtempSync(join(tmpdir(), "subline-crc-"));
        try {
            // A minimal NSIS-shaped file matching everything the hardened hook
            // validates: a PE header with an empty security directory, the NSIS
            // signature at a 512-aligned firstheader, loafd covering the
            // overlay, CRC at fhOffset+loafd-4.
            const bytes = Buffer.alloc(1024, 7);
            bytes.write("MZ", 0, "ascii");
            bytes.writeUInt32LE(0x80, 0x3c);              // e_lfanew
            bytes.write("PE\0\0", 0x80, "ascii");
            bytes.writeUInt16LE(0x10b, 0x80 + 24);        // PE32 optional header
            bytes.writeUInt32LE(0, 0x80 + 24 + 128);      // security dir RVA
            bytes.writeUInt32LE(0, 0x80 + 24 + 132);      // security dir size
            Buffer.from("EFBEADDE4E756C6C736F6674496E7374", "hex").copy(bytes, 516); // fhOffset = 512
            bytes.writeUInt32LE(100, 512 + 20);           // length_of_header (arbitrary)
            bytes.writeUInt32LE(512, 512 + 24);           // loafd at fh+24: overlay is 512 bytes -> CRC at 1020, ends at EOF
            const right = zlib.crc32(bytes.subarray(512, 1020)) >>> 0;
            bytes.writeUInt32LE((right ^ 0xdeadbeef) >>> 0, 1020); // wrong on purpose

            const path = join(dir, "broken.exe");
            writeFileSync(path, bytes);
            await fix({ path });
            expect(readFileSync(path).readUInt32LE(1020)).toBe(right);

            // Already-correct file: byte-identical after the hook.
            const okPath = join(dir, "ok.exe");
            bytes.writeUInt32LE(right, 1020);
            writeFileSync(okPath, bytes);
            const before = readFileSync(okPath);
            await fix({ path: okPath });
            expect(readFileSync(okPath).equals(before)).toBe(true);

            // Signed exe (nonzero security directory): untouched even with a
            // wrong CRC - never risk clobbering a signature.
            const signedPath = join(dir, "signed.exe");
            bytes.writeUInt32LE(0x9000, 0x80 + 24 + 128);
            bytes.writeUInt32LE(0x100, 0x80 + 24 + 132);
            bytes.writeUInt32LE((right ^ 0x1234) >>> 0, 1020);
            writeFileSync(signedPath, bytes);
            const beforeSigned = readFileSync(signedPath);
            await fix({ path: signedPath });
            expect(readFileSync(signedPath).equals(beforeSigned)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("the stylesheet parses to the end", () => {
    // Two hand-lost braces (a keyframes block at line 200, a media query at
    // line 227) silently swallowed every rule after them, which is why the
    // setup screens shipped unstyled through an entire design pass: the CSS
    // was present, and the browser never saw it. Brace balance is not full
    // CSS validity, but it is exactly the failure class that happened.
    it("design.css braces balance", () => {
        const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "design.css"), "utf8");
        let depth = 0;
        for (const ch of css) {
            if (ch === "{") depth++;
            if (ch === "}") depth--;
        }
        expect(depth).toBe(0);
    });

    it("app.css braces balance", () => {
        const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "app.css"), "utf8");
        let depth = 0;
        for (const ch of css) {
            if (ch === "{") depth++;
            if (ch === "}") depth--;
        }
        expect(depth).toBe(0);
    });
});

describe("the shortcut-ensure macro", () => {
    // Root-caused 2026-09-03: with allowToChangeInstallationDirectory:false,
    // electron-builder's assisted installer NEVER recreates a Start Menu
    // shortcut once HKCU\Software\<APP_GUID> says KeepShortcuts=true - the
    // keep-path only renames an existing .lnk. Delete the .lnk out-of-band
    // and every future install silently produces an app invisible to the
    // Start Menu and Windows Search. customInstall runs after the template's
    // addStartMenuLink with $newStartMenuLink in scope and recreates it when
    // missing. This pins the macro's presence and its load-bearing parts.
    it("is present in installer.nsh and recreates a missing link", () => {
        const nsh = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "packaging", "installer.nsh"), "utf8");
        expect(nsh).toContain("!macro customInstall");
        expect(nsh).toContain('${ifNot} ${FileExists} "$newStartMenuLink"');
        expect(nsh).toContain('CreateShortCut "$newStartMenuLink" "$appExe"');
        expect(nsh).toContain("WinShell::SetLnkAUMI");
    });
});
