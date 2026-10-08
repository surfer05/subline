/**
 * The Electron main process.
 *
 * Deliberately thin. It owns the window, the IPC surface and the two facts only
 * it knows (where the app's resources are, and its version) — and it makes no
 * decisions of its own. Every decision belongs to `InstallFlow`, which is why
 * this file has no tests and needs none: there is nothing here to be wrong about
 * that is not visible the first time the window opens.
 *
 * MAIN OWNS ALL FILESYSTEM WORK. The renderer receives `FlowState` objects and
 * sends `FlowAction` objects, and that is the entire contract. It has no `fs`,
 * no `child_process` and no remote module — `contextIsolation` and
 * `nodeIntegration: false` are set below and are not negotiable: this app writes
 * inside another application's bundle, and a renderer that could do that
 * directly would be a far more attractive thing to compromise than a translator.
 */

import { existsSync } from "node:fs";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DiagnosticsLog } from "../app/log.js";
import { RESET_HELP_URL } from "../app/codeScreen.js";
import { InstallFlow } from "../app/flow.js";
import { guardedFlowCall } from "../app/failure.js";
import type { FlowAction, FlowState } from "../app/flow.js";
import {
    APP_MANAGEMENT_SETTINGS_URL, appManagementSummary, awaitAppManagement, isLoggedAttempt, probeAppManagement, worstAppManagementStatus
} from "../app/appManagement.js";
import { refusedReport, uninstall } from "../app/uninstall.js";
import { UninstallSession } from "../app/uninstallSession.js";
import { isHeadlessUninstall, runHeadlessUninstall, UNINSTALL_EXIT } from "../app/headlessUninstall.js";
import type { UninstallReport } from "../app/uninstall.js";
import {
    createHelperPorts, createLaunchctl, createSchtasks, HELPER_FLAG, HELPER_LABEL, launchAgentPlistPath,
    readPendingAlerts, releaseManifestUrl, runHelperOnce
} from "../helper/index.js";
import { bufferedLogger, concludeHelperLog, managedResourcesPaths } from "../helper/quiet.js";
import { productDirFor } from "../bundle/layout.js";
import { inspectModBundle } from "../bundle/bundle.js";
import { shippedModDirFor } from "../app/modInstall.js";
import { shouldRelaunchForNewerBundle } from "../app/relaunch.js";
import { writeAppVersionFile } from "../app/appVersionFile.js";
import type { AppVersionWriter } from "../app/appVersionFile.js";
import { findDiscordProcesses, quitDiscord } from "../app/discordProcess.js";
import { rememberedResourcesPath, uninstallTargets } from "../patcher/locate.js";
import { isOtherAccountLoader } from "../patcher/ownership.js";
import type { DiscordInstall } from "../patcher/locate.js";
import { hiddenExec } from "../patcher/exec.js";
import { readPatchedInstalls, releaseRestoredInstalls } from "../app/patchedInstalls.js";
import { unpatchInstall } from "../patcher/patch.js";
import { loaderPathFor } from "../bundle/spec.js";
import { usingOriginalFs } from "../patcher/realFs.js";
import {
    createDiskImageMounts, createFlowPorts, ensureHelperFromHelper, forceQuit, installHelperFor, listProcesses, logDirFor, removeHelperFor,
    requestQuit, uninstallPaths
} from "./ports.js";
import type { HelperWiring } from "./ports.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Never a console window on Windows (see patcher/exec.ts). */
const execFileAsync = hiddenExec();
let window: BrowserWindow | null = null;
let flow: InstallFlow | null = null;
/**
 * Set when Uninstall starts. From then on the install flow is over for this
 * window: no flow:start, flow:send or flow:restart may start (or restart) an
 * install while files are being put back.
 */
const session = new UninstallSession();

const log = new DiagnosticsLog({ dir: logDirFor() });

/**
 * Nothing fails without leaving a record.
 *
 * Electron shows "A JavaScript error occurred in the main process" for an
 * uncaught throw and writes nothing anywhere — the user gets a stack trace in a
 * dialog they cannot copy, and the diagnostics log, which is the one thing we
 * ask them to send, has no idea anything happened. An unhandled rejection is
 * worse: no dialog at all, just a step that never advances, which is exactly
 * what "stuck on Starting Discord" looked like.
 *
 * Registered before anything else can throw, and deliberately does NOT exit:
 * the flow may still be usable, and quitting would destroy the window holding
 * the Copy diagnostics button.
 */
function describeCrash(cause: unknown): Record<string, string> {
    if (cause instanceof Error) {
        return {
            name: cause.name,
            message: cause.message,
            // The stack is the whole point — this is the one place a bare stack
            // is more useful than a named error, because by definition nobody
            // anticipated reaching here.
            stack: (cause.stack ?? "").split("\n").slice(0, 12).join(" | ")
        };
    }
    return { name: "non-error", message: String(cause) };
}

process.on("uncaughtException", (cause: unknown) => {
    log.error("main.uncaught-exception", describeCrash(cause));
});

process.on("unhandledRejection", (cause: unknown) => {
    log.error("main.unhandled-rejection", describeCrash(cause));
});

/**
 * Where the mod's own releases are published (spec §10: GitHub Releases).
 *
 * The URL, the asset name and the one switch that turns trigger B on all live in
 * `helper/feed.ts` now, next to the reasoning — and the release script derives
 * the same URLs from the same repository, so the feed a build polls and the feed
 * a release is published to cannot drift apart. It still returns `null` until
 * `RELEASE_FEED_ENABLED` is flipped, because a 404 on every hourly run would
 * raise "cannot check for updates" for a feature that has not shipped, which is
 * exactly the false warning spec §6 says makes true ones get ignored.
 */
const RELEASE_MANIFEST_URL: string | null = releaseManifestUrl();

/* ------------------------------------------------------------------------ *
 * The background helper (spec §2, §6)
 *
 * SAME BUNDLE, DIFFERENT FLAG. macOS TCC grants attach to a code-signing
 * identity: the App Management permission the user granted Subline during
 * install is what lets the helper write inside `Discord.app`. A separate helper
 * binary would be a different identity and would raise its own prompt weeks
 * later, out of nowhere.
 * ------------------------------------------------------------------------ */

const isHelperRun = process.argv.includes(HELPER_FLAG);
/** Windows' own uninstaller runs `Subline.exe --uninstall` (packaging/installer.nsh). No window. */
const isUninstallRun = !isHelperRun && isHeadlessUninstall(process.argv);

/**
 * Record which app version is installed, for the plugin (app/appVersionFile.ts).
 * Every app launch and every helper run. A failure is logged with its cause and
 * never stops either; a helper run logs only the failure, so an idle run stays
 * one line.
 */
function recordAppVersion(writtenBy: AppVersionWriter): void {
    const written = writeAppVersionFile(productDirFor(), app.getVersion(), writtenBy);
    if (!written.ok) {
        log.warn("app-version.write-failed", {
            writtenBy,
            code: written.error.code,
            path: written.error.path ?? null,
            cause: written.error.cause ?? null
        });
    } else if (writtenBy === "app") {
        log.info("app-version.written", { version: app.getVersion(), path: written.value });
    }
}

/**
 * The Start Menu shortcut, self-healed on every app launch.
 *
 * Observed 2026-09-03: after a full install cycle, Windows search could not
 * surface the Subline app at all - only the setup zip. Whether the shortcut
 * was eaten by a cleanup, never indexed, or lost to search ranking against
 * Sublime Text, the durable answer is the same: an app that depends on one
 * .lnk written once at install time has a single point of failure, and this
 * removes it. Runs on every non-helper launch, writes only when missing, and
 * a failure to write is logged rather than fatal - a missing shortcut is an
 * inconvenience, not a broken install.
 */
function ensureStartMenuShortcut(): void {
    // Never from the headless uninstall: the shortcut is about to be deleted.
    if (process.platform !== "win32" || isHelperRun || isUninstallRun) return;
    try {
        const lnk = join(
            app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Subline.lnk"
        );
        if (existsSync(lnk)) return;
        const wrote = shell.writeShortcutLink(lnk, "create", { target: process.execPath });
        log.info("startmenu.shortcut", { restored: wrote });
    } catch (cause) {
        log.warn("startmenu.shortcut-failed", { cause: String(cause) });
    }
}

if (isHelperRun) {
    // No window, no dock icon, no IPC. Run once, write the log, exit.
    app.dock?.hide();
    void (async () => {
        // First, before anything that can fail, so the plugin sees this
        // helper's version even on a run that crashes later.
        recordAppVersion("helper");
        // HELD BACK until the run is over. Since 0.2.1 the helper runs far more
        // often (launchd WatchPaths on macOS, every 5 minutes on Windows), and
        // nearly every run finds nothing to do: such a run writes ONE line
        // (helper.idle), not a header and a dozen decisions, so the rotated log
        // keeps the runs that mattered. Anything else, and any crash, writes
        // everything, header first.
        const held = bufferedLogger(log);
        const writeHeader = (): void => log.writeHeader({
            productVersion: app.getVersion(),
            os: process.platform,
            osVersion: process.getSystemVersion(),
            arch: process.arch,
            originalFs: usingOriginalFs
        });
        try {
            const report = await runHelperOnce(
                createHelperPorts({
                    productVersion: app.getVersion(),
                    log: held.logger,
                    releaseManifestUrl: RELEASE_MANIFEST_URL
                })
            );
            // Bring the registration itself up to date (WatchPaths, interval)
            // when this build defines it differently from what is registered.
            const registration = await ensureHelperFromHelper(helperWiring(), process.platform, app.getPath("home"));
            const forceFull = registration.action === "rewritten" || registration.action === "failed";
            if (concludeHelperLog(report, held, log, writeHeader, forceFull)) return;
            if (registration.action === "rewritten" || registration.action === "failed") {
                log.info("helper.registration", { action: registration.action, reason: registration.reason });
            }
            log.info("helper.run", {
                summary: report.summary,
                found: report.found,
                managed: report.managed,
                repatched: report.repatched.length,
                deferred: report.deferred.length,
                failed: report.failed.length,
                updateChecked: report.updateChecked,
                updateInstalled: report.updateInstalled,
                health: report.health?.status ?? null,
                alerts: report.alerts.length
            });
        } catch (cause) {
            // A helper that throws is one nobody hears from again. The log is the
            // only record there is of a run nobody watched.
            try {
                writeHeader();
                held.flush();
                log.error("helper.crashed", { cause: String(cause) });
            } catch {
                // Even the crash record failed. Exiting still matters more.
            }
        } finally {
            // ALWAYS. A helper that never exits keeps the next scheduled run
            // from starting (Windows IgnoreNew; launchd will not start a second
            // copy), so one throwing log write would end self-repair for good.
            app.exit(0);
        }
    })();
}

function send(channel: string, payload: unknown): void {
    if (window !== null && !window.isDestroyed()) window.webContents.send(channel, payload);
}

/**
 * In a packaged app `process.resourcesPath` is `…/Contents/Resources`; in
 * development it is Electron's own, so the repo's build output is used instead.
 * Both are "the directory the shipped mod sits beside".
 */
function appResourcesPath(): string {
    return app.isPackaged ? process.resourcesPath : join(here, "..", "..", "build");
}

/**
 * The identity of the mod bundle sitting on disk right now, or null if it
 * cannot be read. Never throws: an unreadable bundle is a fact to compare, not
 * a reason to take the app down.
 */
function modBuildIdOnDisk(): string | null {
    try {
        const inspected = inspectModBundle(shippedModDirFor(appResourcesPath()));
        return inspected.ok ? inspected.value.buildId : null;
    } catch {
        return null;
    }
}

/** The bundle this process was launched with, recorded once at startup. */
let startedWithBuildId: string | null = null;
let relaunching = false;

/**
 * Restart into a newer bundle written over this running copy (see
 * `app/relaunch.ts` for the observed problem). Returns true when the app is on
 * its way out, so callers skip whatever they were about to show.
 */
function relaunchIfBundleChanged(): boolean {
    if (relaunching) return true;
    const onDisk = modBuildIdOnDisk();
    if (!shouldRelaunchForNewerBundle(startedWithBuildId, onDisk)) return false;
    relaunching = true;
    log.info("app.relaunch-for-newer-bundle", { from: startedWithBuildId, to: onDisk });
    app.relaunch();
    app.exit(0);
    return true;
}

function createFlow(): InstallFlow {
    const ports = createFlowPorts({
        appResourcesPath: appResourcesPath(),
        productVersion: app.getVersion(),
        log,
        helper: helperWiring(),
        // An unpackaged dev run's "app" is the Electron binary in node_modules.
        repairHelper: app.isPackaged,
        moveToApplications: () => app.moveToApplicationsFolder(),
        // The checkout opens in the default browser through Electron, never
        // through a shell: a checkout URL carries "&", which cmd.exe would read
        // as a command separator.
        openExternal: url => shell.openExternal(url)
    });
    const created = new InstallFlow(ports);
    created.onChange = (state: FlowState) => send("flow:state", state);
    return created;
}

function createWindow(): void {
    window = new BrowserWindow({
        width: 720,
        height: 620,
        // The 720×620 in the design is the CONTENT, not the frame. Without this
        // the title bar eats into it and every screen is short by its height.
        useContentSize: true,
        // A run-once installer has nothing to reveal at a larger size: the
        // layout is fixed, so dragging the corner only produces dead space or a
        // scrollbar. It was resizable by default, and that is exactly what it
        // looked like — a card adrift in an oversized window.
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
        webPreferences: {
            preload: join(here, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    window.once("ready-to-show", () => window?.show());
    void window.loadFile(join(here, "..", "renderer", "index.html"));

    // Anything that is not our own page opens in the user's browser rather than
    // inside a window that can talk to the main process.
    window.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: "deny" };
    });
}

if (isUninstallRun) {
    // No window, no dock icon. Run the uninstall, log it, exit with its code.
    app.dock?.hide();
    void app.whenReady().then(async () => {
        let code: number = UNINSTALL_EXIT.crashed;
        try {
            log.writeHeader({
                productVersion: app.getVersion(),
                os: process.platform,
                osVersion: process.getSystemVersion(),
                arch: process.arch,
                originalFs: usingOriginalFs
            });
            code = await runHeadlessUninstall({ argv: process.argv, run: options => runUninstall(options, false), log });
        } finally {
            app.exit(code);
        }
    });
}

if (!isHelperRun && !isUninstallRun) app.whenReady().then(() => {
    ensureStartMenuShortcut();
    log.writeHeader({
        productVersion: app.getVersion(),
        os: process.platform,
        osVersion: process.getSystemVersion(),
        arch: process.arch,
            originalFs: usingOriginalFs
    });

    recordAppVersion("app");

    startedWithBuildId = modBuildIdOnDisk();

    flow = createFlow();
    createWindow();

    app.on("activate", () => {
        // A macOS `open` on a bundle whose app is already running re-activates
        // this process rather than launching the new copy, so this is the first
        // moment we can notice that the bundle underneath us changed.
        if (relaunchIfBundleChanged()) return;
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}).catch((cause: unknown) => {
    log.error("app.start-failed", { cause: String(cause) });
});

app.on("window-all-closed", () => {
    // Every platform, macOS included. This is a run-once installer, not a
    // document app: once its window is closed there is nothing left for it to
    // do, and a copy lingering in the Dock is what a later `open` reactivates
    // into a stale screen. The background helper is a separate launch
    // (isHelperRun) and is not affected.
    app.quit();
});

/* ------------------------------------------------------------------------ *
 * IPC — the whole renderer contract
 * ------------------------------------------------------------------------ */

// EVERY FLOW CALL IS GUARDED (audit 2026-10-06 #20): a throw becomes a
// "Something went wrong" screen with Done, and its cause goes to the log,
// instead of a rejected call that left the window on a busy screen.
const onFlowCrash = (cause: unknown): void => log.error("flow.crashed", describeCrash(cause));

ipcMain.handle("flow:start", () => guardedFlowCall(() => {
    // Also here, not only on activate: a window that was already open when the
    // new bundle landed asks for its first state through this handler, and
    // starting the flow would run the old build's install.
    if (relaunchIfBundleChanged()) return null;
    if (!session.mayDriveFlow) return null;
    return (flow ??= createFlow()).start();
}, onFlowCrash));

ipcMain.handle("flow:send", (_event, action: FlowAction) => guardedFlowCall(() => {
    if (!session.mayDriveFlow) return null;
    flow ??= createFlow();
    return flow.send(action);
}, onFlowCrash));

ipcMain.handle("flow:restart", () => guardedFlowCall(() => {
    if (!session.mayDriveFlow) return null;
    // The old flow may still have a background confirmation running (see
    // InstallFlow.verify); detach it so a late result cannot repaint the new
    // run's screen with the previous run's verdict.
    if (flow !== null) flow.onChange = null;
    flow = createFlow();
    return flow.start();
}, onFlowCrash));

/** The manual path picker for "Discord installed somewhere unusual" (§7). */
ipcMain.handle("flow:pick-discord", async () => {
    const result = await dialog.showOpenDialog({
        title: "Where is Discord?",
        properties: process.platform === "darwin" ? ["openFile", "openDirectory"] : ["openDirectory"],
        ...(process.platform === "darwin" ? { filters: [{ name: "Applications", extensions: ["app"] }] } : {})
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("diagnostics:copy", () => {
    const bundle = log.copyBundle();
    clipboard.writeText(bundle);
    log.info("diagnostics.copied", { bytes: bundle.length });
    return bundle.length;
});

ipcMain.handle("diagnostics:read", () => log.read());

/* ---- The helper's own surface ---------------------------------------- */

const launchctl = createLaunchctl();
const schtasks = createSchtasks();
const helperPlistPath = (): string => launchAgentPlistPath(app.getPath("home"));

/**
 * The one description of the helper Subline installs, on both platforms.
 *
 * macOS: `app.getPath("exe")` is `<Subline.app>/Contents/MacOS/Subline`; the spec
 * builder wants the bundle and appends the rest itself. Same bundle, different
 * flag — spec §2: a separate helper binary would be a different code-signing
 * identity and would raise its own App Management prompt weeks later, out of
 * nowhere.
 *
 * Windows: there is no bundle, so the executable path is passed WHOLE rather
 * than reconstructed. The macOS regex above simply does not match there, which
 * is why `executablePath` is its own field instead of something the Windows
 * side re-derives from `appPath` and gets subtly wrong.
 */
function helperWiring(): HelperWiring {
    return {
        appPath: app.getPath("exe").replace(/\/Contents\/MacOS\/[^/]+$/, ""),
        uid: userInfo().uid,
        launchctl,
        executablePath: app.getPath("exe"),
        schtasks,
        // The task XML is handed to schtasks and then deleted. It lives in our
        // own product directory rather than a temp dir, so nothing can sweep it
        // away between writing it and registering it. `productDirFor` returns
        // null on a platform we do not support, which leaves `workDir`
        // undefined and makes the Windows branch report a named failure rather
        // than writing the file somewhere arbitrary.
        workDir: productDirFor() ?? undefined,
        // macOS: an app on /Volumes is "temporary" only when a disk image holds
        // it (audit 2026-10-06 #24). Read only; never attaches anything.
        ...(process.platform === "darwin" ? { diskImageMounts: createDiskImageMounts() } : {}),
        // Read fresh every time a registration is rendered (install, repair,
        // the already-set-up check, and the helper's own check), so WatchPaths
        // always names the Discords Subline manages right now.
        managedResources: () => {
            const ports = createHelperPorts({ productVersion: app.getVersion(), log, releaseManifestUrl: null });
            // The installer's record too: a lost helper memory must not drop
            // a Discord from WatchPaths (audit #34).
            const remembered = new Set([
                ...Object.keys(ports.readState().installs),
                ...(ports.rememberedStableIds?.() ?? [])
            ]);
            return managedResourcesPaths(ports.locate, ports.inspect, remembered, ports.isOtherAccountLoader);
        }
    };
}

/**
 * §3 step 8b, as a manual retry.
 *
 * The INSTALL FLOW is what normally registers the agent — `FlowPorts.installHelper`,
 * called between patching and launching. This handler stays for the case that
 * screen cannot cover: an existing installation whose agent was removed, which
 * `helper:status` can now show and this can repair without re-patching Discord.
 */
ipcMain.handle("helper:install", async () => {
    const result = await installHelperFor(helperWiring(), process.platform, app.getPath("home"));
    log.info("helper.install", { ok: result.ok, code: result.ok ? null : result.error.code });
    return result;
});

ipcMain.handle("helper:status", async () => ({
    loaded: await launchctl.isLoaded(HELPER_LABEL, userInfo().uid),
    plistPath: helperPlistPath()
}));

/** What the helper had to say while the app was closed (see `alerts.ts`). */
ipcMain.handle("helper:alerts", () => readPendingAlerts(productDirFor()));

/**
 * Set by the Cancel button on the uninstall permission screen. The wait has no
 * timeout, so Cancel is the only way out of it short of a grant.
 */
let uninstallPermissionCancelled = false;
ipcMain.handle("uninstall:cancel", () => {
    uninstallPermissionCancelled = true;
    log.info("uninstall.permission.cancel");
});

ipcMain.handle("uninstall:run", async (
    _event,
    options: { keepSettings: boolean; closeDiscord?: "ask" | "force" }
): Promise<UninstallReport> => runUninstall(options, true));

/**
 * The uninstall, for the window (interactive) and for Windows' own
 * uninstaller (headless, `--uninstall`). One body, so the two cannot drift.
 * Headless never opens System Settings and never waits for a grant: a
 * permission it does not have is a refusal with nothing changed.
 */
async function runUninstall(
    options: { keepSettings: boolean; closeDiscord?: "ask" | "force" },
    interactive: boolean
): Promise<UninstallReport> {
    // uninstallTargets, not locateDiscordInstalls: the latter deliberately
    // returns only the NEWEST Windows app dir (right for installing), but a
    // helper patches whichever dir is newest at the time, so after a Discord
    // update TWO siblings can carry the patch. Restoring only the newest left
    // a shim behind whose require died once the mod bundle was deleted —
    // observed bricking a real machine on 2026-09-02. Uninstall's question is
    // "where did we ever leave a mark?", and this is the function that
    // answers it.
    // THE INSTALL FLOW STOPS FIRST. Uninstall can be pressed on any screen,
    // including "Turn on Subline" and "Finish paying in your browser", whose
    // polls kept running: the grant given FOR this uninstall, or a payment
    // landing, then started a patch and a helper registration interleaved
    // with the restore below. abort() ends the polls and waits for anything
    // already writing, so what it wrote is restored too.
    session.begin();
    if (flow !== null) {
        const running = flow;
        flow = null;
        await running.abort();
    }

    // Every Discord Subline remembers patching, read BEFORE anything deletes
    // the product folder that holds the list. A hand-picked PTB, Canary or
    // unusual folder is found only through it.
    const remembered = readPatchedInstalls(productDirFor());
    const installs = uninstallTargets({ platform: process.platform }, remembered, detail => {
        log.warn("uninstall.remembered-skipped", detail);
    });

    // §4 applies to removal too. Putting Discord's original archive back is a
    // write inside the app bundle — the very write the INSTALL flow probes for
    // and, when refused, walks the user through granting. Observed 2026-09-20:
    // a rebuilt (re-signed) app had lost the grant, and Uninstall answered with
    // a bare PERMISSION_DENIED where the install would have opened the settings
    // pane and waited. Same gate, same wait, here — and BEFORE the helper is
    // removed, so a grant that never comes leaves the install exactly as it was
    // rather than patched-but-unattended.
    const phase = (name: "permission" | "removing"): void => {
        if (window !== null && !window.isDestroyed()) window.webContents.send("uninstall:phase", name);
    };
    const probe = () => worstAppManagementStatus(installs.map(install =>
        probeAppManagement({ resourcesPath: install.resourcesPath, platform: process.platform })));
    const status = probe();
    log.info("uninstall.permission.probe", { status, installs: installs.length });
    if (status === "not-writable") {
        // File ownership, not App Management: no toggle fixes it, so nothing
        // is opened and nothing waits. Nothing has been changed.
        const message = appManagementSummary("not-writable");
        return refused(refusedReport(
            [{ code: "NOT_WRITABLE", message, path: installs[0]?.resourcesPath }],
            `${message} Nothing has been changed.`
        ));
    }
    if (status !== "granted" && status !== "not-required" && !interactive) {
        const message = appManagementSummary(status);
        return refused(refusedReport(
            [{ code: "PERMISSION_DENIED", message, path: installs[0]?.resourcesPath }],
            `${message} Nothing has been changed.`
        ));
    }
    if (status !== "granted" && status !== "not-required") {
        phase("permission");
        uninstallPermissionCancelled = false;
        await shell.openExternal(APP_MANAGEMENT_SETTINGS_URL);
        // The same wait as the install: no timeout, until the grant or Cancel.
        const report = await awaitAppManagement({
            probe,
            isCancelled: () => uninstallPermissionCancelled,
            onAttempt: (attemptStatus, attempt) => {
                if (isLoggedAttempt(attempt)) log.info("uninstall.permission.attempt", { status: attemptStatus, attempt });
            }
        });
        log.info("uninstall.permission.result", {
            status: report.status,
            attempts: report.attempts,
            cancelled: report.cancelled,
            failed: report.failed
        });
        if (!report.permitted && report.status === "not-writable") {
            const message = appManagementSummary("not-writable");
            return refused(refusedReport(
                [{ code: "NOT_WRITABLE", message, path: installs[0]?.resourcesPath }],
                `${message} Nothing has been changed.`
            ));
        }
        if (!report.permitted) {
            // Nothing has been touched: no helper removed, no file moved.
            // Cancelled: the renderer says so and nothing more. Failed: the
            // probe itself kept erroring, and the renderer offers to try again.
            return refused({
                ...refusedReport(
                    report.cancelled
                        ? []
                        : [{ code: "IO_ERROR", message: report.summary, path: installs[0]?.resourcesPath }],
                    report.cancelled
                        ? "Nothing was changed. Discord is exactly as it was."
                        : `${report.summary} Nothing has been changed. Discord keeps working exactly as it does now.`
                ),
                cancelled: report.cancelled,
                permissionCheckFailed: report.failed
            });
        }
    }
    phase("removing");

    // THE ORDER IS uninstall()'s: dry run, close Discord (if asked), check it
    // is gone, stop the helper, restore, bring the helper back if a restore
    // failed, and only then the bundle and the settings. This handler only
    // supplies the ports. It used to remove the helper here, before anything
    // was checked, and a refused uninstall left Discord patched with no helper
    // (field logs 2026-10-06 and 2026-10-08).
    log.info("uninstall.start", {
        installs: installs.length,
        keepSettings: options.keepSettings,
        closeDiscord: options.closeDiscord ?? null
    });
    const report = await uninstall(
        {
            // Our own loader by path too, so a stub whose marker went missing (a
            // Windows Discord update copies app.asar without it) is still restored.
            unpatch: (install, opts) => unpatchOurs(install, opts),
            ...uninstallPaths(),
            platform: process.platform,
            log,
            // Only the branches Subline is in: uninstall() decides which.
            listDiscordProcesses: branches => runningDiscord(branches),
            // Two strengths, and the second is only ever reached from a button
            // that says so: "ask" is the polite request that escalates inside
            // quitDiscord, "force" is the consented close.
            quitDiscord: async (mode, branches) => {
                for (const branch of branches) {
                    const quit = await quitDiscord({
                        branch,
                        platform: process.platform,
                        listProcesses: () => listProcesses(process.platform, execFileAsync, log),
                        requestQuit: () => requestQuit(branch, process.platform, execFileAsync),
                        forceQuit: () => forceQuit(branch, process.platform, execFileAsync),
                        force: mode === "force",
                        escalate: mode === "ask"
                    });
                    log.info("uninstall.quit-discord", {
                        branch,
                        outcome: quit.outcome,
                        clear: quit.clear,
                        forced: quit.forced
                    });
                }
            },
            removeHelper: () => removeHelperFor(helperWiring(), process.platform, app.getPath("home")),
            restoreHelper: () => installHelperFor(helperWiring(), process.platform, app.getPath("home")),
            forgetInstalls: stableIds => releaseRestoredInstalls(productDirFor(), stableIds)
        },
        {
            installs,
            keepSettings: options.keepSettings,
            ...(options.closeDiscord === undefined ? {} : { closeDiscord: options.closeDiscord }),
            rememberedResources: remembered.map(entry => rememberedResourcesPath(entry, process.platform))
        }
    );
    log.info("uninstall.done", {
        clean: report.clean,
        nothingChanged: report.nothingChanged === true,
        helperStopped: report.helperStopped,
        settingsRemoved: report.settingsRemoved,
        code: report.problems[0]?.code ?? null
    });
    return refused(report);
}

/**
 * unpatchInstall with our own loader known by path, so a stub whose marker
 * went missing (a Windows Discord update copies app.asar without it) is still
 * recognised as ours and restored.
 */
function unpatchOurs(install: DiscordInstall, opts: { removeForeignMod?: boolean; dryRun?: boolean }) {
    const modDir = uninstallPaths().modBundleDir;
    // macOS shares /Applications/Discord.app between accounts: a Discord
    // another account set up is never restored from this one (audit #5).
    const home = app.getPath("home");
    return unpatchInstall(install, {
        ...opts,
        ownLoaderPaths: modDir === null ? [] : [loaderPathFor(modDir)],
        ...(process.platform === "darwin"
            ? { isOtherAccountLoader: (loaderPath: string) => isOtherAccountLoader(loaderPath, home, "darwin") }
            : {})
    });
}

/** Discord processes of the given branches, right now. */
async function runningDiscord(branches: readonly DiscordInstall["branch"][]): Promise<{ pid: number }[]> {
    const processes = await listProcesses(process.platform, execFileAsync, log);
    return branches.flatMap(branch => findDiscordProcesses(processes, branch, process.platform));
}

/**
 * A report that changed nothing hands the window back to the install flow:
 * the user can press Back and carry on, instead of a dead window (audit
 * 2026-10-06: after a refused uninstall nothing could be pressed).
 */
function refused(report: UninstallReport): UninstallReport {
    return session.finish(report);
}

/**
 * The first uninstall screen asks this before anything is changed, so it can
 * offer "Quit Discord and remove" up front, as the install does.
 */
ipcMain.handle("uninstall:check", async (): Promise<{ discordRunning: boolean; platform: NodeJS.Platform }> => {
    const remembered = readPatchedInstalls(productDirFor());
    const installs = uninstallTargets({ platform: process.platform }, remembered, () => {});
    // Only Discords Subline is in. A Canary running Vencord is not "Discord
    // is still open" for this uninstall. Same dry run uninstall() makes.
    const branches = [...new Set(installs
        .filter(install => {
            const verdict = unpatchOurs(install, { dryRun: true });
            return !verdict.ok || (verdict.value.foreignMod === undefined && !verdict.value.alreadyClean);
        })
        .map(install => install.branch))];
    const running = await runningDiscord(branches);
    log.info("uninstall.check", { installs: installs.length, discordRunning: running.length });
    return { discordRunning: running.length > 0, platform: process.platform };
});

ipcMain.handle("shell:open", async (_event, url: string) => {
    // Only ever our own deep links and documentation. A renderer that could open
    // an arbitrary URL through the main process is a phishing primitive.
    // And exactly one mailto: Subline's support address (field test I8).
    if (!/^(https:\/\/|x-apple\.systempreferences:)/.test(url) && url !== RESET_HELP_URL) return false;
    await shell.openExternal(url);
    return true;
});
