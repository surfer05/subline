import { describe, expect, it } from "vitest";

import {
    findDiscordProcesses,
    isDiscordRunning,
    parsePsOutput,
    processNameFor,
    quitDiscord
} from "../src/app/discordProcess.js";
import type { QuitDiscordOptions, RunningProcess } from "../src/app/discordProcess.js";

const DISCORD = { pid: 100, command: "/Applications/Discord.app/Contents/MacOS/Discord" };
const HELPER = {
    pid: 101,
    command: "/Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer).app/Contents/MacOS/Discord Helper (Renderer)"
};
const UNRELATED = { pid: 102, command: "/Users/x/dev/discord-translate/node_modules/.bin/vitest" };

describe("processNameFor", () => {
    it("names the branch-specific binary on each platform", () => {
        expect(processNameFor("stable", "darwin")).toBe("Discord");
        expect(processNameFor("ptb", "darwin")).toBe("Discord PTB");
        expect(processNameFor("canary", "darwin")).toBe("Discord Canary");
        expect(processNameFor("stable", "win32")).toBe("Discord.exe");
        expect(processNameFor("canary", "win32")).toBe("DiscordCanary.exe");
    });
});

describe("findDiscordProcesses", () => {
    it("finds the app itself", () => {
        expect(findDiscordProcesses([DISCORD], "stable", "darwin")).toEqual([DISCORD]);
    });

    it("ignores helper processes, which only exit when their parent does", () => {
        expect(findDiscordProcesses([HELPER], "stable", "darwin")).toEqual([]);
    });

    it("ignores an unrelated command that merely mentions discord in its path", () => {
        expect(findDiscordProcesses([UNRELATED], "stable", "darwin")).toEqual([]);
    });

    it("does not confuse branches", () => {
        const ptb = { pid: 200, command: "/Applications/Discord PTB.app/Contents/MacOS/Discord PTB" };
        expect(findDiscordProcesses([DISCORD, ptb], "stable", "darwin")).toEqual([DISCORD]);
        expect(findDiscordProcesses([DISCORD, ptb], "ptb", "darwin")).toEqual([ptb]);
    });

    it("matches Windows image names case-insensitively and by backslash segment", () => {
        const win = { pid: 300, command: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.9200\\discord.exe" };
        expect(findDiscordProcesses([win], "stable", "win32")).toEqual([win]);
        expect(findDiscordProcesses([win], "canary", "win32")).toEqual([]);
    });
});

describe("parsePsOutput", () => {
    it("parses padded pids and command paths containing spaces", () => {
        const stdout = [
            "  100 /Applications/Discord.app/Contents/MacOS/Discord",
            "  101 /Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer)",
            ""
        ].join("\n");
        expect(parsePsOutput(stdout)).toEqual([
            { pid: 100, command: "/Applications/Discord.app/Contents/MacOS/Discord" },
            { pid: 101, command: "/Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer)" }
        ]);
    });

    it("skips blank and malformed lines instead of producing NaN pids", () => {
        expect(parsePsOutput("\n\nnot a process line\n  42 /bin/thing\n")).toEqual([
            { pid: 42, command: "/bin/thing" }
        ]);
    });

    it("returns an empty list for empty output", () => {
        expect(parsePsOutput("")).toEqual([]);
    });
});

/* ------------------------------------------------------------------------ */

class Harness {
    quitRequests = 0;
    private t = 0;
    private call = 0;
    readonly options: QuitDiscordOptions;

    constructor(script: { tables: RunningProcess[][]; requestQuit?: () => Promise<void> }) {
        this.options = {
            branch: "stable",
            platform: "darwin",
            listProcesses: async () => {
                const index = Math.min(this.call++, script.tables.length - 1);
                return script.tables[index] ?? [];
            },
            requestQuit: script.requestQuit ?? (async () => { this.quitRequests += 1; }),
            clock: () => this.t,
            sleep: async (ms: number) => { this.t += ms; },
            gracePeriodMs: 5_000,
            pollIntervalMs: 1_000
        };
    }
}

function harness(script: { tables: RunningProcess[][]; requestQuit?: () => Promise<void> }): Harness {
    return new Harness(script);
}

describe("isDiscordRunning", () => {
    it("returns the matching processes", async () => {
        const found = await isDiscordRunning({
            branch: "stable",
            platform: "darwin",
            listProcesses: async () => [DISCORD, HELPER, UNRELATED]
        });
        expect(found).toEqual([DISCORD]);
    });
});

describe("quitDiscord", () => {
    it("does nothing when Discord is not running", async () => {
        const h = harness({ tables: [[]] });
        const report = await quitDiscord(h.options);
        expect(report.outcome).toBe("not-running");
        expect(report.clear).toBe(true);
        expect(h.quitRequests).toBe(0);
    });

    it("asks Discord to quit and confirms against the process table, not against the request returning", async () => {
        const h = harness({ tables: [[DISCORD], [DISCORD], []] });
        const report = await quitDiscord(h.options);
        expect(report.outcome).toBe("quit");
        expect(report.clear).toBe(true);
        expect(report.pids).toEqual([100]);
        expect(h.quitRequests).toBe(1);
    });

    it("gives up asking after the grace period and hands it to the user — never a kill", async () => {
        const h = harness({ tables: [[DISCORD]] });
        const report = await quitDiscord(h.options);
        expect(report.outcome).toBe("still-running");
        expect(report.clear).toBe(false);
        expect(report.summary).toContain("Subline will not force it to close");
        // Asked exactly once. Repeated quit requests would be indistinguishable
        // from nagging, and none of them helps a modal dialog.
        expect(h.quitRequests).toBe(1);
    });

    it("reports a named outcome when the quit request itself fails", async () => {
        const h = harness({
            tables: [[DISCORD]],
            requestQuit: async () => { throw new Error("osascript: not authorised"); }
        });
        const report = await quitDiscord(h.options);
        expect(report.outcome).toBe("quit-failed");
        expect(report.clear).toBe(false);
        expect(report.cause).toContain("not authorised");
        expect(report.summary).toContain("Quit Discord yourself");
    });

    it("does not treat a lingering helper as Discord still running", async () => {
        const h = harness({ tables: [[DISCORD], [HELPER]] });
        const report = await quitDiscord(h.options);
        expect(report.outcome).toBe("quit");
        expect(report.clear).toBe(true);
    });

    it("polls a bounded number of times, so a Discord that never quits cannot hang the installer", async () => {
        let polls = 0;
        let t = 0;
        const report = await quitDiscord({
            branch: "stable",
            platform: "darwin",
            listProcesses: async () => { polls += 1; return [DISCORD]; },
            requestQuit: async () => {},
            gracePeriodMs: 5_000,
            pollIntervalMs: 1_000,
            clock: () => t,
            sleep: async (ms: number) => { t += ms; }
        });
        expect(report.outcome).toBe("still-running");
        // One initial check plus at most grace/interval + 1 polls.
        expect(polls).toBeLessThanOrEqual(8);
    }, 5_000);
});
