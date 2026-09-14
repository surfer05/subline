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
    /** Google Gemini API key (billing-enabled/paid tier). When set, Gemini is
     *  the PRIMARY translation provider and Groq becomes the fallback; when
     *  absent the relay runs Groq-only exactly as before. A secret, never in
     *  wrangler.jsonc. */
    GEMINI_KEY?: string;
    ADMIN_TOKEN: string;
    /** Primary model id. `gemini*` routes to Gemini (needs GEMINI_KEY); anything
     *  else routes to Groq. */
    MODEL: string;
    /** Groq model used as the fallback when Gemini is primary and a call fails
     *  (rate limit, overload, bad key). Defaults to openai/gpt-oss-120b. */
    FALLBACK_MODEL?: string;
    METRICS?: AnalyticsEngineDataset;
    /** Freeze the whole relay once this many messages have been spent, ever.
     *  ~1.4M messages ≈ $45 on Groq at $0.032/1k, leaving slack under $50. */
    GLOBAL_BUDGET_MESSAGES?: string;
    /** The Dodo Payments webhook SIGNING SECRET (`whsec_<base64>`, Standard
     *  Webhooks). Used to verify webhook-signature in index.ts. Inert until set. */
    MOR_WEBHOOK_SECRET?: string;
    /** Merchant-of-Record product_id → { plan, dailyCap } map (see wrangler.jsonc).
     *  Keyed by the Dodo product id that a license key belongs to. Bound as a
     *  JSON object var; parsed DEFENSIVELY (bad/absent config must fail safe to
     *  the free/default cap, never to an unbounded one). May also arrive as a
     *  JSON string, so variantConfig() tolerates both. */
    VARIANTS?: unknown;
}

export interface CodeRecord {
    status: "active" | "revoked";
    /** Fair-use ceiling, messages per day. */
    dailyCap: number;
    // "paid" is the legacy admin-mint tier and is kept so POST /admin/codes and
    // reserve()'s per-plan rate limit keep working; the paid spine adds the
    // Merchant-of-Record subscription/lifetime tiers alongside it.
    plan?: "free" | "paid" | "monthly" | "annual" | "lifetime";
    /** Maker-facing note. NEVER put PII here — the relay stores no identity. */
    note?: string;
    /** Opaque Merchant-of-Record join id (subscription id, else payment id), kept
     *  for admin/refund parity with the legacy admin-mint path. Not identity. */
    orderRef?: string;
    /** Epoch ms. ABSENT ⇒ never expires (lifetime / free / comp / beta). Set from
     *  the subscription's next renewal date; enforced LOCALLY in authCode as the
     *  safety net that stops access even if a lifecycle webhook is missed. */
    expiresAt?: number;
    /** Opaque MoR subscription id (Dodo data.subscription_id), for lifecycle
     *  correlation and the subscription reverse index. Not identity. */
    mor_subscription_id?: string;
    /** Opaque MoR payment id (Dodo data.payment_id), the join key for one-time
     *  purchases and for refund/dispute revocation. Not identity. */
    mor_order_id?: string;
    /** STICKY death flag. Set on a refund/chargeback (refund.succeeded /
     *  dispute.lost / dispute.accepted) or a subscription.expired — the events
     *  that mean "this purchase is over for good". Once true it is NEVER cleared:
     *  a genuine re-subscribe issues a NEW license key (a fresh code), so this
     *  dead code must never resurrect. Exploit closed: a duplicate/out-of-order/
     *  replayed active subscription event flipping a refunded code back to active
     *  (refund bypass). A plain subscription.cancelled is NOT terminal — access
     *  continues to the period end (next_billing_date). */
    terminal?: boolean;
    /** Epoch ms the code was made terminal (audit only; not identity). */
    revokedAt?: number;
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
    | { ok: false; reason: "no_code" | "unknown_code" | "revoked" | "expired" };

/** Validate the bearer code. Never reveals whether a code merely doesn't exist
 *  vs. is malformed — both read as unknown_code — to avoid an enumeration oracle. */
export async function authCode(env: Env, code: string | null): Promise<AuthOutcome> {
    if (!code) return { ok: false, reason: "no_code" };
    const raw = await env.CODES.get(`code:${code}`);
    if (raw === null) return { ok: false, reason: "unknown_code" };
    let rec: CodeRecord;
    try { rec = JSON.parse(raw) as CodeRecord; } catch { return { ok: false, reason: "unknown_code" }; }
    if (rec.status === "revoked") return { ok: false, reason: "revoked" };
    // TERMINAL is permanent death (refund/expire). Denied here too as
    // defense-in-depth: even if a bug ever left status !== "revoked" on a
    // terminal record, a refunded/expired code can never authenticate.
    if (rec.terminal) return { ok: false, reason: "revoked" };
    // LOCAL expiry, enforced on the hot path so a subscription that lapsed still
    // loses access the instant it passes its renewal date even if the MoR's
    // `subscription_expired` webhook was dropped/delayed. A replayed stale
    // lifecycle event can only ever push expiresAt to a PAST value (see
    // applyMorEvent), which this line then rejects — so replays cannot resurrect.
    if (rec.expiresAt && Date.now() > rec.expiresAt) return { ok: false, reason: "expired" };
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
    // Any paid tier (legacy "paid" or a MoR subscription/lifetime plan) gets the
    // higher burst ceiling; only "free"/unset stays at the free tier's 20.
    const rpmLimit = rec.plan && rec.plan !== "free" ? 30 : 20;
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

// ===========================================================================
//  MERCHANT-OF-RECORD (Dodo Payments) WEBHOOK STATE MIRROR
// ===========================================================================
//
// DESIGN. Dodo Payments is the Merchant of Record; the License Key it issues IS
// the Subline code (`authCode` is format-agnostic, so a Dodo key string and an
// `slp_` admin code are the same kind of Bearer credential). Webhooks mirror
// each key's lifecycle into KV so the hot translate path stays a SINGLE local
// KV read, with `expiresAt` as a locally-enforced safety net.
//
// CONFIRMED DODO PAYLOAD FIELD PATHS (docs.dodopayments.com + the
// dodopayments-node SDK types src/resources/{webhook-events,license-keys,
// subscriptions,refunds,disputes}.ts). Dodo follows the Standard Webhooks spec;
// the JSON body is a FLAT object (there is NO Lemon-Squeezy `data.attributes`
// nesting and NO `meta` — the event name is `type`, the fields are on `data`):
//   • ROOT: { business_id, type, timestamp, data }   — `type` IS the event name.
//   • license_key.created  (data.payload_type "LicenseKey"): CARRIES THE KEY VALUE.
//       data.key             — the license key string == the Subline code
//       data.product_id      — product → plan/cap map (VARIANTS is keyed by this)
//       data.subscription_id — the subscription join key (null for one-time)
//       data.payment_id      — the payment join key (present for every purchase)
//   • subscription.{active,renewed,plan_changed,cancelled,on_hold,failed,expired,…}
//     (data.payload_type "Subscription"):
//       data.subscription_id     — join key
//       data.status              — pending|active|on_hold|paused|cancelled|failed|expired|past_due
//       data.next_billing_date   — END of the current period (drives expiresAt: the
//                                  renewal target while active, the access end on cancel)
//       data.cancelled_at        — WHEN the user cancelled (NOT the access end)
//   • refund.succeeded (data.payload_type "Refund"): data.payment_id ONLY — a
//     Refund object carries NO subscription_id.
//   • dispute.* (data.payload_type "Dispute"): data.payment_id ONLY — likewise
//     no subscription_id.
//
// REVERSE-INDEX SCHEME. Unlike Lemon Squeezy (one shared order_id on every
// event), Dodo's identifiers DIFFER per event family: subscription.* carry only
// subscription_id, while refund.succeeded / dispute.* carry only payment_id. So
// to keep a subscription code REVOCABLE on a chargeback we write the SAME single
// `order:` reverse index under BOTH join ids at creation:
//     order:<subscription_id> → key   (resolves subscription.* lifecycle)
//     order:<payment_id>      → key   (resolves refund.succeeded / dispute.*)
// A one-time (lifetime) purchase has no subscription_id, so only order:<payment_id>
// is written. It is still ONE index namespace feeding the SAME state machine —
// applyLifecycle is unchanged; the adapter just picks the right join id per event.
//
// ORDER-INDEPENDENCE. Webhook delivery order is NOT guaranteed, and only
// license_key.created carries the key. A lifecycle event that arrives BEFORE the
// key is staged under `pending:<join_id>` and folded into the record at creation
// (we drain the pending row for EACH join id) — so the record converges to the
// correct state regardless of arrival order, and a refund that races ahead of
// the key still lands as revoked.
//
// REPLAY DEFENSE (no per-delivery dedup). A validly-signed body can be resent
// (a captured body carries the same webhook-signature; the router's 5-minute
// timestamp window bounds but does not eliminate this). We deliberately do NOT
// dedup by webhook-id: it would need durable per-id state and a dropped id would
// silently strand a paid lifecycle event. Instead replays are made HARMLESS by
// construction: (1) every mutation is DERIVED from the payload (never a blind
// "activate"); (2) expiry moves FORWARD-only, so a stale active replay can
// neither shorten a live user nor revive an already-past expiry; and (3) revoke
// is TERMINAL (see CodeRecord.terminal) — once refunded/expired, no replayed
// active event can ever flip the code back on. Together these close the refund/
// paywall-bypass replay without any dedup state.

const FREE_FALLBACK_CAP = 500; // the conservative cap for an unmapped/misconfigured variant
const KNOWN_PLANS = new Set(["free", "paid", "monthly", "annual", "lifetime"]);

// Provisional expiry stamped on a SUBSCRIPTION code at license_key.created so it
// is NEVER born never-expiring (paywall bypass #2). 3 days generously absorbs
// normal webhook delay, Dodo's retry backoff (~seconds→minutes), and out-of-order
// delivery — the subscription.active event that carries the real next_billing_date
// (~a month out) normally lands within seconds — while capping the damage of a
// PERMANENTLY missed subscription event at 3 days of access rather than forever.
// The real next_billing_date supersedes this via the forward-only max in applyLifecycle.
const SUBSCRIPTION_GRACE_MS = 3 * DAY_MS;
const SUBSCRIPTION_PLANS = new Set(["monthly", "annual"]);
// TTL on the staged pending:<order_id> record (#4). It only has to survive the
// gap between an out-of-order lifecycle event and its license_key_created (near-
// simultaneous in practice); 3 days is ample and, like use:/rl:, self-purges so
// a never-completed order can't leave latent state in KV forever.
const PENDING_TTL_S = 3 * 86_400;

function safeParse(raw: string | null): CodeRecord | undefined {
    if (raw === null) return undefined;
    try { return JSON.parse(raw) as CodeRecord; } catch { return undefined; }
}
function asStr(v: unknown): string { return v === undefined || v === null ? "" : String(v); }
/** Parse an ISO-8601 date to epoch ms, or undefined if absent/unparseable. */
function parseDateMs(v: unknown): number | undefined {
    if (typeof v !== "string" || v === "") return undefined;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
}

/** Resolve a Dodo product_id → {plan, dailyCap}, DEFENSIVELY. A missing table, a
 *  bad entry, a non-numeric cap, or an unknown product all FAIL SAFE to the free
 *  cap (never an unbounded one) so a config typo can never mint an uncapped
 *  paid code. `mapped:false` lets the caller note the misconfiguration. */
export function variantConfig(env: Env, productId: string): { plan: CodeRecord["plan"]; dailyCap: number; mapped: boolean } {
    let table: any = env.VARIANTS;
    if (typeof table === "string") { try { table = JSON.parse(table); } catch { table = undefined; } }
    const entry = table && typeof table === "object" ? table[productId] : undefined;
    if (!productId || !entry || typeof entry !== "object") {
        return { plan: "free", dailyCap: FREE_FALLBACK_CAP, mapped: false };
    }
    const plan = KNOWN_PLANS.has(entry.plan) ? entry.plan as CodeRecord["plan"] : "free";
    const capN = Number(entry.dailyCap);
    const dailyCap = Number.isFinite(capN) && capN > 0 ? capN : FREE_FALLBACK_CAP;
    return { plan, dailyCap, mapped: true };
}

/** Derived lifecycle mutation for a code, computed from the CURRENT payload. */
interface Lifecycle {
    revoked?: boolean;        // set status=revoked (refund/chargeback/expired)
    terminal?: boolean;       // STICKY death (refund/expire): can never be undone
    setActive?: boolean;      // reinstate to active (genuine (re)activation)
    expiresAt?: number;       // new expiry candidate (epoch ms)
    forward?: boolean;        // true ⇒ only ever move expiry FORWARD (max), so a
                              //   stale replay cannot shorten an active user AND
                              //   cannot resurrect an already-past expiry.
    mor_subscription_id?: string;
    revokedAt?: number;       // epoch ms of the terminal event (audit only)
}

/** Apply a derived lifecycle change to the code behind an order — or, if the
 *  key-bearing event hasn't arrived yet, STAGE it under pending:<order_id> so
 *  license_key_created can fold it in. Returns a coarse action label for tests. */
async function applyLifecycle(env: Env, orderId: string, d: Lifecycle): Promise<string> {
    if (!orderId) return "ignored_no_order";
    const key = await env.CODES.get(`order:${orderId}`);
    if (!key) {
        const prev = (safeParse(await env.CODES.get(`pending:${orderId}`)) as any) ?? {};
        if (d.revoked) prev.revoked = true;
        if (d.terminal) { prev.terminal = true; if (typeof d.revokedAt === "number") prev.revokedAt = d.revokedAt; }
        if (typeof d.expiresAt === "number") {
            prev.expiresAt = d.forward ? Math.max(prev.expiresAt ?? 0, d.expiresAt) : d.expiresAt;
        }
        if (d.mor_subscription_id) prev.mor_subscription_id = d.mor_subscription_id;
        // #4: TTL so a staged-but-never-completed order self-purges (no KV bloat).
        await env.CODES.put(`pending:${orderId}`, JSON.stringify(prev), { expirationTtl: PENDING_TTL_S });
        return "staged";
    }
    const rec = safeParse(await env.CODES.get(`code:${key}`));
    if (!rec) return "code_missing";
    // #1: TERMINAL is sticky and dead. Once refunded/expired, NOTHING — not a
    // replayed/out-of-order active event, not a late renewal — reactivates it or
    // extends its expiry. (A genuine re-subscribe mints a NEW key/order → a fresh
    // code.) This is the load-bearing guard that closes the refund bypass: a
    // duplicated `subscription.active{future next_billing_date}` after a refund
    // is a no-op here instead of flipping status back to active.
    if (rec.terminal) {
        if (d.mor_subscription_id) rec.mor_subscription_id = d.mor_subscription_id; // link only
        await env.CODES.put(`code:${key}`, JSON.stringify(rec));
        return "terminal_noop";
    }
    if (d.terminal) { rec.terminal = true; rec.revokedAt = d.revokedAt; }
    if (d.revoked) rec.status = "revoked";
    else if (d.setActive) rec.status = "active";
    if (typeof d.expiresAt === "number") {
        // Terminal events pass forward:false + expiresAt=now to PULL expiry back to
        // the revoke instant, so the local expiry net denies too; renewals pass
        // forward:true so a stale replay can only ever move expiry forward.
        rec.expiresAt = d.forward ? Math.max(rec.expiresAt ?? 0, d.expiresAt) : d.expiresAt;
    }
    if (d.mor_subscription_id) rec.mor_subscription_id = d.mor_subscription_id;
    await env.CODES.put(`code:${key}`, JSON.stringify(rec));
    return "applied";
}

// Dispute states in which the merchant has DEFINITIVELY lost the funds → revoke.
// dispute.opened/challenged are still IN FLIGHT (revoking terminally on `opened`
// would permanently strand a customer the merchant may go on to win, since
// terminal is sticky), and dispute.won/cancelled/expired keep the money — so
// those are all handled no-ops. Only a lost/accepted dispute is a true refund.
const DISPUTE_LOST = new Set(["dispute.lost", "dispute.accepted"]);
// Subscription events that mean "still recoverable" (Dodo's dunning window):
// they must neither extend nor revoke — the local expiresAt net lapses access on
// its own if the period actually ends. on_hold is NOT terminal in Dodo (a
// successful retry returns the sub to active), so it is dunning, not a lapse.
const SUB_DUNNING = new Set(["subscription.on_hold", "subscription.failed", "subscription.past_due", "subscription.paused"]);
// Subscription events that keep the sub ALIVE and carry a fresh next_billing_date
// → push expiry forward and (re)activate.
const SUB_ACTIVE = new Set(["subscription.active", "subscription.renewed", "subscription.plan_changed", "subscription.unpaused"]);

/**
 * Mirror one verified Dodo webhook event into KV. Idempotent & replay-safe: ALL
 * state is DERIVED from the current payload (never a blind "activate"), so a
 * retry converges to the same record and a stale replay (whose next_billing_date
 * is now in the past) yields a past expiresAt that authCode rejects — access is
 * never resurrected. Signature verification and the bare 2xx response live in
 * the router (index.ts); this function only touches KV and NEVER logs the key,
 * email, or any payload text.
 *
 * This is the ADAPTER: it maps Dodo's flat `{ type, data:{...} }` payload onto
 * the SAME internal Lifecycle actions the (unchanged) state machine consumes.
 */
export async function applyMorEvent(env: Env, evt: any, now: number): Promise<{ action: string }> {
    const name = asStr(evt?.type);          // Dodo event name lives in `type`, not `meta.event_name`
    const data = evt?.data ?? {};           // Dodo fields are FLAT on `data`, not `data.attributes`

    // ---- CREATE: the only event that carries the key value ----------------
    if (name === "license_key.created") {
        const key = asStr(data.key);
        if (!key) return { action: "ignored_no_key" }; // nothing to key on; a code we can't name is useless
        const subId = asStr(data.subscription_id);   // subscription join key (empty for one-time)
        const payId = asStr(data.payment_id);        // payment join key (present for every purchase)
        // The join ids this code is reachable by. Both feed the SAME `order:`
        // index (see REVERSE-INDEX SCHEME): sub id for lifecycle, payment id for
        // refund/dispute (which carry ONLY payment_id).
        const joinIds = [...new Set([subId, payId].filter(Boolean))];
        const cfg = variantConfig(env, asStr(data.product_id));
        // #5: a PAID/subscription key with NO join id at all can be filed under
        // no order:<id> index, so a later refund/expire could never find it — an
        // un-revokable paid code. Refuse to mint (Dodo retries; a well-formed
        // license_key.created always carries a payment_id). Free/unmapped codes
        // are harmless without one (already free-capped), so only paid is guarded.
        if (cfg.plan !== "free" && joinIds.length === 0) return { action: "ignored_no_order" };
        const isSubscription = SUBSCRIPTION_PLANS.has(cfg.plan as string);
        // UPSERT (never a second code for one purchase). Preserve any expiry /
        // subscription id / revocation an out-of-order lifecycle event already
        // wrote, so a replay of this create can't wipe a live renewal or
        // un-revoke a refunded purchase.
        const existing = safeParse(await env.CODES.get(`code:${key}`));
        // #2: a subscription code must NEVER be born without an expiry, or a
        // missed/absent subscription event would leave it valid forever (the
        // authCode expiry net is skipped when expiresAt is undefined). Stamp a
        // finite PROVISIONAL expiry (now + GRACE); the real next_billing_date
        // supersedes it forward-only. Lifetime/free codes stay never-expiring.
        const provisional = isSubscription ? now + SUBSCRIPTION_GRACE_MS : undefined;
        const rec: CodeRecord = {
            status: existing?.status === "revoked" ? "revoked" : "active",
            dailyCap: cfg.dailyCap,
            plan: cfg.plan,
            mor_order_id: payId || undefined,               // the payment join id
            orderRef: subId || payId || undefined,          // keep orderRef populated for admin/refund parity
            mor_subscription_id: subId || existing?.mor_subscription_id,
            expiresAt: existing?.expiresAt ?? provisional,
            terminal: existing?.terminal,
            revokedAt: existing?.revokedAt,
            // Unmapped product is a config error: fail safe on the cap AND flag it.
            note: cfg.mapped ? existing?.note : `unmapped product_id — capped at free default (${FREE_FALLBACK_CAP}/day)`,
        };
        // Fold in any lifecycle state that arrived before this key, draining the
        // pending row for EACH join id (see ORDER-INDEPENDENCE). A refund that
        // raced ahead staged under pending:<payment_id>; a subscription event
        // under pending:<subscription_id> — fold both so the record converges.
        for (const id of joinIds) {
            const pend = safeParse(await env.CODES.get(`pending:${id}`)) as any;
            if (!pend) continue;
            if (pend.revoked) rec.status = "revoked";
            if (pend.terminal) { rec.terminal = true; if (typeof pend.revokedAt === "number") rec.revokedAt = pend.revokedAt; }
            if (typeof pend.expiresAt === "number") rec.expiresAt = pend.expiresAt;
            if (pend.mor_subscription_id) rec.mor_subscription_id = pend.mor_subscription_id;
            await env.CODES.delete(`pending:${id}`);
        }
        await env.CODES.put(`code:${key}`, JSON.stringify(rec));
        for (const id of joinIds) await env.CODES.put(`order:${id}`, key); // reverse index (both join ids)
        return { action: cfg.mapped ? "created" : "created_unmapped_variant" };
    }

    // ---- SUBSCRIPTION lifecycle (join via data.subscription_id) -----------
    if (name.startsWith("subscription.")) {
        const subId = asStr(data.subscription_id);

        // EXPIRE: the terminal lapse. terminal:true makes it permanent;
        // expiresAt:now pulls the local expiry net back so a later replayed
        // active event cannot resurrect access.
        if (name === "subscription.expired") {
            return { action: await applyLifecycle(env, subId, { revoked: true, terminal: true, expiresAt: now, revokedAt: now, mor_subscription_id: subId }) };
        }
        // CANCEL: not a revoke. Access continues to the PERIOD END. Dodo has no
        // `ends_at`; the period end is next_billing_date (data.cancelled_at is
        // only WHEN they cancelled, not when access stops). Not terminal, so a
        // change-of-mind reactivation within the period still works.
        if (name === "subscription.cancelled") {
            return { action: await applyLifecycle(env, subId, { expiresAt: parseDateMs(data.next_billing_date), mor_subscription_id: subId }) };
        }
        // RENEWAL / (RE)ACTIVATION: push expiry FORWARD to the new
        // next_billing_date. forward:true means a replayed old event (past date)
        // can't shorten a live user, and an event replayed onto an already-expired
        // code can't revive it (the terminal guard also blocks a refunded one).
        if (SUB_ACTIVE.has(name)) {
            return { action: await applyLifecycle(env, subId, { setActive: true, expiresAt: parseDateMs(data.next_billing_date), forward: true, mor_subscription_id: subId }) };
        }
        // DUNNING (on_hold / failed / past_due / paused): DO NOT extend and DO NOT
        // revoke — recoverable window; the existing expiresAt lapses on its own.
        if (SUB_DUNNING.has(name)) return { action: "ignored_dunning" };
        // Any other subscription.* (paused-adjacent, update_payment_method, …):
        // handled no-op, never a throw that could flip deny→allow.
        return { action: "ignored" };
    }

    // ---- REFUND / CHARGEBACK-LOST: revoke immediately — TERMINAL ----------
    // Refund and Dispute objects carry ONLY data.payment_id (no subscription_id),
    // which is why a subscription code is ALSO indexed under order:<payment_id>.
    // terminal:true closes the refund bypass — a replayed active subscription
    // event can never flip a refunded code back to active.
    if (name === "refund.succeeded" || DISPUTE_LOST.has(name)) {
        return { action: await applyLifecycle(env, asStr(data.payment_id), { revoked: true, terminal: true, expiresAt: now, revokedAt: now }) };
    }

    // ---- Everything else (payment.*, in-flight/won disputes, credit.*, …):
    // handled no-op (2xx). NEVER a throw — a throw becomes a 500 and, worse, must
    // never be able to turn a deny into an allow.
    return { action: "ignored" };
}
