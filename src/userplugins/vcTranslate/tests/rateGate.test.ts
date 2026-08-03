import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSlot, BURST_CAPACITY, REFILL_MS, resetRateGate } from "../rateGate";

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
