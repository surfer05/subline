import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    acquireSlot, BURST_CAPACITY, rateGateSettings, REFILL_MS, resetRateGate, SAFETY_FACTOR,
    tuneRateGateToObservedLimit
} from "../rateGate";

beforeEach(() => {
    vi.useFakeTimers();
    resetRateGate();
});

afterEach(() => {
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
