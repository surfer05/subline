/**
 * Not acting while Discord's updater is mid-flight (spec §5, §6).
 *
 * Every prior repatcher learned this the same way: racing the updater produces a
 * half-patched install. The whole point of these tests is that a Discord that
 * LOOKS quiet for one instant is not settled — the code has to ask twice.
 *
 * Nothing here touches a real Discord, a real clock or a real process table.
 */

import { describe, expect, it } from "vitest";

import type { DiscordInstall } from "../src/patcher/locate.js";
import { err, ok } from "../src/patcher/result.js";
import type { Result } from "../src/patcher/result.js";
import type { DiscordBuildInfo } from "../src/patcher/version.js";
import { awaitDiscordSettled, watchedPaths } from "../src/helper/settle.js";
import type { SettlePorts } from "../src/helper/settle.js";

const INSTALL: DiscordInstall = {
    branch: "stable",
    rootPath: "/Applications/Discord.app",
    resourcesPath: "/Applications/Discord.app/Contents/Resources",
    asarPath: "/Applications/Discord.app/Contents/Resources/app.asar",
    backupPath: "/Applications/Discord.app/Contents/Resources/_app.asar",
    buildInfoPath: "/Applications/Discord.app/Contents/Resources/build_info.json",
    fromExplicitPath: false
};

const OPTIONS = { quietMs: 45_000, confirmMs: 10_000, pollMs: 15_000, maxWaitMs: 120_000 };

const START = 1_000_000;

interface Script {
    running?: boolean[] | boolean;
    /**
     * How old the newest file under Resources is at the START of the run, per
     * observation. An ABSOLUTE mtime is derived from it, so a file that is not
     * being written keeps the same mtime as the clock advances — which is the
     * whole thing the confirmation compares.
     */
    ageMs?: number[] | number;
    version?: string[] | string;
}

function pick<T>(source: T[] | T | undefined, index: number, fallback: T): T {
    if (source === undefined) return fallback;
    if (!Array.isArray(source)) return source;
    return source[Math.min(index, source.length - 1)] ?? fallback;
}

function makePorts(script: Script): SettlePorts & { clock: () => number; sleeps: number[]; samples: number } {
    let clock = START;
    let runningIndex = 0;
    let sampleIndex = 0;
    const sleeps: number[] = [];
    const ports = {
        now: () => clock,
        sleep: async (ms: number) => {
            sleeps.push(ms);
            clock += ms;
        },
        discordRunning: async () => pick(script.running, runningIndex++, false),
        mtimeOf: (path: string) => {
            if (path === INSTALL.resourcesPath) return null;
            // One sample reads several paths; the age is per SAMPLE, so it is
            // resolved from the sample counter rather than a per-path one.
            return START - pick(script.ageMs, sampleIndex, 600_000);
        },
        readDiscordVersion: (): Result<DiscordBuildInfo> => {
            const version = pick(script.version, sampleIndex, "0.0.406");
            sampleIndex += 1;
            return ok({ version, releaseChannel: "stable", raw: {} });
        },
        clock: () => clock,
        sleeps,
        get samples() {
            return sampleIndex;
        }
    };
    return ports;
}

describe("waiting for Discord's updater to settle", () => {
    it("watches exactly the files an updater replaces", () => {
        expect(watchedPaths(INSTALL)).toEqual([
            INSTALL.asarPath,
            INSTALL.backupPath,
            INSTALL.buildInfoPath,
            INSTALL.resourcesPath
        ]);
    });

    it("settles when Discord is closed and nothing has changed across two observations", async () => {
        const ports = makePorts({ running: false, ageMs: 600_000, version: "0.0.407" });
        const report = await awaitDiscordSettled(INSTALL, ports, OPTIONS);

        expect(report.settled).toBe(true);
        expect(report.status).toBe("settled");
        expect(report.version).toBe("0.0.407");
        // It ASKED TWICE — the confirmation delay was actually waited out.
        expect(ports.sleeps).toContain(OPTIONS.confirmMs);
        expect(ports.samples).toBeGreaterThanOrEqual(2);
    });

    it("refuses to act while Discord is running, however quiet the files are", async () => {
        const ports = makePorts({ running: true, ageMs: 10 * 60_000 });
        const report = await awaitDiscordSettled(INSTALL, ports, OPTIONS);

        expect(report.settled).toBe(false);
        expect(report.status).toBe("discord-running");
        expect(report.reason).toContain("Discord is running");
        // Nothing was read: a running Discord ends the question before it starts.
        expect(ports.samples).toBe(0);
    });

    it("refuses while files under Resources are still being written", async () => {
        const ports = makePorts({ running: false, ageMs: 5_000 });
        const report = await awaitDiscordSettled(INSTALL, ports, { ...OPTIONS, maxWaitMs: 0 });

        expect(report.settled).toBe(false);
        expect(report.status).toBe("files-changing");
        expect(report.quietForMs).toBe(5_000);
        expect(report.reason).toContain("quiet window");
    });

    it("waits out the quiet window rather than giving up on a recently-written install", async () => {
        // Written 5s ago and never touched again: it is not settled NOW, but it
        // will be, and the helper should still repair it in this run.
        const ports = makePorts({ running: false, ageMs: 5_000 });
        const report = await awaitDiscordSettled(INSTALL, ports, OPTIONS);

        expect(report.settled).toBe(true);
        expect(report.quietForMs).toBeGreaterThanOrEqual(OPTIONS.quietMs);
    });

    it("does NOT settle on a quiet gap between two of the updater's own writes", async () => {
        // The first sample looks perfectly quiet. The second, after the
        // confirmation delay, shows the version has moved: an update was landing
        // the whole time, and a single-sample check would have patched into it.
        const ports = makePorts({
            running: false,
            ageMs: [600_000, 1_000],
            version: ["0.0.406", "0.0.407", "0.0.407", "0.0.407"]
        });
        const report = await awaitDiscordSettled(INSTALL, ports, { ...OPTIONS, maxWaitMs: 0 });

        expect(report.settled).toBe(false);
        expect(report.status).toBe("version-changing");
        expect(report.reason).toContain("changed while we were watching");
    });

    it("does NOT settle when a file changes during the confirmation delay", async () => {
        const ports = makePorts({ running: false, ageMs: [600_000, 500], version: "0.0.406" });
        const report = await awaitDiscordSettled(INSTALL, ports, { ...OPTIONS, maxWaitMs: 0 });

        expect(report.settled).toBe(false);
        expect(report.status).toBe("files-changing");
        expect(report.reason).toContain("changed while we were watching");
    });

    it("does NOT settle when Discord starts during the confirmation delay", async () => {
        // Closed when first asked, open when asked again — the updater relaunching
        // it, or the user opening it.
        const ports = makePorts({ running: [false, true], ageMs: 600_000 });
        const report = await awaitDiscordSettled(INSTALL, ports, { ...OPTIONS, maxWaitMs: 0 });

        expect(report.settled).toBe(false);
        expect(report.status).toBe("discord-running");
        expect(report.reason).toContain("started while we were watching");
    });

    it("keeps waiting and settles once the update finishes", async () => {
        // Running, running, then closed and quiet.
        const ports = makePorts({ running: [true, true, false, false], ageMs: 600_000 });
        const report = await awaitDiscordSettled(INSTALL, ports, OPTIONS);

        expect(report.settled).toBe(true);
        expect(ports.sleeps.filter(ms => ms === OPTIONS.pollMs).length).toBeGreaterThanOrEqual(2);
        expect(report.waitedMs).toBeGreaterThan(0);
    });

    it("gives up within its budget and reports what was blocking, not a generic timeout", async () => {
        const ports = makePorts({ running: true });
        const report = await awaitDiscordSettled(INSTALL, ports, { ...OPTIONS, maxWaitMs: 40_000 });

        expect(report.settled).toBe(false);
        expect(report.status).toBe("discord-running");
        expect(report.waitedMs).toBeLessThanOrEqual(40_000);
    });

    it("takes one look even when there is no budget at all", async () => {
        const ports = makePorts({ running: true });
        const report = await awaitDiscordSettled(INSTALL, ports, { ...OPTIONS, maxWaitMs: 0 });

        expect(report.status).toBe("discord-running");
        expect(report.reason).toContain("Discord is running");
    });

    it("refuses to call an install settled when nothing under Resources can be dated", async () => {
        const ports: SettlePorts = {
            now: () => 1_000_000,
            sleep: async () => undefined,
            discordRunning: async () => false,
            mtimeOf: () => null,
            readDiscordVersion: () => ok({ version: "0.0.406", releaseChannel: "stable", raw: {} })
        };
        const report = await awaitDiscordSettled(INSTALL, ports, { ...OPTIONS, maxWaitMs: 0 });

        expect(report.settled).toBe(false);
        expect(report.status).toBe("files-changing");
        expect(report.reason).toContain("nothing under Resources could be dated");
    });

    it("settles even when build_info is unreadable, reporting no version rather than guessing", async () => {
        const ports: SettlePorts = {
            now: () => 1_000_000,
            sleep: async () => undefined,
            discordRunning: async () => false,
            mtimeOf: () => 100_000,
            readDiscordVersion: () => err("BUILD_INFO_MISSING", "gone")
        };
        const report = await awaitDiscordSettled(INSTALL, ports, OPTIONS);

        expect(report.settled).toBe(true);
        expect(report.version).toBeNull();
    });
});
