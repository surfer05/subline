import type { CodeRecord } from "../src/codes";
/** Minimal in-memory KVNamespace for tests. Records the put OPTIONS (e.g.
 *  expirationTtl) so tests can assert a key was written to self-expire. */
export function fakeKV(seed: Record<string, string> = {}) {
    const m = new Map<string, string>(Object.entries(seed));
    const opts = new Map<string, any>();
    return {
        get: async (k: string) => (m.has(k) ? m.get(k)! : null),
        put: async (k: string, v: string, o?: any) => { m.set(k, v); opts.set(k, o); },
        delete: async (k: string) => { m.delete(k); opts.delete(k); },
        _dump: () => Object.fromEntries(m),
        _opts: (k: string) => opts.get(k),
    } as unknown as KVNamespace & { _dump: () => Record<string, string>; _opts: (k: string) => any };
}
export function codeRec(over: Partial<CodeRecord> = {}): string {
    return JSON.stringify({ status: "active", dailyCap: 500, plan: "free", ...over } satisfies CodeRecord);
}

import { Budget } from "../src/budget";

/** In-memory Durable Object storage with the calls the relay's objects use. */
export function fakeDOStorage() {
    const store = new Map<string, unknown>();
    let alarm: number | null = null;
    const storage = {
        // Read when the promise settles, not when called, like a real storage read.
        get: (k: string) => Promise.resolve().then(() => store.get(k)),
        put: async (k: string | Record<string, unknown>, v?: unknown) => {
            if (typeof k === "object") for (const [a, b] of Object.entries(k)) store.set(a, b);
            else store.set(k, v);
        },
        delete: async (k: string | string[]) => {
            if (Array.isArray(k)) { let n = 0; for (const x of k) if (store.delete(x)) n++; return n; }
            return store.delete(k);
        },
        deleteAll: async () => { store.clear(); },
        list: async (o: { prefix?: string } = {}) => new Map([...store].filter(([k]) => k.startsWith(o.prefix ?? ""))),
        getAlarm: async () => alarm,
        setAlarm: async (t: number) => { alarm = t; }
    };
    return { store, storage, alarm: () => alarm };
}

/** A fake Budget Durable Object namespace running the REAL Budget class (one
 *  instance, in-memory storage), so codes.ts's DO path is exercised as it
 *  runs in production. `state.total` reads and sets the global total;
 *  `count(key)` reads a per-code row (see budget.ts dayRowKey). */
export function fakeBudget() {
    const { store, storage } = fakeDOStorage();
    const obj = new Budget({ storage, blockConcurrencyWhile: async (fn: () => Promise<void>) => fn() } as unknown as DurableObjectState);
    const inner = () => ((obj as any).st ?? obj) as { total: number; counters?: Map<string, number> };
    const stub = { fetch: (url: string, init?: any) => obj.fetch(new Request(String(url), init)) };
    const state = {
        get total() { return inner().total; },
        // Also stored, so the object's own (async) first load reads the same value.
        set total(v: number) { inner().total = v; store.set("total", v); }
    };
    return {
        ns: { idFromName: () => "global", get: () => stub } as unknown as DurableObjectNamespace,
        state,
        obj,
        store,
        count: (key: string) => inner().counters?.get(key) ?? (store.get(key) as number | undefined) ?? 0
    };
}
