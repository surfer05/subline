/**
 * Auth, per-code fair-use metering, and the global budget kill-switch.
 *
 * STORAGE: Cloudflare KV. KV is simple, free-tier, and self-expiring, which is
 * right for a friends beta. Its one weakness — no atomic read-modify-write, so
 * two concurrent requests for the SAME code can both read `used=N` and both
 * write `N+cost`, slightly undercounting — is deliberately tolerated here for
 * two reasons: (1) a client sends only ~2-3 quality requests/minute
 * (QUALITY_DEBOUNCE_MS = 20s), so same-code concurrency is rare; (2) the thing
 * that actually protects the ~$50 budget is the GLOBAL cumulative counter
 * below, which is slack-tolerant by nature. When precise per-code accounting
 * matters (paid tier, fairness), swap this module for one Durable Object per
 * code — the router only calls authCode/reserve/refund, so nothing else moves.
 */

export interface Env {
    CODES: KVNamespace;
    /** The atomic global spend guard (see budget.ts) — the real $50 ceiling. */
    BUDGET: DurableObjectNamespace;
    GROQ_KEY: string;
    ADMIN_TOKEN: string;
    MODEL: string;
    METRICS?: AnalyticsEngineDataset;
    /** Freeze the whole relay once this many messages have been spent, ever.
     *  ~1.4M messages ≈ $45 on Groq at $0.032/1k, leaving slack under $50. */
    GLOBAL_BUDGET_MESSAGES?: string;
    MOR_WEBHOOK_SECRET?: string;
}

export interface CodeRecord {
    status: "active" | "revoked";
    /** Fair-use ceiling, messages per day. */
    dailyCap: number;
    plan?: "free" | "paid";
    /** Maker-facing note. NEVER put PII here — the relay stores no identity. */
    note?: string;
    /** Opaque Merchant-of-Record order id, for revoke-on-refund. Not identity. */
    orderRef?: string;
}

const DAY_MS = 86_400_000;
const DEFAULT_GLOBAL_FREEZE = 1_400_000;

/** UTC date bucket, so daily counters reset at 00:00 UTC and self-expire. */
function today(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}
function msUntilUtcMidnight(now: number): number {
    return DAY_MS - (now % DAY_MS);
}

/** Read a KV integer counter (absent → 0). */
async function readCount(env: Env, key: string): Promise<number> {
    const v = await env.CODES.get(key);
    const n = v === null ? 0 : Number(v);
    return Number.isFinite(n) ? n : 0;
}

export type AuthOutcome =
    | { ok: true; record: CodeRecord }
    | { ok: false; reason: "no_code" | "unknown_code" | "revoked" };

/** Validate the bearer code. Never reveals whether a code merely doesn't exist
 *  vs. is malformed — both read as unknown_code — to avoid an enumeration oracle. */
export async function authCode(env: Env, code: string | null): Promise<AuthOutcome> {
    if (!code) return { ok: false, reason: "no_code" };
    const raw = await env.CODES.get(`code:${code}`);
    if (raw === null) return { ok: false, reason: "unknown_code" };
    let rec: CodeRecord;
    try { rec = JSON.parse(raw) as CodeRecord; } catch { return { ok: false, reason: "unknown_code" }; }
    if (rec.status === "revoked") return { ok: false, reason: "revoked" };
    return { ok: true, record: rec };
}

export type ReserveOutcome =
    | { ok: true; used: number; cap: number }
    | { ok: false; reason: "cap_exceeded" | "rate_limited" | "capacity"; retryAfterMs: number; used?: number; cap?: number };

/**
 * RESERVE BEFORE SPEND. The cap is checked and the spend committed to KV
 * BEFORE Groq is called, so a normal upstream failure (which then refunds)
 * never overspends, and the reserve is the safe direction for the budget.
 */
export async function reserve(env: Env, code: string, rec: CodeRecord, cost: number, now: number): Promise<ReserveOutcome> {
    // 1) Per-minute rate limit (KV, soft): one shared paid key must not be
    //    drained by a runaway/scraping client. Well above a real user's rate.
    const rpmKey = `rl:${code}:${Math.floor(now / 60_000)}`;
    const rpm = await readCount(env, rpmKey);
    const rpmLimit = rec.plan === "paid" ? 30 : 20;
    if (rpm >= rpmLimit) return { ok: false, reason: "rate_limited", retryAfterMs: 60_000 - (now % 60_000) };

    // 2) Daily per-code cap (KV, soft fairness — bounded by the atomic global
    //    guard below, so slight concurrent over-count costs pennies, not dollars).
    const dayKey = `use:${code}:${today(now)}`;
    const used = await readCount(env, dayKey);
    if (used + cost > rec.dailyCap) {
        return { ok: false, reason: "cap_exceeded", retryAfterMs: msUntilUtcMidnight(now), used, cap: rec.dailyCap };
    }

    // 3) Global spend guard (ATOMIC — Durable Object). This is the real money
    //    ceiling; committed FIRST so a race can never push total dollars past
    //    the cap. If it freezes, nothing per-code is written.
    const freezeAt = Number(env.GLOBAL_BUDGET_MESSAGES) || DEFAULT_GLOBAL_FREEZE;
    const budget = env.BUDGET.get(env.BUDGET.idFromName("global"));
    const bres = await budget.fetch("https://budget.internal/reserve", {
        method: "POST",
        body: JSON.stringify({ cost, freezeAt })
    });
    const decision = await bres.json() as { allowed: boolean };
    if (!decision.allowed) return { ok: false, reason: "capacity", retryAfterMs: 3_600_000 };

    // 4) Commit the per-code counters (soft). Self-purge (daily 2d, rpm 2min).
    await env.CODES.put(dayKey, String(used + cost), { expirationTtl: 172_800 });
    await env.CODES.put(rpmKey, String(rpm + 1), { expirationTtl: 120 });

    return { ok: true, used: used + cost, cap: rec.dailyCap };
}

/** Return a reservation when the upstream call failed, so a Groq outage never
 *  costs a user their quota. Best-effort; the global counter is left as-is
 *  (slack-tolerant) so the budget guard stays conservative. */
export async function refund(env: Env, code: string, cost: number, now: number): Promise<void> {
    const dayKey = `use:${code}:${today(now)}`;
    const used = await readCount(env, dayKey);
    await env.CODES.put(dayKey, String(Math.max(0, used - cost)), { expirationTtl: 172_800 });
}

/** Current usage for GET /v1/status. */
export async function usage(env: Env, code: string, rec: CodeRecord, now: number): Promise<{ used: number; cap: number; resetsInMs: number }> {
    const used = await readCount(env, `use:${code}:${today(now)}`);
    return { used, cap: rec.dailyCap, resetsInMs: msUntilUtcMidnight(now) };
}

/** A high-entropy opaque code: `slp_` + base32(16 bytes). The prefix aids
 *  support; 16 random bytes make it unguessable and non-enumerable. */
export function mintCode(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const alpha = "abcdefghijklmnopqrstuvwxyz234567";
    let out = "";
    for (const b of bytes) out += alpha[b & 31];
    return "slp_" + out;
}
