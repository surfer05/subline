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
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DiagnosticsLog } from "../app/log.js";
import { InstallFlow } from "../app/flow.js";
import type { FlowAction, FlowState } from "../app/flow.js";
import { uninstall } from "../app/uninstall.js";
import type { UninstallReport } from "../app/uninstall.js";
import {
    createHelperPorts, createLaunchctl, createSchtasks, HELPER_FLAG, HELPER_LABEL, launchAgentPlistPath,
    readPendingAlerts, releaseManifestUrl, runHelperOnce
} from "../helper/index.js";
import { productDirFor } from "../bundle/layout.js";
import { findDiscordProcesses, quitDiscord } from "../app/discordProcess.js";
import { uninstallTargets } from "../patcher/locate.js";
import { unpatchInstall } from "../patcher/patch.js";
import { usingOriginalFs } from "../patcher/realFs.js";
import {
    createFlowPorts, forceQuit, installHelperFor, listProcesses, logDirFor, removeHelperFor,
    requestQuit, uninstallPaths
} from "./ports.js";
import type { HelperWiring } from "./ports.js";

const here = dirname(fileURLToPath(import.meta.url));

const execFileAsync = promisify(execFile);
let window: BrowserWindow | null = null;
let flow: InstallFlow | null = null;

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
    if (process.platform !== "win32" || isHelperRun) return;
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
        log.writeHeader({
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
                    log,
                    releaseManifestUrl: RELEASE_MANIFEST_URL
                })
            );
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
            log.error("helper.crashed", { cause: String(cause) });
        }
        app.exit(0);
    })();
}

function send(channel: string, payload: unknown): void {
    if (window !== null && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function createFlow(): InstallFlow {
    const ports = createFlowPorts({
        // In a packaged app `process.resourcesPath` is `…/Contents/Resources`;
        // in development it is Electron's own, so the repo's build output is
        // used instead. Both are "the directory the shipped mod sits beside".
        appResourcesPath: app.isPackaged ? process.resourcesPath : join(here, "..", "..", "build"),
        productVersion: app.getVersion(),
        log,
        helper: helperWiring()
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

if (!isHelperRun) app.whenReady().then(() => {
    ensureStartMenuShortcut();
    log.writeHeader({
        productVersion: app.getVersion(),
        os: process.platform,
        osVersion: process.getSystemVersion(),
        arch: process.arch,
            originalFs: usingOriginalFs
    });

    flow = createFlow();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}).catch((cause: unknown) => {
    log.error("app.start-failed", { cause: String(cause) });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

/* ------------------------------------------------------------------------ *
 * IPC — the whole renderer contract
 * ------------------------------------------------------------------------ */

ipcMain.handle("flow:start", () => (flow ??= createFlow()).start());

ipcMain.handle("flow:send", async (_event, action: FlowAction) => {
    flow ??= createFlow();
    return flow.send(action);
});

ipcMain.handle("flow:restart", () => {
    flow = createFlow();
    return flow.start();
});

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
        workDir: productDirFor() ?? undefined
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

ipcMain.handle("uninstall:run", async (
    _event,
    options: { keepSettings: boolean; closeDiscord?: "ask" | "force" }
): Promise<UninstallReport> => {
    // §8 step 3 FIRST. Restoring Discord under a live helper would have the
    // helper put the patch straight back at its next interval. `removeHelperFor`
    // returns the precondition `uninstall` requires, so this call site cannot
    // assemble it wrongly.
    const helper = await removeHelperFor(helperWiring(), process.platform, app.getPath("home"));

    // uninstallTargets, not locateDiscordInstalls: the latter deliberately
    // returns only the NEWEST Windows app dir (right for installing), but a
    // helper patches whichever dir is newest at the time, so after a Discord
    // update TWO siblings can carry the patch. Restoring only the newest left
    // a shim behind whose require died once the mod bundle was deleted —
    // observed bricking a real machine on 2026-09-02. Uninstall's question is
    // "where did we ever leave a mark?", and this is the function that
    // answers it.
    const installs = uninstallTargets({ platform: process.platform });

    // Restoring Discord renames _app.asar back over app.asar, and Windows
    // refuses to rename a file a running process holds open. Looked up here
    // because `uninstall` does no I/O of its own — the same reason `helper`
    // arrives already resolved. Without it the failure surfaced as FILE_IN_USE
    // from deep inside the restore, which is a filesystem error standing in for
    // a fact the user could have been told first.
    // Uninstall may be asked to close Discord on the user's behalf, exactly as
    // the install flow does — "one click to install, one click to remove" is not
    // met by handing someone a file error and letting them work out that the
    // remedy is to quit an app they believe is already closed.
    //
    // Two strengths, and the second is only ever reached from a button that
    // says so: "ask" is the polite request, "force" is the consented close for
    // the Windows case where the polite one merely hides Discord in the tray.
    const branches = new Set(installs.map(install => install.branch));
    if (options.closeDiscord !== undefined) {
        for (const branch of branches) {
            // The escalation lives in quitDiscord now. This used to re-implement
            // it — ask, inspect the report, ask again with force — beside a
            // near-identical copy in flow.ts that differed in the details, in
            // the file whose own header says there is nothing here to be wrong
            // about. An invariant enforced in two places is enforced in none.
            const report = await quitDiscord({
                branch,
                platform: process.platform,
                listProcesses: () => listProcesses(process.platform, execFileAsync, log),
                requestQuit: () => requestQuit(branch, process.platform, execFileAsync),
                forceQuit: () => forceQuit(branch, process.platform, execFileAsync),
                force: options.closeDiscord === "force",
                escalate: options.closeDiscord === "ask"
            });
            log.info("uninstall.quit-discord", {
                branch,
                outcome: report.outcome,
                clear: report.clear,
                forced: report.forced
            });
        }
    }

    const processes = await listProcesses(process.platform, execFileAsync, log);
    const discordRunning = [...branches]
        .flatMap(branch => findDiscordProcesses(processes, branch, process.platform));

    log.info("uninstall.start", {
        installs: installs.length,
        keepSettings: options.keepSettings,
        helperRemoved: helper.removed,
        discordRunning: discordRunning.length
    });
    return uninstall(
        { unpatch: (install, opts) => unpatchInstall(install, opts), ...uninstallPaths(), log },
        { installs, keepSettings: options.keepSettings, helper, discordRunning }
    );
});

ipcMain.handle("shell:open", async (_event, url: string) => {
    // Only ever our own deep links and documentation. A renderer that could open
    // an arbitrary URL through the main process is a phishing primitive.
    if (!/^(https:\/\/|x-apple\.systempreferences:)/.test(url)) return false;
    await shell.openExternal(url);
    return true;
});
