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

import { applyBudget, type BudgetState } from "../src/budget";
/** A fake Budget Durable Object namespace: one shared in-memory counter,
 *  applying the real applyBudget arithmetic — so codes.ts's DO path is exercised. */
export function fakeBudget() {
    const state: BudgetState = { total: 0, frozen: false };
    const stub = {
        fetch: async (url: string, init: any) => {
            // /status, as the real Budget DO answers it (see budget.ts).
            if (String(url).endsWith("/status")) return { json: async () => ({ total: state.total, frozen: state.frozen }) } as any;
            const { cost, freezeAt } = JSON.parse(init.body);
            const r = applyBudget(state, cost, freezeAt);
            if (r.allowed) { state.total = r.total; state.frozen = r.frozen; }
            return { json: async () => r } as any;
        }
    };
    return {
        ns: { idFromName: () => "global", get: () => stub } as unknown as DurableObjectNamespace,
        state
    };
}
