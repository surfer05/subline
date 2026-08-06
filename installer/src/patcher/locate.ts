/**
 * Finding Discord installations.
 *
 * Spec §10 fixes v1 at Stable only, so `DEFAULT_BRANCHES` is `["stable"]`.
 * The branch table below already carries PTB and Canary: enabling them is a
 * one-line change to the default list, not a redesign.
 *
 * Windows (spec §5) is structurally different — `%LOCALAPPDATA%\Discord\
 * app-1.0.xxxx\` with a *new* directory per update — so the layout of an
 * install is computed by a per-platform function rather than assumed.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Result } from "./result.js";
import { err, ok } from "./result.js";

export type DiscordBranch = "stable" | "ptb" | "canary";

export interface BranchDefinition {
    branch: DiscordBranch;
    /** macOS application bundle name. */
    macAppName: string;
    /** Windows directory under %LOCALAPPDATA%. */
    windowsDirName: string;
}

export const BRANCHES: readonly BranchDefinition[] = [
    { branch: "stable", macAppName: "Discord.app", windowsDirName: "Discord" },
    { branch: "ptb", macAppName: "Discord PTB.app", windowsDirName: "DiscordPTB" },
    { branch: "canary", macAppName: "Discord Canary.app", windowsDirName: "DiscordCanary" }
];

/** Spec §10: Stable only for v1. */
export const DEFAULT_BRANCHES: readonly DiscordBranch[] = ["stable"];

export interface DiscordInstall {
    branch: DiscordBranch;
    /** The thing a user would point at: `/Applications/Discord.app`, or the versioned folder on Windows. */
    rootPath: string;
    /** Directory holding `app.asar` — `Contents/Resources` on macOS, `resources` on Windows. */
    resourcesPath: string;
    /** The patch target. */
    asarPath: string;
    /** Where the original is preserved. */
    backupPath: string;
    buildInfoPath: string;
    /** True when the branch was inferred from an explicitly supplied path. */
    fromExplicitPath: boolean;
}

export type SupportedPlatform = "darwin" | "win32";

export interface LocateOptions {
    /** Defaults to `process.platform`. */
    platform?: NodeJS.Platform;
    /** Directories to scan for app bundles. Defaults to the platform's standard roots. */
    searchRoots?: readonly string[];
    /** Paths the user picked by hand (spec §7: "Discord installed somewhere unusual"). */
    explicitPaths?: readonly string[];
    branches?: readonly DiscordBranch[];
}

/** The standard places Discord lands, per platform. */
export function defaultSearchRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string[] {
    if (platform === "darwin") {
        return ["/Applications", join(homedir(), "Applications")];
    }
    if (platform === "win32") {
        const localAppData = env.LOCALAPPDATA;
        return localAppData ? [localAppData] : [];
    }
    return [];
}

/** Where `app.asar` lives inside a given install root. */
export function resourcesDirFor(rootPath: string, platform: NodeJS.Platform): string {
    return platform === "darwin" ? join(rootPath, "Contents", "Resources") : join(rootPath, "resources");
}

function makeInstall(
    branch: DiscordBranch,
    rootPath: string,
    platform: NodeJS.Platform,
    fromExplicitPath: boolean
): DiscordInstall {
    const resourcesPath = resourcesDirFor(rootPath, platform);
    return {
        branch,
        rootPath,
        resourcesPath,
        asarPath: join(resourcesPath, "app.asar"),
        backupPath: join(resourcesPath, "_app.asar"),
        buildInfoPath: join(resourcesPath, "build_info.json"),
        fromExplicitPath
    };
}

/**
 * A candidate counts as Discord when its resources directory exists and holds
 * either `app.asar` or the preserved `_app.asar`. Accepting a lone `_app.asar`
 * is deliberate: that is exactly the half-patched install we must still be able
 * to find in order to repair it.
 */
function looksLikeDiscord(install: DiscordInstall): boolean {
    if (!existsSync(install.resourcesPath)) return false;
    return existsSync(install.asarPath) || existsSync(install.backupPath);
}

/** Windows keeps Discord in `app-1.0.xxxx`; the newest one is the live install (spec §5). */
export function findWindowsAppDirs(branchDir: string): string[] {
    let entries: string[];
    try {
        entries = readdirSync(branchDir);
    } catch {
        return [];
    }
    const versioned = entries
        .filter(name => name.startsWith("app-"))
        .map(name => ({ name, version: name.slice("app-".length) }))
        .filter(item => /^[\d.]+$/.test(item.version));

    versioned.sort((a, b) => compareVersions(b.version, a.version));
    return versioned.map(item => join(branchDir, item.name));
}

function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Locate every Discord install we can see.
 *
 * Returns `DISCORD_NOT_FOUND` rather than an empty list, because "not
 * installed" is a screen the GUI has to render (spec §3 step 3), not an
 * ordinary empty result.
 */
export function locateDiscordInstalls(options: LocateOptions = {}): Result<DiscordInstall[]> {
    const platform = options.platform ?? process.platform;
    const branches = options.branches ?? DEFAULT_BRANCHES;
    const roots = options.searchRoots ?? defaultSearchRoots(platform);

    const found: DiscordInstall[] = [];
    const seen = new Set<string>();

    const add = (install: DiscordInstall): void => {
        const key = canonicalKey(install.rootPath);
        if (seen.has(key)) return;
        seen.add(key);
        found.push(install);
    };

    for (const explicit of options.explicitPaths ?? []) {
        const install = describeExplicitPath(explicit, platform, branches);
        if (!install.ok) return install as Result<DiscordInstall[]>;
        add(install.value);
    }

    for (const root of roots) {
        if (!existsSync(root)) continue;
        for (const definition of BRANCHES) {
            if (!branches.includes(definition.branch)) continue;

            if (platform === "darwin") {
                const candidate = join(root, definition.macAppName);
                if (!isDirectory(candidate)) continue;
                const install = makeInstall(definition.branch, candidate, platform, false);
                if (looksLikeDiscord(install)) add(install);
            } else if (platform === "win32") {
                const branchDir = join(root, definition.windowsDirName);
                if (!isDirectory(branchDir)) continue;
                for (const appDir of findWindowsAppDirs(branchDir)) {
                    const install = makeInstall(definition.branch, appDir, platform, false);
                    if (looksLikeDiscord(install)) add(install);
                }
            }
        }
    }

    if (found.length === 0) {
        return err<DiscordInstall[]>(
            "DISCORD_NOT_FOUND",
            "No Discord installation was found. If Discord is installed somewhere unusual, choose its location manually.",
            { path: roots.join(", ") }
        );
    }
    return ok(found);
}

function describeExplicitPath(
    rootPath: string,
    platform: NodeJS.Platform,
    branches: readonly DiscordBranch[]
): Result<DiscordInstall> {
    if (!isDirectory(rootPath)) {
        return err<DiscordInstall>("NOT_A_DISCORD_INSTALL", `${rootPath} is not a folder we can read.`, {
            path: rootPath
        });
    }
    const branch = branchFromPath(rootPath, platform) ?? branches[0] ?? "stable";
    const install = makeInstall(branch, rootPath, platform, true);
    if (!looksLikeDiscord(install)) {
        return err<DiscordInstall>(
            "NOT_A_DISCORD_INSTALL",
            `${rootPath} does not look like a Discord installation (no app.asar under ${install.resourcesPath}).`,
            { path: rootPath }
        );
    }
    return ok(install);
}

/** Best-effort branch inference for a hand-picked path; falls back to the caller's default. */
export function branchFromPath(rootPath: string, platform: NodeJS.Platform): DiscordBranch | null {
    const lower = rootPath.toLowerCase();
    for (const definition of BRANCHES) {
        const needle = (platform === "darwin" ? definition.macAppName : definition.windowsDirName).toLowerCase();
        if (definition.branch !== "stable" && lower.includes(needle)) return definition.branch;
    }
    const stable = platform === "darwin" ? "discord.app" : "discord";
    return lower.includes(stable) ? "stable" : null;
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** Dedupe key: symlinks and `/tmp` vs `/private/tmp` must not produce two hits. */
function canonicalKey(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}
