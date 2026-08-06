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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DiagnosticsLog } from "../app/log.js";
import { InstallFlow } from "../app/flow.js";
import { uninstall } from "../app/uninstall.js";
import { locateDiscordInstalls } from "../patcher/locate.js";
import { unpatchInstall } from "../patcher/patch.js";
import { createFlowPorts, logDirFor, uninstallPaths } from "./ports.js";
const here = dirname(fileURLToPath(import.meta.url));
let window = null;
let flow = null;
const log = new DiagnosticsLog({ dir: logDirFor() });
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
        log
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
ipcMain.handle("uninstall:run", (_event, options) => {
    const located = locateDiscordInstalls({ platform: process.platform });
    const installs = located.ok ? located.value : [];
    log.info("uninstall.start", { installs: installs.length, keepSettings: options.keepSettings });
    return uninstall({ unpatch: (install, opts) => unpatchInstall(install, opts), ...uninstallPaths(), log }, { installs, keepSettings: options.keepSettings });
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