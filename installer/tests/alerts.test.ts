/**
 * Surfacing what the helper could not fix.
 *
 * Two properties, pulling against each other. It must reach the user somewhere
 * they will actually see (spec §6's "silent by default" has a boundary), and it
 * must not nag — an updater that warns falsely, or repeatedly, gets ignored when
 * it warns truthfully.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    ALERTS_FILENAME, ALERTS_FORMAT, alertsPathFor, DEFAULT_REPEAT_MS, pendingAlertCodes, raiseAlert,
    readPendingAlerts, resolveAlert
} from "../src/helper/alerts.js";
import type { Alert, AlertPorts } from "../src/helper/alerts.js";
import { emptyHelperState } from "../src/helper/state.js";
import type { HelperState } from "../src/helper/state.js";

const START = 1_700_000_000_000;

let dir: string;
let shown: Alert[];
let clock: number;
let state: HelperState;

function ports(overrides: Partial<AlertPorts> = {}): AlertPorts {
    return {
        notify: async alert => {
            shown.push(alert);
        },
        productDir: dir,
        now: () => clock,
        ...overrides
    };
}

function alert(code: Alert["code"], at: number = clock): Alert {
    return { code, message: "something went wrong", detail: { code: "IO_ERROR" }, at };
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subline-alerts-"));
    shown = [];
    clock = START;
    state = emptyHelperState();
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("raising an alert", () => {
    it("notifies AND writes a durable record, because either alone is missable", async () => {
        const raised = await raiseAlert(state, alert("repatch-failed"), ports());

        expect(raised.notified).toBe(true);
        expect(shown.map(entry => entry.code)).toEqual(["repatch-failed"]);
        // The file is what survives Do Not Disturb, a sleeping Mac, or nobody
        // being at the machine.
        expect(existsSync(alertsPathFor(dir))).toBe(true);
        expect(readPendingAlerts(dir).map(entry => entry.code)).toEqual(["repatch-failed"]);
    });

    it("writes the format and product so the app can refuse a file that is not ours", () => {
        void raiseAlert(state, alert("mod-stale"), ports());
        const document = JSON.parse(readFileSync(join(dir, ALERTS_FILENAME), "utf8"));
        expect(document.format).toBe(ALERTS_FORMAT);
        expect(document.product).toBe("subline");
    });

    it("does not notify again inside the repeat window, however often the condition is seen", async () => {
        await raiseAlert(state, alert("mod-stale"), ports());
        for (let index = 0; index < 20; index += 1) {
            clock += 60 * 60_000;
            await raiseAlert(state, alert("mod-stale"), ports());
        }

        expect(shown).toHaveLength(1);
        // But the record still counts every sighting, so the log is honest.
        expect(state.alerts["mod-stale"]?.count).toBe(21);
    });

    it("notifies again once the window has passed and the problem is still there", async () => {
        await raiseAlert(state, alert("mod-stale"), ports());
        clock += DEFAULT_REPEAT_MS + 1;
        const second = await raiseAlert(state, alert("mod-stale"), ports());

        expect(second.notified).toBe(true);
        expect(shown).toHaveLength(2);
    });

    it("keeps the durable record even when the notification is suppressed as a repeat", async () => {
        await raiseAlert(state, alert("update-failed"), ports());
        rmSync(alertsPathFor(dir), { force: true });
        clock += 60_000;

        const second = await raiseAlert(state, alert("update-failed"), ports());
        expect(second.notified).toBe(false);
        expect(existsSync(alertsPathFor(dir))).toBe(true);
    });

    it("survives a notification that will not display", async () => {
        const raised = await raiseAlert(
            state,
            alert("backup-missing"),
            ports({ notify: () => Promise.reject(new Error("no notification centre")) })
        );

        expect(raised.notified).toBe(false);
        expect(raised.reason).toContain("could not be shown");
        // The record is still there — the whole point of having two surfaces.
        expect(readPendingAlerts(dir).map(entry => entry.code)).toEqual(["backup-missing"]);
    });

    it("does not fail on a platform with nowhere to write", async () => {
        const raised = await raiseAlert(state, alert("repatch-failed"), ports({ productDir: null }));
        expect(raised.notified).toBe(true);
        expect(readPendingAlerts(null)).toEqual([]);
    });
});

describe("clearing an alert", () => {
    it("removes the file entirely when nothing is outstanding", async () => {
        await raiseAlert(state, alert("update-failed"), ports());
        expect(resolveAlert(state, "update-failed", ports())).toBe(true);

        // ABSENT, not empty: an empty file is indistinguishable from one we
        // failed to write.
        expect(existsSync(alertsPathFor(dir))).toBe(false);
        expect(readPendingAlerts(dir)).toEqual([]);
    });

    it("leaves the others in place", async () => {
        await raiseAlert(state, alert("update-failed"), ports());
        await raiseAlert(state, alert("mod-stale"), ports());
        resolveAlert(state, "update-failed", ports());

        expect(pendingAlertCodes(state)).toEqual(["mod-stale"]);
        expect(readPendingAlerts(dir).map(entry => entry.code)).toEqual(["mod-stale"]);
    });

    it("reports that there was nothing to clear", () => {
        expect(resolveAlert(state, "rollback-failed", ports())).toBe(false);
    });
});

describe("reading them back", () => {
    it("ignores a file that is not readable, rather than failing the app's launch", () => {
        rmSync(dir, { recursive: true, force: true });
        expect(readPendingAlerts(dir)).toEqual([]);
    });

    it("drops entries that carry no code or no timestamp", async () => {
        await raiseAlert(state, alert("mod-stale"), ports());
        const path = alertsPathFor(dir);
        const document = JSON.parse(readFileSync(path, "utf8"));
        document.alerts.push({ code: 42, firstAt: 1 }, { firstAt: 2 }, "not an object");
        rmSync(path, { force: true });
        writeFileSync(path, JSON.stringify(document), "utf8");

        expect(readPendingAlerts(dir).map(entry => entry.code)).toEqual(["mod-stale"]);
    });
});
