/**
 * I3 (field test 2026-10-08): the first uninstall screen offers to quit
 * Discord up front, the way the install's "Quit Discord for me" does, and says
 * where Windows hides a "closed" Discord. The renderer draws exactly this view.
 */

import { describe, expect, it } from "vitest";

import {
    UNINSTALL_COPY,
    discordOpenLine,
    discordRunningSummary,
    helperStopFailedSummary,
    uninstallReportTitle,
    uninstallStartView
} from "../src/app/uninstallScreen.js";

describe("the first uninstall screen", () => {
    it("Discord open on Windows: names the ^, and the main button quits and removes", () => {
        const view = uninstallStartView({ platform: "win32", discordRunning: true });
        expect(view.title).toBe("Remove Subline?");
        expect(view.detail).toContain("Discord is still open in the background, behind the ^ near the clock.");
        expect(view.primary).toEqual({ label: "Quit Discord and remove", closeDiscord: "ask" });
        expect(view.cancel).toBe("Cancel");
    });

    it("Discord open on a Mac: the same button, with Mac wording", () => {
        const view = uninstallStartView({ platform: "darwin", discordRunning: true });
        expect(view.primary).toEqual({ label: "Quit Discord and remove", closeDiscord: "ask" });
        expect(view.detail).toContain("Discord is still open.");
        expect(view.detail).not.toMatch(/\^|clock|tray/);
    });

    it("Discord closed: a plain Remove that quits nothing", () => {
        for (const platform of ["win32", "darwin"] as const) {
            const view = uninstallStartView({ platform, discordRunning: false });
            expect(view.primary).toEqual({ label: "Remove", closeDiscord: null });
            expect(view.detail).not.toContain("Discord is still open");
        }
    });

    it("offers the settings as a separate choice, off by default in the renderer", () => {
        expect(uninstallStartView({ platform: "win32", discordRunning: false }).settingsLabel)
            .toBe("Also remove my settings and code");
    });
});

describe("the uninstall's words", () => {
    it("never tells a Mac user about the ^ or the tray", () => {
        expect(discordOpenLine("darwin")).toBe("Discord is still open.");
        for (const afterQuit of [false, true]) {
            expect(discordRunningSummary("darwin", afterQuit)).not.toMatch(/\^|clock|tray|Task Scheduler/);
        }
        expect(helperStopFailedSummary("darwin")).not.toMatch(/Task Scheduler/);
    });

    it("never says 'check the system tray' on Windows: it names the ^", () => {
        for (const afterQuit of [false, true]) {
            const summary = discordRunningSummary("win32", afterQuit);
            expect(summary).toContain("behind the ^ near the clock");
            expect(summary).not.toMatch(/system tray/i);
        }
        expect(helperStopFailedSummary("win32")).not.toMatch(/Mac/);
    });

    it("has no em dashes", () => {
        const all = [
            ...Object.values(UNINSTALL_COPY),
            discordOpenLine("win32"),
            discordRunningSummary("win32", true),
            discordRunningSummary("darwin", true),
            helperStopFailedSummary("win32")
        ];
        for (const line of all) expect(line).not.toContain("—");
    });

    it("titles the report by what happened", () => {
        expect(uninstallReportTitle({ clean: true, problems: [] })).toBe("Removed");
        expect(uninstallReportTitle({ clean: false, nothingChanged: true, problems: [{ code: "DISCORD_RUNNING" }] }))
            .toBe("Discord is still open");
        expect(uninstallReportTitle({ clean: false, nothingChanged: true, problems: [{ code: "FOREIGN_MOD_PRESENT" }] }))
            .toBe("Subline was not removed");
        expect(uninstallReportTitle({ clean: false, nothingChanged: false, problems: [{ code: "FILE_IN_USE" }] }))
            .toBe("Not fully removed");
        expect(uninstallReportTitle({ clean: false, cancelled: true, nothingChanged: true, problems: [] })).toBe("Cancelled");
    });
});

describe("the line under a clean removal (audit 2026-10-06 #42)", () => {
    it("names where the app itself is removed, per system", async () => {
        const { deleteAppLine } = await import("../src/app/uninstallScreen.js");
        expect(deleteAppLine("win32")).toBe("You can now uninstall Subline in Windows Settings, under Apps.");
        expect(deleteAppLine("darwin")).toBe("You can now move Subline to the Trash.");
    });
});
