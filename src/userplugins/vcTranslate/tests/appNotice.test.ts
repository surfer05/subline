import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    APP_DOWNLOAD_URL, APP_NOTICE_COPY, APP_NOTICE_SHOWN_KEY, appTooOld, checkAppNotice, compareVersions,
    MIN_APP_VERSION, shouldShowAppNotice
} from "../appNotice";
import { type AppSignals, parseAppVersion, parseCannotRepair, readAppSignalsSync } from "../appSignals";

/** The product directory as the plugin reads it, built in a temp dir. */
let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subline-appsignals-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function stageMod(): void {
    mkdirSync(join(dir, "mod"), { recursive: true });
    writeFileSync(join(dir, "mod", "subline-mod.json"), JSON.stringify({ buildId: "0123456789abcdef" }));
}

function memoryStore(initial: Record<string, unknown> = {}) {
    const mem = new Map<string, unknown>(Object.entries(initial));
    return {
        mem,
        get: async (key: string) => mem.get(key),
        set: async (key: string, value: unknown) => { mem.set(key, value); }
    };
}

/** One plugin start: read the real files in `dir`, decide, maybe show. */
async function startOnce(store: ReturnType<typeof memoryStore>, modVersion = "0.2.3") {
    const show = vi.fn();
    const shown = await checkAppNotice({
        modVersion,
        readSignals: async () => readAppSignalsSync({ dir }),
        storage: store,
        show
    });
    expect(shown).toBe(show.mock.calls.length === 1);
    return show.mock.calls.length;
}

describe("the copy", () => {
    it("is exactly what the owner asked for, with no em dash", () => {
        expect(APP_NOTICE_COPY.text).toBe("Download the new Subline once to keep it working after Discord updates.");
        expect(APP_NOTICE_COPY.button).toBe("Download");
        expect(APP_NOTICE_COPY.later).toBe("Later");
        for (const s of Object.values(APP_NOTICE_COPY)) expect(s).not.toMatch(/[–—]/);
        expect(APP_DOWNLOAD_URL.startsWith("https://subline.page")).toBe(true);
        expect(MIN_APP_VERSION).toBe("0.2.3");
    });
});

describe("compareVersions / appTooOld", () => {
    it("orders numerically, not as text", () => {
        expect(compareVersions("0.2.10", "0.2.3")).toBe(1);
        expect(compareVersions("0.1.3", "0.2.3")).toBe(-1);
        expect(compareVersions("0.2.3", "0.2.3")).toBe(0);
        expect(compareVersions("0.2", "0.2.0")).toBe(0);
        expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    });
    it("null is old; the minimum and above are not", () => {
        expect(appTooOld(null)).toBe(true);
        expect(appTooOld("0.2.2")).toBe(true);
        expect(appTooOld("0.2.3")).toBe(false);
        expect(appTooOld("0.3.0")).toBe(false);
    });
});

describe("the files (worst cases)", () => {
    it("no signal file (an old app) reads as no version", () => {
        stageMod();
        expect(readAppSignalsSync({ dir })).toEqual({ managed: true, appVersion: null, cannotRepair: false });
    });
    it("a corrupt version file reads as old and never throws", () => {
        stageMod();
        for (const junk of ["", "{", "null", "[]", "42", '{"appVersion":7}', '{"appVersion":"0.2.3; rm -rf"}', "\u0000\u0001"]) {
            writeFileSync(join(dir, "app-version.json"), junk);
            expect(() => readAppSignalsSync({ dir })).not.toThrow();
            expect(readAppSignalsSync({ dir }).appVersion).toBeNull();
        }
        expect(parseAppVersion("not json")).toBeNull();
    });
    it("a directory where the file should be reads as old and never throws", () => {
        stageMod();
        mkdirSync(join(dir, "app-version.json"));
        mkdirSync(join(dir, "alerts.json"));
        expect(readAppSignalsSync({ dir })).toEqual({ managed: true, appVersion: null, cannotRepair: false });
    });
    it("a missing product directory is not managed", () => {
        expect(readAppSignalsSync({ dir: join(dir, "nope") }).managed).toBe(false);
    });
    it("an unsupported platform reads nothing", () => {
        expect(readAppSignalsSync({ platform: "linux" })).toEqual({ managed: false, appVersion: null, cannotRepair: false });
    });
    it("alerts: only the could-not-repair codes count, corrupt is none", () => {
        const doc = (code: string) => JSON.stringify({ format: 1, product: "subline", alerts: [{ code, firstAt: 1, count: 1 }] });
        expect(parseCannotRepair(doc("repatch-failed"))).toBe(true);
        expect(parseCannotRepair(doc("rollback-failed"))).toBe(true);
        expect(parseCannotRepair(doc("backup-missing"))).toBe(true);
        expect(parseCannotRepair(doc("restart-required"))).toBe(false);
        expect(parseCannotRepair(doc("update-failed"))).toBe(false);
        for (const junk of ["", "{", "null", '{"alerts":5}', '{"alerts":[null,1,"x"]}']) {
            expect(parseCannotRepair(junk)).toBe(false);
        }
    });
});

describe("the decision", () => {
    const sig = (s: Partial<AppSignals>): AppSignals => ({ managed: true, appVersion: "0.2.3", cannotRepair: false, ...s });
    it("never on an install Subline does not manage", () => {
        expect(shouldShowAppNotice(sig({ managed: false, appVersion: null, cannotRepair: true }), "0.2.3", undefined)).toBe(false);
    });
    it("shows for an old app only; a stale repair alert on a current app does not show it", () => {
        expect(shouldShowAppNotice(sig({ appVersion: null }), "0.2.3", undefined)).toBe(true);
        expect(shouldShowAppNotice(sig({ appVersion: "0.1.3" }), "0.2.3", undefined)).toBe(true);
        expect(shouldShowAppNotice(sig({ appVersion: "0.1.3", cannotRepair: true }), "0.2.3", undefined)).toBe(true);
        expect(shouldShowAppNotice(sig({ cannotRepair: true }), "0.2.3", undefined)).toBe(false);
        expect(shouldShowAppNotice(sig({}), "0.2.3", undefined)).toBe(false);
    });
});

describe("checkAppNotice, start to start", () => {
    it("no signal file (old app): the notice shows once, then never again for this mod version", async () => {
        stageMod();
        const store = memoryStore();
        expect(await startOnce(store)).toBe(1);
        expect(store.mem.get(APP_NOTICE_SHOWN_KEY)).toBe("0.2.3");
        // Discord restarts, the app is still old: dismissed stays dismissed.
        expect(await startOnce(store)).toBe(0);
        expect(await startOnce(store)).toBe(0);
    });

    it("comes back after a later mod update only while the app is still old", async () => {
        stageMod();
        const store = memoryStore();
        expect(await startOnce(store, "0.2.3")).toBe(1);
        expect(await startOnce(store, "0.2.4")).toBe(1);
        expect(await startOnce(store, "0.2.4")).toBe(0);
        // The user installed the new app; the next mod update says nothing.
        writeFileSync(join(dir, "app-version.json"), JSON.stringify({ format: 1, product: "subline", appVersion: "0.2.4" }));
        expect(await startOnce(store, "0.2.5")).toBe(0);
    });

    it("new app: no notice", async () => {
        stageMod();
        writeFileSync(join(dir, "app-version.json"), JSON.stringify({ format: 1, product: "subline", appVersion: "0.2.3" }));
        const store = memoryStore();
        expect(await startOnce(store)).toBe(0);
        expect(store.mem.has(APP_NOTICE_SHOWN_KEY)).toBe(false);
    });

    it("corrupt signal file: treated as old, shown once, never throws", async () => {
        stageMod();
        writeFileSync(join(dir, "app-version.json"), "{\"appVersion\": \"0.2.");
        const store = memoryStore();
        expect(await startOnce(store)).toBe(1);
        expect(await startOnce(store)).toBe(0);
    });

    it("new app with a stale 'could not repair' alert: no notice, and the once-mark is not spent", async () => {
        stageMod();
        writeFileSync(join(dir, "app-version.json"), JSON.stringify({ appVersion: "0.2.3" }));
        writeFileSync(join(dir, "alerts.json"), JSON.stringify({
            format: 1, product: "subline", updatedAt: 1,
            alerts: [{ code: "repatch-failed", firstAt: 1, lastNotifiedAt: 1, count: 2 }]
        }));
        const store = memoryStore();
        expect(await startOnce(store)).toBe(0);
        expect(store.mem.has(APP_NOTICE_SHOWN_KEY)).toBe(false);
    });

    it("a hand-built install (no staged mod) is never told to download", async () => {
        expect(await startOnce(memoryStore())).toBe(0);
    });

    it("a reader that rejects, or a store that fails, shows nothing and never throws", async () => {
        const show = vi.fn();
        await expect(checkAppNotice({
            modVersion: "0.2.3",
            readSignals: () => Promise.reject(new Error("bridge gone")),
            storage: memoryStore(),
            show
        })).resolves.toBe(false);
        await expect(checkAppNotice({
            modVersion: "0.2.3",
            readSignals: async () => ({ managed: true, appVersion: null, cannotRepair: false }),
            storage: { get: async () => undefined, set: () => Promise.reject(new Error("idb")) },
            show
        })).resolves.toBe(false);
        expect(show).not.toHaveBeenCalled();
    });
});
