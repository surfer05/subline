import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

import { ENGINE_CAPS, type EngineId } from "./types";

const logger = new Logger("VcTranslate");

// Four states, not two. `skipped` exists because a message that is ALREADY in
// the target language has no translation to store — but writing nothing at
// all would make it a permanent cache miss, so catch-up would re-enqueue the
// entire already-target-language backlog on every channel open, forever. In a
// mixed-language chat that is most of the backlog.
//
// `deferred` exists for the same "don't leave it blank" reason, but for the
// opposite situation: the request was never attempted at all, or was
// rejected by the API before it ever reached the model (most commonly a 429
// rate-limit from a catch-up burst against Claude/Gemini's free/low tiers).
// That is not a translation failure — the model never got a chance to be
// wrong — so it must not render or count as one. `failed` is reserved for a
// genuine attempt that came back broken (bad response shape, an id the model
// never returned a usable row for, a non-retryable transport error).
//
// All four are "resolved" in the sense that catch-up's cache-hit check must
// see an entry at all; `failed` and `deferred` are the two worth retrying.
//
// `via` records which engine actually produced a real translation. It lives in
// the VALUE, not in the key (see makeKey), and it is what lets the accessory
// tell the reader whether the line they are reading came from a
// context-aware model or from Google's per-message approximation.
//
// `conf` is Google's detection confidence, kept for two jobs: the accessory
// marks a low-confidence line so the reader knows not to trust it, and a short
// reply borrowing this message's language only does so when this message was
// itself detected confidently — otherwise one bad detection would propagate
// down an entire reply chain.
export type StoredTranslation =
    | { lang: string; text: string; via: EngineId; conf?: number }
    | { failed: true }
    | { skipped: true }
    | { deferred: true };

const MAX_ENTRIES = 500;

const cache = new Map<string, StoredTranslation>();
const listeners = new Set<() => void>();

/* ------------------------------------------------------------ persistence -- */

export const PERSIST_KEY = "VcTranslate_translations";

/**
 * How many entries survive a restart, independent of the 500-entry in-memory
 * LRU above.
 *
 * The two caps answer different questions. 500 is a session's working set —
 * what the reader might scroll back to right now. The persisted cap exists so
 * a restart costs nothing, which means it should cover the backlog a user
 * actually re-reads across days, not just the current session. At roughly
 * 1,000 translated messages a day (the budget this phase is built around: ~40
 * requests × ~25 messages), 2,000 is about two days of chat.
 *
 * It is also small on disk: an entry is a key plus a short translation, on the
 * order of 100-200 bytes of JSON, so the whole thing is a few hundred KB in
 * IndexedDB. Raising it is cheap; leaving it unbounded is not, which is the
 * only thing this constant is actually here to prevent.
 */
const MAX_PERSISTED = 2000;

/**
 * The in-memory mirror of what is on disk — same pattern as channels.ts, for
 * the same reason: a write is async, and the rest of the plugin cannot wait on
 * IndexedDB to answer a cache lookup.
 *
 * Deliberately a SEPARATE map from `cache`, not a view of it. `cache` is the
 * LRU the renderer reads and is capped at 500; this one is capped at
 * MAX_PERSISTED and is only ever read to serialise. Eviction from one does not
 * evict from the other.
 */
const persisted = new Map<string, StoredTranslation>();

/**
 * What the last successful write actually put on disk, used to roll the mirror
 * back when a write fails (channels.ts's discipline: memory must never claim
 * something is persisted when it is not).
 */
let lastWritten: [string, StoredTranslation][] = [];

/**
 * Writes are serialised through this chain and coalesced via `dirty`, so the
 * 25 setTranslation() calls that land from a single batch response produce one
 * write of the whole map rather than 25.
 */
let writeChain: Promise<void> = Promise.resolve();
let dirty = false;

/** True for a value that still matches the StoredTranslation union TODAY. */
function isStoredTranslation(value: unknown): value is StoredTranslation {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const o = value as Record<string, unknown>;

    // The three marker variants carry exactly one key and nothing else.
    if (o.failed === true || o.skipped === true || o.deferred === true) {
        return Object.keys(o).length === 1;
    }

    return typeof o.lang === "string"
        && typeof o.text === "string"
        && isKnownEngine(o.via);
}

/**
 * `via` is validated against ENGINE_CAPS — the runtime table that already has
 * to list every engine — rather than against a hand-written string literal
 * union that would drift. A persisted entry outlives a rename of the engine
 * ids, so a stored `via: "gemini"` after a rename to (say) "google-gemini"
 * would otherwise be trusted and then crash ENGINE_PROVENANCE[entry.via] in
 * the renderer with an undefined lookup. Dropping the entry costs one
 * re-translation; trusting it breaks the subtitle.
 */
function isKnownEngine(value: unknown): value is EngineId {
    return typeof value === "string"
        && Object.prototype.hasOwnProperty.call(ENGINE_CAPS, value);
}

function schedulePersist(): void {
    dirty = true;
    writeChain = writeChain.then(flushOnce);
}

async function flushOnce(): Promise<void> {
    // A previous link in the chain already wrote everything that was pending.
    if (!dirty) return;
    dirty = false;

    const snapshot: [string, StoredTranslation][] = [...persisted.entries()];
    try {
        await DataStore.set(PERSIST_KEY, snapshot);
        lastWritten = snapshot;
    } catch (err) {
        // Roll the mirror back to what disk actually holds. Note this does NOT
        // touch `cache`: the reader keeps the translation for this session, it
        // just stops being something we claim is saved. Same direction as
        // channels.ts — never let memory outrun the disk.
        persisted.clear();
        for (const [k, v] of lastWritten) persisted.set(k, v);
        dirty = false;
        logger.warn("Couldn't persist translations; keeping them for this session only.", err);
    }
}

/**
 * Resolves once every write scheduled so far has settled. Exists so tests can
 * assert on what actually reached DataStore without sleeping, and so a future
 * caller can flush deliberately; nothing in the plugin awaits it.
 */
export function persistenceSettled(): Promise<void> {
    return writeChain;
}

/**
 * Rehydrate the cache from disk. Never rejects and never throws: a slow or
 * broken read degrades to an empty cache (every message is simply a miss and
 * gets re-requested), which is the pre-Phase-2 behaviour, not a broken plugin.
 *
 * Entries already written this session win over anything on disk — the load is
 * not awaited by start(), so a message translated during startup must not be
 * clobbered by a stale persisted copy of itself.
 */
export async function loadPersistedTranslations(): Promise<void> {
    let stored: unknown;
    try {
        stored = await DataStore.get<unknown>(PERSIST_KEY);
    } catch (err) {
        logger.warn("Couldn't read persisted translations; starting with an empty cache.", err);
        return;
    }

    // Absent, or written by some other/older format. Not an error.
    if (!Array.isArray(stored)) return;

    const valid: [string, StoredTranslation][] = [];
    for (const row of stored) {
        // Every entry is validated rather than trusted. A shape that does not
        // match the union today is DROPPED, not coerced and not kept: the only
        // cost is re-translating that one message, whereas a bad entry renders
        // as a broken subtitle forever.
        if (!Array.isArray(row) || row.length !== 2) continue;
        const [key, value] = row as [unknown, unknown];
        if (typeof key !== "string" || key === "") continue;
        if (!isStoredTranslation(value)) continue;
        valid.push([key, value]);
    }

    // Insertion order is oldest-first, so the tail is the newest.
    for (const [key, value] of valid.slice(-MAX_PERSISTED)) {
        if (!persisted.has(key)) persisted.set(key, value);
        if (!cache.has(key)) cache.set(key, value);
    }
    trim(cache, MAX_ENTRIES);
    lastWritten = [...persisted.entries()];

    // Anything already rendered as "no translation yet" has to re-read now.
    for (const fn of listeners) fn();
}

function trim(map: Map<string, StoredTranslation>, max: number): void {
    while (map.size > max) {
        const oldest = map.keys().next().value as string;
        map.delete(oldest);
    }
}

/**
 * The cache key is (message, target language) — deliberately NOT (message,
 * target language, engine).
 *
 * Keying by engine meant a translation produced by one engine was invisible to
 * a reader configured for another: the writer wrote `<id> <lang> google` while
 * the accessory looked up `<id> <lang> gemini` and got a guaranteed miss. That
 * makes an engine fallback — translate with Google when the LLM engine is
 * unavailable — structurally impossible to display, which is the reason this
 * component exists in the shape it does.
 *
 * The visible consequence, which is intended: switching engines does not
 * re-request anything. A message already translated by Google stays on screen,
 * labelled as Google, when Gemini is selected. Budget is not re-spent
 * upgrading messages the user has already read.
 *
 * Separator discipline: exactly one space, and no trailing separator, so
 * `invalidateMessage`'s `"<id> "` prefix scan matches message `7` without also
 * matching message `70`.
 */
export function makeKey(messageId: string, lang: string): string {
    return `${messageId} ${lang}`;
}

export function getTranslation(key: string): StoredTranslation | undefined {
    const hit = cache.get(key);
    if (hit === undefined) return undefined;
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
}

export function setTranslation(key: string, value: StoredTranslation): void {
    cache.delete(key);
    cache.set(key, value);
    trim(cache, MAX_ENTRIES);

    // Same recency-refresh + eviction as the LRU above, on its own cap.
    persisted.delete(key);
    persisted.set(key, value);
    trim(persisted, MAX_PERSISTED);
    schedulePersist();

    for (const fn of listeners) fn();
}

export function invalidateMessage(messageId: string): void {
    const prefix = `${messageId} `;
    for (const key of [...cache.keys()]) {
        if (key.startsWith(prefix)) cache.delete(key);
    }

    // Must reach disk too, or an edited message's pre-edit translation comes
    // back from the dead on the next restart.
    let removedFromDisk = false;
    for (const key of [...persisted.keys()]) {
        if (key.startsWith(prefix)) {
            persisted.delete(key);
            removedFromDisk = true;
        }
    }
    if (removedFromDisk) schedulePersist();

    for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Drops everything held in memory, including the persistence mirror and any
 * pending write bookkeeping. Deliberately does NOT erase what is on disk: this
 * is a "reset this module's state" hook (tests, stop/start), not a "forget the
 * user's translations" one.
 */
export function clearStore(): void {
    cache.clear();
    listeners.clear();
    persisted.clear();
    lastWritten = [];
    dirty = false;
    writeChain = Promise.resolve();
}
