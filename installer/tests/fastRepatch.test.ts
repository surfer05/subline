/**
 * 0.2.1: repatch within seconds of a Discord update, not at the next hourly run.
 *
 * Field evidence: Discord 0.0.413 to 0.0.414 wiped the patch and the helper only
 * repaired it at its next hourly run (~15 minutes later, up to 60). macOS now
 * also starts the helper from launchd WatchPaths on each managed Discord's
 * Resources; Windows polls every 5 minutes. The helper waits for the update's
 * files to settle before writing, a run with nothing to do costs one log line
 * and no network, and an outdated registration is brought up to date.
 *
 * Nothing here registers a real agent or task: plists go to temp directories,
 * launchctl and schtasks are fakes, reloads are recorded.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { awaitDiscordSettled, DEFAULT_CONFIRM_MS, DEFAULT_MAX_WAIT_MS, DEFAULT_QUIET_MS } from "../src/helper/settle.js";
import {
    HELPER_LABEL, helperLaunchAgentSpec, launchAgentPlistPath, launchAgentWatchPaths, readLaunchAgentPlist,
    renderLaunchAgentPlist
} from "../src/helper/launchAgent.js";
import { HELPER_TASK_NAME, renderScheduledTaskXml, helperScheduledTaskSpec } from "../src/helper/scheduledTask.js";
import { bufferedLogger, concludeHelperLog, isIdleRun, managedResourcesPaths } from "../src/helper/quiet.js";
import type { HelperRunReport } from "../src/helper/helper.js";
import { ensureHelperFor, ensureHelperFromHelper, installHelperFor } from "../src/main/ports.js";
import type { DiscordInstall } from "../src/patcher/locate.js";
import { ok } from "../src/patcher/result.js";
import { makeFakeLaunchctl, makeFakeSchtasks } from "./fixture.js";
import type { FakeLaunchctl, FakeSchtasks } from "./fixture.js";

const UID = 501;
const APP = "/Applications/Subline.app";
const RES_A = "/Applications/Discord.app/Contents/Resources";
const RES_B = "/Applications/Discord PTB.app/Contents/Resources";
const WINDOWS_EXE = "C:\\Users\\x\\AppData\\Local\\Programs\\Subline\\Subline.exe";

let home: string;
let launchctl: FakeLaunchctl;
let schtasks: FakeSchtasks;
let managed: string[];

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "subline-fast-"));
    launchctl = makeFakeLaunchctl();
    schtasks = makeFakeSchtasks();
    managed = [RES_A];
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

const wiring = () => ({ appPath: APP, uid: UID, launchctl, managedResources: () => managed });
const windowsWiring = () => ({ ...wiring(), executablePath: WINDOWS_EXE, schtasks, workDir: home });

/** The <string> entries of the plist's WatchPaths array, or null when there is none. */
function watchPathsOf(plist: string): string[] | null {
    const block = /<key>WatchPaths<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
    if (block === null) return null;
    return [...(block[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1] ?? "");
}

describe("the LaunchAgent watches each managed Discord", () => {
    it("one install: its app.asar and its Resources directory, with RunAtLoad and the hourly interval kept", () => {
        const plist = renderLaunchAgentPlist(helperLaunchAgentSpec(APP, 3600, "Subline", [RES_A]));
        expect(watchPathsOf(plist)).toEqual([RES_A, `${RES_A}/app.asar`]);
        expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
        expect(plist).toContain("<key>StartInterval</key>\n    <integer>3600</integer>");
        // launchd's own rate limit, stated rather than assumed.
        expect(plist).toContain("<key>ThrottleInterval</key>\n    <integer>10</integer>");
    });

    it("two installs: all four paths, sorted, each once", () => {
        const plist = renderLaunchAgentPlist(helperLaunchAgentSpec(APP, 3600, "Subline", [RES_B, RES_A, RES_A]));
        expect(watchPathsOf(plist)).toEqual([RES_A, `${RES_A}/app.asar`, RES_B, `${RES_B}/app.asar`].sort());
    });

    it("no managed install: no WatchPaths key at all", () => {
        const plist = renderLaunchAgentPlist(helperLaunchAgentSpec(APP));
        expect(watchPathsOf(plist)).toBeNull();
        expect(plist).not.toContain("ThrottleInterval");
    });

    it("escapes a watched path that has XML in it", () => {
        expect(launchAgentWatchPaths(["/Users/a&b/Discord.app/Contents/Resources"]))
            .toEqual(["/Users/a&b/Discord.app/Contents/Resources", "/Users/a&b/Discord.app/Contents/Resources/app.asar"]);
        const plist = renderLaunchAgentPlist(helperLaunchAgentSpec(APP, 3600, "Subline", ["/Users/a&b/Discord.app/Contents/Resources"]));
        expect(plist).toContain("<string>/Users/a&amp;b/Discord.app/Contents/Resources</string>");
    });

    it("install writes the WatchPaths of the installs managed right now", async () => {
        managed = [RES_A, RES_B];
        const installed = await installHelperFor(wiring(), "darwin", home);
        expect(installed.ok).toBe(true);
        expect(watchPathsOf(readLaunchAgentPlist(launchAgentPlistPath(home)) ?? "")).toHaveLength(4);
    });
});

describe("an outdated registration is brought up to date", () => {
    it("macOS, the app's check: an hourly-only plist from 0.2.0 is rewritten with WatchPaths and reloaded", async () => {
        managed = [];
        await installHelperFor(wiring(), "darwin", home); // what 0.2.0 wrote: no WatchPaths
        launchctl.calls.length = 0;
        managed = [RES_A];
        const result = await ensureHelperFor(wiring(), "darwin", home);
        expect(result.ok && result.value.reason).toBe("definition-changed");
        expect(watchPathsOf(readLaunchAgentPlist(launchAgentPlistPath(home)) ?? "")).toEqual([RES_A, `${RES_A}/app.asar`]);
        expect(launchctl.calls).toContain(`bootstrap gui/${UID} ${launchAgentPlistPath(home)}`);
    });

    it("macOS, the app's check: an up-to-date registration is not touched", async () => {
        await installHelperFor(wiring(), "darwin", home);
        launchctl.calls.length = 0;
        const result = await ensureHelperFor(wiring(), "darwin", home);
        expect(result.ok && result.value.action).toBe("unchanged");
        expect(launchctl.calls.filter(c => c.startsWith("bootstrap") || c.startsWith("bootout"))).toEqual([]);
    });

    it("macOS, the helper's own check: rewrites the plist and hands the reload to a detached process", async () => {
        managed = [];
        await installHelperFor(wiring(), "darwin", home);
        managed = [RES_A];
        const reloads: string[] = [];
        const result = await ensureHelperFromHelper(wiring(), "darwin", home, (plist, label, uid) => reloads.push(`${uid} ${label} ${plist}`));
        expect(result).toEqual({ action: "rewritten", reason: "definition-changed" });
        expect(watchPathsOf(readLaunchAgentPlist(launchAgentPlistPath(home)) ?? "")).toEqual([RES_A, `${RES_A}/app.asar`]);
        expect(reloads).toEqual([`${UID} ${HELPER_LABEL} ${launchAgentPlistPath(home)}`]);
        // Never booted out from inside the job itself: that would stop the
        // process asking, before the bootstrap could run.
        expect(launchctl.calls.filter(c => c.startsWith("bootout"))).toEqual([]);
    });

    it("macOS, the helper's own check: an up-to-date plist is left alone and nothing is reloaded", async () => {
        await installHelperFor(wiring(), "darwin", home);
        const before = readFileSync(launchAgentPlistPath(home), "utf8");
        const reloads: string[] = [];
        const result = await ensureHelperFromHelper(wiring(), "darwin", home, () => reloads.push("reload"));
        expect(result.action).toBe("unchanged");
        expect(reloads).toEqual([]);
        expect(readFileSync(launchAgentPlistPath(home), "utf8")).toBe(before);
    });

    it("macOS, the helper's own check: never resurrects a registration that was removed", async () => {
        const reloads: string[] = [];
        const result = await ensureHelperFromHelper(wiring(), "darwin", home, () => reloads.push("reload"));
        expect(result).toEqual({ action: "skipped", reason: "not-registered" });
        expect(existsSync(launchAgentPlistPath(home))).toBe(false);
        expect(reloads).toEqual([]);
    });

    it("Windows: an hourly task with the right command is re-registered every 5 minutes, logon trigger kept", async () => {
        // What 0.2.0 registered.
        await installHelperFor({ ...windowsWiring(), intervalSeconds: 3600 }, "win32", home);
        expect(schtasks.intervals.get(HELPER_TASK_NAME)).toBe("PT1H");
        const result = await ensureHelperFor(windowsWiring(), "win32", home);
        expect(result.ok && result.value.reason).toBe("definition-changed");
        expect(schtasks.intervals.get(HELPER_TASK_NAME)).toBe("PT5M");
        expect(schtasks.lastXml).toContain("<LogonTrigger>");
    });

    it("Windows: a task already on 5 minutes is not touched", async () => {
        await installHelperFor(windowsWiring(), "win32", home);
        schtasks.calls.length = 0;
        const result = await ensureHelperFor(windowsWiring(), "win32", home);
        expect(result.ok && result.value.action).toBe("unchanged");
        expect(schtasks.calls.filter(c => c.startsWith("create"))).toEqual([]);
    });

    it("Windows: the task definition repeats every 5 minutes and keeps the logon trigger", () => {
        const xml = renderScheduledTaskXml(helperScheduledTaskSpec(WINDOWS_EXE));
        expect(xml).toContain("<Interval>PT5M</Interval>");
        expect(xml).toContain("<LogonTrigger>");
    });
});

describe("the helper waits for an update to finish, then repairs once", () => {
    const install = {
        asarPath: `${RES_A}/app.asar`,
        backupPath: `${RES_A}/_app.asar`,
        buildInfoPath: `${RES_A}/build_info.json`,
        resourcesPath: RES_A
    } as DiscordInstall;

    it("woken mid-update by WatchPaths: keeps polling while files change, settles shortly after the last write", async () => {
        let clock = 1_000_000;
        // The updater writes for 20s from the moment the helper is started.
        const updateEndsAt = clock + 20_000;
        const ports = {
            now: () => clock,
            sleep: async (ms: number) => { clock += ms; },
            discordRunning: async () => true, // macOS does not wait for a closed Discord
            mtimeOf: () => Math.min(clock, updateEndsAt),
            readDiscordVersion: () => ok({ version: clock < updateEndsAt ? "0.0.413" : "0.0.414" } as never)
        };
        const report = await awaitDiscordSettled(install, ports, { requireDiscordClosed: false });
        expect(report.settled).toBe(true);
        expect(report.version).toBe("0.0.414");
        // Not before the update ended plus the quiet window and the confirmation...
        expect(clock).toBeGreaterThanOrEqual(updateEndsAt + DEFAULT_QUIET_MS);
        // ...and within seconds of it, not a minute (the old 45s window).
        expect(clock - updateEndsAt).toBeLessThanOrEqual(DEFAULT_QUIET_MS + DEFAULT_CONFIRM_MS + 10_000);
        expect(clock - updateEndsAt).toBeLessThan(30_000);
    });

    it("an update that never stops within the budget defers quietly, it does not fail", async () => {
        let clock = 0;
        const report = await awaitDiscordSettled(install, {
            now: () => clock,
            sleep: async (ms: number) => { clock += ms; },
            discordRunning: async () => false,
            mtimeOf: () => clock,
            readDiscordVersion: () => ok({ version: "0.0.414" } as never)
        });
        expect(report.settled).toBe(false);
        expect(report.status).toBe("files-changing");
        expect(clock).toBeLessThanOrEqual(DEFAULT_MAX_WAIT_MS + DEFAULT_CONFIRM_MS);
    });
});

describe("a run with nothing to do", () => {
    const report = (over: Partial<HelperRunReport> = {}): HelperRunReport => ({
        at: 0, found: 1, managed: 1, repatched: [], deferred: [], failed: [], updateChecked: false,
        updateInstalled: null, health: null, alerts: [], decisions: [], summary: "nothing to do", ...over
    });

    it("writes exactly one line, and no header", () => {
        const lines: string[] = [];
        const target = {
            info: (e: string) => lines.push(e), warn: (e: string) => lines.push(e), error: (e: string) => lines.push(e)
        };
        const held = bufferedLogger(target);
        for (let i = 0; i < 6; i++) held.logger.info("helper.scan", { outcome: "ok" });
        let headers = 0;
        const idle = concludeHelperLog(report(), held, target, () => { headers++; });
        expect(idle).toBe(true);
        expect(lines).toEqual(["helper.idle"]);
        expect(headers).toBe(0);
    });

    it("a run that did something writes the header and every held line, in order", () => {
        const lines: string[] = [];
        const target = {
            info: (e: string) => lines.push(e), warn: (e: string) => lines.push(e), error: (e: string) => lines.push(e)
        };
        const held = bufferedLogger(target);
        held.logger.info("helper.scan");
        held.logger.warn("helper.repatch");
        let headers = 0;
        const idle = concludeHelperLog(report({ repatched: [RES_A] }), held, target, () => { headers++; lines.push("header"); });
        expect(idle).toBe(false);
        expect(lines).toEqual(["header", "helper.scan", "helper.repatch"]);
        expect(headers).toBe(1);
    });

    it("anything that touched the network, deferred, failed or alerted is not idle", () => {
        expect(isIdleRun(report())).toBe(true);
        expect(isIdleRun(report({ updateChecked: true }))).toBe(false);
        expect(isIdleRun(report({ deferred: [RES_A] }))).toBe(false);
        expect(isIdleRun(report({ failed: [RES_A] }))).toBe(false);
        expect(isIdleRun(report({ health: { status: "broken" } as never }))).toBe(false);
        expect(isIdleRun(report({ health: { status: "healthy" } as never }))).toBe(true);
    });
});

describe("which Discords are watched", () => {
    const mk = (name: string, stableId: string) =>
        ({ resourcesPath: `/Applications/${name}.app/Contents/Resources`, stableId }) as DiscordInstall;

    it("patched by us, or remembered after an update wiped the patch; never another mod's", () => {
        const ours = mk("Discord", "a");
        const wiped = mk("Discord PTB", "b");
        const other = mk("Discord Canary", "c");
        const never = mk("Discord Dev", "d");
        const kinds: Record<string, string> = { a: "patched-by-us", b: "unpatched", c: "patched-by-other", d: "unpatched" };
        const result = managedResourcesPaths(
            () => ok([never, other, wiped, ours]),
            install => ok({ kind: kinds[install.stableId] } as never),
            new Set(["b", "c"])
        );
        expect(result).toEqual([ours.resourcesPath, wiped.resourcesPath].sort());
    });

    it("never throws: an unreadable install is left out", () => {
        const result = managedResourcesPaths(() => { throw new Error("boom"); }, () => ok({ kind: "patched-by-us" } as never), new Set());
        expect(result).toEqual([]);
    });
});


describe("Windows: a removed helper is never brought back by the helper itself", () => {
    it("ensureHelperFromHelper skips a task the user removed, and does not register it again", async () => {
        await installHelperFor(windowsWiring(), "win32", home);
        await schtasks.remove(HELPER_TASK_NAME);
        const result = await ensureHelperFromHelper(windowsWiring(), "win32", home);
        expect(result).toEqual({ action: "skipped", reason: "not-registered" });
        expect(await schtasks.exists(HELPER_TASK_NAME)).toBe(false);
    });

    it("the app itself still repairs a missing task (ensureHelperFor from the UI)", async () => {
        const result = await ensureHelperFor(windowsWiring(), "win32", home);
        expect(result.ok && result.value.action).toBe("repaired");
        expect(await schtasks.exists(HELPER_TASK_NAME)).toBe(true);
    });

    it("reads the task definition ONCE per check when the port can", async () => {
        await installHelperFor(windowsWiring(), "win32", home);
        let reads = 0;
        const port = {
            ...schtasks,
            queryDefinition: async (name: string) => {
                reads += 1;
                return schtasks.registered.has(name)
                    ? { command: schtasks.commands.get(name) ?? null, interval: schtasks.intervals.get(name) ?? null }
                    : null;
            },
            queryCommand: async () => { throw new Error("should use queryDefinition"); },
            queryInterval: async () => { throw new Error("should use queryDefinition"); }
        };
        const result = await ensureHelperFor({ ...windowsWiring(), schtasks: port }, "win32", home);
        expect(result.ok && result.value.action).toBe("unchanged");
        expect(reads).toBe(1);
    });
});
