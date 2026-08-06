import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    APP_MANAGEMENT_SETTINGS_URL,
    awaitAppManagement,
    probeAppManagement,
    PROBE_FILENAME,
    RELAUNCH_ADVICE_AFTER_ATTEMPTS
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
        expect(report.timedOut).toBe(false);
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
        expect(report.timedOut).toBe(false);
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

    it("reports rather than throws when the window closes, so the caller can offer retry", async () => {
        const report = await awaitAppManagement({
            probe: () => "blocked",
            timeoutMs: 5_000,
            pollIntervalMs: 1_000,
            ...fakeClockPorts()
        });
        expect(report.permitted).toBe(false);
        expect(report.timedOut).toBe(true);
        expect(report.status).toBe("blocked");
        expect(report.summary).toContain("App Management");
    });

    it("does not poll forever", async () => {
        const report = await awaitAppManagement({
            probe: () => "blocked",
            timeoutMs: 10_000,
            pollIntervalMs: 1_000,
            ...fakeClockPorts()
        });
        expect(report.attempts).toBeLessThanOrEqual(12);
    });

    it("advises granting first, and only escalates to relaunch after long enough", async () => {
        const short = await awaitAppManagement({
            probe: () => "blocked",
            timeoutMs: 3_000,
            pollIntervalMs: 1_000,
            ...fakeClockPorts()
        });
        expect(short.advice).toBe("grant");
        expect(short.summary).not.toContain("quit Subline");

        const long = await awaitAppManagement({
            probe: () => "blocked",
            timeoutMs: RELAUNCH_ADVICE_AFTER_ATTEMPTS * 1_000 + 5_000,
            pollIntervalMs: 1_000,
            ...fakeClockPorts()
        });
        expect(long.attempts).toBeGreaterThanOrEqual(RELAUNCH_ADVICE_AFTER_ATTEMPTS);
        expect(long.advice).toBe("relaunch");
        expect(long.summary).toContain("quit Subline");
    });

    it("never advises relaunching once permission arrives, however long it took", async () => {
        let calls = 0;
        const report = await awaitAppManagement({
            probe: () => (++calls > RELAUNCH_ADVICE_AFTER_ATTEMPTS + 5 ? "granted" : "blocked"),
            timeoutMs: 600_000,
            pollIntervalMs: 1_000,
            ...fakeClockPorts()
        });
        expect(report.permitted).toBe(true);
        expect(report.advice).toBe("grant");
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
