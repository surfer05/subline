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
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DiagnosticsLog } from "../app/log.js";
import { InstallFlow } from "../app/flow.js";
import type { FlowAction, FlowState } from "../app/flow.js";
import { uninstall } from "../app/uninstall.js";
import type { HelperRemoval, UninstallReport } from "../app/uninstall.js";
import {
    createHelperPorts, createLaunchctl, HELPER_FLAG, HELPER_LABEL, helperLaunchAgentSpec,
    installLaunchAgent, launchAgentPlistPath, readPendingAlerts, removeLaunchAgent, runHelperOnce
} from "../helper/index.js";
import { productDirFor } from "../bundle/layout.js";
import { locateDiscordInstalls } from "../patcher/locate.js";
import { unpatchInstall } from "../patcher/patch.js";
import { createFlowPorts, logDirFor, uninstallPaths } from "./ports.js";

const here = dirname(fileURLToPath(import.meta.url));

let window: BrowserWindow | null = null;
let flow: InstallFlow | null = null;

const log = new DiagnosticsLog({ dir: logDirFor() });

/**
 * Where the mod's own releases are published (spec §10: GitHub Releases).
 *
 * `null` disables trigger B entirely rather than pointing the helper at a URL
 * that does not exist yet — a 404 on every run would raise "cannot check for
 * updates" alerts for a feature that has not shipped, which is exactly the false
 * warning spec §6 says makes true ones get ignored.
 */
const RELEASE_MANIFEST_URL: string | null = null;

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
            arch: process.arch
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
        log
    });
    const created = new InstallFlow(ports);
    created.onChange = (state: FlowState) => send("flow:state", state);
    return created;
}

function createWindow(): void {
    window = new BrowserWindow({
        width: 720,
        height: 620,
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
        arch: process.arch
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
const helperPlistPath = (): string => launchAgentPlistPath(app.getPath("home"));

/** §3 step 8b — install the LaunchAgent once Discord has been patched. */
ipcMain.handle("helper:install", async () => {
    const result = await installLaunchAgent({
        plistPath: helperPlistPath(),
        spec: helperLaunchAgentSpec(app.getPath("exe").replace(/\/Contents\/MacOS\/[^/]+$/, "")),
        uid: userInfo().uid,
        launchctl
    });
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
    // helper put the patch straight back at its next interval.
    const removed = await removeLaunchAgent({
        plistPath: helperPlistPath(),
        label: HELPER_LABEL,
        uid: userInfo().uid,
        launchctl
    });
    const helper: HelperRemoval = {
        applicable: process.platform === "darwin",
        removed: removed.ok && removed.value,
        error: removed.ok ? null : removed.error
    };

    const located = locateDiscordInstalls({ platform: process.platform });
    const installs = located.ok ? located.value : [];
    log.info("uninstall.start", {
        installs: installs.length,
        keepSettings: options.keepSettings,
        helperRemoved: helper.removed
    });
    return uninstall(
        { unpatch: (install, opts) => unpatchInstall(install, opts), ...uninstallPaths(), log },
        { installs, keepSettings: options.keepSettings, helper }
    );
});

ipcMain.handle("shell:open", async (_event, url: string) => {
    // Only ever our own deep links and documentation. A renderer that could open
    // an arbitrary URL through the main process is a phishing primitive.
    if (!/^(https:\/\/|x-apple\.systempreferences:)/.test(url)) return false;
    await shell.openExternal(url);
    return true;
});
