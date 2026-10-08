/**
 * The durable alert surface reaches the user (audit 2026-10-06 #29, #33).
 * alerts.json used to be written and read by nothing.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PENDING_ALERT_COPY, pendingAlertLines } from "../src/app/pendingAlerts.js";
import { raiseAlert, readPendingAlerts } from "../src/helper/alerts.js";
import { emptyHelperState } from "../src/helper/state.js";

const INSTALLER = join(import.meta.dirname, "..");

describe("pending alerts in the app", () => {
    it("the preload exposes them and the renderer asks for them", () => {
        const preload = readFileSync(join(INSTALLER, "src", "main", "preload.cts"), "utf8");
        expect(preload).toContain('pendingAlerts: () => ipcRenderer.invoke("helper:alerts")');
        const renderer = readFileSync(join(INSTALLER, "src", "renderer", "renderer.ts"), "utf8");
        expect(renderer).toContain("api.pendingAlerts");
        expect(renderer).toContain("pendingAlertLines(");
        const main = readFileSync(join(INSTALLER, "src", "main", "main.ts"), "utf8");
        expect(main).toContain('ipcMain.handle("helper:alerts"');
    });

    it("maps every patch failure to a fixed sentence on the welcome screen", () => {
        expect(pendingAlertLines([{ code: "repatch-failed" }], "welcome")).toEqual([
            "Discord updated and Subline could not turn itself back on. Press Continue to repair it."
        ]);
        expect(pendingAlertLines([{ code: "rollback-failed" }, { code: "backup-missing" }], "welcome")).toEqual([
            "Subline could not repair Discord after an update. Reinstall Discord, then run Subline again.",
            "Discord's original files are gone, so Subline cannot repair it. Reinstall Discord, then run Subline again."
        ]);
    });

    it("does not tell an already set up install to repair itself", () => {
        expect(pendingAlertLines([{ code: "repatch-failed" }, { code: "backup-missing" }], "already-installed")).toEqual([]);
        expect(pendingAlertLines([{ code: "mod-stale" }], "already-installed")).toEqual([PENDING_ALERT_COPY["mod-stale"]]);
    });

    it("shows nothing for codes that are not news on opening the app, or unknown", () => {
        expect(pendingAlertLines(
            [{ code: "restart-required" }, { code: "quit-required" }, { code: "update-failed" }, { code: "toString" }, { code: "x" }],
            "welcome"
        )).toEqual([]);
    });

    it("reads straight from what the helper writes", async () => {
        const dir = mkdtempSync(join(tmpdir(), "subline-pending-"));
        try {
            const state = emptyHelperState();
            await raiseAlert(state, { code: "repatch-failed", message: "m", detail: {}, at: 1 }, {
                notify: async () => {},
                productDir: dir,
                now: () => 1
            });
            expect(pendingAlertLines(readPendingAlerts(dir), "welcome")).toEqual([PENDING_ALERT_COPY["repatch-failed"]]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("uses short plain sentences with no em dashes", () => {
        for (const line of Object.values(PENDING_ALERT_COPY)) {
            expect(line.includes("—")).toBe(false);
            for (const sentence of line.split(/(?<=\.)\s+/)) expect(sentence.split(" ").length).toBeLessThanOrEqual(20);
        }
    });
});
