import * as DataStore from "@api/DataStore";

/**
 * Token-bucket gate for the key-gated LLM engines (Claude, Gemini). `runTier`
 * in index.tsx awaits `acquireSlot()` before calling `Native.translateBatch`
 * for the quality tier — the fast tier is Google, which is per-message with
 * its own concurrency cap (see engines/google.ts's CONCURRENCY) and does not
 * go through this gate.
 *
 * Why this exists — CORRECTED. It was written for a restart fan-out: with
 * `globalAuto` on, catch-up used to fire for every open server channel at
 * once. That is no longer possible — catch-up is focus-gated, so only the
 * channel actually on screen is ever caught up, and deep scroll-back no longer
 * reaches the quality tier at all (see `initialHistoryPending` in index.tsx).
 * The burst it still has to smooth is CHANNEL HOPPING: each channel opened
 * queues its own quality batch, and a user clicking through half a dozen
 * channels in a few seconds produces exactly the same shape of burst one
 * channel at a time. The gate stays.
 *
 * BURST_CAPACITY / REFILL_MS reasoning (free-tier shaped): a burst of 5 tokens
 * available immediately, refilling one per 4 seconds. The quality tier flushes
 * at most one batch per 20s window per channel (QUALITY_DEBOUNCE_MS, see
 * types.ts), so ordinary chat in one channel NEVER waits on this gate, and a
 * hop across many channels is smoothed into a steady rate instead of
 * front-loaded into a second and rejected wholesale.
 *
 * Those two numbers apply only until a 429 states a real quota — see
 * SAFETY_FACTOR below, which is where the arithmetic against the MEASURED
 * ceiling (Gemini free tier: 20 requests per rolling minute) is done. They are
 * deliberately not tuned to that measurement themselves: they are the guess
 * that stands in for a quota this install has not been told yet, and the
 * install it is wrong for is someone else's.
 *
 * Those two constants are only the STARTING GUESS. A 429 body sometimes states
 * the quota it just enforced ("limit: 20" — see rateHint.ts), and when it does,
 * tuneRateGateToObservedLimit() below replaces the guess with a rate derived
 * from that number. This is deliberately adaptive rather than hardcoded: free
 * tier quotas differ per project, differ per model, and are changed by the
 * provider without notice, so any constant compiled in here is guaranteed to be
 * wrong for someone — and being wrong in the generous direction is what
 * produced the 429 storm in the first place.
 */
export const BURST_CAPACITY = 5;
export const REFILL_MS = 4_000;

/**
 * How much of the observed ceiling to actually aim at.
 *
 * WHY 0.5 AND NOT 0.75 (the arithmetic, against the measured numbers). The
 * provider enforces a ROLLING WINDOW — Gemini's free tier allows 20 requests
 * per rolling minute, confirmed live: successive probes were told to retry in
 * 29.5s, then 56.7s, then 11.2s as the window drained. This gate is a token
 * BUCKET, which is not the same shape: the most it can put into any single
 * 60-second window is the sustained rate PLUS a full burst released at the
 * window's start, i.e. `targetPerMinute + capacity`.
 *
 * At 0.75 that is 15 + 5 = 20 for a reported limit of 20 — exactly the ceiling,
 * with nothing left for the provider's own window boundaries, requests already
 * in flight when the window turns over, or another client on the same key. A
 * gate tuned to sit precisely on a hard limit is a gate that 429s.
 *
 * At 0.5 it is 10 + 5 = 15 against the same ceiling: a quarter of the quota
 * held back for exactly those three. The cost is throughput this plugin does
 * not need — the quality tier flushes at most one batch per channel per 20s
 * window, so a live conversation still never waits on this gate at all, and
 * with deep scroll-back no longer routed through the quality tier (see
 * `initialHistoryPending` in index.tsx) the only remaining burst is channel
 * hopping, which is what a bucket smooths rather than blocks.
 *
 * A FRACTION of the reported limit, never a rate: what the number multiplies is
 * whatever the API said its quota was, so a project on a different plan retunes
 * to a different rate with the same headroom.
 */
export const SAFETY_FACTOR = 0.5;

/**
 * The quota the API last told us about, persisted.
 *
 * WHY IT HAS TO SURVIVE A RESTART — the same argument cooldownStore.ts makes
 * for its cooldown mark, for the same reason. Without this the lesson lives
 * only in module state, so every Discord launch reopens the gate at the
 * untaught defaults above, spends requests at a rate this project's quota has
 * already been proven not to allow, and buys the 429 (and the toast) all over
 * again — on every single launch, learning nothing it did not already know.
 * The reported quota is a fact about the API KEY and project, not about a
 * plugin session, so a session boundary is not a reason to forget it.
 *
 * The REPORTED limit is stored, not the derived capacity/refillMs. It is the
 * only part that is actually a fact; everything else is this file's arithmetic
 * over it, so a later change to SAFETY_FACTOR (or to how the burst is sized)
 * applies to an already-learned quota on the next start instead of being
 * frozen into whatever the numbers were the day the 429 arrived.
 */
export const LEARNED_QUOTA_KEY = "VcTranslate_learnedQuota";

// The LIVE values. Everything below reads these, never the constants above,
// so a retune takes effect without restarting anything.
let capacity = BURST_CAPACITY;
let refillMs = REFILL_MS;

let tokens = capacity;
let lastRefillAt = Date.now();
// FIFO queue of resolvers waiting for a token. Order matters only in that it
// makes behaviour deterministic; correctness does not depend on it.
let waiters: Array<() => void> = [];
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

function refill(now: number): void {
    if (tokens >= capacity) {
        lastRefillAt = now;
        return;
    }
    const elapsed = now - lastRefillAt;
    if (elapsed <= 0) return;
    const gained = Math.floor(elapsed / refillMs);
    if (gained <= 0) return;
    tokens = Math.min(capacity, tokens + gained);
    lastRefillAt += gained * refillMs;
}

function scheduleWake(): void {
    // Only one timer in flight ever — every call below either drains the
    // queue immediately or (if the queue is still non-empty afterwards)
    // re-arms exactly one more.
    if (wakeTimer !== null) return;
    wakeTimer = setTimeout(() => {
        wakeTimer = null;
        wake();
    }, refillMs);
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
 * Move the LIVE gate onto a quota the API actually reported, e.g. the
 * "limit: 20" in a real Gemini 429 body (see rateHint.ts). A parsed limit is
 * treated as AUTHORITATIVE over BURST_CAPACITY/REFILL_MS: those are a guess
 * about someone else's project, this is a statement about ours.
 *
 * Only the sustained rate is derived; the burst is left at BURST_CAPACITY
 * unless the target rate is smaller than that, because the burst exists to
 * keep ordinary chat off the gate entirely and bursting above the per-minute
 * ceiling is exactly what a tiny quota cannot afford.
 *
 * Returns true when something actually changed. This is also the SOLE validator
 * of the number: a non-finite or non-positive limit is rejected here, so a
 * garbage value out of a 429 body and a garbage value out of IndexedDB are
 * refused by the same code path rather than by two guards that could drift.
 *
 * Private because it does not persist. Both callers below are the two ways a
 * limit legitimately arrives: freshly reported (persist it) and read back off
 * disk (do not write it straight back).
 */
function applyObservedLimit(limitPerMinute: number): boolean {
    if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) return false;

    // At least 1/minute: a quota so small that SAFETY_FACTOR of it rounds to
    // zero still has to let SOMETHING through, or the gate becomes a deadlock.
    const targetPerMinute = Math.max(1, Math.floor(limitPerMinute * SAFETY_FACTOR));
    const nextRefillMs = Math.round(60_000 / targetPerMinute);
    const nextCapacity = Math.max(1, Math.min(BURST_CAPACITY, targetPerMinute));

    if (nextRefillMs === refillMs && nextCapacity === capacity) return false;

    refillMs = nextRefillMs;
    capacity = nextCapacity;
    // A tightened bucket must not keep handing out tokens it is no longer
    // allowed to hold.
    tokens = Math.min(tokens, capacity);
    return true;
}

/**
 * Retune from a freshly reported quota AND remember it, so the next session
 * does not have to buy another 429 to learn the same thing. Called from
 * enterCooldown() in index.tsx. Returns true when the tuning actually moved,
 * so the caller can log/announce a real retune without doing so on every
 * repeated 429 that reports the same number.
 */
export function tuneRateGateToObservedLimit(limitPerMinute: number): boolean {
    if (!applyObservedLimit(limitPerMinute)) return false;

    // Persisted only when the tuning ACTUALLY moved — a 429 storm reports the
    // same quota over and over, and a write per 429 would be a write per
    // rejected batch for no new information.
    //
    // Deliberately not awaited, exactly as cooldownStore.setCooldown() is not:
    // a flush must never block on IndexedDB, and losing the write costs one
    // relearned 429 next launch — precisely today's behaviour, so there is no
    // failure mode here worse than not having persisted at all.
    void DataStore.set(LEARNED_QUOTA_KEY, limitPerMinute).catch(() => {
        // Best effort. See above.
    });
    return true;
}

/**
 * Apply the persisted quota, if there is one. Called (and awaited) from the
 * plugin's `start()` BEFORE any batcher exists, so the first quality batch of
 * the session already goes out under the learned rate rather than under the
 * untaught defaults.
 *
 * Anything malformed is discarded rather than thrown — same reasoning as
 * loadCooldowns(): a corrupt entry must not stop the plugin starting, and
 * degrading to the (deliberately conservative) defaults costs at most a
 * relearned 429, whereas refusing to start costs the user everything. A read
 * that REJECTS is the same story, and start() awaits this, so letting the
 * rejection out would cost the user the whole plugin to save one request.
 */
export async function loadRateGateTuning(): Promise<void> {
    let stored: unknown;
    try {
        stored = await DataStore.get<unknown>(LEARNED_QUOTA_KEY);
    } catch {
        return;
    }
    // Narrows `unknown`; the VALUE guard is applyObservedLimit()'s, which is
    // why a stored 0, -1, NaN or Infinity falls back to the defaults too
    // rather than being trusted for having the right type. Nothing is coerced:
    // a stored "20" is a corrupt entry, not a quota.
    if (typeof stored !== "number") return;
    applyObservedLimit(stored);
}

/** The live gate settings. Exists so tests (and only tests) can observe a retune. */
export function rateGateSettings(): { capacity: number; refillMs: number; } {
    return { capacity, refillMs };
}

/**
 * Reset the gate — called from the plugin's `stop()` alongside its other
 * module state (the in-flight sets, the quality-attempt ledger,
 * batcherGeneration, sessionFallback, cooldowns).
 *
 * This drops the IN-MEMORY result of tuneRateGateToObservedLimit() back to the
 * untaught defaults. The PERSISTED quota deliberately survives: it is a fact
 * about the API key and project, not about a plugin session, and start() reads
 * it back before anything can flush (see loadRateGateTuning()). Re-learning it
 * instead would mean buying a 429 on every launch, which is the defect this
 * key exists to close.
 *
 * Resolves every currently-queued waiter IMMEDIATELY rather than leaving them
 * to time out naturally on the next refill tick (up to REFILL_MS away). A
 * flush blocked in `acquireSlot()` during `stop()` must be cheap to abandon —
 * the generation guard in runTier is what actually stops it from writing
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
    capacity = BURST_CAPACITY;
    refillMs = REFILL_MS;
    tokens = capacity;
    lastRefillAt = Date.now();
    for (const resolve of pending) resolve();
}
