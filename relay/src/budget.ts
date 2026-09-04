/**
 * The global spend guard — the one place that must be ATOMIC.
 *
 * The whole ~$50 ceiling rests here. KV cannot enforce it: KV has no atomic
 * read-modify-write, so N concurrent requests all read `total`, all pass the
 * check, and all commit `total+cost` — the counter advances by ONE cost instead
 * of N, the freeze never trips, and the paid key drains without bound (found by
 * the security review, confirmed). A Durable Object serialises all requests to
 * one instance, so the read-check-increment below is atomic and the freeze is a
 * hard stop no matter how many requests race.
 *
 * Per-code daily caps stay in KV (see codes.ts): they are soft fairness limits,
 * and even if a code slips slightly over under concurrency the total dollars are
 * still bounded by THIS guard. The money-safety property lives here alone.
 *
 * The beta budget is a ONE-TIME total, so there is no monthly reset — `total`
 * accumulates until the maker calls /reset (or raises GLOBAL_BUDGET_MESSAGES).
 */

export interface BudgetState { total: number; frozen: boolean }
export interface BudgetResult { allowed: boolean; total: number; frozen: boolean }

/** Pure decision, unit-tested. Atomicity is the DO runtime's job; correctness
 *  of the arithmetic is this function's. */
export function applyBudget(state: BudgetState, cost: number, freezeAt: number): BudgetResult {
    if (state.frozen || state.total >= freezeAt) return { allowed: false, total: state.total, frozen: true };
    const next = state.total + cost;
    return { allowed: true, total: next, frozen: next >= freezeAt };
}

export class Budget {
    private total = 0;
    private frozen = false;
    private ready: Promise<void>;

    constructor(private ctx: DurableObjectState) {
        this.ready = ctx.blockConcurrencyWhile(async () => {
            this.total = (await ctx.storage.get<number>("total")) ?? 0;
            this.frozen = (await ctx.storage.get<boolean>("frozen")) ?? false;
        });
    }

    async fetch(req: Request): Promise<Response> {
        await this.ready;
        const path = new URL(req.url).pathname;

        if (path === "/reserve") {
            const { cost, freezeAt } = await req.json() as { cost: number; freezeAt: number };
            // Read → decide → write, with the in-memory value updated before the
            // storage await. The DO runtime's input gates hold concurrent fetches
            // during the storage op, so this is atomic; a racing request sees the
            // committed total.
            const r = applyBudget({ total: this.total, frozen: this.frozen }, cost, freezeAt);
            if (r.allowed) {
                this.total = r.total;
                this.frozen = r.frozen;
                await this.ctx.storage.put("total", this.total);
                if (this.frozen) await this.ctx.storage.put("frozen", true);
            }
            return Response.json(r);
        }
        if (path === "/status") return Response.json({ total: this.total, frozen: this.frozen });
        if (path === "/reset") { // maker-only (gated at the router): start a fresh budget window
            this.total = 0; this.frozen = false;
            await this.ctx.storage.deleteAll();
            return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
    }
}
