import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must exist before statusBeacon.ts's module body runs: it reads
// `VencordNative.pluginHelpers.VcTranslate` at import time, exactly as
// index.tsx does. vi.hoisted is the only hook that fires before the imports.
const native = vi.hoisted(() => {
    const reportStatus = vi.fn(async () => true);
    (globalThis as any).VencordNative = { pluginHelpers: { VcTranslate: { reportStatus } } };
    return { reportStatus };
});

import {
    MIN_WRITE_INTERVAL_MS, recordError, recordPluginLoaded, recordRendered,
    recordTranslation, resetStatusBeacon, __beaconSnapshot
} from "../statusBeacon";
import { sanitizeBeacon, type StatusBeacon } from "../statusShape";
import { calls as loggedCalls, __resetLogCalls } from "./stubs/utils-logger";

/** The beacon as the main process would receive it, for the nth write. */
function written(n: number): StatusBeacon {
    return JSON.parse(native.reportStatus.mock.calls[n][0] as string);
}

function lastWritten(): StatusBeacon {
    return written(native.reportStatus.mock.calls.length - 1);
}

beforeEach(() => {
    vi.useFakeTimers();
    // A fixed wall clock so every timestamp below is predictable, and so
    // "advance the throttle window" is the only thing that moves time.
    vi.setSystemTime(new Date("2026-08-06T10:00:00.000Z"));
    native.reportStatus.mockReset();
    native.reportStatus.mockResolvedValue(true);
    resetStatusBeacon();
    __resetLogCalls();
});

afterEach(() => {
    resetStatusBeacon();
    vi.useRealTimers();
});

/** Let the coalescing window elapse and any armed write fire. */
async function passThrottle() {
    await vi.advanceTimersByTimeAsync(MIN_WRITE_INTERVAL_MS);
}

describe("the load signal", () => {
    it("writes immediately, without waiting for the coalescing window", async () => {
        // This is the signal the installer polls for after launching Discord
        // (spec §7 step 3). Delaying it by the throttle would make a healthy
        // install look dead for five extra seconds, for no saving at all.
        recordPluginLoaded();

        expect(native.reportStatus).toHaveBeenCalledTimes(1);
        expect(written(0).loadedAt).toBe("2026-08-06T10:00:00.000Z");
    });

    it("reports a load with nothing translated yet — the legitimate idle state", () => {
        recordPluginLoaded();
        expect(written(0)).toMatchObject({
            product: "subline",
            lastTranslationAt: null,
            lastRenderedAt: null,
            lastEngine: null,
            counts: { approx: 0, upgraded: 0 },
            lastError: null
        });
    });

    it("starts a NEW session, dropping the previous launch's counts and errors", async () => {
        // loadedAt is the installer's staleness anchor: everything beside it
        // has to belong to the SAME launch, or a previous session's success
        // would vouch for this one.
        recordPluginLoaded();
        recordTranslation("google");
        recordError("rate-limited");
        await passThrottle();

        vi.setSystemTime(new Date("2026-08-06T11:00:00.000Z"));
        recordPluginLoaded();

        expect(lastWritten()).toMatchObject({
            loadedAt: "2026-08-06T11:00:00.000Z",
            lastTranslationAt: null,
            counts: { approx: 0, upgraded: 0 },
            lastError: null
        });
    });

    it("records nothing at all before the plugin has loaded", () => {
        // A translation recorded with no load behind it would produce a beacon
        // with no anchor to compare against the install time.
        recordTranslation("google");
        recordRendered();
        recordError("engine-error");

        expect(native.reportStatus).not.toHaveBeenCalled();
        expect(__beaconSnapshot()).toBeNull();
    });
});

describe("the distinguishable states, write → read", () => {
    // Every state the installer has to tell apart has to survive the trip
    // through JSON and the main process's sanitiser. `sanitizeBeacon` is what
    // actually reaches disk, so each case is asserted on THAT, not on the
    // renderer's in-memory snapshot.
    function onDisk(): StatusBeacon | null {
        return sanitizeBeacon(lastWritten());
    }

    it("loaded but never translated", async () => {
        recordPluginLoaded();
        await passThrottle();

        const beacon = onDisk()!;
        expect(beacon.lastRenderedAt).toBeNull();
        expect(beacon.counts).toEqual({ approx: 0, upgraded: 0 });
        expect(beacon.lastError).toBeNull();
    });

    it("translating via Google only", async () => {
        recordPluginLoaded();
        recordTranslation("google");
        recordTranslation("google");
        recordRendered();
        await passThrottle();

        const beacon = onDisk()!;
        expect(beacon.counts).toEqual({ approx: 2, upgraded: 0 });
        expect(beacon.lastEngine).toBe("google");
        expect(beacon.lastRenderedAt).not.toBeNull();
    });

    it("translating with LLM upgrades", async () => {
        // The distinction that would have caught the week this project lost:
        // Google lines on screen and the ✦ upgrade silently never arriving
        // looks exactly like a healthy install on every other signal.
        recordPluginLoaded();
        recordTranslation("google");
        recordTranslation("gemini");
        recordRendered();
        await passThrottle();

        const beacon = onDisk()!;
        expect(beacon.counts).toEqual({ approx: 1, upgraded: 1 });
        expect(beacon.lastEngine).toBe("gemini");
    });

    it("counts claude as an upgrade tier too, not as a third thing", async () => {
        recordPluginLoaded();
        recordTranslation("claude");
        await passThrottle();
        expect(onDisk()!.counts).toEqual({ approx: 0, upgraded: 1 });
    });

    it("loaded but erroring", async () => {
        recordPluginLoaded();
        recordError("rate-limited");
        await passThrottle();

        const beacon = onDisk()!;
        expect(beacon.lastError).toEqual({ code: "rate-limited", at: "2026-08-06T10:00:00.000Z" });
        expect(beacon.counts).toEqual({ approx: 0, upgraded: 0 });
    });

    it("translating but rendering nothing — spec §6's silent frontend break", async () => {
        // The mod loads, translates, and the message accessory never paints:
        // the one failure that a "did it translate?" check alone reads as
        // healthy. Two timestamps are what make it visible.
        recordPluginLoaded();
        recordTranslation("google");
        await passThrottle();

        const beacon = onDisk()!;
        expect(beacon.lastTranslationAt).not.toBeNull();
        expect(beacon.lastRenderedAt).toBeNull();
    });

    it("keeps only the LATEST error, not a history", async () => {
        recordPluginLoaded();
        recordError("engine-error");
        vi.setSystemTime(new Date("2026-08-06T10:00:30.000Z"));
        recordError("auth-rejected");
        await passThrottle();

        expect(onDisk()!.lastError).toEqual({ code: "auth-rejected", at: "2026-08-06T10:00:30.000Z" });
    });
});

describe("writes are coalesced — this is the translation hot path", () => {
    it("turns a whole batch of results into one write", async () => {
        recordPluginLoaded();
        expect(native.reportStatus).toHaveBeenCalledTimes(1);

        // A quality batch lands 25 results in one tick.
        for (let i = 0; i < 25; i++) recordTranslation("gemini");
        await passThrottle();

        expect(native.reportStatus).toHaveBeenCalledTimes(2);
        expect(lastWritten().counts).toEqual({ approx: 0, upgraded: 25 });
    });

    it("carries everything that accumulated while the write was pending", async () => {
        // Coalescing must not mean DROPPING: the deferred write reports the
        // state at the moment it fires, not the state that first asked for it.
        recordPluginLoaded();
        recordTranslation("google");
        await vi.advanceTimersByTimeAsync(MIN_WRITE_INTERVAL_MS / 2);
        recordTranslation("gemini");
        recordError("rate-limited");
        await passThrottle();

        expect(lastWritten()).toMatchObject({
            counts: { approx: 1, upgraded: 1 },
            lastError: { code: "rate-limited" }
        });
    });

    it("does not write more than once per window under continuous traffic", async () => {
        recordPluginLoaded();
        native.reportStatus.mockClear();

        // Ten minutes of a busy channel: a render on every store notification
        // and a translation every second.
        for (let tick = 0; tick < 600; tick++) {
            recordTranslation("google");
            recordRendered();
            await vi.advanceTimersByTimeAsync(1_000);
        }

        // 600s of traffic at a 5s floor: at most one write per window.
        expect(native.reportStatus.mock.calls.length).toBeLessThanOrEqual(600_000 / MIN_WRITE_INTERVAL_MS);
        expect(native.reportStatus.mock.calls.length).toBeGreaterThan(0);
    });

    it("does write again once the window has passed", async () => {
        // The other half of the throttle: coalescing must not become "one
        // write and then silence", or the beacon would freeze at the first
        // translation and a later failure would never be reported.
        recordPluginLoaded();
        recordTranslation("google");
        await passThrottle();
        const first = native.reportStatus.mock.calls.length;

        await vi.advanceTimersByTimeAsync(MIN_WRITE_INTERVAL_MS);
        recordTranslation("google");
        await passThrottle();

        expect(native.reportStatus.mock.calls.length).toBeGreaterThan(first);
        expect(lastWritten().counts.approx).toBe(2);
    });

    it("leaves no armed timer behind after a reset", async () => {
        // stop() calls resetStatusBeacon(). A surviving timer would write a
        // beacon for a session that no longer exists — and `loadedAt` is
        // exactly what the installer trusts to mean "this launch".
        recordPluginLoaded();
        recordTranslation("google");
        native.reportStatus.mockClear();

        resetStatusBeacon();
        await passThrottle();

        expect(native.reportStatus).not.toHaveBeenCalled();
    });
});

describe("a broken beacon never breaks translation", () => {
    it("does not throw when the native half is missing entirely", () => {
        // An older build, or a plugin whose native module failed to load:
        // `reportStatus` is simply not a function.
        const helpers = (globalThis as any).VencordNative.pluginHelpers.VcTranslate;
        const saved = helpers.reportStatus;
        delete helpers.reportStatus;
        try {
            expect(() => recordPluginLoaded()).not.toThrow();
            expect(() => recordTranslation("google")).not.toThrow();
        } finally {
            helpers.reportStatus = saved;
        }
    });

    it("does not throw, and does not reject, when the write fails on disk", async () => {
        recordPluginLoaded();
        native.reportStatus.mockRejectedValue(new Error("EROFS: read-only file system"));

        expect(() => recordTranslation("google")).not.toThrow();
        await expect(passThrottle()).resolves.not.toThrow();
    });

    it("keeps counting correctly after a failed write, so a later write is still accurate", async () => {
        // A failed beacon write costs the INSTALLER a confirmation. It must not
        // also corrupt what the next successful write reports.
        recordPluginLoaded();
        native.reportStatus.mockRejectedValue(new Error("nope"));
        recordTranslation("google");
        await passThrottle();

        native.reportStatus.mockResolvedValue(true);
        recordTranslation("gemini");
        await passThrottle();

        expect(lastWritten().counts).toEqual({ approx: 1, upgraded: 1 });
    });

    it("warns once per session, not once per failed write", async () => {
        // The console belongs to the user. A per-write warning on a read-only
        // volume would be a warning every five seconds, forever.
        recordPluginLoaded();
        native.reportStatus.mockResolvedValue(false);
        __resetLogCalls();

        for (let i = 0; i < 5; i++) {
            recordTranslation("google");
            await passThrottle();
        }

        const warnings = loggedCalls.filter(c => c.level === "warn");
        expect(warnings).toHaveLength(1);
    });

    it("never puts anything but counts and codes in what it sends", () => {
        // The renderer's own discipline, independent of the main process's
        // sanitiser: this is what actually crosses IPC, and it is asserted to
        // carry exactly the keys of the beacon shape and nothing else.
        recordPluginLoaded();
        recordTranslation("gemini");

        expect(Object.keys(written(0)).sort()).toEqual([
            "counts", "format", "lastEngine", "lastError", "lastRenderedAt",
            "lastTranslationAt", "loadedAt", "pluginVersion", "product", "updatedAt"
        ]);
    });
});
