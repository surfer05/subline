import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    acquireSlot, BURST_CAPACITY, LEARNED_QUOTA_KEY, loadRateGateTuning, rateGateAvailable,
    rateGateSettings, REFILL_MS, resetRateGate, SAFETY_FACTOR, tuneRateGateToObservedLimit
} from "../rateGate";
import * as DataStore from "./stubs/api-datastore";

/**
 * The quota measured directly against the live Gemini free tier: 20 requests
 * per ROLLING minute (probes were told to retry in 56.6s, 11.2s, 25.0s and
 * 39.3s as the window drained — it never fully emptied under load).
 */
const MEASURED_CEILING_PER_MINUTE = 20;

/** What a token bucket can put into one rolling window: sustained + a full burst. */
const worstMinute = ({ capacity, refillMs }: { capacity: number; refillMs: number; }) =>
    60_000 / refillMs + capacity;

beforeEach(() => {
    vi.useFakeTimers();
    DataStore.__reset();
    resetRateGate();
});

afterEach(() => {
    vi.restoreAllMocks();
    resetRateGate();
    vi.useRealTimers();
});

describe("rateGate — burst capacity", () => {
    it("lets a burst of exactly BURST_CAPACITY requests through with no wait", async () => {
        let resolved = 0;
        const all = Promise.all(
            Array.from({ length: BURST_CAPACITY }, () => acquireSlot().then(() => resolved++))
        );
        // No timer advance at all — a normal live-chat debounce window (700ms)
        // never has to wait behind this gate.
        await Promise.resolve();
        await Promise.resolve();
        await all;
        expect(resolved).toBe(BURST_CAPACITY);
    });

    it("does NOT let request BURST_CAPACITY+1 through immediately — this is the throttle itself", async () => {
        let resolved = 0;
        const promises = Array.from(
            { length: BURST_CAPACITY + 1 },
            () => acquireSlot().then(() => resolved++)
        );

        // Flush only the microtasks a truly-immediate resolve would need.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        // If this is EVER equal to BURST_CAPACITY + 1 here, the burst was not
        // capped and the whole point of this gate (smoothing a catch-up storm
        // instead of hammering the API) does not hold.
        expect(resolved).toBe(BURST_CAPACITY);

        await vi.advanceTimersByTimeAsync(REFILL_MS);
        await Promise.all(promises);
        expect(resolved).toBe(BURST_CAPACITY + 1);
    });

    it("drains queued waiters at the refill rate, one per REFILL_MS, not all at once", async () => {
        let resolved = 0;
        const promises = Array.from(
            { length: BURST_CAPACITY + 3 },
            () => acquireSlot().then(() => resolved++)
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(resolved).toBe(BURST_CAPACITY);

        await vi.advanceTimersByTimeAsync(REFILL_MS);
        expect(resolved).toBe(BURST_CAPACITY + 1);

        await vi.advanceTimersByTimeAsync(REFILL_MS);
        expect(resolved).toBe(BURST_CAPACITY + 2);

        await vi.advanceTimersByTimeAsync(REFILL_MS);
        await Promise.all(promises);
        expect(resolved).toBe(BURST_CAPACITY + 3);
    });
});

describe("rateGate — cancellation and concurrency", () => {
    it("resetRateGate() wakes queued waiters immediately instead of leaving them pending", async () => {
        for (let i = 0; i < BURST_CAPACITY; i++) await acquireSlot();

        let resolved = false;
        const p = acquireSlot().then(() => { resolved = true; });

        // Without a refill tick or a reset, this stays pending — proves the
        // assertion after reset is actually testing something.
        await Promise.resolve();
        await Promise.resolve();
        expect(resolved).toBe(false);

        resetRateGate();
        await p;
        expect(resolved).toBe(true);
    });

    it("never deadlocks when two flushes wait concurrently", async () => {
        for (let i = 0; i < BURST_CAPACITY; i++) await acquireSlot();

        const a = acquireSlot();
        const b = acquireSlot();
        await vi.advanceTimersByTimeAsync(REFILL_MS * 2);

        await expect(Promise.all([a, b])).resolves.toBeDefined();
    });

    it("resetRateGate() refills the bucket to full capacity for the next session", async () => {
        for (let i = 0; i < BURST_CAPACITY; i++) await acquireSlot();
        resetRateGate();

        let resolved = 0;
        await Promise.all(
            Array.from({ length: BURST_CAPACITY }, () => acquireSlot().then(() => resolved++))
        );
        expect(resolved).toBe(BURST_CAPACITY);
    });
});

describe("rateGate — rateGateAvailable() is a pure read", () => {
    it("reports the full untaught burst before anything has been spent", () => {
        expect(rateGateAvailable()).toBe(BURST_CAPACITY);
    });

    it("does not consume a token — repeated reads are stable", () => {
        expect(rateGateAvailable()).toBe(BURST_CAPACITY);
        expect(rateGateAvailable()).toBe(BURST_CAPACITY);
        expect(rateGateAvailable()).toBe(BURST_CAPACITY);
        expect(rateGateAvailable()).toBe(BURST_CAPACITY);
    });

    it("a read does not perturb the bucket — every real token is still grantable afterwards", async () => {
        // Hammer the read far more than there are tokens, with no timer
        // advance in between (so nothing could legitimately refill).
        for (let i = 0; i < 50; i++) rateGateAvailable();

        let resolved = 0;
        await Promise.all(
            Array.from({ length: BURST_CAPACITY }, () => acquireSlot().then(() => resolved++))
        );
        // If the read had consumed anything, fewer than BURST_CAPACITY of
        // these would resolve without a timer advance.
        expect(resolved).toBe(BURST_CAPACITY);
    });

    it("reflects tokens a real acquireSlot() actually spent", async () => {
        await acquireSlot();
        expect(rateGateAvailable()).toBe(BURST_CAPACITY - 1);
        await acquireSlot();
        expect(rateGateAvailable()).toBe(BURST_CAPACITY - 2);
    });

    it("drops to zero once the burst is exhausted, and stays zero with no timer advance", async () => {
        for (let i = 0; i < BURST_CAPACITY; i++) await acquireSlot();
        expect(rateGateAvailable()).toBe(0);
        expect(rateGateAvailable()).toBe(0);
    });

    it("accrues over time exactly like a real refill — WITHOUT writing lastRefillAt back", async () => {
        for (let i = 0; i < BURST_CAPACITY; i++) await acquireSlot();
        expect(rateGateAvailable()).toBe(0);

        // Advance past one refill tick without calling anything that would
        // legitimately update lastRefillAt itself.
        vi.advanceTimersByTime(REFILL_MS);
        expect(rateGateAvailable()).toBe(1);
        // Still a pure read: asking twice in a row must not double-count.
        expect(rateGateAvailable()).toBe(1);

        // If the read HAD written lastRefillAt back on the call above, a real
        // acquireSlot() landing here would see an already-advanced clock and
        // grant a second token it has not actually earned yet.
        await acquireSlot();
        expect(rateGateAvailable()).toBe(0);
    });

    it("caps at capacity — accrued time beyond a full bucket is not banked", async () => {
        vi.advanceTimersByTime(REFILL_MS * 100);
        expect(rateGateAvailable()).toBe(BURST_CAPACITY);
    });
});

describe("rateGate — retuning from a quota the API actually reported", () => {
    it("slows the gate down when the reported quota is tighter than the guess", () => {
        expect(rateGateSettings().refillMs).toBe(REFILL_MS);

        expect(tuneRateGateToObservedLimit(4)).toBe(true);

        // floor(4 * 0.5) = 2 requests/minute → one every 30s.
        const { capacity, refillMs } = rateGateSettings();
        expect(refillMs).toBe(30_000);
        expect(refillMs).toBeGreaterThan(REFILL_MS);
        // A burst larger than the whole per-minute allowance would defeat the
        // point of learning the limit at all.
        expect(capacity).toBe(2);
    });

    it("speeds the gate up when the reported quota is more generous than the guess", () => {
        expect(tuneRateGateToObservedLimit(120)).toBe(true);

        // floor(120 * 0.5) = 60/minute → one every 1000ms, and the burst is
        // still capped at BURST_CAPACITY (the gate is not a throughput
        // booster, it only stops storms).
        const { capacity, refillMs } = rateGateSettings();
        expect(refillMs).toBe(1_000);
        expect(refillMs).toBeLessThan(REFILL_MS);
        expect(capacity).toBe(BURST_CAPACITY);
    });

    it("aims comfortably BELOW the reported ceiling, never at it", () => {
        tuneRateGateToObservedLimit(20);
        const perMinute = 60_000 / rateGateSettings().refillMs;
        expect(perMinute).toBeLessThan(20);
        expect(perMinute).toBeCloseTo(20 * SAFETY_FACTOR, 0);
    });

    it("leaves headroom even in the WORST rolling minute — sustained rate plus a full burst", () => {
        // The arithmetic that fixes SAFETY_FACTOR's value. The provider counts
        // a rolling 60-second window (measured on Gemini's free tier: 20/min,
        // with probes told to retry in 29.5s, 56.7s and 11.2s as the window
        // drained). A token BUCKET can put more into one such window than its
        // sustained rate: a full burst released at the window's start, plus the
        // refills during it. That worst case — not the sustained rate — is what
        // has to clear the ceiling, with room left for requests still in flight
        // and for the provider's window boundary not lining up with ours.
        //
        // At SAFETY_FACTOR 0.75 this was 15 + 5 = 20 against a ceiling of 20:
        // exactly on it, which is a gate that 429s.
        const LIMIT = 20;
        tuneRateGateToObservedLimit(LIMIT);

        const { capacity, refillMs } = rateGateSettings();
        const worstMinute = 60_000 / refillMs + capacity;

        expect(worstMinute).toBeLessThan(LIMIT);
        // ...and not merely a hair under it.
        expect(worstMinute).toBeLessThanOrEqual(LIMIT * 0.8);
    });

    it("scales the target with the REPORTED limit rather than settling on one rate", () => {
        // The guard against "fix the burst by hardcoding a smaller number":
        // two different reported quotas must produce two rates in the same
        // ratio as the quotas. A compiled-in rate would give the same answer
        // twice, and a rate that ignored the report would give the guess twice.
        tuneRateGateToObservedLimit(20);
        const at20 = 60_000 / rateGateSettings().refillMs;

        tuneRateGateToObservedLimit(40);
        const at40 = 60_000 / rateGateSettings().refillMs;

        expect(at20).toBeCloseTo(20 * SAFETY_FACTOR, 5);
        expect(at40).toBeCloseTo(40 * SAFETY_FACTOR, 5);
        expect(at40).toBeCloseTo(at20 * 2, 5);
        expect(at40).not.toBe(60_000 / REFILL_MS);
    });

    it("actually throttles at the retuned rate, not just in the reported settings", async () => {
        tuneRateGateToObservedLimit(4);   // → capacity 2, one refill per 30s

        let resolved = 0;
        const promises = Array.from({ length: 3 }, () => acquireSlot().then(() => resolved++));
        await Promise.resolve();
        await Promise.resolve();
        expect(resolved).toBe(2);

        // The OLD refill window is not enough any more — this is the assertion
        // that would still pass if the retune only changed a reported number.
        await vi.advanceTimersByTimeAsync(REFILL_MS);
        expect(resolved).toBe(2);

        await vi.advanceTimersByTimeAsync(30_000);
        await Promise.all(promises);
        expect(resolved).toBe(3);
    });

    it("never throttles to a standstill, however small the reported quota", () => {
        expect(tuneRateGateToObservedLimit(1)).toBe(true);
        const { capacity, refillMs } = rateGateSettings();
        expect(capacity).toBeGreaterThanOrEqual(1);
        expect(refillMs).toBe(60_000);
    });

    it("ignores a nonsensical limit rather than deadlocking the gate", () => {
        expect(tuneRateGateToObservedLimit(0)).toBe(false);
        expect(tuneRateGateToObservedLimit(-5)).toBe(false);
        expect(tuneRateGateToObservedLimit(Number.NaN)).toBe(false);
        expect(rateGateSettings()).toEqual({ capacity: BURST_CAPACITY, refillMs: REFILL_MS });
    });

    it("reports no change when the same limit is seen again", () => {
        expect(tuneRateGateToObservedLimit(4)).toBe(true);
        expect(tuneRateGateToObservedLimit(4)).toBe(false);
    });

    it("resetRateGate() discards what was learned, back to the compiled-in guess", () => {
        tuneRateGateToObservedLimit(4);
        resetRateGate();
        expect(rateGateSettings()).toEqual({ capacity: BURST_CAPACITY, refillMs: REFILL_MS });
    });
});

describe("rateGate — the untaught defaults are the conservative guess", () => {
    it("keeps the WORST rolling minute (sustained + burst) well under the measured ceiling", () => {
        // Asserted as a PROPERTY of the live untaught gate rather than against
        // a spelled-out number, so raising either constant is caught here even
        // if the other is left alone. The previous defaults (5 and 4_000) gave
        // 15 + 5 = 20 — the measured ceiling exactly, on an install that had
        // been told nothing at all — which is the 429 seconds after a fresh
        // start that this bound exists to make unreachable.
        expect(worstMinute(rateGateSettings())).toBeLessThan(MEASURED_CEILING_PER_MINUTE);
        // Not merely a hair under it either: an untaught guess has to clear
        // tiers we have never measured, not just the one we have.
        expect(worstMinute(rateGateSettings()))
            .toBeLessThanOrEqual(MEASURED_CEILING_PER_MINUTE / 2);
    });

    it("is still fast enough that live chat never queues behind it", () => {
        // The other side of the bound, so "make it safe" cannot be answered by
        // making it useless. A busy single channel flushes the quality tier at
        // ~2-3 requests/minute (QUALITY_DEBOUNCE_MS is 20s), so the sustained
        // rate has to clear that — otherwise ordinary reading starts waiting on
        // a gate that exists only to smooth bursts.
        const sustainedPerMinute = 60_000 / rateGateSettings().refillMs;
        expect(sustainedPerMinute).toBeGreaterThanOrEqual(3);
    });
});

describe("rateGate — the learned quota is persisted across restarts", () => {
    it("writes the REPORTED limit when the tuning actually moves", async () => {
        expect(tuneRateGateToObservedLimit(20)).toBe(true);
        await Promise.resolve();   // the write is deliberately not awaited

        // The reported quota, not the derived refillMs: it is the only part
        // that is a fact, so SAFETY_FACTOR is re-applied on the next load
        // rather than frozen in.
        expect(await DataStore.get(LEARNED_QUOTA_KEY)).toBe(20);
    });

    it("does not rewrite on every repeat of the same 429", async () => {
        expect(tuneRateGateToObservedLimit(20)).toBe(true);
        await Promise.resolve();

        const set = vi.spyOn(DataStore, "set");
        // A 429 storm reports the same quota over and over; a write per 429
        // would be a write per rejected batch for no new information.
        expect(tuneRateGateToObservedLimit(20)).toBe(false);
        expect(set).not.toHaveBeenCalled();
    });

    it("re-applies the persisted quota after resetRateGate() dropped the in-memory one", async () => {
        tuneRateGateToObservedLimit(4);
        const tuned = rateGateSettings();
        await Promise.resolve();

        // stop() — the in-memory lesson goes...
        resetRateGate();
        expect(rateGateSettings()).toEqual({ capacity: BURST_CAPACITY, refillMs: REFILL_MS });

        // ...and start() reads it straight back off disk.
        await loadRateGateTuning();
        expect(rateGateSettings()).toEqual(tuned);
        expect(rateGateSettings().refillMs).not.toBe(REFILL_MS);
    });

    it("falls back to the defaults, without throwing, on a corrupt stored value", async () => {
        // Every shape a hand-edited or half-written IndexedDB entry could take.
        // NaN/0/-5 are rejected by the same guard that rejects a nonsensical
        // 429; the rest never reach it.
        for (const junk of ["20", { limit: 20 }, null, [4], true, Number.NaN, 0, -5, Infinity]) {
            resetRateGate();
            await DataStore.set(LEARNED_QUOTA_KEY, junk);

            await expect(loadRateGateTuning()).resolves.toBeUndefined();
            expect(rateGateSettings()).toEqual({ capacity: BURST_CAPACITY, refillMs: REFILL_MS });
        }
    });

    it("falls back to the defaults when nothing has ever been stored", async () => {
        await expect(loadRateGateTuning()).resolves.toBeUndefined();
        expect(rateGateSettings()).toEqual({ capacity: BURST_CAPACITY, refillMs: REFILL_MS });
    });

    it("does not let a failed read stop the plugin starting", async () => {
        vi.spyOn(DataStore, "get").mockRejectedValueOnce(new Error("IndexedDB is having a day"));

        // start() awaits this. A rejection escaping here would reject start()
        // itself, which costs the user the whole plugin to save one 429.
        await expect(loadRateGateTuning()).resolves.toBeUndefined();
        expect(rateGateSettings()).toEqual({ capacity: BURST_CAPACITY, refillMs: REFILL_MS });
    });

    it("handles a failed WRITE itself rather than leaving it to reject unhandled", async () => {
        const rejected = Promise.reject(new Error("disk full"));
        // Counts rejection handlers attached to the write, however they are
        // attached — `.catch(fn)` and `await` in a try/catch both land here.
        // Zero means the fire-and-forget write was left to reject into the
        // void, which in the renderer is an unhandled-rejection report about
        // a failure the plugin had already decided it could live without.
        let handlersAttached = 0;
        const probe = {
            then(onOk: any, onErr: any) { handlersAttached++; return rejected.then(onOk, onErr); },
            catch(onErr: any) { handlersAttached++; return rejected.catch(onErr); }
        };
        vi.spyOn(DataStore, "set").mockReturnValueOnce(probe as any);

        // The in-memory gate is retuned regardless. Losing the write costs one
        // relearned 429 next launch — exactly the behaviour before this key
        // existed, so there is nothing to roll back and nothing to report.
        expect(tuneRateGateToObservedLimit(4)).toBe(true);
        expect(rateGateSettings().refillMs).toBe(30_000);
        expect(handlersAttached).toBeGreaterThan(0);

        await rejected.catch(() => { /* keep the fixture itself from leaking */ });
    });
});
