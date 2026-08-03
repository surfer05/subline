/**
 * Token-bucket gate for the key-gated LLM engines (Claude, Gemini). `onFlush`
 * in index.tsx awaits `acquireSlot()` before calling `Native.translateBatch`
 * for those two engines — Google is per-message with its own concurrency cap
 * (see engines/google.ts's CONCURRENCY) and does not go through this gate.
 *
 * Why this exists: with `globalAuto` on, a Discord restart fires catch-up for
 * every open server channel within seconds of each other. Each channel's
 * batcher flushes independently, so nothing previously limited how many
 * `translateBatch` calls left the client in that first burst — easily enough
 * to blow through Gemini's free-tier requests-per-minute ceiling and get
 * every one of those batches back as a 429.
 *
 * BURST_CAPACITY / REFILL_MS reasoning (free-tier shaped): Gemini's free tier
 * allows on the order of 15 requests/minute; a low/free Anthropic tier is
 * comparably tight. A single live conversation flushes at most one batch per
 * debounce window (700ms, see batcher.ts) — a burst of 5 tokens available
 * immediately means ordinary chat NEVER waits on this gate. Refilling at one
 * token per 4 seconds caps steady-state throughput at 15/minute, which is
 * exactly the class of ceiling the free tiers impose — so a catch-up storm
 * across many channels is smoothed into that rate instead of front-loaded
 * into the first second and rejected wholesale.
 */
export const BURST_CAPACITY = 5;
export const REFILL_MS = 4_000;

let tokens = BURST_CAPACITY;
let lastRefillAt = Date.now();
// FIFO queue of resolvers waiting for a token. Order matters only in that it
// makes behaviour deterministic; correctness does not depend on it.
let waiters: Array<() => void> = [];
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

function refill(now: number): void {
    if (tokens >= BURST_CAPACITY) {
        lastRefillAt = now;
        return;
    }
    const elapsed = now - lastRefillAt;
    if (elapsed <= 0) return;
    const gained = Math.floor(elapsed / REFILL_MS);
    if (gained <= 0) return;
    tokens = Math.min(BURST_CAPACITY, tokens + gained);
    lastRefillAt += gained * REFILL_MS;
}

function scheduleWake(): void {
    // Only one timer in flight ever — every call below either drains the
    // queue immediately or (if the queue is still non-empty afterwards)
    // re-arms exactly one more.
    if (wakeTimer !== null) return;
    wakeTimer = setTimeout(() => {
        wakeTimer = null;
        wake();
    }, REFILL_MS);
}

function wake(): void {
    refill(Date.now());
    while (tokens > 0 && waiters.length > 0) {
        tokens--;
        const resolve = waiters.shift()!;
        resolve();
    }
    // Still queued waiters after draining what tokens allow: more refills are
    // still needed, so keep the wake loop alive. This is also how two flushes
    // waiting concurrently both eventually resolve rather than deadlocking —
    // each refill tick wakes as many as the bucket now allows, and the timer
    // keeps re-arming itself until the queue is empty.
    if (waiters.length > 0) scheduleWake();
}

/**
 * Resolves immediately if a token is available, otherwise queues and
 * resolves once the bucket refills enough to reach the front of the queue.
 */
export function acquireSlot(): Promise<void> {
    refill(Date.now());
    // The `waiters.length === 0` check matters: without it, a caller could
    // jump a token that a longer-waiting caller is still queued for, the
    // moment this function is re-entered while others are already waiting.
    if (tokens > 0 && waiters.length === 0) {
        tokens--;
        return Promise.resolve();
    }
    return new Promise<void>(resolve => {
        waiters.push(resolve);
        scheduleWake();
    });
}

/**
 * Reset the gate — called from the plugin's `stop()` alongside its other
 * module state (inFlight, batcherGeneration, sessionFallback, pausedUntil).
 *
 * Resolves every currently-queued waiter IMMEDIATELY rather than leaving them
 * to time out naturally on the next refill tick (up to REFILL_MS away). A
 * flush blocked in `acquireSlot()` during `stop()` must be cheap to abandon —
 * the generation guard in onFlush is what actually stops it from writing
 * under a stale generation once it resumes, but that guard can only run once
 * the await returns, so the await itself must not be left hanging.
 */
export function resetRateGate(): void {
    if (wakeTimer !== null) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
    }
    const pending = waiters;
    waiters = [];
    tokens = BURST_CAPACITY;
    lastRefillAt = Date.now();
    for (const resolve of pending) resolve();
}
