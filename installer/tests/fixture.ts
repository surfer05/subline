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
