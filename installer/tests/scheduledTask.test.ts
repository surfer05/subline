/**
 * The Windows Scheduled Task, in isolation.
 *
 * `helperWiring.test.ts` covers the wiring — that the flow really registers one
 * and the uninstaller really removes it. This file covers the definition itself:
 * what gets written, and what happens when Windows says no.
 *
 * Nothing here registers a real task. `schtasks` is a fake and `workDir` is a
 * temp directory, exactly as `launchAgent.test.ts` never registers a real agent.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_INTERVAL_SECONDS, HELPER_FLAG } from "../src/helper/launchAgent.js";
import {
    HELPER_TASK_NAME,
    helperScheduledTaskSpec,
    installScheduledTask,
    isoDuration,
    removeScheduledTask,
    renderScheduledTaskXml
} from "../src/helper/scheduledTask.js";
import { makeFakeSchtasks } from "./fixture.js";
import type { FakeSchtasks } from "./fixture.js";

const EXE = "C:\\Users\\x\\AppData\\Local\\Programs\\Subline\\Subline.exe";

let workDir: string;
let schtasks: FakeSchtasks;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "subline-task-"));
    schtasks = makeFakeSchtasks();
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
});

const install = () => installScheduledTask({
    spec: helperScheduledTaskSpec(EXE),
    workDir,
    schtasks,
    platform: "win32"
});

describe("isoDuration", () => {
    it("renders the durations Task Scheduler accepts", () => {
        expect(isoDuration(3600)).toBe("PT1H");
        expect(isoDuration(7200)).toBe("PT2H");
        expect(isoDuration(1800)).toBe("PT30M");
        expect(isoDuration(90)).toBe("PT90S");
    });

    it("never renders an interval Windows would reject as too small", () => {
        // Task Scheduler's minimum repetition is one minute. A zero or negative
        // interval — from a mis-set config, say — would produce XML that fails
        // to register, which presents as a helper that silently never runs.
        expect(isoDuration(0)).toBe("PT1M");
        expect(isoDuration(-5)).toBe("PT1M");
    });
});

describe("the task definition", () => {
    it("runs this executable with the helper flag, hourly and at logon", () => {
        const xml = renderScheduledTaskXml(helperScheduledTaskSpec(EXE));
        expect(xml).toContain(`<Command>${EXE}</Command>`);
        expect(xml).toContain(`<Arguments>${HELPER_FLAG}</Arguments>`);
        expect(xml).toContain(`<Interval>${isoDuration(DEFAULT_INTERVAL_SECONDS)}</Interval>`);
        expect(xml).toContain("<LogonTrigger>");
        expect(xml).toContain("<TimeTrigger>");
    });

    it("repeats indefinitely rather than stopping after a day", () => {
        const xml = renderScheduledTaskXml(helperScheduledTaskSpec(EXE));
        // An omitted <Duration> means "forever". A bounded one would stop the
        // helper after its window and leave the NEXT Discord update unrepaired,
        // which is the failure this whole mechanism exists to prevent.
        expect(xml).not.toContain("<Duration>");
        expect(xml).toContain("<StopAtDurationEnd>false</StopAtDurationEnd>");
    });

    it("still runs on battery and after a missed window", () => {
        const xml = renderScheduledTaskXml(helperScheduledTaskSpec(EXE));
        // A laptop that is never plugged in at the scheduled minute would
        // otherwise never repair itself, and StartWhenAvailable is what covers
        // the machine that was switched off when Discord updated.
        expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
        expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    });

    it("asks for no more privilege than it needs", () => {
        const xml = renderScheduledTaskXml(helperScheduledTaskSpec(EXE));
        // The helper writes inside the user's own AppData. A task registered to
        // run elevated would be a permanent SYSTEM-level foothold installed by
        // a chat translator.
        expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
        expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    });

    it("escapes a path that would otherwise break the XML", () => {
        // NSIS lets the install directory be chosen, and Windows allows `&` in
        // folder names. Unescaped, the definition is rejected and the helper
        // silently never runs — the same hazard the plist renderer escapes for.
        const xml = renderScheduledTaskXml(helperScheduledTaskSpec("C:\\Program Files\\R&D <x>\\Subline.exe"));
        expect(xml).toContain("R&amp;D &lt;x&gt;");
        expect(xml).not.toContain("R&D <x>");
    });

    it("produces the same definition every time it is asked", () => {
        // Derived from the clock, two runs on one machine would differ and two
        // machines could never be compared. It also makes the output testable.
        expect(renderScheduledTaskXml(helperScheduledTaskSpec(EXE)))
            .toBe(renderScheduledTaskXml(helperScheduledTaskSpec(EXE)));
    });
});

describe("registering", () => {
    it("creates the task and confirms it by querying it back", async () => {
        const result = await install();
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        expect(result.value.name).toBe(HELPER_TASK_NAME);
        expect(result.value.registered).toBe(true);
        expect(result.value.replaced).toBe(false);
        expect(schtasks.calls).toContain(`create ${HELPER_TASK_NAME}`);
    });

    it("reports a replacement when one was already registered", async () => {
        await install();
        const again = await install();
        expect(again.ok).toBe(true);
        if (!again.ok) throw new Error(again.error.message);
        expect(again.value.replaced).toBe(true);
    });

    it("refuses on a platform with no Scheduled Tasks", async () => {
        const result = await installScheduledTask({
            spec: helperScheduledTaskSpec(EXE),
            workDir,
            schtasks,
            platform: "darwin"
        });
        expect(result.ok).toBe(false);
        // And it did not write a file or call anything.
        expect(schtasks.calls).toEqual([]);
        expect(readdirSync(workDir)).toEqual([]);
    });

    it("removes the hand-off XML even when registration fails", async () => {
        schtasks.failCreate = true;
        const result = await install();
        expect(result.ok).toBe(false);
        // A leftover definition next to a task that does not exist is worse
        // than no file at all: the next reader cannot tell which is true.
        expect(readdirSync(workDir)).toEqual([]);
        expect(existsSync(join(workDir, "subline-helper-task.xml"))).toBe(false);
    });

    it("does not report success from the create's exit code alone", async () => {
        schtasks.lieAboutRegistered = true;
        const result = await install();
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected a refusal");
        expect(result.error.code).toBe("HELPER_REGISTRATION_FAILED");
    });
});

describe("removing", () => {
    it("deletes a registered task and verifies it is gone", async () => {
        await install();
        const removed = await removeScheduledTask({ schtasks, platform: "win32" });
        expect(removed.ok).toBe(true);
        if (!removed.ok) throw new Error(removed.error.message);
        expect(removed.value).toBe(true);
        expect(schtasks.registered.size).toBe(0);
    });

    it("reports false, not an error, when there is nothing registered", async () => {
        const removed = await removeScheduledTask({ schtasks, platform: "win32" });
        expect(removed.ok).toBe(true);
        if (!removed.ok) throw new Error("unreachable");
        expect(removed.value).toBe(false);
        // Nothing was deleted, so nothing was asked to be.
        expect(schtasks.calls.filter(call => call.startsWith("delete"))).toEqual([]);
    });

    it("fails when Windows still lists the task after deleting it", async () => {
        await install();
        // Deletion "succeeds" but the task survives: reporting a clean removal
        // here would leave an uninstalled product re-patching Discord hourly.
        schtasks.remove = async () => ({ ok: true, value: true });
        const removed = await removeScheduledTask({ schtasks, platform: "win32" });
        expect(removed.ok).toBe(false);
    });

    it("is a no-op off Windows", async () => {
        const removed = await removeScheduledTask({ schtasks, platform: "darwin" });
        expect(removed.ok).toBe(true);
        expect(schtasks.calls).toEqual([]);
    });
});
