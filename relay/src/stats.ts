/**
 * Owner stats: a handful of daily COUNTS the maker can read at /admin/stats to
 * see whether v0.1.6's trial is working (how many installs are active, how many
 * started a trial, how many previews were shown, how many bought).
 *
 * WHY KV AND NOT ANALYTICS ENGINE: metrics.ts rows need a SQL API token and a
 * dashboard to read; these need only the ADMIN_TOKEN the maker already has. And
 * "distinct installs per day" needs a seen-marker, which is state, not a row.
 *
 * PRIVACY: counts only. A key never contains a code, an install id, or an IP.
 * Distinct counting uses a marker keyed by a 16-hex SHA-256 FINGERPRINT of the
 * bearer, which self-expires in 2 days; the stat keys themselves carry only a
 * day and a counter name.
 *
 * APPROXIMATE, NEVER BILLING: KV has no atomic read-modify-write, so two
 * concurrent requests can both read N and both write N+1 (and two first
 * requests from one install can both miss its seen-marker). The counters can
 * therefore undercount (or, for distinct counts, rarely double count) a little.
 * That is fine for "is the trial converting"; nothing here gates access or money.
 *
 * NEVER ON THE CRITICAL PATH: the router runs every write here inside
 * ctx.waitUntil through `safely`, so a slow or failing KV write can never slow
 * or fail a translation.
 */
import type { Env, CodeRecord } from "./codes";

/** Daily counters live a little over a month, so /admin/stats?days=30 always
 *  has data and nothing accumulates forever. */
const STAT_TTL_S = 35 * 86_400;
/** A seen-marker only has to outlive its own UTC day. */
const SEEN_TTL_S = 2 * 86_400;
export const STATS_MAX_DAYS = 30;
export const STATS_DEFAULT_DAYS = 14;

function day(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

/** First 16 hex of SHA-256(bearer): enough to tell installs apart for a day,
 *  never reversible to the code or id. */
export async function fingerprint16(bearer: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer));
    return [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function readCount(env: Env, key: string): Promise<number> {
    const v = await env.CODES.get(key);
    const n = v === null ? 0 : Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** +by on `stat:<day>:<name>`. Read-modify-write; see APPROXIMATE above. */
export async function bumpStat(env: Env, now: number, name: string, by = 1): Promise<void> {
    const key = `stat:${day(now)}:${name}`;
    const n = await readCount(env, key);
    await env.CODES.put(key, String(n + by), { expirationTtl: STAT_TTL_S });
}

/** Count `bearer` once per day under `<kind>_active`. */
async function markDistinct(env: Env, now: number, kind: string, fp: string): Promise<void> {
    const seen = `seen:${kind}:${day(now)}:${fp}`;
    if (await env.CODES.get(seen) !== null) return;
    await env.CODES.put(seen, "1", { expirationTtl: SEEN_TTL_S });
    await bumpStat(env, now, `${kind}_active`);
}

/** The plans that count as a paying customer. An admin-minted plan:"free" beta
 *  code is neither a keyless install nor a purchase, so it counts as neither. */
const PAID_PLANS = new Set(["paid", "monthly", "annual", "lifetime"]);

/** Mark one authenticated request: every free_ bearer is a free install; a
 *  trial-plan request is also an active trial; a paid code is a paid code. */
export async function markActive(env: Env, bearer: string, plan: CodeRecord["plan"], now: number): Promise<void> {
    const fp = await fingerprint16(bearer);
    if (bearer.startsWith("free_")) {
        await markDistinct(env, now, "free", fp);
        if (plan === "trial") await markDistinct(env, now, "trial", fp);
    } else if (plan && PAID_PLANS.has(plan)) {
        await markDistinct(env, now, "paid", fp);
    }
}

/** Run a stats write for ctx.waitUntil, swallowing any failure: stats must
 *  never break (or, via an unhandled rejection, log noise on) a translation. */
export function safely(p: () => Promise<void>): Promise<void> {
    return (async () => { try { await p(); } catch { /* approximate owner metrics only */ } })();
}

export interface DayStats {
    day: string;
    activeFreeInstalls: number;
    trialsStarted: number;
    activeTrials: number;
    activePaidCodes: number;
    previewsServed: number;
    conversions: { monthly: number; annual: number; lifetime: number; paid: number; free: number };
}

/** Clamp the ?days= query to 1..30 (default 14). */
export function clampDays(raw: string | null): number {
    const n = raw === null || raw.trim() === "" ? NaN : Math.floor(Number(raw));
    if (!Number.isFinite(n)) return STATS_DEFAULT_DAYS;
    return Math.min(STATS_MAX_DAYS, Math.max(1, n));
}

/** The last `days` UTC days, NEWEST FIRST (today is days[0]). Reads run in
 *  parallel: 10 counters × 30 days = 300 KV reads at most, well under the
 *  per-invocation KV operation limit. */
export async function readStats(env: Env, days: number, now: number): Promise<DayStats[]> {
    const out: Promise<DayStats>[] = [];
    for (let i = 0; i < days; i++) {
        const d = day(now - i * 86_400_000);
        const get = (name: string) => readCount(env, `stat:${d}:${name}`);
        out.push((async () => {
            const [free, started, trial, paid, previews, monthly, annual, lifetime, paidConv, freeConv] = await Promise.all([
                get("free_active"), get("trials_started"), get("trial_active"), get("paid_active"), get("previews"),
                get("conv:monthly"), get("conv:annual"), get("conv:lifetime"), get("conv:paid"), get("conv:free")
            ]);
            return {
                day: d,
                activeFreeInstalls: free,
                trialsStarted: started,
                activeTrials: trial,
                activePaidCodes: paid,
                previewsServed: previews,
                conversions: { monthly, annual, lifetime, paid: paidConv, free: freeConv }
            };
        })());
    }
    return Promise.all(out);
}
