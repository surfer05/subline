import { describe, expect, it } from "vitest";

import { isHeadlessUninstall, runHeadlessUninstall, UNINSTALL_EXIT, uninstallExitCode } from "../src/app/headlessUninstall.js";
import { refusedReport } from "../src/app/uninstall.js";
import type { UninstallReport } from "../src/app/uninstall.js";

function report(overrides: Partial<UninstallReport>): UninstallReport {
    return { ...refusedReport([], "x"), nothingChanged: false, ...overrides };
}
const log = { info: () => {}, error: () => {} };

describe("the headless uninstall for Windows' own uninstaller (audit 2026-10-06 #14, #42)", () => {
    it("only with --uninstall", () => {
        expect(isHeadlessUninstall(["Subline.exe", "--uninstall"])).toBe(true);
        expect(isHeadlessUninstall(["Subline.exe"])).toBe(false);
    });

    it("exit codes: removed, nothing to remove, Discord open, still loads Subline", () => {
        expect(uninstallExitCode(report({ clean: true, discordRestored: true }))).toBe(UNINSTALL_EXIT.removed);
        // No Discord at all: nothing loads Subline, so the files may go.
        expect(uninstallExitCode(report({ clean: true, discordRestored: true, restores: [] }))).toBe(UNINSTALL_EXIT.removed);
        expect(uninstallExitCode(refusedReport([{ code: "DISCORD_RUNNING", message: "open" }], "open"))).toBe(UNINSTALL_EXIT.discordRunning);
        expect(uninstallExitCode(report({ discordRestored: false, problems: [{ code: "FILE_IN_USE", message: "held" }] }))).toBe(UNINSTALL_EXIT.notRemoved);
        expect(uninstallExitCode(refusedReport([{ code: "BACKUP_MISSING", message: "gone" }], "gone"))).toBe(UNINSTALL_EXIT.notRemoved);
        // Discord is back to normal; a leftover file of Subline's own does not keep Subline.exe.
        expect(uninstallExitCode(report({ discordRestored: true, clean: false, problems: [{ code: "IO_ERROR", message: "bundle" }] }))).toBe(UNINSTALL_EXIT.removed);
    });

    it("keeps settings, and closes Discord only when the uninstaller says the user agreed", async () => {
        const asked: unknown[] = [];
        const run = async (options: unknown) => { asked.push(options); return report({ clean: true, discordRestored: true }); };
        expect(await runHeadlessUninstall({ argv: ["x", "--uninstall"], run, log })).toBe(0);
        expect(await runHeadlessUninstall({ argv: ["x", "--uninstall", "--close-discord"], run, log })).toBe(0);
        expect(asked).toEqual([{ keepSettings: true }, { keepSettings: true, closeDiscord: "ask" }]);
    });

    it("a throw is exit 1, never an exception", async () => {
        const code = await runHeadlessUninstall({ argv: ["x", "--uninstall"], run: async () => { throw new Error("boom"); }, log });
        expect(code).toBe(UNINSTALL_EXIT.crashed);
    });
});

describe("main.ts wiring (source level: main.ts runs only inside Electron)", () => {
    it("the headless run creates no window and restores no Start Menu shortcut", async () => {
        const { readFileSync } = await import("node:fs");
        const { join, dirname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main", "main.ts"), "utf8");
        expect(main).toContain("if (!isHelperRun && !isUninstallRun) app.whenReady()");
        expect(main).toMatch(/process\.platform !== "win32" \|\| isHelperRun \|\| isUninstallRun\) return;/);
        expect(main).toContain("runUninstall(options, false)");
        expect(main).toContain("app.exit(code)");
    });
});
