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
import { uninstall } from "../app/uninstall.js";
import { createHelperPorts, createLaunchctl, HELPER_FLAG, HELPER_LABEL, launchAgentPlistPath, readPendingAlerts, releaseManifestUrl, runHelperOnce } from "../helper/index.js";
import { productDirFor } from "../bundle/layout.js";
import { locateDiscordInstalls } from "../patcher/locate.js";
import { unpatchInstall } from "../patcher/patch.js";
import { createFlowPorts, installHelperFor, logDirFor, removeHelperFor, uninstallPaths } from "./ports.js";
const here = dirname(fileURLToPath(import.meta.url));
let window = null;
let flow = null;
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
const RELEASE_MANIFEST_URL = releaseManifestUrl();
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
            const report = await runHelperOnce(createHelperPorts({
                productVersion: app.getVersion(),
                log,
                releaseManifestUrl: RELEASE_MANIFEST_URL
            }));
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
        }
        catch (cause) {
            // A helper that throws is one nobody hears from again. The log is the
            // only record there is of a run nobody watched.
            log.error("helper.crashed", { cause: String(cause) });
        }
        app.exit(0);
    })();
}
function send(channel, payload) {
    if (window !== null && !window.isDestroyed())
        window.webContents.send(channel, payload);
}
function createFlow() {
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
    created.onChange = (state) => send("flow:state", state);
    return created;
}
function createWindow() {
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
if (!isHelperRun)
    app.whenReady().then(() => {
        log.writeHeader({
            productVersion: app.getVersion(),
            os: process.platform,
            osVersion: process.getSystemVersion(),
            arch: process.arch
        });
        flow = createFlow();
        createWindow();
        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0)
                createWindow();
        });
    }).catch((cause) => {
        log.error("app.start-failed", { cause: String(cause) });
    });
app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        app.quit();
});
/* ------------------------------------------------------------------------ *
 * IPC — the whole renderer contract
 * ------------------------------------------------------------------------ */
ipcMain.handle("flow:start", () => (flow ??= createFlow()).start());
ipcMain.handle("flow:send", async (_event, action) => {
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
const helperPlistPath = () => launchAgentPlistPath(app.getPath("home"));
/**
 * The one description of the agent Subline installs.
 *
 * `app.getPath("exe")` is `<Subline.app>/Contents/MacOS/Subline`; the spec builder
 * wants the bundle, and appends the rest itself. Same bundle, different flag —
 * spec §2: a separate helper binary would be a different code-signing identity
 * and would raise its own App Management prompt weeks later, out of nowhere.
 */
function helperWiring() {
    return {
        appPath: app.getPath("exe").replace(/\/Contents\/MacOS\/[^/]+$/, ""),
        uid: userInfo().uid,
        launchctl
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
ipcMain.handle("uninstall:run", async (_event, options) => {
    // §8 step 3 FIRST. Restoring Discord under a live helper would have the
    // helper put the patch straight back at its next interval. `removeHelperFor`
    // returns the precondition `uninstall` requires, so this call site cannot
    // assemble it wrongly.
    const helper = await removeHelperFor(helperWiring(), process.platform, app.getPath("home"));
    const located = locateDiscordInstalls({ platform: process.platform });
    const installs = located.ok ? located.value : [];
    log.info("uninstall.start", {
        installs: installs.length,
        keepSettings: options.keepSettings,
        helperRemoved: helper.removed
    });
    return uninstall({ unpatch: (install, opts) => unpatchInstall(install, opts), ...uninstallPaths(), log }, { installs, keepSettings: options.keepSettings, helper });
});
ipcMain.handle("shell:open", async (_event, url) => {
    // Only ever our own deep links and documentation. A renderer that could open
    // an arbitrary URL through the main process is a phishing primitive.
    if (!/^(https:\/\/|x-apple\.systempreferences:)/.test(url))
        return false;
    await shell.openExternal(url);
    return true;
});
//# sourceMappingURL=main.js.map