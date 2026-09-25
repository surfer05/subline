/**
 * The translation cache for text OUTSIDE messages: statuses, bios, embeds,
 * polls, reply and forward previews, channel topics and the like.
 *
 * KEYED BY TEXT, NOT BY PLACE. The same custom status shows in the member
 * list, the DM list and the profile; the same link preview is posted in ten
 * channels. Each distinct text (normalised) is translated once per target
 * language and reused everywhere, in this session and the next.
 *
 * BOUNDED. At most `maxEntries` (2,000), least recently used first out, and
 * nothing older than `maxAgeMs` (30 days) is served or kept. Persisted to
 * DataStore after a short quiet period, so a member list rendering fifty
 * statuses writes once, not fifty times.
 *
 * Every entry read from disk is validated, never trusted: a bad row is dropped
 * and that one text is simply translated again.
 */

export interface SurfaceTranslation {
    lang: string;
    text: string;
    /** Google's detection confidence, when it gave one. */
    conf?: number;
}

export interface SurfaceEntry {
    /** ≈, Google. */
    fast?: SurfaceTranslation;
    /** ✦, the relay. */
    quality?: SurfaceTranslation;
    /** An engine judged it not foreign (already in the target language). */
    skip?: true;
    /** Last written or read, epoch ms. Drives both the LRU and the age limit. */
    at: number;
}

export const SURFACE_CACHE_KEY = "VcTranslate_surfaceCache";
export const SURFACE_CACHE_MAX_ENTRIES = 2_000;
export const SURFACE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SURFACE_PERSIST_DELAY_MS = 2_000;

/** Whitespace-insensitive at the edges and within lines, line-break-preserving. */
export function normalizeSurfaceText(text: string): string {
    return text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map(line => line.replace(/[ \t ]+/g, " ").trim())
        .join("\n")
        .trim();
}

export function surfaceKey(text: string, targetLang: string): string {
    return `${targetLang}\u0000${normalizeSurfaceText(text)}`;
}

export interface SurfaceStorage {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
}

export interface SurfaceCacheOptions {
    storage: SurfaceStorage;
    now: () => number;
    schedule: (fn: () => void, ms: number) => unknown;
    cancel: (handle: unknown) => void;
    maxEntries?: number;
    maxAgeMs?: number;
    persistDelayMs?: number;
}

function isTranslation(v: unknown): v is SurfaceTranslation {
    if (v === null || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    return typeof o.lang === "string" && typeof o.text === "string" && o.text.trim() !== ""
        && (o.conf === undefined || (typeof o.conf === "number" && Number.isFinite(o.conf)));
}

function isEntry(v: unknown): v is SurfaceEntry {
    if (v === null || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    if (typeof o.at !== "number" || !Number.isFinite(o.at)) return false;
    if (o.fast !== undefined && !isTranslation(o.fast)) return false;
    if (o.quality !== undefined && !isTranslation(o.quality)) return false;
    if (o.skip !== undefined && o.skip !== true) return false;
    return o.fast !== undefined || o.quality !== undefined || o.skip === true;
}

export class SurfaceCache {
    private readonly map = new Map<string, SurfaceEntry>();
    private timer: unknown = null;
    private readonly maxEntries: number;
    private readonly maxAgeMs: number;
    private readonly persistDelayMs: number;
    private writes = Promise.resolve();

    constructor(private readonly opts: SurfaceCacheOptions) {
        this.maxEntries = opts.maxEntries ?? SURFACE_CACHE_MAX_ENTRIES;
        this.maxAgeMs = opts.maxAgeMs ?? SURFACE_CACHE_MAX_AGE_MS;
        this.persistDelayMs = opts.persistDelayMs ?? SURFACE_PERSIST_DELAY_MS;
    }

    get size(): number {
        return this.map.size;
    }

    /** The entry for a key, touched (most recently used). Expired entries are dropped. */
    get(key: string): SurfaceEntry | undefined {
        const entry = this.map.get(key);
        if (entry === undefined) return undefined;
        const now = this.opts.now();
        if (now - entry.at > this.maxAgeMs) {
            this.map.delete(key);
            this.schedulePersist();
            return undefined;
        }
        // Touch: re-insert at the young end. The timestamp is refreshed too,
        // so a status seen every day never ages out.
        this.map.delete(key);
        entry.at = now;
        this.map.set(key, entry);
        return entry;
    }

    /** Merge a verdict into an entry. A ✦ is never replaced by ≈. */
    put(key: string, patch: { fast?: SurfaceTranslation; quality?: SurfaceTranslation; skip?: true }): SurfaceEntry {
        const prev = this.map.get(key);
        const next: SurfaceEntry = { ...(prev ?? {}), at: this.opts.now() };
        if (patch.quality) {
            next.quality = patch.quality;
            delete next.skip;
        }
        if (patch.fast && !next.quality) next.fast = patch.fast;
        if (patch.skip && !next.quality && !next.fast) next.skip = true;
        this.map.delete(key);
        this.map.set(key, next);
        this.evict();
        this.schedulePersist();
        return next;
    }

    private evict(): void {
        while (this.map.size > this.maxEntries) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined) break;
            this.map.delete(oldest);
        }
    }

    private schedulePersist(): void {
        if (this.timer !== null) return;
        this.timer = this.opts.schedule(() => {
            this.timer = null;
            void this.persistNow();
        }, this.persistDelayMs);
    }

    /** Write everything now. Never rejects. */
    persistNow(): Promise<void> {
        if (this.timer !== null) {
            this.opts.cancel(this.timer);
            this.timer = null;
        }
        const snapshot = [...this.map.entries()];
        this.writes = this.writes.then(() => this.opts.storage.set(SURFACE_CACHE_KEY, snapshot)).catch(() => { });
        return this.writes;
    }

    /** Load from disk. Entries set this session win. Never rejects. */
    async load(): Promise<void> {
        let stored: unknown;
        try {
            stored = await this.opts.storage.get(SURFACE_CACHE_KEY);
        } catch {
            return;
        }
        if (!Array.isArray(stored)) return;
        const now = this.opts.now();
        const loaded = new Map<string, SurfaceEntry>();
        for (const row of stored) {
            if (!Array.isArray(row) || row.length !== 2) continue;
            const [key, value] = row as [unknown, unknown];
            if (typeof key !== "string" || key === "" || !isEntry(value)) continue;
            if (now - value.at > this.maxAgeMs) continue;
            loaded.set(key, value);
        }
        // Disk order is LRU order (oldest first); session entries go after it.
        const session = [...this.map.entries()];
        const inSession = new Set(this.map.keys());
        this.map.clear();
        for (const [k, v] of loaded) if (!inSession.has(k)) this.map.set(k, v);
        for (const [k, v] of session) this.map.set(k, v);
        this.evict();
    }

    /** Drop everything in memory (stop()). Disk is untouched. */
    clear(): void {
        if (this.timer !== null) this.opts.cancel(this.timer);
        this.timer = null;
        this.map.clear();
    }

    keys(): string[] {
        return [...this.map.keys()];
    }
}
