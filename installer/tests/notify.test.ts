/**
 * Telling the user something, and saying in the log whether it worked.
 *
 * This path had no test at all, and on Windows it had no implementation: the
 * port was `platform === "darwin" ? notifyMac(...) : Promise.resolve()`, so
 * every alert the helper raised on Windows was discarded by an expression that
 * looked like a deliberate platform check. Nothing distinguished it, in a log or
 * anywhere else, from a notification that was delivered.
 *
 * So the assertions here are as much about the LOGGING as the notifying. A
 * background process nobody is watching is exactly where a silent failure costs
 * the most, because the only evidence anyone will ever have is the log file.
 */

import { describe, expect, it } from "vitest";

import type { Alert } from "../src/helper/alerts.js";
import { notify, notifyWindows } from "../src/helper/ports.js";

const ALERT: Alert = {
    code: "repatch-failed",
    message: "Subline could not repair Discord after an update.",
    detail: { attempts: 3 },
    at: 1_700_000_000_000
};

function recorder() {
    const lines: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
    return {
        lines,
        log: {
            info: (event: string, fields: Record<string, unknown> = {}) => { lines.push({ level: "info", event, fields }); },
            warn: (event: string, fields: Record<string, unknown> = {}) => { lines.push({ level: "warn", event, fields }); },
            error: (event: string, fields: Record<string, unknown> = {}) => { lines.push({ level: "error", event, fields }); }
        }
    };
}

describe("notify", () => {
    it("uses osascript on macOS and records that it went out", async () => {
        const seen: string[][] = [];
        const { lines, log } = recorder();
        await notify(ALERT, "darwin", async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; }, log);

        expect(seen[0]?.[0]).toBe("/usr/bin/osascript");
        expect(lines.map(line => line.event)).toContain("notify.sent");
    });

    it("actually notifies on Windows instead of resolving to nothing", async () => {
        const seen: string[][] = [];
        const { lines, log } = recorder();
        await notify(ALERT, "win32", async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; }, log);

        // The regression this replaces: no call at all, and a clean log.
        expect(seen).toHaveLength(1);
        expect(seen[0]?.[0]).toBe("powershell");
        expect(lines.map(line => line.event)).toContain("notify.sent");
    });

    it("logs a failure rather than swallowing it, and does not throw", async () => {
        const { lines, log } = recorder();
        // The helper's job is repairing Discord. An undelivered message must not
        // undo a completed repair — but it must not vanish either.
        await expect(notify(ALERT, "win32", async () => { throw new Error("powershell is missing"); }, log))
            .resolves.toBeUndefined();

        const failure = lines.find(line => line.event === "notify.failed");
        expect(failure).toBeDefined();
        expect(failure?.level).toBe("warn");
        // The cause, not just the fact — the whole lesson of the Windows install.
        expect(String(failure?.fields.cause)).toContain("powershell is missing");
    });

    it("says so when the platform has no notifier, instead of reporting success", async () => {
        const seen: string[][] = [];
        const { lines, log } = recorder();
        await notify(ALERT, "linux", async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; }, log);

        expect(seen).toEqual([]);
        expect(lines.map(line => line.event)).toContain("notify.unsupported");
        expect(lines.map(line => line.event)).not.toContain("notify.sent");
    });
});

describe("the Windows notification itself", () => {
    it("runs PowerShell with no profile and no prompt", async () => {
        const seen: string[][] = [];
        await notifyWindows(ALERT, async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; });
        const args = seen[0] ?? [];
        // A background task inherits no console. A PowerShell that decides to
        // prompt — or runs a profile script that does — hangs until the task's
        // time limit instead of notifying anybody.
        expect(args).toContain("-NoProfile");
        expect(args).toContain("-NonInteractive");
    });

    it("carries the message text", async () => {
        const seen: string[][] = [];
        await notifyWindows(ALERT, async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; });
        expect(seen[0]?.join(" ")).toContain("Subline could not repair Discord after an update.");
    });

    it("cannot be made to run something else by the text of an alert", async () => {
        const seen: string[][] = [];
        const nasty: Alert = { ...ALERT, message: "hi'; Start-Process calc.exe; $x='" };
        await notifyWindows(nasty, async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; });

        const command = seen[0]?.join(" ") ?? "";
        // Quotes are REPLACED, not escaped: our messages are fixed strings with
        // scalars interpolated, so nothing is lost, and there is no escaping
        // scheme to get subtly wrong inside a string nested two levels deep.
        expect(command).not.toContain("';");
        expect(command).not.toContain("$x=");
    });
});
