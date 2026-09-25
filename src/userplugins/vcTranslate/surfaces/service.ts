/**
 * Translation for text OUTSIDE messages, for paid installs only.
 *
 * LAZY. Nothing is requested until a component that shows the text renders
 * and calls `want(text)`. A member list only asks for the statuses on screen.
 *
 * BATCHED. `want` never sends anything itself: it queues the text, and a
 * short quiet period later every queued text leaves in one request per tier
 * (≈ Google, then ✦ the relay), at most `maxBatch` per request. Fifty statuses
 * appearing at once cost two relay requests, not fifty, and each of those
 * still waits its turn at the shared rate gate (the caller's `translate`).
 *
 * CACHED BY TEXT. See cache.ts. A text already translated is never sent again.
 *
 * PAID ONLY. `isPaid()` is asked before anything is queued and again before
 * anything is sent. A free or trial install never queues a text, so it never
 * sends a surface request, and its screens are exactly as they were.
 *
 * NO CONTEXT. Surface texts are sent with no conversation around them; the
 * caller builds the request.
 */

import { normalizeSurfaceText, type SurfaceCache, type SurfaceEntry, surfaceKey } from "./cache";

export type SurfaceTier = "fast" | "quality";

/** One text's verdict from an engine, in request order. */
export type SurfaceVerdict = { lang: string; text: string; conf?: number } | "skip" | "fail";

/**
 * What `translate` returns: a verdict per text, in order, or `null` for "not
 * now" (cooling down, refused, unreachable). "Not now" is retried later;
 * a "fail" verdict is not retried for `failRetryMs`.
 */
export type SurfaceOutcome = SurfaceVerdict[] | null;

export interface SurfaceDeps {
    isPaid(): boolean;
    targetLang(): string;
    /** The plugin's own local rules: nothing translatable, or already the target language. */
    locallySkipped(text: string): boolean;
    translate(tier: SurfaceTier, texts: string[]): Promise<SurfaceOutcome>;
    cache: SurfaceCache;
    now(): number;
    schedule(fn: () => void, ms: number): unknown;
    cancel(handle: unknown): void;
    debug?(message: string): void;
    fastDebounceMs?: number;
    qualityDebounceMs?: number;
    maxBatch?: number;
    failRetryMs?: number;
    notNowRetryMs?: number;
}

export const SURFACE_FAST_DEBOUNCE_MS = 400;
export const SURFACE_QUALITY_DEBOUNCE_MS = 1_500;
export const SURFACE_MAX_BATCH = 25;
export const SURFACE_FAIL_RETRY_MS = 10 * 60_000;
export const SURFACE_NOT_NOW_RETRY_MS = 60_000;

const TIERS: SurfaceTier[] = ["fast", "quality"];

export class SurfaceService {
    private readonly pending: Record<SurfaceTier, Map<string, string>> = { fast: new Map(), quality: new Map() };
    private readonly inFlight: Record<SurfaceTier, Set<string>> = { fast: new Set(), quality: new Set() };
    private readonly retryAt: Record<SurfaceTier, Map<string, number>> = { fast: new Map(), quality: new Map() };
    private readonly timers: Record<SurfaceTier, unknown> = { fast: null, quality: null };
    private readonly listeners = new Set<() => void>();
    private generation = 0;
    /** Requests actually sent, per tier. For tests and debug logging. */
    readonly sent: Record<SurfaceTier, number> = { fast: 0, quality: 0 };

    constructor(private readonly deps: SurfaceDeps) { }

    /**
     * What to show for `text` right now, and queue whatever is still missing.
     * `null` means show nothing: not paid, nothing foreign, or nothing yet.
     */
    want(text: string | null | undefined): SurfaceEntry | null {
        if (typeof text !== "string" || !this.deps.isPaid()) return null;
        const norm = normalizeSurfaceText(text);
        if (norm === "" || this.deps.locallySkipped(norm)) return null;
        const key = surfaceKey(norm, this.deps.targetLang());
        const entry = this.deps.cache.get(key);
        if (entry?.skip) return null;
        if (entry?.quality) return entry;
        if (!entry?.fast) this.queue("fast", key, norm);
        this.queue("quality", key, norm);
        return entry ?? null;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    /** Stop everything: nothing queued is sent, nothing in flight is written. */
    stop(): void {
        this.generation++;
        for (const tier of TIERS) {
            if (this.timers[tier] !== null) this.deps.cancel(this.timers[tier]);
            this.timers[tier] = null;
            this.pending[tier].clear();
            this.inFlight[tier].clear();
            this.retryAt[tier].clear();
        }
        this.listeners.clear();
    }

    private queue(tier: SurfaceTier, key: string, text: string): void {
        if (this.inFlight[tier].has(key) || this.pending[tier].has(key)) return;
        const retry = this.retryAt[tier].get(key);
        if (retry !== undefined && this.deps.now() < retry) return;
        this.pending[tier].set(key, text);
        this.arm(tier);
    }

    private arm(tier: SurfaceTier): void {
        if (this.timers[tier] !== null) return;
        const ms = tier === "fast"
            ? this.deps.fastDebounceMs ?? SURFACE_FAST_DEBOUNCE_MS
            : this.deps.qualityDebounceMs ?? SURFACE_QUALITY_DEBOUNCE_MS;
        this.timers[tier] = this.deps.schedule(() => {
            this.timers[tier] = null;
            void this.flush(tier);
        }, ms);
    }

    private async flush(tier: SurfaceTier): Promise<void> {
        const queue = this.pending[tier];
        if (queue.size === 0) return;
        if (!this.deps.isPaid()) {
            // The plan changed under a queued batch: send nothing.
            queue.clear();
            return;
        }
        const max = this.deps.maxBatch ?? SURFACE_MAX_BATCH;
        const batch = [...queue.entries()].slice(0, max);
        for (const [key] of batch) {
            queue.delete(key);
            this.inFlight[tier].add(key);
        }
        // Whatever did not fit leaves in the next request.
        if (queue.size > 0) this.arm(tier);

        const generation = this.generation;
        const texts = batch.map(([, text]) => text);
        this.sent[tier]++;
        this.deps.debug?.(`[surface] ${tier}: ${texts.length} text(s) in one request`);
        let outcome: SurfaceOutcome;
        try {
            outcome = await this.deps.translate(tier, texts);
        } catch {
            outcome = null;
        }
        if (generation !== this.generation) return;

        const now = this.deps.now();
        batch.forEach(([key], i) => {
            this.inFlight[tier].delete(key);
            const verdict = outcome === null ? null : outcome[i];
            if (verdict === null || verdict === undefined) {
                this.retryAt[tier].set(key, now + (this.deps.notNowRetryMs ?? SURFACE_NOT_NOW_RETRY_MS));
            } else if (verdict === "fail") {
                this.retryAt[tier].set(key, now + (this.deps.failRetryMs ?? SURFACE_FAIL_RETRY_MS));
            } else if (verdict === "skip") {
                this.deps.cache.put(key, { skip: true });
                // Not foreign after all: the other tier need not be asked.
                this.pending.fast.delete(key);
                this.pending.quality.delete(key);
            } else {
                this.deps.cache.put(key, tier === "quality" ? { quality: verdict } : { fast: verdict });
                if (tier === "quality") this.pending.fast.delete(key);
            }
        });
        for (const listener of [...this.listeners]) {
            try { listener(); } catch { /* one broken listener must not starve the rest */ }
        }
    }
}
