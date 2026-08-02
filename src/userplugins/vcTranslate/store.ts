// Three terminal states, not two. `skipped` exists because a message that is
// ALREADY in the target language has no translation to store — but writing
// nothing at all would make it a permanent cache miss, so catch-up would
// re-enqueue the entire already-target-language backlog on every channel open,
// forever. In a mixed-language chat that is most of the backlog. Both `failed`
// and `skipped` are "resolved"; only `failed` is worth retrying.
export type StoredTranslation =
    | { lang: string; text: string }
    | { failed: true }
    | { skipped: true };

const MAX_ENTRIES = 500;

const cache = new Map<string, StoredTranslation>();
const listeners = new Set<() => void>();

export function makeKey(messageId: string, lang: string, engine: string): string {
    return `${messageId} ${lang} ${engine}`;
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
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value as string;
        cache.delete(oldest);
    }
    for (const fn of listeners) fn();
}

export function invalidateMessage(messageId: string): void {
    const prefix = `${messageId} `;
    for (const key of [...cache.keys()]) {
        if (key.startsWith(prefix)) cache.delete(key);
    }
    for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function clearStore(): void {
    cache.clear();
    listeners.clear();
}
