/**
 * Temp-directory Discord fixtures.
 *
 * These mirror the layout of the real `/Applications/Discord.app` observed on
 * this machine — `Contents/Resources/{app.asar,_app.asar,build_info.json}` —
 * so the patcher runs against real files with real renames. Nothing here ever
 * touches `/Applications`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    digestEntries,
    manifestPathFor,
    MOD_MANIFEST_FORMAT,
    renderManifest,
    SOURCE_NOTICE_NAME
} from "../src/bundle/spec.js";
import { buildAsar } from "../src/patcher/asar.js";
import type { DiscordInstall } from "../src/patcher/locate.js";
import { buildStubAsar } from "../src/patcher/stub.js";

/** Exactly the fields the real build_info.json carries. */
export const FIXTURE_BUILD_INFO = {
    releaseChannel: "stable",
    sentryDist: "stable-osx-universal",
    sentryRelease: "discord-desktop-a5f122cee6cc2c2ac2ab98888187e190cbf3d7b1",
    version: "0.0.406"
};

/**
 * A stand-in for Discord's 3.6 MB archive. Same top-level entry names as the
 * real `_app.asar` (`bundle.js`, `package.json`, `splashScreenPreload.js`), so
 * stub-vs-original detection is exercised on realistic shapes rather than on
 * "big file / small file".
 */
export function buildOriginalDiscordAsar(marker = "original"): Buffer {
    return buildAsar([
        { name: "bundle.js", content: Buffer.from(`// discord bundle ${marker}\n${"x".repeat(4096)}`, "utf8") },
        { name: "package.json", content: Buffer.from(JSON.stringify({ name: "discord", main: "bundle.js" }), "utf8") },
        { name: "splashScreenPreload.js", content: Buffer.from("// splash\n", "utf8") }
    ]);
}

export interface FixtureOptions {
    appName?: string;
    /** Omit `app.asar` entirely (the interrupted-patch case). */
    withoutAsar?: boolean;
    /** Write `_app.asar` as well. */
    withBackup?: boolean;
    /** Replace `app.asar` with a loader stub requiring this path. */
    stubLoaderPath?: string;
    /** Create the BetterDiscord-style unpacked `resources/app` directory. */
    withUnpackedAppDir?: boolean;
    /** Omit `build_info.json`. */
    withoutBuildInfo?: boolean;
    buildInfo?: unknown;
}

export interface Fixture {
    /** The mkdtemp root; treat as the stand-in for `/Applications`. */
    root: string;
    install: DiscordInstall;
    /** Bytes of the original archive written into this fixture. */
    originalAsar: Buffer;
    cleanup(): void;
}

export function makeDiscordFixture(options: FixtureOptions = {}): Fixture {
    const root = mkdtempSync(join(tmpdir(), "subline-fixture-"));
    const appName = options.appName ?? "Discord.app";
    const rootPath = join(root, appName);
    const resourcesPath = join(rootPath, "Contents", "Resources");
    mkdirSync(resourcesPath, { recursive: true });

    const install: DiscordInstall = {
        branch: "stable",
        rootPath,
        resourcesPath,
        asarPath: join(resourcesPath, "app.asar"),
        backupPath: join(resourcesPath, "_app.asar"),
        buildInfoPath: join(resourcesPath, "build_info.json"),
        fromExplicitPath: false
    };

    const originalAsar = buildOriginalDiscordAsar();

    if (!options.withoutAsar) {
        if (options.stubLoaderPath) {
            writeFileSync(install.asarPath, buildStubAsar(options.stubLoaderPath));
        } else {
            writeFileSync(install.asarPath, originalAsar);
        }
    }
    if (options.withBackup) {
        writeFileSync(install.backupPath, originalAsar);
    }
    if (options.withUnpackedAppDir) {
        const appDir = join(resourcesPath, "app");
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "index.js"), 'require("/Users/x/Library/Application Support/BetterDiscord/data/betterdiscord.asar")');
        writeFileSync(join(appDir, "package.json"), '{"name":"discord","main":"index.js"}');
    }
    if (!options.withoutBuildInfo) {
        writeFileSync(install.buildInfoPath, JSON.stringify(options.buildInfo ?? FIXTURE_BUILD_INFO, null, 2));
    }

    return {
        root,
        install,
        originalAsar,
        cleanup: () => rmSync(root, { recursive: true, force: true })
    };
}

export function readBytes(path: string): Buffer {
    return readFileSync(path);
}

/* ------------------------------------------------------------------------ *
 * Mod bundle fixtures
 * ------------------------------------------------------------------------ */

/**
 * Modelled on a real `pnpm build` of Vencord 1.15.0, inspected at
 * `/Users/surfer/dev/Vencord/dist`: the names are that build's names and the
 * proportions are that build's proportions —
 *
 *   patcher.js     52,220 B    preload.js      2,401 B
 *   renderer.js   760,013 B    renderer.css   42,172 B
 *
 * — because a fixture invented to look plausible would let the entry-point
 * checks pass against a layout the real build never produces. The sizes here
 * are ~10× smaller so the tests stay fast, but every one still clears the
 * minimum `REQUIRED_ENTRIES` demands.
 *
 * The one property that matters most: `renderer.js` CONTAINS the build id,
 * exactly as the real one does (esbuild inlines `BUILD_ID` from the plugin's
 * `buildStamp.ts`, and only into the renderer — the main-process bundle never
 * states an identity of its own).
 */
export const FIXTURE_VENCORD_COMMIT = "1a8c3b71bbfaeb195a7f402458b6b68b0ccea7ef";
export const FIXTURE_VENCORD_REPOSITORY = "https://github.com/Vendicated/Vencord.git";
export const FIXTURE_VENCORD_VERSION = "1.15.0";

export interface ModBundleOptions {
    buildId?: string;
    pluginVersion?: string;
    /** Write this into `renderer.js` instead of `buildId` — a bundle that lies about itself. */
    stampedBuildId?: string;
    vencordCommit?: string;
    vencordRepository?: string;
    vencordVersion?: string;
}

export interface ModBundleFixture {
    dir: string;
    /** What the stub will `require()` — `<dir>/patcher.js`. */
    loaderPath: string;
    buildId: string;
    /** Rewrite the artefacts and the manifest, as the helper does when it self-updates in place. */
    rebuild(options?: ModBundleOptions): void;
    /** Re-derive the manifest's digests from whatever is on disk right now. */
    restamp(): void;
    cleanup(): void;
}

function filler(bytes: number, seed: string): string {
    const unit = `/*${seed}*/function _${seed}(a,b){return a+b}`;
    return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

function writeBundleFiles(dir: string, options: ModBundleOptions): { buildId: string } {
    const buildId = options.buildId ?? "1f2e3d4c5b6a7980";
    const stamped = options.stampedBuildId ?? buildId;
    const pluginVersion = options.pluginVersion ?? "0.1.0";

    writeFileSync(join(dir, "patcher.js"), `${filler(9_000, "patcher")}\nrequire("./renderer.js");\n`);
    writeFileSync(join(dir, "preload.js"), `${filler(900, "preload")}\n`);
    // The stamp, inlined the way esbuild inlines it.
    writeFileSync(
        join(dir, "renderer.js"),
        `var PLUGIN_VERSION="${pluginVersion}",BUILD_ID="${stamped}";\n${filler(70_000, "renderer")}\n`
    );
    writeFileSync(join(dir, "renderer.css"), `.vc-translate{color:red}\n${filler(5_000, "css")}\n`);
    writeFileSync(join(dir, "patcher.js.LEGAL.txt"), "/*! third-party notices */\n");
    writeFileSync(join(dir, "renderer.js.LEGAL.txt"), "/*! third-party notices */\n");
    writeFileSync(join(dir, "LICENSE"), "GNU GENERAL PUBLIC LICENSE Version 3\n");
    writeFileSync(
        join(dir, SOURCE_NOTICE_NAME),
        "Subline mod bundle — corresponding source\n"
        + `Vencord commit ${options.vencordCommit ?? FIXTURE_VENCORD_COMMIT}\n`
        + `vcTranslate build ${buildId}\nThe complete corresponding source is that repository at that commit.\n`
    );

    return { buildId };
}

function writeBundleManifest(dir: string, buildId: string, options: ModBundleOptions): void {
    writeFileSync(
        manifestPathFor(dir),
        renderManifest({
            format: MOD_MANIFEST_FORMAT,
            product: "subline",
            buildId,
            pluginVersion: options.pluginVersion ?? "0.1.0",
            vencord: {
                repository: options.vencordRepository ?? FIXTURE_VENCORD_REPOSITORY,
                commit: options.vencordCommit ?? FIXTURE_VENCORD_COMMIT,
                version: options.vencordVersion ?? FIXTURE_VENCORD_VERSION
            },
            builtAt: "2026-08-06T12:00:00.000Z",
            entries: digestEntries(dir)
        }),
        "utf8"
    );
}

export function makeModBundleFixture(options: ModBundleOptions = {}): ModBundleFixture {
    const dir = mkdtempSync(join(tmpdir(), "subline-mod-"));
    let current = options;
    const { buildId } = writeBundleFiles(dir, current);
    writeBundleManifest(dir, buildId, current);

    const fixture: ModBundleFixture = {
        dir,
        loaderPath: join(dir, "patcher.js"),
        buildId,
        rebuild(next: ModBundleOptions = {}) {
            current = { ...current, ...next };
            const rebuilt = writeBundleFiles(dir, current);
            writeBundleManifest(dir, rebuilt.buildId, current);
            fixture.buildId = rebuilt.buildId;
        },
        restamp() {
            writeBundleManifest(dir, fixture.buildId, current);
        },
        cleanup: () => rmSync(dir, { recursive: true, force: true })
    };
    return fixture;
}
