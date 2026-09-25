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
    /**
     * The surfaces' own daily ✦ allowance (see budget.ts). When it is spent,
     * nothing more goes to the relay today: roomy lines fall back to ≈, tight
     * marks show nothing new. Absent means unlimited (tests of other rules).
     */
    budget?: { remaining(): number; spend(texts: number): void; };
    /** At most this many relay requests per minute for surfaces (default 4). */
    maxQualityPerMinute?: number;
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
export const SURFACE_MAX_QUALITY_PER_MINUTE = 4;
const MINUTE_MS = 60_000;

export interface WantOptions {
    /**
     * A tight mark (a tooltip on a list row, a title, a tag). Tight marks use
     * ✦ only: Google is never asked, so a long list costs no ≈ fan-out.
     */
    tight?: boolean;
}

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
    /** When each recent surface relay request left, for the per-minute cap. */
    private qualitySends: number[] = [];

    constructor(private readonly deps: SurfaceDeps) { }

    /**
     * What to show for `text` right now, and queue whatever is still missing.
     * `null` means show nothing: not paid, nothing foreign, or nothing yet.
     */
    want(text: string | null | undefined, options: WantOptions = {}): SurfaceEntry | null {
        if (typeof text !== "string" || !this.deps.isPaid()) return null;
        const norm = normalizeSurfaceText(text);
        if (norm === "" || this.deps.locallySkipped(norm)) return null;
        const key = surfaceKey(norm, this.deps.targetLang());
        const entry = this.deps.cache.get(key);
        if (entry?.skip) return null;
        if (entry?.quality) return entry;
        if (!options.tight && !entry?.fast) this.queue("fast", key, norm);
        if (this.budgetLeft() > 0) this.queue("quality", key, norm);
        return entry ?? null;
    }

    private budgetLeft(): number {
        return this.deps.budget ? this.deps.budget.remaining() : Number.POSITIVE_INFINITY;
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
        this.qualitySends = [];
    }

    private queue(tier: SurfaceTier, key: string, text: string): void {
        if (this.inFlight[tier].has(key) || this.pending[tier].has(key)) return;
        const retry = this.retryAt[tier].get(key);
        if (retry !== undefined && this.deps.now() < retry) return;
        this.pending[tier].set(key, text);
        this.arm(tier);
    }

    private arm(tier: SurfaceTier, atLeastMs = 0): void {
        if (this.timers[tier] !== null) return;
        const ms = Math.max(atLeastMs, tier === "fast"
            ? this.deps.fastDebounceMs ?? SURFACE_FAST_DEBOUNCE_MS
            : this.deps.qualityDebounceMs ?? SURFACE_QUALITY_DEBOUNCE_MS);
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
        let max = this.deps.maxBatch ?? SURFACE_MAX_BATCH;
        if (tier === "quality") {
            const left = this.budgetLeft();
            if (left <= 0) {
                // Today's surface ✦ is spent: nothing more goes to the relay.
                queue.clear();
                return;
            }
            max = Math.min(max, left);
            // At most `maxQualityPerMinute` surface requests a minute. A full
            // window waits for its oldest request to age out.
            const now = this.deps.now();
            this.qualitySends = this.qualitySends.filter(t => now - t < MINUTE_MS);
            const cap = this.deps.maxQualityPerMinute ?? SURFACE_MAX_QUALITY_PER_MINUTE;
            if (this.qualitySends.length >= cap) {
                this.arm(tier, this.qualitySends[0] + MINUTE_MS - now);
                return;
            }
            this.qualitySends.push(now);
        }
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
        if (tier === "quality" && outcome !== null) this.deps.budget?.spend(texts.length);

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
