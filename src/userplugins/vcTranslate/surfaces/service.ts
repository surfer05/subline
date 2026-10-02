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
export type SurfaceVerdict = { lang: string; text: string; conf?: number } | "skip" | "unsure" | "fail";

/**
 * What `translate` returns: a verdict per text, in order, or `null` for "not
 * now" (sent, but refused or unreachable). "Not now" is retried later; a
 * "fail" verdict is not retried for `failRetryMs`. `"busy"` means nothing was
 * sent at all (a message batch was out, a cooldown, no gate slot): it costs
 * no per-minute slot and no budget, and is retried after `busyRetryMs`.
 */
export type SurfaceOutcome = SurfaceVerdict[] | null | "busy";

export interface SurfaceDeps {
    isPaid(): boolean;
    /**
     * Whether ✦ (the relay) may be asked. False for an Automatic owner without
     * AI: then every surface, tight ones too, is translated by Google (≈), which
     * costs nothing, and nothing goes to the relay. Absent means true.
     */
    qualityAllowed?(): boolean;
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
     * The surfaces' own daily ✦ allowance in cost units (see budget.ts and
     * `surfaceCost`). When it is spent,
     * nothing more goes to the relay today: roomy lines fall back to ≈, tight
     * marks show nothing new. Absent means unlimited (tests of other rules).
     */
    budget?: { remaining(): number; spend(units: number): void; };
    /** At most this many relay requests per minute for surfaces (default 4). */
    maxQualityPerMinute?: number;
    /** At most this many Google requests per minute for surfaces (default 60). */
    maxFastPerMinute?: number;
    maxBatchBytes?: number;
    fastDebounceMs?: number;
    qualityDebounceMs?: number;
    maxBatch?: number;
    /** Fast-tier (Google) texts per batch (default SURFACE_MAX_FAST_BATCH). */
    maxFastBatch?: number;
    failRetryMs?: number;
    notNowRetryMs?: number;
    busyRetryMs?: number;
}

export const SURFACE_FAST_DEBOUNCE_MS = 400;
export const SURFACE_QUALITY_DEBOUNCE_MS = 1_500;
export const SURFACE_MAX_BATCH = 25;
/**
 * A fast-tier (Google) surface batch carries at most this many texts. Google is
 * asked once per text, so a small batch keeps each burst short and lets the
 * per-minute cap below meter it finely.
 */
export const SURFACE_MAX_FAST_BATCH = 5;
/** A batch never carries more than this much text (UTF-8 bytes). */
export const SURFACE_MAX_BATCH_BYTES = 20 * 1024;
/** Longer texts are not surface-translated at all: no request, no line. */
export const SURFACE_MAX_TEXT_CHARS = 2_000;
/**
 * The cap for long-text kinds (an embed description allows 4,096). The same
 * number as the relay's per-text limit (relay/src/index.ts MAX_TEXT_CHARS):
 * one text over it makes the relay refuse the whole batch.
 */
export const SURFACE_MAX_LONG_TEXT_CHARS = 4_000;

/** Spans a long-text cut may not land inside. */
const UNCUTTABLE = /```[\s\S]*?```|`[^`\n]+`|<a?:\w+:\d+>|<#\d+>|<@&\d+>|<@!?\d+>|<t:-?\d+(?::[a-zA-Z])?>|https?:\/\/\S+/g;

/**
 * A long text cut to fit SURFACE_MAX_LONG_TEXT_CHARS: at the last paragraph
 * break, else the last sentence end, else the last space, at or under the
 * limit. `partial` says the line covers only the first part.
 */
export function fitLongText(text: string): { text: string; partial: boolean; } {
    const max = SURFACE_MAX_LONG_TEXT_CHARS;
    if (text.length <= max) return { text, partial: false };
    const head = text.slice(0, max);
    const breaks = [head.lastIndexOf("\n\n"), head.lastIndexOf("\n")];
    const sentence = Math.max(...[". ", "! ", "? ", "。", "！", "？"].map(m => {
        const at = head.lastIndexOf(m);
        return at < 0 ? -1 : at + m.trimEnd().length;
    }));
    const floor = max / 2;
    let cut = breaks.find(at => at >= floor) ?? -1;
    if (cut < 0 && sentence >= floor) cut = sentence;
    if (cut < 0) cut = head.lastIndexOf(" ");
    if (cut < floor) cut = max;
    // Never inside a Discord token (a code block, inline code, a link, a
    // mention, an emoji, a timestamp): half of one would reach the
    // translator as text. Cut before it instead.
    for (const m of text.matchAll(UNCUTTABLE)) {
        const start = m.index!, end = start + m[0].length;
        if (cut > start && cut < end) { cut = start; break; }
        if (start >= cut) break;
    }
    if (cut <= 0) cut = max;
    // Never end on half of a surrogate pair.
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    return { text: text.slice(0, cut).trimEnd(), partial: true };
}

/** What one text costs against the daily budget: 1 + one per started 1,000 characters. */
export function surfaceCost(text: string): number {
    return 1 + Math.ceil(text.length / 1000);
}

function byteLength(text: string): number {
    return new TextEncoder().encode(text).length;
}
export const SURFACE_FAIL_RETRY_MS = 10 * 60_000;
export const SURFACE_NOT_NOW_RETRY_MS = 60_000;
/** Nothing was sent (a message batch was out): ask again soon. */
export const SURFACE_BUSY_RETRY_MS = 8_000;
/**
 * At most this many tight texts wait per tier. Rows scrolled past fall off
 * the old end without ever being sent; what is on screen now is the newest.
 */
export const SURFACE_MAX_PENDING = 60;
/**
 * Before a batch carrying tight texts leaves, mounted views are asked to
 * render again, and a tight text only goes if it is wanted again within this
 * long. A row scrolled past is no longer mounted, so it never spends.
 */
export const SURFACE_PROBE_MS = 300;
export const SURFACE_MAX_QUALITY_PER_MINUTE = 4;
/**
 * Google is free to us, but a member list or a busy server can want hundreds
 * of statuses at once, and Google answers a burst with 429s. Surfaces send at
 * most this many TEXTS to Google a minute (each text is one Google call), one
 * batch at a time.
 */
export const SURFACE_MAX_FAST_PER_MINUTE = 60;
const MINUTE_MS = 60_000;

export interface WantOptions {
    /**
     * A tight mark (a tooltip on a list row, a title, a tag). Tight marks use
     * ✦ only: Google is never asked, so a long list costs no ≈ fan-out.
     */
    tight?: boolean;
    /** A kind that may be long (an embed description): the 4,000 cap applies, see fitLongText. */
    long?: boolean;
}

const TIERS: SurfaceTier[] = ["fast", "quality"];

interface PendingText { text: string; tight: boolean; wantedAt: number; }

export class SurfaceService {
    private readonly pending: Record<SurfaceTier, Map<string, PendingText>> = { fast: new Map(), quality: new Map() };
    /** When the probe for the next flush went out (see SURFACE_PROBE_MS), or null. */
    private readonly probeAt: Record<SurfaceTier, number | null> = { fast: null, quality: null };
    /** One timer per tier that wakes mounted views when parked texts may be asked again. */
    private readonly wake: Record<SurfaceTier, { handle: unknown; at: number; } | null> = { fast: null, quality: null };
    private readonly inFlight: Record<SurfaceTier, Set<string>> = { fast: new Set(), quality: new Set() };
    private readonly retryAt: Record<SurfaceTier, Map<string, number>> = { fast: new Map(), quality: new Map() };
    private readonly timers: Record<SurfaceTier, unknown> = { fast: null, quality: null };
    private readonly listeners = new Set<() => void>();
    private generation = 0;
    /** Requests actually sent, per tier. For tests and debug logging. */
    readonly sent: Record<SurfaceTier, number> = { fast: 0, quality: 0 };
    /** When each recent surface request left, per tier, for the per-minute caps. */
    private readonly sends: Record<SurfaceTier, number[]> = { fast: [], quality: [] };
    /**
     * A request of this tier is out. The next batch is armed only when it
     * comes back: one request at a time per tier, never a burst of parallel
     * ones while the first is still waiting on Google.
     */
    private readonly busy: Record<SurfaceTier, boolean> = { fast: false, quality: false };

    constructor(private readonly deps: SurfaceDeps) { }

    /**
     * What to show for `text` right now, and queue whatever is still missing.
     * `null` means show nothing: not paid, nothing foreign, or nothing yet.
     */
    want(text: string | null | undefined, options: WantOptions = {}): SurfaceEntry | null {
        if (typeof text !== "string" || !this.deps.isPaid()) return null;
        let norm = normalizeSurfaceText(text);
        if (options.long) norm = fitLongText(norm).text;
        if (norm === "" || (norm.length > SURFACE_MAX_TEXT_CHARS && !options.long) || this.deps.locallySkipped(norm)) return null;
        const key = surfaceKey(norm, this.deps.targetLang());
        const entry = this.deps.cache.get(key);
        if (entry?.skip) return null;
        if (entry?.quality) return entry;
        const tight = options.tight === true;
        // A tight mark is ✦ only while ✦ can be had. Without AI, or once
        // today's surface ✦ is spent, it is Google's too: ≈ in place, exactly
        // as an Automatic owner gets. Paying more must never show less.
        if ((!tight || !this.tightQualityOnly()) && !entry?.fast) this.queue("fast", key, norm, tight);
        if (this.qualityAllowed() && this.budgetLeft() > 0) this.queue("quality", key, norm, tight);
        return entry ?? null;
    }

    /** Whether ✦ may be asked right now (see SurfaceDeps.qualityAllowed). */
    qualityAllowed(): boolean {
        return this.deps.qualityAllowed ? this.deps.qualityAllowed() : true;
    }

    /** True while a tight mark waits for ✦ alone: ✦ is allowed and today's budget is not spent. */
    tightQualityOnly(): boolean {
        return this.qualityAllowed() && this.budgetLeft() > 0;
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
            this.sends[tier] = [];
            this.busy[tier] = false;
            this.probeAt[tier] = null;
            if (this.wake[tier] !== null) this.deps.cancel(this.wake[tier]!.handle);
            this.wake[tier] = null;
        }
        this.listeners.clear();
    }

    private queue(tier: SurfaceTier, key: string, text: string, tight = false): void {
        if (this.inFlight[tier].has(key)) return;
        const retry = this.retryAt[tier].get(key);
        if (retry !== undefined && this.deps.now() < retry) return;
        const queue = this.pending[tier];
        // Re-inserted on every want, so the newest end of the map is what is
        // on screen now; flush sends from that end first.
        const was = queue.get(key);
        queue.delete(key);
        queue.set(key, { text, tight: tight && (was?.tight ?? true), wantedAt: this.deps.now() });
        // Tight texts only: a list row is wanted again whenever it is on
        // screen, while a roomy line under a message may render just once.
        if (queue.size > SURFACE_MAX_PENDING) {
            for (const [k, p] of queue) {
                if (queue.size <= SURFACE_MAX_PENDING) break;
                if (p.tight) queue.delete(k);
            }
        }
        this.arm(tier);
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            try { listener(); } catch { /* one broken listener must not starve the rest */ }
        }
    }

    /**
     * Wake mounted views at `at`, when a parked text may be asked again. Only
     * views still on screen call want() again, so nothing that has scrolled
     * away or closed is sent. One timer per tier, moved earlier when needed.
     */
    private scheduleWake(tier: SurfaceTier, at: number): void {
        const current = this.wake[tier];
        if (current !== null && current.at <= at) return;
        if (current !== null) this.deps.cancel(current.handle);
        const generation = this.generation;
        const handle = this.deps.schedule(() => {
            if (generation !== this.generation) return;
            this.wake[tier] = null;
            this.notify();
        }, Math.max(0, at - this.deps.now()) + 1);
        this.wake[tier] = { handle, at };
    }

    private arm(tier: SurfaceTier, atLeastMs = 0): void {
        if (this.timers[tier] !== null || this.busy[tier]) return;
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
        if (!this.deps.isPaid() || (tier === "quality" && !this.qualityAllowed())) {
            // The plan changed under a queued batch: send nothing.
            queue.clear();
            return;
        }
        let max = this.deps.maxBatch ?? SURFACE_MAX_BATCH;
        if (tier === "fast") max = Math.min(max, this.deps.maxFastBatch ?? SURFACE_MAX_FAST_BATCH);
        const maxBytes = this.deps.maxBatchBytes ?? SURFACE_MAX_BATCH_BYTES;
        let left = Number.POSITIVE_INFINITY;
        if (tier === "quality") {
            left = this.budgetLeft();
            if (left <= 0) {
                // Today's surface ✦ is spent: nothing more goes to the relay.
                queue.clear();
                return;
            }
        }
        // At most `maxQualityPerMinute` relay REQUESTS and `maxFastPerMinute`
        // Google TEXTS a minute (each text is one Google call). A full window
        // waits for its oldest entry to age out; a nearly full one sends only
        // as many fast texts as it still has room for.
        {
            const now = this.deps.now();
            this.sends[tier] = this.sends[tier].filter(t => now - t < MINUTE_MS);
            const cap = tier === "quality"
                ? this.deps.maxQualityPerMinute ?? SURFACE_MAX_QUALITY_PER_MINUTE
                : this.deps.maxFastPerMinute ?? SURFACE_MAX_FAST_PER_MINUTE;
            if (this.sends[tier].length >= cap) {
                this.arm(tier, this.sends[tier][0] + MINUTE_MS - now);
                return;
            }
            if (tier === "fast") max = Math.min(max, cap - this.sends[tier].length);
        }
        // STILL ON SCREEN? A tight text (a list row, a title) is wanted on
        // render, so rows scrolled past sit in the queue too. Ask mounted
        // views to render again and send only the tight texts wanted again;
        // the rest never spend a request or the day's budget.
        if (this.probeAt[tier] === null && this.listeners.size > 0 && [...queue.values()].some(p => p.tight)) {
            const generation = this.generation;
            this.probeAt[tier] = this.deps.now();
            this.timers[tier] = this.deps.schedule(() => {
                this.timers[tier] = null;
                if (generation === this.generation) void this.flush(tier);
            }, SURFACE_PROBE_MS);
            this.notify();
            return;
        }
        if (this.probeAt[tier] !== null) {
            const probedAt = this.probeAt[tier]!;
            this.probeAt[tier] = null;
            for (const [key, p] of [...queue.entries()]) if (p.tight && p.wantedAt < probedAt) queue.delete(key);
            if (queue.size === 0) return;
        }
        // Pack by count, by size, and (for ✦) by what today's budget still
        // allows, NEWEST FIRST: what was wanted last is what is on screen. A
        // text the budget can no longer afford is dropped from the ✦ queue; a
        // roomy line keeps its ≈.
        const batch: Array<[string, string]> = [];
        let bytes = 0;
        let units = 0;
        for (const [key, { text }] of [...queue.entries()].reverse()) {
            if (batch.length >= max) break;
            const size = byteLength(text);
            if (batch.length > 0 && bytes + size > maxBytes) break;
            const cost = surfaceCost(text);
            if (units + cost > left) {
                if (batch.length === 0) { queue.delete(key); continue; }
                break;
            }
            batch.push([key, text]);
            bytes += size;
            units += cost;
        }
        if (batch.length === 0) return;
        // Chosen newest first, sent in the order they were wanted.
        batch.reverse();
        // One entry per relay request, one per Google text.
        const sendEntries = tier === "fast" ? batch.length : 1;
        {
            const sentAt = this.deps.now();
            for (let i = 0; i < sendEntries; i++) this.sends[tier].push(sentAt);
        }
        for (const [key] of batch) {
            queue.delete(key);
            this.inFlight[tier].add(key);
        }

        const generation = this.generation;
        this.busy[tier] = true;
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
        this.busy[tier] = false;
        const now = this.deps.now();
        if (outcome === "busy") {
            // Nothing left this computer: give back the per-minute slot it
            // took, spend no budget, and ask again soon.
            this.sends[tier].splice(this.sends[tier].length - sendEntries, sendEntries);
            const at = now + (this.deps.busyRetryMs ?? SURFACE_BUSY_RETRY_MS);
            for (const [key] of batch) {
                this.inFlight[tier].delete(key);
                this.retryAt[tier].set(key, at);
            }
            this.scheduleWake(tier, at);
            if (this.pending[tier].size > 0) this.arm(tier);
            return;
        }
        // Whatever did not fit, or was asked for meanwhile, leaves in the next
        // request, armed only now that this one is back.
        if (this.pending[tier].size > 0) this.arm(tier);
        if (tier === "quality" && outcome !== null) this.deps.budget?.spend(units);

        let earliestRetry = Number.POSITIVE_INFINITY;
        batch.forEach(([key], i) => {
            this.inFlight[tier].delete(key);
            const verdict = outcome === null ? null : outcome[i];
            if (verdict === null || verdict === undefined) {
                this.retryAt[tier].set(key, now + (this.deps.notNowRetryMs ?? SURFACE_NOT_NOW_RETRY_MS));
            } else if (verdict === "fail") {
                this.retryAt[tier].set(key, now + (this.deps.failRetryMs ?? SURFACE_FAIL_RETRY_MS));
            } else if (verdict === "unsure") {
                // Google was not sure what language this is. That is no
                // verdict about the text: nothing is cached, the other tier is
                // not cancelled (✦ decides), and ≈ is not asked again until
                // the fail retry, so a render loop cannot re-send it.
                this.retryAt[tier].set(key, now + (this.deps.failRetryMs ?? SURFACE_FAIL_RETRY_MS));
            } else if (verdict === "skip") {
                // A real verdict: Google saw the reader's own language or
                // handed the text back unchanged, or ✦ decided it needs no
                // translation. A ✦ skip retracts a ≈ line already cached
                // (bias to silence, the same rule as messages); a ≈ skip never
                // removes a ✦ line. Either way this tier is not asked again
                // before the fail retry, even if the entry is evicted.
                this.deps.cache.put(key, tier === "quality" ? { skip: true, retract: true } : { skip: true });
                this.retryAt[tier].set(key, now + (this.deps.failRetryMs ?? SURFACE_FAIL_RETRY_MS));
                // Not foreign after all: the other tier need not be asked.
                this.pending.fast.delete(key);
                this.pending.quality.delete(key);
            } else {
                this.deps.cache.put(key, tier === "quality" ? { quality: verdict } : { fast: verdict });
                if (tier === "quality") this.pending.fast.delete(key);
            }
            const retry = this.retryAt[tier].get(key);
            if (retry !== undefined && retry > now && verdict !== "skip") earliestRetry = Math.min(earliestRetry, retry);
        });
        // A text parked for "not now" or a failure is asked for again by the
        // views still showing it, once its wait is over. Without this wake,
        // a popout opened during a message batch stayed untranslated until
        // something unrelated re-rendered it.
        if (Number.isFinite(earliestRetry)) this.scheduleWake(tier, earliestRetry);
        this.notify();
    }
}
