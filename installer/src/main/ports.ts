/**
 * The real `FlowPorts` — where the pure state machine meets the operating
 * system.
 *
 * Everything Electron-, process- or filesystem-specific lives here, and nothing
 * here makes a decision. That split is what lets `flow.ts` be exercised entirely
 * in tests: this file is the only part that needs a Mac with a Discord on it,
 * and it is deliberately the thinnest part.
 *
 * It imports NOTHING from `electron`. The main process passes in the two paths
 * it alone knows (where the app's resources are, and its version), so this
 * module — and therefore every port the flow uses — is constructible and
 * runnable from a plain Node process, which is how the ports get tested at all.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { APP_MANAGEMENT_SETTINGS_URL, probeAppManagement } from "../app/appManagement.js";
import type { FlowLogger, FlowPorts, HelperInstallOutcome } from "../app/flow.js";
import type { HelperRemoval } from "../app/uninstall.js";
import {
    defaultLanguage,
    discordSettingsPathFor,
    readDiscordLocale,
    setTargetLanguage,
    vencordSettingsPathFor
} from "../app/language.js";
import { parsePsOutput, processNameFor } from "../app/discordProcess.js";
import type { RunningProcess } from "../app/discordProcess.js";
import { installModBundle, shippedModDirFor } from "../app/modInstall.js";
import { inspectModBundle } from "../bundle/bundle.js";
import {
    HELPER_LABEL, helperLaunchAgentSpec, installLaunchAgent, launchAgentPlistPath, removeLaunchAgent
} from "../helper/launchAgent.js";
import type { LaunchctlPort } from "../helper/launchAgent.js";
import { modBundleDirFor, productDirFor } from "../bundle/layout.js";
import { locateDiscordInstalls } from "../patcher/locate.js";
import type { DiscordBranch, DiscordInstall } from "../patcher/locate.js";
import { patchInstall } from "../patcher/patch.js";
import { err, ok } from "../patcher/result.js";
import type { Result } from "../patcher/result.js";
import { inspectInstall } from "../patcher/state.js";
import { awaitVerification } from "../verify/verify.js";

const run = promisify(execFile);

export interface RealPortsOptions {
    /** The packaged app's `Contents/Resources`, where the shipped mod bundle sits. */
    appResourcesPath: string;
    productVersion: string;
    log: FlowLogger;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    /**
     * Where to look for Discord. Defaults to the platform's standard roots.
     * Overridable so the integration tests can point at a temp-directory
     * Discord — nothing in this project's tests may write to `/Applications`.
     */
    searchRoots?: readonly string[];
    /** Injected by tests so no child process is spawned. */
    exec?: (file: string, args: string[]) => Promise<{ stdout: string }>;
    /**
     * Everything the background helper's registration needs (§3 step 8b).
     *
     * REQUIRED, deliberately. The reason this task exists at all is that
     * `helper:install` was wired to IPC and to nothing else, so a real install
     * silently got no helper — and spec §6 says a product with no helper dies
     * quietly the first time Discord rewrites its frontend. An optional field
     * here would rebuild exactly that hole: it would default to a no-op, every
     * test would pass, and the shipped installer would register nothing.
     */
    helper: HelperWiring;
}

export interface HelperWiring {
    /**
     * The `.app` Subline is running from — NOT its executable.
     * `helperLaunchAgentSpec` appends `Contents/MacOS/<name>` itself, because the
     * agent has to run THIS bundle: macOS TCC grants attach to a code-signing
     * identity, and the App Management permission the user granted during install
     * is the one that lets the helper write inside `Discord.app` (spec §2).
     */
    appPath: string;
    uid: number;
    launchctl: LaunchctlPort;
    intervalSeconds?: number;
    /** The executable inside the bundle. Must match electron-builder's `productName`. */
    executableName?: string;
}

/**
 * Register the LaunchAgent, or say honestly that there is nothing to register.
 *
 * Windows returns `applicable: false` rather than an error: spec §5's Scheduled
 * Task is not built, and a named failure on a platform that never had the feature
 * would put a warning screen in front of every Windows user for something that is
 * not wrong with their machine.
 */
export async function installHelperFor(
    wiring: HelperWiring,
    platform: NodeJS.Platform = process.platform,
    home: string = homedir()
): Promise<Result<HelperInstallOutcome>> {
    if (platform !== "darwin") {
        return ok({ applicable: false, installed: false, label: null, path: null });
    }
    const registered = await installLaunchAgent({
        plistPath: launchAgentPlistPath(home),
        spec: helperLaunchAgentSpec(wiring.appPath, wiring.intervalSeconds, wiring.executableName),
        uid: wiring.uid,
        launchctl: wiring.launchctl,
        platform
    });
    if (!registered.ok) return registered as Result<HelperInstallOutcome>;
    return ok({
        applicable: true,
        // `loaded` is `launchctl print` AFTER the bootstrap, not the bootstrap's
        // own exit code. See `launchAgent.ts`: a registration that silently did
        // not happen is indistinguishable later from a helper with nothing to do.
        installed: registered.value.loaded,
        label: registered.value.label,
        path: registered.value.plistPath
    });
}

/**
 * Unregister it — §8 step 3, and `uninstall`'s required precondition.
 *
 * Returns the `HelperRemoval` shape `uninstall` demands rather than a raw result,
 * so the one caller that has to get this ordering right cannot assemble it
 * wrongly. `uninstall.ts` explains what a forgotten ordering costs: Discord
 * restored under a live agent is put straight back at the next interval.
 */
export async function removeHelperFor(
    wiring: Pick<HelperWiring, "uid" | "launchctl">,
    platform: NodeJS.Platform = process.platform,
    home: string = homedir()
): Promise<HelperRemoval> {
    if (platform !== "darwin") return { applicable: false, removed: false, error: null };
    const removed = await removeLaunchAgent({
        plistPath: launchAgentPlistPath(home),
        label: HELPER_LABEL,
        uid: wiring.uid,
        launchctl: wiring.launchctl
    });
    return {
        applicable: true,
        removed: removed.ok && removed.value,
        error: removed.ok ? null : removed.error
    };
}

/** `ps` on macOS, `tasklist` on Windows, parsed into the same shape. */
export async function listProcesses(
    platform: NodeJS.Platform,
    exec: (file: string, args: string[]) => Promise<{ stdout: string }>
): Promise<RunningProcess[]> {
    try {
        if (platform === "win32") {
            const { stdout } = await exec("tasklist", ["/FO", "CSV", "/NH"]);
            return parseTasklistCsv(stdout);
        }
        const { stdout } = await exec("/bin/ps", ["-axo", "pid=,comm="]);
        return parsePsOutput(stdout);
    } catch {
        // A process table we cannot read is not a reason to fail an install. The
        // caller's next step is to ask the user to quit Discord anyway, and an
        // empty list means "we saw nothing running" — which the patcher itself
        // will catch if it is wrong, because it verifies its write.
        return [];
    }
}

/** `"Discord.exe","1234","Console","1","300,000 K"` → one process. */
export function parseTasklistCsv(stdout: string): RunningProcess[] {
    const processes: RunningProcess[] = [];
    for (const line of stdout.split("\n")) {
        const fields = line.trim().match(/"([^"]*)"/g);
        if (fields === null || fields.length < 2) continue;
        const name = (fields[0] ?? "").slice(1, -1);
        const pid = Number((fields[1] ?? "").slice(1, -1));
        if (name.length === 0 || !Number.isFinite(pid)) continue;
        processes.push({ pid, command: name });
    }
    return processes;
}

/**
 * Ask Discord to quit. AppleScript on macOS, `taskkill` WITHOUT `/F` on Windows.
 *
 * Both are the polite request — the same thing as choosing Quit from the menu.
 * Neither sends a kill, and spec §7 says why: an installer that force-closes
 * Discord is one that loses whatever the user was typing.
 */
export async function requestQuit(
    branch: DiscordBranch,
    platform: NodeJS.Platform,
    exec: (file: string, args: string[]) => Promise<{ stdout: string }>
): Promise<void> {
    if (platform === "win32") {
        await exec("taskkill", ["/IM", processNameFor(branch, "win32")]);
        return;
    }
    const appName = branch === "stable" ? "Discord" : processNameFor(branch, "darwin");
    await exec("/usr/bin/osascript", ["-e", `tell application "${appName}" to quit`]);
}

/** Open a URL with the platform's handler — used only for the System Settings deep link. */
export async function openUrl(
    url: string,
    platform: NodeJS.Platform,
    exec: (file: string, args: string[]) => Promise<{ stdout: string }>
): Promise<void> {
    if (platform === "win32") await exec("cmd", ["/c", "start", "", url]);
    else await exec("/usr/bin/open", [url]);
}

async function launchDiscord(
    install: DiscordInstall,
    platform: NodeJS.Platform,
    exec: (file: string, args: string[]) => Promise<{ stdout: string }>
): Promise<Result<true>> {
    try {
        if (platform === "win32") {
            await exec("cmd", ["/c", "start", "", join(install.rootPath, processNameFor(install.branch, "win32"))]);
        } else {
            await exec("/usr/bin/open", ["-a", install.rootPath]);
        }
        return ok(true);
    } catch (cause) {
        return err<true>("IO_ERROR", "Subline could not start Discord for you.", {
            path: install.rootPath,
            cause
        });
    }
}

/** The system's own locale, for the language step's second-choice default. */
export function systemLocale(): string | null {
    try {
        return new Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
        return null;
    }
}

/**
 * Build the ports the flow runs on.
 *
 * Note where the mod bundle goes: `modBundleDirFor` — the per-user directory —
 * and NOT `appResourcesPath`. That is the whole point of `modInstall.ts`, and
 * getting it wrong would break Discord rather than break translation.
 */
export function createFlowPorts(options: RealPortsOptions): FlowPorts {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    const exec = options.exec ?? (async (file: string, args: string[]) => run(file, args));

    const shippedDir = shippedModDirFor(options.appResourcesPath);
    const runtimeDir = modBundleDirFor(platform, env, home);
    const vencordSettings = vencordSettingsPathFor(platform, env, home);

    return {
        platform,
        productVersion: options.productVersion,
        log: options.log,
        now: () => Date.now(),
        sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),

        inspectShippedBundle: () => inspectModBundle(shippedDir),
        installModBundle: () =>
            runtimeDir === null
                ? err("MOD_BUNDLE_INVALID", "Subline does not know where to install the mod on this platform.")
                : installModBundle({ sourceDir: shippedDir, destDir: runtimeDir }),

        locate: explicitPaths =>
            locateDiscordInstalls({
                platform,
                ...(options.searchRoots === undefined ? {} : { searchRoots: options.searchRoots }),
                ...(explicitPaths === undefined ? {} : { explicitPaths })
            }),
        inspect: install => inspectInstall(install),

        listProcesses: () => listProcesses(platform, exec),
        requestQuit: branch => requestQuit(branch, platform, exec),

        probePermission: install => probeAppManagement({ resourcesPath: install.resourcesPath, platform }),
        openPermissionSettings: () => openUrl(APP_MANAGEMENT_SETTINGS_URL, platform, exec),
        permissionSettingsUrl: APP_MANAGEMENT_SETTINGS_URL,

        discordLocale: () => readDiscordLocale(discordSettingsPathFor(platform, env, home)),
        systemLocale,
        setLanguage: code => setTargetLanguage(vencordSettings, code),

        patch: (install, patchOptions) =>
            patchInstall(install, {
                modBundleDir: patchOptions.modBundleDir,
                productVersion: options.productVersion,
                overwriteForeignMod: patchOptions.overwriteForeignMod
            }),
        installHelper: () => installHelperFor(options.helper, platform, home),
        launchDiscord: install => launchDiscord(install, platform, exec),
        // The same platform/env/home the mod bundle was installed with. Without
        // these, `readBeacon` falls back to the process defaults and looks for
        // the status file somewhere other than where this installation put it —
        // which, on a machine that already has a beacon, means verifying THIS
        // install against SOMEBODY ELSE'S status file.
        verify: verifyOptions => awaitVerification({ ...verifyOptions, platform, env, home })
    };
}

/** The paths §8's uninstall needs, resolved the same way the flow resolves them. */
export function uninstallPaths(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): { modBundleDir: string | null; productDir: string | null; vencordSettingsPath: string | null } {
    return {
        modBundleDir: modBundleDirFor(platform, env, home),
        productDir: productDirFor(platform, env, home),
        vencordSettingsPath: vencordSettingsPathFor(platform, env, home)
    };
}

/** Where the rotating diagnostics log lives (spec §4/§5 paths). */
export function logDirFor(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): string {
    if (platform === "darwin") return join(home, "Library", "Logs", "Subline");
    if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "Subline", "logs");
    return join(home, ".subline", "logs");
}

export function defaultLanguageFor(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): string {
    return defaultLanguage({
        discordLocale: readDiscordLocale(discordSettingsPathFor(platform, env, home)),
        systemLocale: systemLocale()
    });
}
