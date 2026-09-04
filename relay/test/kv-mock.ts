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

import { applyBudget, type BudgetState } from "../src/budget";
/** A fake Budget Durable Object namespace: one shared in-memory counter,
 *  applying the real applyBudget arithmetic — so codes.ts's DO path is exercised. */
export function fakeBudget() {
    const state: BudgetState = { total: 0, frozen: false };
    const stub = {
        fetch: async (_url: string, init: any) => {
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
