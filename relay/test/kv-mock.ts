import type { CodeRecord } from "../src/codes";
/** Minimal in-memory KVNamespace for tests. Ignores TTL (irrelevant to logic). */
export function fakeKV(seed: Record<string, string> = {}) {
    const m = new Map<string, string>(Object.entries(seed));
    return {
        get: async (k: string) => (m.has(k) ? m.get(k)! : null),
        put: async (k: string, v: string) => { m.set(k, v); },
        delete: async (k: string) => { m.delete(k); },
        _dump: () => Object.fromEntries(m),
    } as unknown as KVNamespace & { _dump: () => Record<string, string> };
}
export function codeRec(over: Partial<CodeRecord> = {}): string {
    return JSON.stringify({ status: "active", dailyCap: 500, plan: "free", ...over } satisfies CodeRecord);
}
