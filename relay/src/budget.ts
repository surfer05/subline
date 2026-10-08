/**
 * The global spend guard and the per-code counters: the places that must be
 * ATOMIC.
 *
 * The money ceiling rests here. KV cannot enforce it: KV has no atomic
 * read-modify-write, so N concurrent requests all read `total`, all pass the
 * check, and all commit `total+cost` — the counter advances by ONE cost instead
 * of N, the freeze never trips, and the paid key drains without bound (found by
 * the security review, confirmed). A Durable Object serialises all requests to
 * one instance, so the read-check-increment below is atomic and the freeze is a
 * hard stop no matter how many requests race.
 *
 * PER-CODE COUNTERS LIVE HERE TOO (worst-case review, 2026-10). Every paid AI
 * request used to write two KV keys (use:<code>:<day> and rl:<code>:<minute>).
 * At 1,000 subscribers that is millions of KV writes a month, and on the
 * Workers Free plan the 1,000-writes-a-day ceiling stopped the relay within
 * minutes. The request already makes one call to this object, so the daily
 * count, the optional monthly allowance and the per-minute rate are checked and
 * counted inside that SAME call: no extra round trip, no KV write, and the
 * daily cap is now exact under concurrency. The per-minute counter is kept in
 * memory only (a soft anti-scrape limit; it resets if the object restarts).
 * Day and month rows are deleted by a daily alarm once they are old.
 *
 * FREEZE IS DERIVED, NEVER STORED. A request is refused while total >=
 * freezeAt, and freezeAt comes from GLOBAL_BUDGET_MESSAGES on every call. So
 * raising GLOBAL_BUDGET_MESSAGES (or POST /admin/budget/reset) unfreezes the
 * relay at once. A stored "frozen" flag used to outlive a raised limit and kept
 * every paying user refused until new code was deployed.
 *
 * The budget is a ONE-TIME total, so there is no monthly reset — `total`
 * accumulates until the owner calls POST /admin/budget/reset or raises
 * GLOBAL_BUDGET_MESSAGES. GET /admin/budget and /admin/stats show it.
 */

export interface BudgetState { total: number; frozen?: boolean }
export interface BudgetResult { allowed: boolean; total: number; frozen: boolean }

/** Pure decision, unit-tested. Atomicity is the DO runtime's job; correctness
 *  of the arithmetic is this function's. Decided from total and freezeAt ONLY:
 *  a `frozen` flag carried in `state` is ignored, so a raised limit unfreezes. */
export function applyBudget(state: BudgetState, cost: number, freezeAt: number): BudgetResult {
    if (state.total >= freezeAt) return { allowed: false, total: state.total, frozen: true };
    const next = state.total + cost;
    return { allowed: true, total: next, frozen: next >= freezeAt };
}

/** One per-code counter checked and counted inside a reserve. */
export interface CounterReq { key: string; add: number; cap: number }

export interface ReserveReq {
    /** Spend units charged to the global total. */
    cost: number;
    freezeAt: number;
    /** The code's daily count (cost units the client sees). */
    day?: CounterReq;
    /** The code's monthly allowance (spend units), when one is configured. */
    month?: CounterReq;
    /** Requests a minute for this code. Counted in memory only. */
    rpm?: { key: string; limit: number };
    /** The request's clock (epoch ms), for the minute bucket. */
    now?: number;
    /**
     * ONE COUNT PER MESSAGE (a ✦ preview). A marker row for this exact message
     * on this day: the first reserve counts `day.add` as usual and sets it; a
     * repeat of the same message (a lost answer retried, a second press, a
     * restart) adds nothing to the day count, up to `maxFree` repeats. Past
     * that a repeat counts again, so one message cannot be looped for free
     * upstream spend. The global `cost` is always charged: the model still runs.
     */
    once?: { key: string; maxFree: number };
    /**
     * ONE COUNT PER MESSAGE SENT IN PARTS (a long ✦ preview the plugin split
     * into rows "<id>~p<n>", in one request or several). `group` is the
     * message's row for the day (how many distinct parts it has had); `keys`
     * holds one marker per part in this request. The day is charged only when
     * the message is new today (group 0). A later part, or a repeat, is free
     * while every part here has been seen at most `maxFree` times and the
     * message has had at most `maxNew` distinct parts; past either, the
     * request counts again (no free loops). `charge` sums what the message was
     * charged today, so a failed part can give all of it back (/refund-group).
     */
    parts?: { group: string; charge: string; keys: string[]; maxFree: number; maxNew: number };
}

export type ReserveReason = "capacity" | "cap_exceeded" | "month_cap_exceeded" | "rate_limited";

export interface ReserveRes {
    allowed: boolean;
    total: number;
    frozen: boolean;
    reason?: ReserveReason;
    /** The day counter after this call (or as it stands, when refused). */
    used?: number;
    monthUsed?: number;
    /** What this call added to the day counter (0 for a free repeat, see `once`). */
    charged?: number;
    /** Parts seen for the first time today in this call (see `parts`). */
    partsAdded?: number;
}

export interface CounterState {
    total: number;
    counters: Map<string, number>;
    rpm: Map<string, number>;
}

/**
 * Pure decision over the in-memory state: rate, then day, then month, then the
 * global total. Nothing changes unless every check passes. Mutates `st` only
 * when allowed. Unit-tested.
 */
export function applyReserve(st: CounterState, r: ReserveReq): ReserveRes {
    const dayUsed = r.day ? st.counters.get(r.day.key) ?? 0 : undefined;
    const monthUsed = r.month ? st.counters.get(r.month.key) ?? 0 : undefined;
    const seen = r.once ? st.counters.get(r.once.key) ?? 0 : 0;
    // A repeat of a message already counted today is free (see ReserveReq.once).
    const onceFree = !!r.once && seen >= 1 && seen <= r.once.maxFree;
    // A message sent in parts (see ReserveReq.parts).
    const p = r.parts;
    const partKeys = p ? [...new Set(p.keys)] : [];
    const group = p ? st.counters.get(p.group) ?? 0 : 0;
    const partSeen = partKeys.map(k => st.counters.get(k) ?? 0);
    const partsNew = partSeen.filter(n => n === 0).length;
    const partsFree = !!p && group >= 1 && partSeen.every(n => n <= p.maxFree) && group + partsNew <= p.maxNew;
    const dayAdd = r.day ? (onceFree || partsFree ? 0 : r.day.add) : 0;
    const refuse = (reason: ReserveReason): ReserveRes => ({
        allowed: false, reason, total: st.total, frozen: st.total >= r.freezeAt,
        ...(dayUsed !== undefined ? { used: dayUsed } : {}),
        ...(monthUsed !== undefined ? { monthUsed } : {})
    });
    if (r.rpm && (st.rpm.get(r.rpm.key) ?? 0) >= r.rpm.limit) return refuse("rate_limited");
    if (r.day && dayUsed! + dayAdd > r.day.cap) return refuse("cap_exceeded");
    if (r.month && monthUsed! + r.month.add > r.month.cap) return refuse("month_cap_exceeded");
    const b = applyBudget({ total: st.total }, r.cost, r.freezeAt);
    if (!b.allowed) return refuse("capacity");
    st.total = b.total;
    if (r.day) st.counters.set(r.day.key, dayUsed! + dayAdd);
    if (r.once) st.counters.set(r.once.key, seen + 1);
    if (p) {
        partKeys.forEach((k, i) => st.counters.set(k, partSeen[i]! + 1));
        st.counters.set(p.group, group + partsNew);
        st.counters.set(p.charge, (st.counters.get(p.charge) ?? 0) + dayAdd);
    }
    if (r.month) st.counters.set(r.month.key, monthUsed! + r.month.add);
    if (r.rpm) st.rpm.set(r.rpm.key, (st.rpm.get(r.rpm.key) ?? 0) + 1);
    return {
        allowed: true, total: b.total, frozen: b.frozen,
        ...(r.day ? { used: dayUsed! + dayAdd, charged: dayAdd } : {}),
        ...(p ? { partsAdded: partsNew } : {}),
        ...(r.month ? { monthUsed: monthUsed! + r.month.add } : {})
    };
}

/** Day rows are `d:<YYYY-MM-DD>:<code>`, month rows `m:<YYYY-MM>:<code>`. */
export function dayRowKey(code: string, now: number): string {
    return `d:${new Date(now).toISOString().slice(0, 10)}:${code}`;
}
export function monthRowKey(code: string, now: number): string {
    return `m:${new Date(now).toISOString().slice(0, 7)}:${code}`;
}

const DAY_MS = 86_400_000;
/** A storage delete takes at most 128 keys. */
const DELETE_BATCH = 128;
/** At most one "budget reached" log line per this interval. */
const FREEZE_LOG_EVERY_MS = 10 * 60_000;

type Storage = DurableObjectStorage & {
    setAlarm?: (t: number) => Promise<void>;
    getAlarm?: () => Promise<number | null>;
};

export class Budget {
    private st: CounterState = { total: 0, counters: new Map(), rpm: new Map() };
    private rpmMinute = -1;
    private lastFreezeLog = 0;
    private alarmChecked = false;
    /** The UTC day the counter cache belongs to: it is dropped when the day
     *  changes (storage keeps every value), so memory holds one day of codes. */
    private cacheDay = "";
    private ready: Promise<void>;

    constructor(private ctx: DurableObjectState) {
        this.ready = ctx.blockConcurrencyWhile(async () => {
            this.st.total = (await ctx.storage.get<number>("total")) ?? 0;
            // A "frozen" row written by an older version is ignored on purpose:
            // the freeze is derived from total and freezeAt (see the header).
        });
    }

    private get storage(): Storage { return this.ctx.storage as Storage; }

    /** Load the rows this call needs into the cache before deciding. */
    private async load(keys: string[], now: number): Promise<void> {
        const day = new Date(now).toISOString().slice(0, 10);
        if (day > this.cacheDay) { this.st.counters.clear(); this.cacheDay = day; }
        const loaded = new Map<string, number>();
        for (const k of keys) {
            if (this.st.counters.has(k)) continue;
            loaded.set(k, (await this.ctx.storage.get<number>(k)) ?? 0);
        }
        // Another call may have filled a row while this one awaited: keep its
        // newer value. (The runtime's input gates already hold other calls
        // during a storage read; this is belt and braces.)
        for (const [k, v] of loaded) if (!this.st.counters.has(k)) this.st.counters.set(k, v);
    }

    /** The daily alarm that deletes old day and month rows. Set once. */
    private async ensureAlarm(now: number): Promise<void> {
        if (this.alarmChecked) return;
        this.alarmChecked = true;
        const s = this.storage;
        if (!s.getAlarm || !s.setAlarm) return;
        try {
            if ((await s.getAlarm()) === null) await s.setAlarm(now + DAY_MS);
        } catch (e) {
            console.warn("budget: alarm setup failed", { error: String((e as any)?.message ?? e).slice(0, 200) });
        }
    }

    async fetch(req: Request): Promise<Response> {
        await this.ready;
        const path = new URL(req.url).pathname;

        if (path === "/reserve") {
            const r = await req.json() as ReserveReq;
            const now = typeof r.now === "number" ? r.now : Date.now();
            await this.load([r.day?.key, r.month?.key, r.once?.key, r.parts?.group, r.parts?.charge, ...(r.parts?.keys ?? [])]
                .filter((k): k is string => typeof k === "string" && k !== ""), now);
            const minute = Math.floor(now / 60_000);
            if (minute !== this.rpmMinute) { this.st.rpm.clear(); this.rpmMinute = minute; }
            const wasFrozen = this.st.total >= r.freezeAt;
            // Decide and update memory with no await in between, then persist.
            const out = applyReserve(this.st, r);
            if (out.allowed) {
                const rows: Record<string, number> = { total: this.st.total };
                if (r.day) rows[r.day.key] = this.st.counters.get(r.day.key)!;
                if (r.month) rows[r.month.key] = this.st.counters.get(r.month.key)!;
                if (r.once) rows[r.once.key] = this.st.counters.get(r.once.key)!;
                if (r.parts) {
                    for (const k of [r.parts.group, r.parts.charge, ...r.parts.keys]) rows[k] = this.st.counters.get(k)!;
                }
                await this.ctx.storage.put(rows);
                if (r.day || r.month) await this.ensureAlarm(now);
            }
            if (out.frozen && (!wasFrozen || Date.now() - this.lastFreezeLog > FREEZE_LOG_EVERY_MS)) {
                this.lastFreezeLog = Date.now();
                // The owner's alarm: everything AI is refused until the limit is
                // raised or POST /admin/budget/reset is called.
                console.error("global budget reached: AI requests are refused", { total: this.st.total, freezeAt: r.freezeAt });
            }
            return Response.json(out);
        }
        if (path === "/refund") {
            // Give back per-code units after an upstream failure. The global
            // total is NOT refunded (conservative, as before).
            const r = await req.json() as { rows?: { key: string; sub: number }[] };
            const rows = Array.isArray(r.rows) ? r.rows.filter(x => x && typeof x.key === "string" && Number.isFinite(x.sub)) : [];
            await this.load(rows.map(x => x.key), Date.now());
            const put: Record<string, number> = {};
            for (const x of rows) {
                const n = Math.max(0, (this.st.counters.get(x.key) ?? 0) - x.sub);
                this.st.counters.set(x.key, n);
                put[x.key] = n;
            }
            if (rows.length) await this.ctx.storage.put(put);
            return Response.json({ ok: true });
        }
        if (path === "/refund-group") {
            // A message sent in parts lost a part: give back EVERYTHING it was
            // charged today (its `charge` row, from earlier requests too), reset
            // its group so the next try counts as the first, and take back this
            // call's part markers (`rows`).
            const r = await req.json() as { day?: unknown; charge?: unknown; group?: unknown; rows?: { key: string; sub: number }[] };
            if (typeof r.day !== "string" || typeof r.charge !== "string" || typeof r.group !== "string") {
                return Response.json({ ok: false }, { status: 400 });
            }
            const day = r.day, charge = r.charge, group = r.group;
            const rows = Array.isArray(r.rows) ? r.rows.filter(x => x && typeof x.key === "string" && Number.isFinite(x.sub)) : [];
            await this.load([day, charge, group, ...rows.map(x => x.key)], Date.now());
            const c = this.st.counters.get(charge) ?? 0;
            const put: Record<string, number> = {};
            const set = (k: string, n: number) => { this.st.counters.set(k, n); put[k] = n; };
            set(day, Math.max(0, (this.st.counters.get(day) ?? 0) - c));
            set(charge, 0);
            set(group, 0);
            for (const x of rows) set(x.key, Math.max(0, (this.st.counters.get(x.key) ?? 0) - x.sub));
            await this.ctx.storage.put(put);
            return Response.json({ ok: true, refunded: c });
        }
        if (path === "/peek") {
            const r = await req.json() as { keys?: string[] };
            const keys = Array.isArray(r.keys) ? r.keys.filter(k => typeof k === "string").slice(0, 16) : [];
            await this.load(keys, Date.now());
            return Response.json({ values: Object.fromEntries(keys.map(k => [k, this.st.counters.get(k) ?? 0])) });
        }
        if (path === "/status") {
            // The total only: the freeze point comes from GLOBAL_BUDGET_MESSAGES
            // on the caller's side (see codes.ts freezeAtFor).
            return Response.json({ total: this.st.total });
        }
        if (path === "/reset") { // owner-only (gated at the router): a fresh budget window
            this.st.total = 0;
            await this.ctx.storage.delete(["total", "frozen"]);
            return Response.json({ ok: true, total: 0 });
        }
        return new Response("not found", { status: 404 });
    }

    /** Delete day rows older than yesterday and month rows older than last month. */
    async alarm(): Promise<void> {
        const now = Date.now();
        const keepDay = new Date(now - DAY_MS).toISOString().slice(0, 10);
        const d = new Date(now);
        const keepMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
        const old: string[] = [];
        for (const [prefix, keep, len] of [["d:", keepDay, 10], ["m:", keepMonth, 7]] as const) {
            const rows = await this.ctx.storage.list({ prefix });
            for (const k of rows.keys()) {
                if (k.slice(2, 2 + len) < keep) old.push(k);
            }
        }
        for (let i = 0; i < old.length; i += DELETE_BATCH) {
            const batch = old.slice(i, i + DELETE_BATCH);
            await this.ctx.storage.delete(batch);
            for (const k of batch) this.st.counters.delete(k);
        }
        const s = this.storage;
        if (s.setAlarm) await s.setAlarm(now + DAY_MS);
    }
}
