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

import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { APP_MANAGEMENT_SETTINGS_URL, probeAppManagement } from "../app/appManagement.js";
import type { FlowLogger, FlowPorts, HelperInstallOutcome } from "../app/flow.js";
import type { HelperRemoval } from "../app/uninstall.js";
import {
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
import { helperScheduledTaskSpec, installScheduledTask, removeScheduledTask } from "../helper/scheduledTask.js";
import type { SchtasksPort } from "../helper/scheduledTask.js";
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
    /**
     * Windows only: the full path to `Subline.exe`.
     *
     * Separate from `appPath` rather than derived from it, because the two are
     * not the same kind of thing — `appPath` is a bundle directory that macOS
     * appends an executable to, and there is no bundle on Windows. Deriving one
     * from the other means a regex that quietly yields a wrong-but-plausible
     * path on the platform it was not written for, and a scheduled task that
     * points at nothing fails silently at 3am rather than during an install.
     */
    executablePath?: string;
    /** Windows only. Registers and queries the Scheduled Task. */
    schtasks?: SchtasksPort;
    /** Windows only: a directory we own, for the task XML hand-off file. */
    workDir?: string;
}

/**
 * Register the background helper, or say honestly that there is nothing to
 * register.
 *
 * macOS gets a LaunchAgent, Windows a Scheduled Task; anything else gets
 * `applicable: false`, because a named failure on a platform that never had the
 * feature would put a warning screen in front of a user for something that is
 * not wrong with their machine. Windows used to take that branch too, which
 * meant every Windows install silently had no helper and stopped translating
 * the first time Discord updated itself into a new `app-1.0.xxxx` directory.
 */
export async function installHelperFor(
    wiring: HelperWiring,
    platform: NodeJS.Platform = process.platform,
    home: string = homedir()
): Promise<Result<HelperInstallOutcome>> {
    if (platform === "win32") return installWindowsHelper(wiring);
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
 * The Windows registration.
 *
 * Missing wiring is an ERROR, not `applicable: false`. "Not applicable" is the
 * honest answer on a platform with no such mechanism; on Windows the mechanism
 * exists, so a silent false here would recreate exactly the hole `helper` being
 * required was introduced to close — every test green, every install helperless,
 * and the symptom only appearing weeks later when Discord updates.
 */
async function installWindowsHelper(wiring: HelperWiring): Promise<Result<HelperInstallOutcome>> {
    if (wiring.schtasks === undefined || wiring.executablePath === undefined || wiring.workDir === undefined) {
        return err<HelperInstallOutcome>(
            "HELPER_REGISTRATION_FAILED",
            "Subline cannot set up background updates on this system: the scheduler is not available."
        );
    }
    const registered = await installScheduledTask({
        spec: helperScheduledTaskSpec(wiring.executablePath, wiring.intervalSeconds),
        workDir: wiring.workDir,
        schtasks: wiring.schtasks,
        platform: "win32"
    });
    if (!registered.ok) return registered as Result<HelperInstallOutcome>;
    return ok({
        applicable: true,
        // Queried back after creation, never the exit code. See `scheduledTask.ts`.
        installed: registered.value.registered,
        label: registered.value.name,
        path: registered.value.name
    });
}

/**
 * Unregister it — §8 step 3, and `uninstall`'s required precondition.
 *
 * Returns the `HelperRemoval` shape `uninstall` demands rather than a raw result,
 * so the one caller that has to get this ordering right cannot assemble it
 * wrongly. `uninstall.ts` explains what a forgotten ordering costs: Discord
 * restored under a live helper is put straight back at the next interval —
 * which is as true of a Scheduled Task as of a LaunchAgent.
 */
export async function removeHelperFor(
    wiring: Pick<HelperWiring, "uid" | "launchctl" | "schtasks">,
    platform: NodeJS.Platform = process.platform,
    home: string = homedir()
): Promise<HelperRemoval> {
    if (platform === "win32") {
        if (wiring.schtasks === undefined) return { applicable: false, removed: false, error: null };
        const gone = await removeScheduledTask({ schtasks: wiring.schtasks, platform });
        return {
            applicable: true,
            removed: gone.ok && gone.value,
            error: gone.ok ? null : gone.error
        };
    }
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
    exec: (file: string, args: string[]) => Promise<{ stdout: string }>,
    log?: FlowLogger
): Promise<RunningProcess[]> {
    try {
        if (platform === "win32") {
            const { stdout } = await exec("tasklist", ["/FO", "CSV", "/NH"]);
            return parseTasklistCsv(stdout);
        }
        const { stdout } = await exec("/bin/ps", ["-axo", "pid=,comm="]);
        return parsePsOutput(stdout);
    } catch (cause) {
        // A process table we cannot read is not a reason to fail an install. The
        // caller's next step is to ask the user to quit Discord anyway, and an
        // empty list means "we saw nothing running" — which the patcher itself
        // will catch if it is wrong, because it verifies its write.
        //
        // But it is logged, because an empty list is ALSO what a machine with no
        // Discord running produces. Patching underneath a live Discord and
        // "correctly saw nothing" would otherwise be one indistinguishable line
        // in the log, and on Windows the resulting sharing violation surfaces
        // nowhere near here.
        log?.warn("processes.unreadable", {
            platform,
            cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
        });
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

/**
 * End Discord without asking — reached only from the button that says so.
 *
 * `/T` matters as much as `/F` on Windows: Electron runs several processes that
 * all share the image name `Discord.exe`, and ending the parent alone can leave
 * orphaned children holding the files we are about to rewrite. `pkill -x` on
 * macOS matches the executable name exactly, so it will not catch unrelated
 * processes that merely mention Discord in their command line.
 */
export async function forceQuit(
    branch: DiscordBranch,
    platform: NodeJS.Platform,
    exec: (file: string, args: string[]) => Promise<{ stdout: string }>
): Promise<void> {
    if (platform === "win32") {
        await exec("taskkill", ["/F", "/T", "/IM", processNameFor(branch, "win32")]);
        // DiscordSystemHelper.exe outlives Discord.exe — it is not a child, so
        // /T does not reach it — and it is loaded from the same app directory.
        // Windows will not rename a file that anything holds a handle to, so a
        // survivor here is an EBUSY on app.asar and a failed install. Its
        // absence is not an error: most machines never run it.
        await exec("taskkill", ["/F", "/IM", "DiscordSystemHelper.exe"]).catch(() => ({ stdout: "" }));
        return;
    }
    await exec("/usr/bin/pkill", ["-x", processNameFor(branch, "darwin")]);
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
            // SPAWNED AND ABANDONED, not exec'd and awaited.
            //
            // `execFile` resolves when the child's stdio pipes close, not when
            // the child exits — and Discord inherits those pipes, so the promise
            // waited for Discord to be closed by the user. The install screen
            // sat on "Starting Discord…" for as long as Discord stayed open,
            // never reaching verification, with everything already correctly
            // patched behind it.
            //
            // `detached` puts Discord in its own process group so it survives
            // this installer exiting; `stdio: "ignore"` is what actually frees
            // us; `unref()` stops Node keeping the event loop alive for it.
            const child = spawn(join(install.rootPath, processNameFor(install.branch, "win32")), [], {
                detached: true,
                stdio: "ignore"
            });
            child.unref();
        } else {
            // `open` returns as soon as it has asked Launch Services to start
            // the app, so macOS never had this problem.
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
                ...(explicitPaths === undefined ? {} : { explicitPaths }),
                // "Discord not found" and "we could not read the folder Discord
                // is in" are the same screen. This is the only place that can
                // tell them apart, and it costs one log line to do so.
                onIgnoredError: detail => options.log.warn("locate.skipped", detail)
            }),
        inspect: install => inspectInstall(install),

        listProcesses: () => listProcesses(platform, exec, options.log),
        requestQuit: branch => requestQuit(branch, platform, exec),
        forceQuit: branch => forceQuit(branch, platform, exec),

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
