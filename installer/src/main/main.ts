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
import { findDiscordProcesses } from "../app/discordProcess.js";
import { locateDiscordInstalls } from "../patcher/locate.js";
import { unpatchInstall } from "../patcher/patch.js";
import { usingOriginalFs } from "../patcher/realFs.js";
import { createFlowPorts, installHelperFor, listProcesses, logDirFor, removeHelperFor, uninstallPaths } from "./ports.js";
import type { HelperWiring } from "./ports.js";

const here = dirname(fileURLToPath(import.meta.url));

const execFileAsync = promisify(execFile);

let window: BrowserWindow | null = null;
let flow: InstallFlow | null = null;

const log = new DiagnosticsLog({ dir: logDirFor() });

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

ipcMain.handle("uninstall:run", async (_event, options: { keepSettings: boolean }): Promise<UninstallReport> => {
    // §8 step 3 FIRST. Restoring Discord under a live helper would have the
    // helper put the patch straight back at its next interval. `removeHelperFor`
    // returns the precondition `uninstall` requires, so this call site cannot
    // assemble it wrongly.
    const helper = await removeHelperFor(helperWiring(), process.platform, app.getPath("home"));

    const located = locateDiscordInstalls({ platform: process.platform });
    const installs = located.ok ? located.value : [];

    // Restoring Discord renames _app.asar back over app.asar, and Windows
    // refuses to rename a file a running process holds open. Looked up here
    // because `uninstall` does no I/O of its own — the same reason `helper`
    // arrives already resolved. Without it the failure surfaced as FILE_IN_USE
    // from deep inside the restore, which is a filesystem error standing in for
    // a fact the user could have been told first.
    const processes = await listProcesses(process.platform, execFileAsync, log);
    const branches = new Set(installs.map(install => install.branch));
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
