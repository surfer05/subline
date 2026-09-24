import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    APP_MANAGEMENT_SETTINGS_URL,
    awaitAppManagement,
    probeAppManagement,
    isLoggedAttempt,
    MAX_CONSECUTIVE_UNKNOWN,
    PROBE_FILENAME
} from "../src/app/appManagement.js";
import type { AppManagementStatus } from "../src/app/appManagement.js";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subline-perm-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function errnoError(code: string): Error {
    return Object.assign(new Error(`${code}: operation not permitted`), { code });
}

describe("APP_MANAGEMENT_SETTINGS_URL", () => {
    it("is the exact pane spec §4 names, not the top of System Settings", () => {
        expect(APP_MANAGEMENT_SETTINGS_URL)
            .toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles");
    });
});

describe("probeAppManagement", () => {
    it("reports not-required off macOS — Windows has no such gate", () => {
        expect(probeAppManagement({ resourcesPath: dir, platform: "win32" })).toBe("not-required");
        expect(probeAppManagement({ resourcesPath: dir, platform: "linux" })).toBe("not-required");
    });

    it("reports granted when the write succeeds, against a real directory", () => {
        expect(probeAppManagement({ resourcesPath: dir, platform: "darwin" })).toBe("granted");
    });

    it("removes the probe file, so it never leaves anything inside the app bundle", () => {
        probeAppManagement({ resourcesPath: dir, platform: "darwin" });
        expect(existsSync(join(dir, PROBE_FILENAME))).toBe(false);
    });

    it("reports blocked for the errnos App Management produces", () => {
        for (const code of ["EPERM", "EACCES"]) {
            const status = probeAppManagement({
                resourcesPath: dir,
                platform: "darwin",
                attemptWrite: () => { throw errnoError(code); }
            });
            expect(status).toBe("blocked");
        }
    });

    it("reports unknown — not blocked — for an unrelated failure", () => {
        const status = probeAppManagement({
            resourcesPath: dir,
            platform: "darwin",
            attemptWrite: () => { throw errnoError("ENOENT"); }
        });
        expect(status).toBe("unknown");
    });

    it("hands the errno of an unknown to onUnknown, so the log can say what happened", () => {
        const causes: string[] = [];
        probeAppManagement({
            resourcesPath: dir,
            platform: "darwin",
            attemptWrite: () => { throw errnoError("ENOENT"); },
            onUnknown: cause => causes.push(cause)
        });
        expect(causes).toHaveLength(1);
        expect(causes[0]).toMatch(/^ENOENT: /);
    });

    it("does not call onUnknown for a plain block", () => {
        const causes: string[] = [];
        probeAppManagement({
            resourcesPath: dir,
            platform: "darwin",
            attemptWrite: () => { throw errnoError("EPERM"); },
            onUnknown: cause => causes.push(cause)
        });
        expect(causes).toEqual([]);
    });

    it("writes its probe inside the resources directory it was given", () => {
        let seen: string | null = null;
        probeAppManagement({
            resourcesPath: "/Applications/Discord.app/Contents/Resources",
            platform: "darwin",
            attemptWrite: path => { seen = path; }
        });
        expect(seen).toBe(`/Applications/Discord.app/Contents/Resources/${PROBE_FILENAME}`);
    });
});

describe("awaitAppManagement", () => {
    function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
        let t = 0;
        return {
            now: () => t,
            sleep: async (ms: number) => { t += ms; }
        };
    }

    it("returns immediately when permission is already there", async () => {
        const report = await awaitAppManagement({ probe: () => "granted", ...fakeClockPorts() });
        expect(report.permitted).toBe(true);
        expect(report.attempts).toBe(1);
        expect(report.cancelled).toBe(false);
        expect(report.failed).toBe(false);
    });

    function fakeClockPorts() {
        const { now, sleep } = fakeClock();
        return { clock: now, sleep };
    }

    it("keeps polling and continues automatically once the toggle is flipped", async () => {
        const statuses: AppManagementStatus[] = ["blocked", "blocked", "blocked", "granted"];
        let index = 0;
        const report = await awaitAppManagement({
            probe: () => statuses[Math.min(index++, statuses.length - 1)] as AppManagementStatus,
            ...fakeClockPorts()
        });
        expect(report.permitted).toBe(true);
        expect(report.attempts).toBe(4);
        // The whole point: no relaunch, no re-run, no user action beyond the toggle.
        expect(report.failed).toBe(false);
    });

    it("keeps polling through an unknown, rather than giving up on the first one", async () => {
        const statuses: AppManagementStatus[] = ["unknown", "unknown", "granted"];
        let index = 0;
        const report = await awaitAppManagement({
            probe: () => statuses[Math.min(index++, statuses.length - 1)] as AppManagementStatus,
            ...fakeClockPorts()
        });
        expect(report.permitted).toBe(true);
        expect(report.attempts).toBe(3);
    });

    it("never times out on a block: field log 2026-09-24 had the grant arrive after the old 2-minute limit", async () => {
        let calls = 0;
        const report = await awaitAppManagement({
            // Ten minutes of "blocked" at one probe a second, then the toggle.
            probe: () => (++calls > 600 ? "granted" : "blocked"),
            ...fakeClockPorts()
        });
        expect(report.permitted).toBe(true);
        expect(report.failed).toBe(false);
        expect(report.cancelled).toBe(false);
        expect(report.attempts).toBe(601);
    });

    it("polls every second for two minutes, then every three", async () => {
        let t = 0;
        const sleeps: number[] = [];
        let calls = 0;
        await awaitAppManagement({
            probe: () => (++calls > 200 ? "granted" : "blocked"),
            clock: () => t,
            sleep: async ms => { sleeps.push(ms); t += ms; }
        });
        // 120 one-second sleeps take the clock to 120s; every later sleep is 3s.
        expect(sleeps.slice(0, 120).every(ms => ms === 1_000)).toBe(true);
        expect(sleeps.slice(120).every(ms => ms === 3_000)).toBe(true);
        expect(sleeps.length).toBe(200);
    });

    it("stops when cancelled, and makes no further probe", async () => {
        let calls = 0;
        let cancelled = false;
        const report = await awaitAppManagement({
            probe: () => {
                calls += 1;
                if (calls === 3) cancelled = true;
                return "blocked";
            },
            isCancelled: () => cancelled,
            ...fakeClockPorts()
        });
        expect(report.cancelled).toBe(true);
        expect(report.permitted).toBe(false);
        expect(report.failed).toBe(false);
        expect(calls).toBe(3);
    });

    it("ends with failed only after a long unbroken run of unknown", async () => {
        const report = await awaitAppManagement({ probe: () => "unknown", ...fakeClockPorts() });
        expect(report.failed).toBe(true);
        expect(report.permitted).toBe(false);
        expect(report.status).toBe("unknown");
        expect(report.attempts).toBe(MAX_CONSECUTIVE_UNKNOWN);
        expect(report.summary).toContain("could not check");
    });

    it("a block in between resets the unknown count, so a wait on the toggle is never cut short", async () => {
        let calls = 0;
        const report = await awaitAppManagement({
            // unknown, blocked, unknown, blocked ... for a long time, then granted.
            probe: () => (++calls > 500 ? "granted" : calls % 2 === 0 ? "blocked" : "unknown"),
            ...fakeClockPorts()
        });
        expect(report.permitted).toBe(true);
        expect(report.failed).toBe(false);
    });

    it("reports every attempt, for the log and the live counter", async () => {
        const seen: Array<[AppManagementStatus, number]> = [];
        const statuses: AppManagementStatus[] = ["blocked", "granted"];
        let index = 0;
        await awaitAppManagement({
            probe: () => statuses[Math.min(index++, statuses.length - 1)] as AppManagementStatus,
            onAttempt: (status, attempt) => seen.push([status, attempt]),
            ...fakeClockPorts()
        });
        expect(seen).toEqual([["blocked", 1], ["granted", 2]]);
    });

    it("treats not-required as permitted without waiting", async () => {
        const report = await awaitAppManagement({ probe: () => "not-required", ...fakeClockPorts() });
        expect(report.permitted).toBe(true);
        expect(report.attempts).toBe(1);
    });
});

describe("isLoggedAttempt", () => {
    it("logs the first attempt and every 30th, not one line a second forever", () => {
        expect([1, 30, 60, 90].every(isLoggedAttempt)).toBe(true);
        expect([2, 29, 31, 59, 61].some(isLoggedAttempt)).toBe(false);
        const logged = Array.from({ length: 600 }, (_, i) => i + 1).filter(isLoggedAttempt);
        expect(logged).toHaveLength(21);
    });
});
