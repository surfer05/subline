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

import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { APP_MANAGEMENT_SETTINGS_URL, probeAppManagement } from "../app/appManagement.js";
import type { FlowLogger, FlowPorts, HelperEnsureReport, HelperInstallOutcome } from "../app/flow.js";
import type { HelperRemoval } from "../app/uninstall.js";
import { type ActivationRelay, createActivationRelay, newInstallId } from "../app/activation.js";
import {
    discordSettingsPathFor,
    ensureInstallId,
    readDiscordLocale,
    readInstallId,
    readClearedCode,
    readPriorUse,
    readSublineCode,
    ensureRelayEngine,
    setSublineCode,
    setTargetLanguage,
    vencordSettingsPathFor
} from "../app/language.js";
import { parsePsOutput, processNameFor } from "../app/discordProcess.js";
import type { RunningProcess } from "../app/discordProcess.js";
import { installModBundle, shippedModDirFor } from "../app/modInstall.js";
import { rememberPatchedInstall } from "../app/patchedInstalls.js";
import { hiddenExec } from "../patcher/exec.js";
import { isOtherAccountLoader } from "../patcher/ownership.js";
import { inspectModBundle } from "../bundle/bundle.js";
import {
    HELPER_LABEL, helperLaunchAgentSpec, installLaunchAgent, launchAgentPlistPath, readLaunchAgentPlist,
    removeLaunchAgent, renderLaunchAgentPlist
} from "../helper/launchAgent.js";
import type { LaunchctlPort } from "../helper/launchAgent.js";
import {
    HELPER_TASK_NAME, helperScheduledTaskSpec, installScheduledTask, isoDuration, removeScheduledTask,
    WINDOWS_INTERVAL_SECONDS
} from "../helper/scheduledTask.js";
import type { SchtasksPort } from "../helper/scheduledTask.js";
import { modBundleDirFor, productDirFor } from "../bundle/layout.js";
import { locateDiscordInstalls } from "../patcher/locate.js";
import type { DiscordBranch, DiscordInstall } from "../patcher/locate.js";
import { loaderPathFor } from "../bundle/spec.js";
import { patchInstall } from "../patcher/patch.js";
import { err, ok } from "../patcher/result.js";
import type { Result } from "../patcher/result.js";
import { inspectInstall } from "../patcher/state.js";
import { awaitVerification } from "../verify/verify.js";

/** Every console program goes through hiddenExec: no window flashes on Windows (see patcher/exec.ts). */
const run = hiddenExec();

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
    /** Injected by tests so no request reaches the real relay. Defaults to the live relay over fetch. */
    relay?: ActivationRelay;
    /**
     * Opens an https URL in the default browser. The app passes Electron's
     * shell.openExternal; without it the platform opener is used, which is fine
     * on macOS but on Windows goes through cmd.exe, where "&" in a URL splits it.
     */
    openExternal?: (url: string) => Promise<void>;
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
    /**
     * False in an unpackaged dev run, whose "running app" is the Electron
     * binary in node_modules: re-pointing the real helper at that would break
     * it. Defaults to true.
     */
    repairHelper?: boolean;
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
    /**
     * macOS: the Resources directory of every Discord install Subline manages,
     * read fresh each time a registration is rendered. The LaunchAgent watches
     * each one (WatchPaths), so a Discord update starts the helper within
     * seconds instead of at the next hourly run. Absent or empty means no
     * WatchPaths, the hourly run still applies.
     */
    managedResources?: () => readonly string[];
}

/** The LaunchAgent definition for this wiring, with the current WatchPaths. */
function launchAgentSpecFor(wiring: HelperWiring) {
    let resources: readonly string[] = [];
    try {
        resources = wiring.managedResources?.() ?? [];
    } catch {
        resources = [];
    }
    return helperLaunchAgentSpec(wiring.appPath, wiring.intervalSeconds, wiring.executableName, resources);
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
        spec: launchAgentSpecFor(wiring),
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
        spec: helperScheduledTaskSpec(wiring.executablePath, wiring.intervalSeconds ?? WINDOWS_INTERVAL_SECONDS),
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
 * Make sure the registered helper runs THIS app; re-register it when it does not.
 *
 * Field evidence: ~/Library/LaunchAgents/com.subline.helper.plist named an app
 * path that had since been deleted. The user opened /Applications/Subline.app,
 * saw "Subline is already set up", and the helper still could not run, because
 * nothing on that path ever looked at the registration.
 *
 * macOS: the plist on disk must be exactly what `installHelperFor` would write
 * for the running app, and launchd must have it loaded. Windows: the Scheduled
 * Task's command must be the running Subline.exe. Anything else is repaired
 * with the same code the install path uses, so there is one definition of what
 * a correct registration is.
 */
export async function ensureHelperFor(
    wiring: HelperWiring,
    platform: NodeJS.Platform = process.platform,
    home: string = homedir(),
    options: { registerIfMissing?: boolean } = {}
): Promise<Result<HelperEnsureReport>> {
    if (platform === "win32") {
        const expected = wiring.executablePath ?? null;
        if (wiring.schtasks === undefined || expected === null) {
            return ok({ action: "skipped", reason: "no-scheduler", registered: null, expected });
        }
        // ONE schtasks read when the port can do it (queryDefinition), not two.
        const definition = wiring.schtasks.queryDefinition !== undefined
            ? await wiring.schtasks.queryDefinition(HELPER_TASK_NAME)
            : undefined;
        const registered = definition !== undefined
            ? (definition === null ? null : definition.command)
            : await wiring.schtasks.queryCommand(HELPER_TASK_NAME);
        // NEVER RESURRECT A TASK THE USER TOOK AWAY. Called from the helper,
        // a missing task means Subline was uninstalled while that helper run
        // was going; registering it again brought a removed Subline back to
        // re-patch Discord every 5 minutes. Only the app may register it.
        if (definition === null && options.registerIfMissing === false) {
            return ok({ action: "skipped", reason: "not-registered", registered: null, expected });
        }
        if (registered === null && options.registerIfMissing === false && definition === undefined) {
            return ok({ action: "skipped", reason: "not-registered", registered: null, expected });
        }
        // Windows paths are case-insensitive, and Task Scheduler may hand the
        // command back with the quotes `createSimple` put round it.
        const normalise = (path: string): string => path.trim().replace(/^"(.*)"$/, "$1").toLowerCase();
        let reason: string | null = null;
        if (registered === null) reason = "missing";
        else if (normalise(registered) !== normalise(expected)) reason = "points-elsewhere";
        else {
            // An older install registered an hourly task; 0.2.1 runs every 5
            // minutes. Same command, outdated definition: re-register it.
            const interval = definition !== undefined && definition !== null
                ? definition.interval
                : wiring.schtasks.queryInterval !== undefined ? await wiring.schtasks.queryInterval(HELPER_TASK_NAME) : null;
            const want = isoDuration(wiring.intervalSeconds ?? WINDOWS_INTERVAL_SECONDS);
            if (interval !== null && interval !== want) reason = "definition-changed";
        }
        if (reason === null) return ok({ action: "unchanged", reason: null, registered, expected });
        const repaired = await installHelperFor(wiring, platform, home);
        if (!repaired.ok) return repaired as Result<HelperEnsureReport>;
        return ok({ action: "repaired", reason, registered, expected });
    }
    if (platform !== "darwin") return ok({ action: "skipped", reason: "no-helper-on-platform", registered: null, expected: null });

    // Never re-point the helper at a copy that is about to vanish: the app run
    // straight off the mounted .dmg, or a Gatekeeper-translocated copy.
    if (wiring.appPath.startsWith("/Volumes/") || wiring.appPath.includes("/AppTranslocation/")) {
        return ok({ action: "skipped", reason: "running-from-temporary-location", registered: null, expected: wiring.appPath });
    }

    const plistPath = launchAgentPlistPath(home);
    const spec = launchAgentSpecFor(wiring);
    const expected = spec.programArguments[0] ?? null;
    const current = readLaunchAgentPlist(plistPath);
    const registered = current === null ? null : firstProgramArgument(current);

    let reason: string | null = null;
    if (current === null) reason = "missing";
    else if (registered !== expected) reason = "points-elsewhere";
    else if (current !== renderLaunchAgentPlist(spec)) reason = "definition-changed";
    else if (!await wiring.launchctl.isLoaded(HELPER_LABEL, wiring.uid)) reason = "not-loaded";

    if (reason === null) return ok({ action: "unchanged", reason: null, registered, expected });

    const repaired = await installHelperFor(wiring, platform, home);
    if (!repaired.ok) return repaired as Result<HelperEnsureReport>;
    return ok({ action: "repaired", reason, registered, expected });
}

/**
 * Reload the LaunchAgent from a process launchd did not start for it.
 *
 * The helper cannot `launchctl bootout` its own label while it runs: bootout
 * stops the job, which is the process asking, so the bootstrap after it would
 * never happen and the agent would be gone until the next login. Instead a
 * detached shell (its own session, so it is not in the job's process group)
 * waits a few seconds for the helper to exit, then boots the old definition
 * out and the rewritten plist in.
 */
export type ReloadAgent = (plistPath: string, label: string, uid: number) => void;

export const reloadAgentDetached: ReloadAgent = (plistPath, label, uid) => {
    // Values go in as positional parameters, never spliced into the script, so
    // a path with quotes or spaces cannot change what the shell runs.
    const script = "sleep 3; /bin/launchctl bootout \"gui/$1/$2\" 2>/dev/null; /bin/launchctl bootstrap \"gui/$1\" \"$3\"";
    const child = spawn("/bin/sh", ["-c", script, "sh", String(uid), label, plistPath], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
};

export interface HelperSelfUpdate {
    action: "unchanged" | "rewritten" | "skipped" | "failed";
    reason: string | null;
}

/**
 * The helper's own check that its registration is current, run at the end of
 * every helper run.
 *
 * Why the helper and not only the app: an existing user rarely opens the
 * Subline app, but the helper runs every hour. When a new Subline build changes
 * the registration (0.2.1 added WatchPaths on macOS and a 5 minute interval on
 * Windows), the first helper run of that build brings the registration up to
 * date, and the faster trigger is live from then on.
 *
 * macOS: if the plist on disk is not exactly what this build renders (with the
 * WatchPaths of the installs managed right now), write it and hand the reload
 * to a detached process (see ReloadAgent). Windows: ensureHelperFor, which
 * re-registers the task with `schtasks /Create /F` (safe while it runs).
 * Never throws: a failure here must not turn a good repair run into a crash.
 */
export async function ensureHelperFromHelper(
    wiring: HelperWiring,
    platform: NodeJS.Platform = process.platform,
    home: string = homedir(),
    reload: ReloadAgent = reloadAgentDetached
): Promise<HelperSelfUpdate> {
    try {
        if (platform === "win32") {
            // registerIfMissing: false. A missing task means the user removed
            // Subline; the helper must never put it back (see ensureHelperFor).
            const ensured = await ensureHelperFor(wiring, platform, home, { registerIfMissing: false });
            if (!ensured.ok) return { action: "failed", reason: ensured.error.code };
            return {
                action: ensured.value.action === "repaired" ? "rewritten" : ensured.value.action === "unchanged" ? "unchanged" : "skipped",
                reason: ensured.value.reason
            };
        }
        if (platform !== "darwin") return { action: "skipped", reason: "no-helper-on-platform" };
        if (wiring.appPath.startsWith("/Volumes/") || wiring.appPath.includes("/AppTranslocation/")) {
            return { action: "skipped", reason: "running-from-temporary-location" };
        }
        const plistPath = launchAgentPlistPath(home);
        const wanted = renderLaunchAgentPlist(launchAgentSpecFor(wiring));
        const current = readLaunchAgentPlist(plistPath);
        // No plist at all means the app was uninstalled under a still-loaded
        // job, or the user removed it: never resurrect a registration the user
        // took away.
        if (current === null) return { action: "skipped", reason: "not-registered" };
        if (current === wanted) return { action: "unchanged", reason: null };
        const temp = `${plistPath}.tmp`;
        mkdirSync(join(plistPath, ".."), { recursive: true });
        writeFileSync(temp, wanted, "utf8");
        renameSync(temp, plistPath);
        reload(plistPath, HELPER_LABEL, wiring.uid);
        return { action: "rewritten", reason: "definition-changed" };
    } catch (cause) {
        return { action: "failed", reason: String((cause as Error)?.message ?? cause).slice(0, 200) };
    }
}

/** The executable a LaunchAgent plist runs: the first ProgramArguments string, unescaped. */
export function firstProgramArgument(plist: string): string | null {
    const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist);
    if (match === null) return null;
    return (match[1] ?? "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
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
    log?: FlowLogger,
    /** macOS: only this user's processes. Omitted: every user's, as before. */
    uid?: number
): Promise<RunningProcess[]> {
    try {
        if (platform === "win32") {
            const { stdout } = await exec("tasklist", ["/FO", "CSV", "/NH"]);
            return parseTasklistCsv(stdout);
        }
        const { stdout } = uid === undefined
            ? await exec("/bin/ps", ["-axo", "pid=,comm="])
            : await exec("/bin/ps", ["-x", "-U", String(uid), "-o", "pid=,comm="]);
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
                stdio: "ignore",
                // Discord is a GUI app and opens its own window; this only
                // stops a console being created for it.
                windowsHide: true
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
    let lastProbeError: string | null = null;

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
        inspect: install => inspectInstall(install, { ownLoaderPaths: runtimeDir === null ? [] : [loaderPathFor(runtimeDir)] }),

        listProcesses: () => listProcesses(platform, exec, options.log),
        requestQuit: branch => requestQuit(branch, platform, exec),
        forceQuit: branch => forceQuit(branch, platform, exec),

        probePermission: install => probeAppManagement({
            resourcesPath: install.resourcesPath,
            platform,
            onUnknown: cause => {
                // Logged when it changes, not on every probe: the wait has no
                // timeout, and the same errno once a second is noise.
                if (cause !== lastProbeError) options.log.warn("permission.probe-unknown", { cause });
                lastProbeError = cause;
            },
            onRefused: cause => {
                // EPERM (App Management) or EACCES (ownership): which one, and where.
                if (cause !== lastProbeError) options.log.info("permission.probe-refused", { cause });
                lastProbeError = cause;
            }
        }),
        lastPermissionProbeError: () => lastProbeError,
        // macOS ONLY. On Windows this ran `cmd /c start "" x-apple...`, which
        // shows a "get an app to open this link" prompt. No caller can reach
        // it there any more, and this keeps it that way.
        openPermissionSettings: () => platform === "darwin" ? openUrl(APP_MANAGEMENT_SETTINGS_URL, platform, exec) : Promise.resolve(),
        permissionSettingsUrl: APP_MANAGEMENT_SETTINGS_URL,

        discordLocale: () => readDiscordLocale(discordSettingsPathFor(platform, env, home)),
        systemLocale,
        setLanguage: code => setTargetLanguage(vencordSettings, code),
        setSublineCode: key => setSublineCode(vencordSettingsPathFor(platform, env, home), key),
        hasSublineCode: () => readSublineCode(vencordSettings) !== null,
        ensureRelayEngine: () => ensureRelayEngine(vencordSettings),

        savedSublineCode: () => readSublineCode(vencordSettings),
        savedInstallId: () => readInstallId(vencordSettings),
        clearedCode: () => readClearedCode(vencordSettings),
        priorSublineUse: () => readPriorUse(vencordSettings),
        ensureInstallId: () => ensureInstallId(vencordSettings, newInstallId),
        relay: options.relay ?? createActivationRelay({
            fetch: (url, init) => globalThis.fetch(url, init),
            version: options.productVersion
        }),
        // https only, and only a checkout URL: the flow hands over a Dodo URL.
        openCheckout: async url => {
            if (!/^https:\/\//.test(url)) return;
            if (options.openExternal !== undefined) await options.openExternal(url);
            else await openUrl(url, platform, exec);
        },

        patch: (install, patchOptions) =>
            patchInstall(install, {
                modBundleDir: patchOptions.modBundleDir,
                productVersion: options.productVersion,
                overwriteForeignMod: patchOptions.overwriteForeignMod
            }),
        rememberPatchedInstall: install => {
            const remembered = rememberPatchedInstall(productDirFor(platform, env, home), install);
            if (!remembered.ok) {
                options.log.warn("patch.remember-failed", {
                    code: remembered.error.code,
                    path: remembered.error.path ?? null,
                    cause: remembered.error.cause ?? null
                });
            }
        },
        ...(platform === "darwin"
            ? { isOtherAccountLoader: (loaderPath: string) => isOtherAccountLoader(loaderPath, home, platform) }
            : {}),
        installHelper: () => installHelperFor(options.helper, platform, home),
        ensureHelper: () => options.repairHelper === false
            ? Promise.resolve(ok({ action: "skipped" as const, reason: "development-build", registered: null, expected: null }))
            : ensureHelperFor(options.helper, platform, home),
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
): {
    modBundleDir: string | null;
    productDir: string | null;
    logDir: string | null;
    vencordSettingsPath: string | null;
} {
    const productDir = productDirFor(platform, env, home);
    const logDir = logDirFor(platform, env, home);
    return {
        modBundleDir: modBundleDirFor(platform, env, home),
        productDir,
        // Only when it is actually INSIDE the product directory. On macOS the
        // log lives under ~/Library/Logs and the removal never goes near it, so
        // naming it here would be a preservation rule with nothing to preserve.
        logDir: productDir !== null && logDir.startsWith(productDir) ? logDir : null,
        vencordSettingsPath: vencordSettingsPathFor(platform, env, home)
    };
}

/** Where the rotating diagnostics log lives (spec §4/§5 paths). */
export const LOG_DIR_NAME = "logs";

export function logDirFor(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): string {
    // macOS keeps logs where the OS expects them, OUTSIDE the product folder.
    if (platform === "darwin") return join(home, "Library", "Logs", "Subline");

    // Everywhere else the logs live INSIDE the product folder, and that is a
    // relationship the uninstaller has to know about — see uninstall.ts, which
    // removes the product folder and must not take the log of the run it is
    // currently reporting with it. Derived from productDirFor rather than
    // rebuilt from a literal "Subline": the literal is how the two drifted into
    // an overlap nobody had stated.
    const product = productDirFor(platform, env, home);
    if (product !== null) return join(product, LOG_DIR_NAME);
    return join(home, ".subline", LOG_DIR_NAME);
}
