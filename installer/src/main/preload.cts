/**
 * The renderer's entire view of the outside world.
 *
 * Everything reachable from the page is on this one object, and there is no
 * `fs`, no `child_process`, no `ipcRenderer` and no `require` on it. The
 * renderer sends actions and receives states; the main process does the work.
 * This app writes inside another application's bundle, and a renderer that could
 * do that directly would be a far more attractive thing to compromise than a
 * translator.
 *
 * CommonJS (`.cts`, `import = require`) because a sandboxed preload script is
 * not an ES module.
 */

import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("subline", {
    start: () => ipcRenderer.invoke("flow:start"),
    send: (action: unknown) => ipcRenderer.invoke("flow:send", action),
    restart: () => ipcRenderer.invoke("flow:restart"),
    pickDiscord: () => ipcRenderer.invoke("flow:pick-discord"),
    copyDiagnostics: () => ipcRenderer.invoke("diagnostics:copy"),
    readDiagnostics: () => ipcRenderer.invoke("diagnostics:read"),
    uninstall: (options: { keepSettings: boolean; closeDiscord?: "ask" | "force" }) =>
        ipcRenderer.invoke("uninstall:run", options),
    openUrl: (url: string) => ipcRenderer.invoke("shell:open", url),
    onState: (handler: (state: unknown) => void) => {
        const listener = (_event: unknown, state: unknown): void => handler(state);
        ipcRenderer.on("flow:state", listener);
        return () => ipcRenderer.removeListener("flow:state", listener);
    }
});
