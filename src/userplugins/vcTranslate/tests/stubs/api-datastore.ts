/** Stand-in for Vencord's IndexedDB-backed `@api/DataStore`. */
const mem = new Map<string, unknown>();

/**
 * Every key a test run has written, in order, including repeats.
 *
 * Exists for one claim the map alone cannot support: the install id (see
 * taste.ts) must be generated and persisted ONCE, ever. Reading the map back
 * proves only that a value is there, not that a second press did not quietly
 * overwrite it with a different id.
 */
export const writes: string[] = [];

export async function get<T>(key: string): Promise<T | undefined> {
    return mem.get(key) as T | undefined;
}

export async function set(key: string, value: unknown): Promise<void> {
    writes.push(key);
    mem.set(key, value);
}

export function __reset(): void {
    mem.clear();
    writes.length = 0;
}
