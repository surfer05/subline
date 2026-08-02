/** Stand-in for Vencord's IndexedDB-backed `@api/DataStore`. */
const mem = new Map<string, unknown>();

export async function get<T>(key: string): Promise<T | undefined> {
    return mem.get(key) as T | undefined;
}

export async function set(key: string, value: unknown): Promise<void> {
    mem.set(key, value);
}

export function __reset(): void {
    mem.clear();
}
