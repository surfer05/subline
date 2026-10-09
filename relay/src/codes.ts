/**
 * Auth, per-code fair-use metering, and the global budget kill-switch.
 *
 * STORAGE. Code records, purchase rows and accounts live in Cloudflare KV.
 * The per-request COUNTERS of paid codes and v2 previews (daily count, the
 * optional monthly allowance, requests a minute) live in the Budget Durable
 * Object, checked and counted in the same call that charges the global budget
 * (see budget.ts and reserve below): exact under concurrency, and no KV write
 * per request, so the relay does not run into KV's write limits as it grows.
 * Only the legacy 0.1.x keyless tiers (taste, trial) still count in KV, with
 * their per-address ceilings, exactly as before.
 */

import { bumpStat } from "./stats";
import { linkFromKey, linkFromLifecycle, clearBuying, recordPurchaseState } from "./checkout";
import { dayRowKey, monthRowKey, type ReserveReq, type ReserveRes } from "./budget";

export interface Env {
    CODES: KVNamespace;
    /** The atomic global spend guard (see budget.ts) — the real $50 ceiling. */
    BUDGET: DurableObjectNamespace;
    GROQ_KEY: string;
    /** OpenRouter API key (pay as you go). When set, OpenRouter is the PRIMARY
     *  translation provider: it resells the SAME openai/gpt-oss-120b, pinned to
     *  Groq's own hosting, without the direct Groq key's free-tier daily token
     *  ceiling. GROQ_KEY then becomes the automatic fallback. A secret, never in
     *  wrangler.jsonc. Drop the key to go back to Groq-only. */
    OPENROUTER_KEY?: string;
    /** Google Gemini API key (billing-enabled/paid tier). When set, Gemini is
     *  the PRIMARY translation provider and Groq becomes the fallback; when
     *  absent the relay runs Groq-only exactly as before. A secret, never in
     *  wrangler.jsonc. */
    GEMINI_KEY?: string;
    ADMIN_TOKEN: string;
    /** Primary model id. `gemini*` routes to Gemini (needs GEMINI_KEY); anything
     *  else is sent to OpenRouter when OPENROUTER_KEY is set, otherwise straight
     *  to Groq. The id alone never picks the route — providers() sets an
     *  explicit Provider.kind, because OpenRouter and Groq share model ids. */
    MODEL: string;
    /** Model used by the FALLBACK provider (the direct Groq key), and by any
     *  provider that cannot be handed a `gemini*` MODEL. Defaults to
     *  openai/gpt-oss-120b. */
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
    /** Dodo Payments API key (a secret). Enables POST /v1/checkout and
     *  POST /admin/coupon; both answer 503 without it. */
    DODO_API_KEY?: string;
    /** Dodo API base URL: https://live.dodopayments.com (default) or
     *  https://test.dodopayments.com. Must match the key's mode. */
    DODO_API_BASE?: string;
    /** Where Dodo sends the buyer after paying (it appends payment_id or
     *  subscription_id, status, license_key, email). Default: the site root. */
    CHECKOUT_RETURN_URL?: string;
    /** One Promo Durable Object per promo code (promo.ts): the exact claim
     *  counter behind "the first 100 installs". Without it /v1/redeem is 503. */
    PROMO?: DurableObjectNamespace;
    /** HMAC key for the v2 entitlement token (entitle.ts). A secret. Absent:
     *  tokens go out unsigned, and AI is still enforced here on the relay. */
    ENTITLEMENT_SECRET?: string;
    /** Launch moment (epoch ms or ISO date). An install whose trial:<id>
     *  record is older gets Automatic free as an early user. Unset: no grants. */
    LAUNCH_AT?: string;
    /** Optional monthly allowance per AI subscription code (monthly/annual), in
     *  budget spend units (budgetCostFor), counted per UTC calendar month in the
     *  Budget Durable Object. Unset, empty or not a positive number: no monthly
     *  allowance (the daily cap and the global budget still apply). A pricing
     *  call for the owner: see wrangler.jsonc. */
    AI_MONTHLY_CAP?: string;
    /** One PatchHealth Durable Object per UTC day (patchHealth.ts). Without it
     *  POST /v1/patch-health and GET /admin/patch-health answer 503. */
    PATCH_HEALTH?: DurableObjectNamespace;
    /** The send_email binding for the owner's patch alert (patchHealth.ts).
     *  Absent: reports are still counted, no email goes out (logged). */
    ALERT_EMAIL?: SendEmail;
    /** Distinct installs that must report one patch on one day before the
     *  owner is emailed. Default 3. */
    PATCH_ALERT_MIN_INSTALLS?: string;
    /** Sender and recipient of the patch alert. Defaults: alerts@subline.page
     *  and rahul05alok@gmail.com (a verified Email Routing destination). */
    PATCH_ALERT_FROM?: string;
    PATCH_ALERT_TO?: string;
}

export interface CodeRecord {
    status: "active" | "revoked";
    /** Fair-use ceiling, messages per day. */
    dailyCap: number;
    // "paid" is the legacy admin-mint tier and is kept so POST /admin/codes and
    // reserve()'s per-plan rate limit keep working; the paid spine adds the
    // Merchant-of-Record subscription/lifetime tiers alongside it. "taste" is
    // the keyless FREE install (see TASTE below): it is SYNTHETIC and never
    // stored, so it can be enumerated here without ever being mintable.
    // "trial" is the same keyless install during its first 7 days (see TRIAL
    // below): equally synthetic, equally never stored, never in KNOWN_PLANS.
    plan?: "free" | "taste" | "trial" | "paid" | "monthly" | "annual" | "lifetime" | "automatic";
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
    /** Epoch ms the webhook first created this code. ABSENT on every code made
     *  before the paid-only launch, which is what marks an AI code as
     *  grandfathered into Automatic (entitle.ts). */
    createdAt?: number;
    /** Set by POST /admin/reissue on the OLD code: the code that replaced it.
     *  A reissued code is dead for good. Webhook events that still name it (a
     *  replayed license_key.created, a refund, a renewal) are forwarded along
     *  this link to the live code, never applied to the dead one. */
    reissuedTo?: string;
}

/** Hops followReissue will take: a reissued code of a reissued code, and so on. */
const MAX_REISSUE_HOPS = 5;

/**
 * Follow reissuedTo links from `key` to the live code (bounded, loop-safe).
 * Returns the last code reached and its record (undefined when missing).
 */
export async function followReissue(env: Env, key: string): Promise<{ key: string; rec: CodeRecord | undefined }> {
    const seen = new Set<string>([key]);
    let rec = safeParse(await env.CODES.get(`code:${key}`));
    for (let hop = 0; hop < MAX_REISSUE_HOPS && rec?.reissuedTo && !seen.has(rec.reissuedTo); hop++) {
        key = rec.reissuedTo;
        seen.add(key);
        rec = safeParse(await env.CODES.get(`code:${key}`));
    }
    return { key, rec };
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

// ===========================================================================
//  THE TASTE TIER — keyless FREE installs
// ===========================================================================
//
// An install with no purchased code still wants to SEE the quality tier once.
// It generates 32 hex chars of local randomness at install time and presents
// `free_<id>` as its bearer. That id is never minted, never stored, and never
// revocable: it exists only so two installs meter separately. authCode resolves
// it to a SYNTHETIC record and never reads KV, which is what makes it
// impossible to mint one, revoke one, or hand one a bigger cap.
//
// The id is client-chosen, so it is farmable by construction — rerolling it
// buys another 3. The per-IP ceiling in reserve() is what makes farming
// tedious; the global budget guard is what makes it harmless.

/** The exact bearer shape a keyless install may present. */
const TASTE_BEARER_RE = /^free_[0-9a-f]{32}$/;
/** Quality translations one free install gets per UTC day, before the nudge. */
export const TASTE_DAILY_CAP = 3;
/** Messages per UTC day across ALL taste ids from one address, so rerolling the
 *  random id does not simply reset the cap. */
export const TASTE_IP_DAILY_CAP = 6;

/** True for a WELL-FORMED taste bearer. */
export function isTasteBearer(code: string | null): boolean {
    return !!code && TASTE_BEARER_RE.test(code);
}

/** The synthetic record a valid taste bearer resolves to. Built fresh per
 *  request and never persisted, so nothing can raise the cap. */
export function tasteRecord(): CodeRecord {
    return { status: "active", plan: "taste", dailyCap: TASTE_DAILY_CAP };
}

// ===========================================================================
//  THE TRIAL — a keyless install's first 7 days, automatic translation
// ===========================================================================
//
// A v0.1.6+ plugin announces itself with `x-subline-client`. For such a client,
// a well-formed free_ bearer gets a 7-day trial measured from the first time
// the relay ever saw that id: 300 messages a day (enough to leave automatic
// translation on through a normal evening) instead of the taste tier's 3. After
// day 7 the same bearer falls back to the taste record, exactly as a legacy
// client always gets.
//
// The one piece of state is `trial:<id>` → first-seen epoch ms, written with a
// 90-day TTL (TRIAL_KEY_TTL_S). The TTL counts from the FIRST write and is never
// refreshed, so 90 days after an id's trial began its key lapses and that id,
// if it shows up again, can start a second 7-day trial. Accepted: that is one
// extra week per id per 90 days, the id is rerollable for free anyway, and
// without a TTL every id ever seen (including throwaway farmed ones) would sit
// in KV forever. The per-IP trial ceilings (use:ipt: messages, use:iptc: cost
// units) and the global budget guard are what keep farming tedious and
// harmless, exactly as for the taste tier.
//
// WRITE ONLY AFTER A SUCCESSFUL RESERVE. Resolving the plan never writes: an
// unseen id is a PROVISIONAL trial (first-seen = now) and the router calls
// startTrial only once /v1/translate has passed reserve(), i.e. after the
// per-IP ceilings. Otherwise /v1/status (or a translate that is then refused)
// with a fresh random id would be one free KV write per request, a
// write-amplification lever anyone could pull without spending a message.
//
// authCode never does this lookup (it resolves free_ with ZERO KV reads, and a
// test pins that): the router calls resolveFreePlan only when the client header
// is present, so a legacy v0.1.5 client never reads or writes a trial: key.

export const TRIAL_MS = 7 * DAY_MS;
/** Messages per UTC day for an install inside its trial. */
export const TRIAL_DAILY_CAP = 300;
/** Messages per UTC day across ALL trial ids behind one address. Twice one
 *  install's cap so a household with two people is not starved, while a farmer
 *  rerolling ids still hits a wall. */
export const TRIAL_IP_DAILY_CAP = 600;
/** Budget COST UNITS (messages + ceil(promptChars/1000), what the global guard
 *  is charged) per UTC day across all trial ids behind one address. The message
 *  cap alone does not bound spend: one message can ride with ~32 KB of prompt
 *  (text + context, the body limit), about 33 units, so 600 messages could be
 *  ~20,000 units. This bounds an address at 1,200 while ordinary chat (short
 *  lines, about 2 units a message) meets the 600-message cap first. */
export const TRIAL_IP_DAILY_COST_CAP = 1_200;
/** trial:<id> lifetime from its first write (see the TRIAL block above). */
export const TRIAL_KEY_TTL_S = 90 * 86_400;

/** The v0.1.6+ client marker. Its PRESENCE (in this shape) is the signal; the
 *  version inside is never compared, so the relay needs no release lockstep. */
const CLIENT_HEADER_RE = /^[A-Za-z0-9._\/+-]{1,40}$/;
export function isNewClient(header: string | null | undefined): boolean {
    return !!header && CLIENT_HEADER_RE.test(header);
}

/** The synthetic record for an install inside its trial. Never persisted. */
export function trialRecord(): CodeRecord {
    return { status: "active", plan: "trial", dailyCap: TRIAL_DAILY_CAP };
}

export interface FreePlan {
    record: CodeRecord;
    trialActive: boolean;
    trialEndsAt: number;
    /** True when no trial:<id> exists yet: the trial reported is PROVISIONAL
     *  (first-seen = now) and nothing has been written. The router makes it
     *  real with startTrial, only after a successful reserve. */
    provisional: boolean;
}

function trialKey(bearer: string): string {
    return `trial:${bearer.slice("free_".length)}`;
}

/** Resolve a WELL-FORMED free_ bearer (the caller has already authenticated it)
 *  for a v0.1.6+ client: trial while inside its 7 days, taste after. READ-ONLY:
 *  an unseen id (or an unreadable value, which only a relay bug could produce)
 *  is a provisional trial starting now, and nothing is written here (see WRITE
 *  ONLY AFTER A SUCCESSFUL RESERVE above). */
export async function resolveFreePlan(env: Env, bearer: string, now: number): Promise<FreePlan> {
    const raw = await env.CODES.get(trialKey(bearer));
    const stored = raw === null ? NaN : Number(raw);
    // AFTER LAUNCH (LAUNCH_AT set and past) no NEW trial starts on this legacy
    // path: 0.2.0 has no free tier, so an older client with an id the relay has
    // never trialled gets the taste allowance only, and nothing is written. A
    // trial already running keeps its 7 days and runs out naturally.
    const launch = launchAtMs(env);
    if (!Number.isFinite(stored) && Number.isFinite(launch) && now >= launch) {
        return { record: tasteRecord(), trialActive: false, trialEndsAt: now, provisional: false };
    }
    const provisional = !Number.isFinite(stored);
    const firstSeen = provisional ? now : stored;
    const trialEndsAt = firstSeen + TRIAL_MS;
    const trialActive = now < trialEndsAt;
    return { record: trialActive ? trialRecord() : tasteRecord(), trialActive, trialEndsAt, provisional };
}

/** Make a provisional trial real: stamp trial:<id> = now with the 90-day TTL,
 *  then count it. Called only after a successful reserve. KV is eventually
 *  consistent, so two first requests racing from different colos may both
 *  write; each writes ~now, so the window moves by milliseconds at most (and
 *  trials_started may count that id twice; an approximate owner metric).
 *  Throws only if the trial write itself fails; the stat bump is best-effort. */
export async function startTrial(env: Env, bearer: string, now: number): Promise<void> {
    await env.CODES.put(trialKey(bearer), String(now), { expirationTtl: TRIAL_KEY_TTL_S });
    try { await bumpStat(env, now, "trials_started"); } catch { /* approximate owner metric only */ }
}

export type AuthOutcome =
    | { ok: true; record: CodeRecord }
    | { ok: false; reason: "no_code" | "unknown_code" | "revoked" | "expired" };

/** Validate the bearer code. Never reveals whether a code merely doesn't exist
 *  vs. is malformed — both read as unknown_code — to avoid an enumeration oracle. */
export async function authCode(env: Env, code: string | null): Promise<AuthOutcome> {
    if (!code) return { ok: false, reason: "no_code" };
    // A keyless install resolves WITHOUT touching KV. Anything else wearing the
    // free_ prefix is malformed or forged and reads as unknown_code — and it
    // never falls through to a KV lookup, so the prefix can never resolve to a
    // stored (and therefore mintable, or bigger-capped) record.
    if (code.startsWith("free_")) {
        return isTasteBearer(code) ? { ok: true, record: tasteRecord() } : { ok: false, reason: "unknown_code" };
    }
    const raw = await env.CODES.get(`code:${code}`);
    if (raw === null) return { ok: false, reason: "unknown_code" };
    let rec: CodeRecord;
    try { rec = JSON.parse(raw) as CodeRecord; } catch { return { ok: false, reason: "unknown_code" }; }
    if (rec.status === "revoked") return { ok: false, reason: "revoked" };
    // A non-terminal record whose expiry still looks provisional (or is near its
    // end) may have an ORPHANED pending:<join_id> row: a lifecycle webhook that
    // raced license_key.created and staged instead of applying (KV is eventually
    // consistent, so no in-handler re-check can fully close that). Fold it in
    // here, lazily. Gated so a healthy record costs zero extra reads.
    if (!rec.terminal) rec = await lazyFoldPending(env, code, rec, Date.now());
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
    | { ok: true; used: number; cap: number; charged?: number }
    | { ok: false; reason: "cap_exceeded" | "month_cap_exceeded" | "rate_limited" | "capacity" | "unavailable"; retryAfterMs: number; used?: number; cap?: number };

/**
 * RESERVE BEFORE SPEND. The cap is checked and the spend committed BEFORE the
 * model is called, so a normal upstream failure (which then refunds)
 * never overspends, and the reserve is the safe direction for the budget.
 */
/**
 * Requests per minute a code may make. A request is a BATCH of up to 25
 * messages, so even 20/min is far above a human reading and scrolling; the
 * daily message cap is the real spend limit. Any paid tier (legacy "paid" or a
 * MoR subscription/lifetime plan) gets the higher ceiling; the unpaid plans
 * ("free", "taste", unset) stay at 20 — a taste install has 3 messages a day
 * anyway, so its rate gate only has to look like the free one. STATED TO THE
 * CLIENT on every response (`rpmLimit`) and on a 429 (`quotaLimitPerMinute`) so
 * the plugin's own rate gate tunes itself to this number instead of a
 * conservative guess.
 */
const UNPAID_PLANS = new Set(["free", "taste", "trial"]);
export function rpmLimitFor(rec: CodeRecord): number {
    return rec.plan && !UNPAID_PLANS.has(rec.plan) ? 60 : 20;
}

/**
 * What one batch costs against the per-bearer DAILY CAP (the used/cap the client
 * sees).
 *
 * A CODE is charged one unit per message, plus a surcharge only for prompt text
 * beyond PROMPT_CHARS_PER_MESSAGE per message, so a client cannot buy cheap
 * tokens by stuffing huge texts into few messages. The allowance is what makes
 * "up to 2,000 ✦ a day" true in ordinary live chat: one short message with the
 * 8-line context ring costs exactly 1, where the old whole-prompt surcharge
 * charged it 2 and a subscriber ran out at about 1,000. A TASTE install is
 * charged MESSAGES ONLY: its cap is 3, and "3 free translations" has to mean 3
 * presses whatever the length, or the nudge ("2 of 3 left today") lies. The
 * money side of a long keyless message is not lost: the global budget and the
 * trial's per-IP cost cap are charged budgetCostFor() instead (see reserve).
 */
export function costFor(rec: CodeRecord, messages: number, promptChars: number): number {
    // A trial is the same keyless install, so it keeps the same honest unit.
    if (rec.plan === "taste" || rec.plan === "trial") return messages;
    const extra = Math.max(0, promptChars - PROMPT_CHARS_PER_MESSAGE * messages);
    return messages + Math.ceil(extra / 1000);
}

/** Prompt characters (message, context, names) one ✦ message may carry before
 *  it counts as more than one. Covers a message with the client's full 8-line
 *  context ring of ordinary chat lines. */
export const PROMPT_CHARS_PER_MESSAGE = 1_000;

/** What one batch really costs in SPEND units, whatever the plan: messages plus
 *  one unit per started 1,000 prompt chars. This is what the global Budget guard
 *  is charged for every plan, so neither a keyless install's messages-only count
 *  nor a code's per-message allowance (costFor) can hide real spend from the
 *  money ceiling. */
export function budgetCostFor(messages: number, promptChars: number): number {
    return messages + Math.ceil(promptChars / 1000);
}

/**
 * The address a per-IP ceiling is keyed on. IPv4 is used as is. IPv6 is cut to
 * its /64 prefix (the first 4 hextets after expanding `::`), because one
 * subscriber is normally handed a whole /64 and can pick a new address inside
 * it at will: keyed on the full address, every one of 2^64 addresses would get
 * its own ceiling. Hextets are lowercased and stripped of leading zeros so two
 * spellings of one prefix share a key. An IPv4-mapped IPv6 (::ffff:a.b.c.d) is
 * treated as its IPv4. Anything unparseable is used as is (lowercased): it can
 * only ever be its own bucket, never someone else's.
 */
export function ipBucket(ip: string): string {
    const raw = ip.trim().toLowerCase();
    if (!raw.includes(":")) return raw;
    const mapped = /^[0:]*:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
    if (mapped) return mapped[1]!;
    const halves = raw.split("::");
    if (halves.length > 2) return raw;
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return raw;
    const full = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
    if (!full.every(h => /^[0-9a-f]{1,4}$/.test(h))) return raw;
    return full.slice(0, 4).map(h => h.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/**
 * A WIDER network key than ipBucket, for limits a scripted user must not be
 * able to multiply cheaply: IPv4 is cut to its /24, IPv6 to its /48. A /48 is
 * what one tunnel or VPS customer is routinely handed (65,536 /64s), so a /64
 * limit alone does not stop one person. Unparseable input is its own bucket.
 */
export function ipBucketWide(ip: string): string {
    const b = ipBucket(ip);
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(b);
    if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
    if (b.endsWith("::/64")) return b.slice(0, -"::/64".length).split(":").slice(0, 3).join(":") + "::/48";
    return b;
}

/**
 * The network key a promo counts its claims under, or undefined for none.
 * IPv6 only, cut to its /48: that is where one person holds 65,536 /64s and
 * can drain a promo. An IPv4 /24 is NOT limited: behind carrier-grade NAT (much
 * mobile and home internet in India and Southeast Asia) and on campus or dorm
 * networks, many real people share one /24, and a limit there would refuse the
 * sixth real member of a server. One person cannot hold many IPv4 addresses
 * cheaply, and the per-address redeem limits (promo.ts) still apply.
 */
export function promoNetKey(ip: string): string | undefined {
    const wide = ipBucketWide(ip);
    return wide.endsWith("::/48") ? wide : undefined;
}

/** One per-address ceiling: its counter key, its limit, and which unit it
 *  counts (messages, or budget cost units). */
interface IpGuard { key: string; cap: number; unit: "messages" | "cost" }

/** Per-address ceilings for a keyless plan; empty for every other plan (a real
 *  code never grows an ip counter). Taste and trial keep SEPARATE counters so a
 *  household's trial traffic cannot eat a legacy install's 6 taste messages,
 *  nor the other way round. A trial has two: messages (use:ipt:) and budget
 *  cost units (use:iptc:), so long messages cannot spend 600 messages' worth of
 *  maximum-size prompts. */
function ipGuards(plan: CodeRecord["plan"], ip: string | null | undefined, now: number): IpGuard[] {
    if (!ip) return [];
    const b = ipBucket(ip), d = today(now);
    if (plan === "taste") return [{ key: `use:ip:${b}:${d}`, cap: TASTE_IP_DAILY_CAP, unit: "messages" }];
    if (plan === "trial") return [
        { key: `use:ipt:${b}:${d}`, cap: TRIAL_IP_DAILY_CAP, unit: "messages" },
        { key: `use:iptc:${b}:${d}`, cap: TRIAL_IP_DAILY_COST_CAP, unit: "cost" }
    ];
    return [];
}

/** Write a soft counter, and if KV refuses, say so and carry on. These counters
 *  are fairness limits, not the money guard (that is the Budget DO, already
 *  committed by the time they are written), so a failed write must never turn a
 *  paid-for, budget-cleared request into an error. The log names the counter
 *  and KV's error, never the code, id, or address. */
async function softPut(env: Env, key: string, value: string, ttlS: number, where: string, counter: string, redact: string[]): Promise<void> {
    try {
        await env.CODES.put(key, value, { expirationTtl: ttlS });
    } catch (e) {
        let msg = String((e as any)?.message ?? e).slice(0, 200);
        for (const r of redact) if (r) msg = msg.split(r).join("<redacted>");
        console.warn(`${where}: KV counter write failed, request continues`, { counter, error: msg });
    }
}

/**
 * WHERE A BEARER'S COUNTERS LIVE. The legacy keyless tiers (0.1.x taste and
 * trial, closed to new ids after launch) keep their KV counters and per-address
 * ceilings exactly as before. Every other bearer, paid and AI codes and a v2
 * account's previews ("pv:<account>"), is counted inside the Budget Durable
 * Object, in the same call that charges the global budget: zero KV writes per
 * request (see budget.ts).
 */
export function countsInKv(code: string, rec: Pick<CodeRecord, "plan">): boolean {
    return (rec.plan === "taste" || rec.plan === "trial") && !code.startsWith("pv:");
}

/** Taste, trial and preview traffic: what does not come from a paid AI plan. */
function isFreeTraffic(rec: Pick<CodeRecord, "plan">): boolean {
    return rec.plan === "taste" || rec.plan === "trial";
}

/** The share of the global budget that free traffic (taste, trial, previews)
 *  may spend. The rest is kept for paying AI users, so free usage can never
 *  freeze a subscriber. */
export const FREE_BUDGET_SHARE = 0.9;

/** The global freeze point for this request. */
export function freezeAtFor(env: Env, free: boolean): number {
    const all = Number(env.GLOBAL_BUDGET_MESSAGES) || DEFAULT_GLOBAL_FREEZE;
    return free ? Math.ceil(all * FREE_BUDGET_SHARE) : all;
}

const SUBSCRIPTION_AI = new Set(["monthly", "annual"]);

/** The monthly allowance (spend units) for this plan, or null when there is none. */
export function monthlyCapFor(env: Env, plan: CodeRecord["plan"]): number | null {
    if (!SUBSCRIPTION_AI.has(plan ?? "")) return null;
    const n = Number(env.AI_MONTHLY_CAP);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function msUntilNextUtcMonth(now: number): number {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - now;
}

function budgetStub(env: Env): DurableObjectStub {
    return env.BUDGET.get(env.BUDGET.idFromName("global"));
}

/** An error's message for a log line, with the code and address cut out. */
function redacted(e: unknown, redact: string[]): string {
    let msg = String((e as any)?.message ?? e).slice(0, 200);
    for (const r of redact) if (r) msg = msg.split(r).join("<redacted>");
    return msg;
}

/** `ip` is the caller's cf-connecting-ip, passed ONLY for taste/trial requests
 *  (and absent when the header is missing) — it enables the per-IP ceilings.
 *  `cost` is the per-bearer daily count (costFor); `budgetCost` is what the
 *  global guard, the monthly allowance and the per-IP cost cap are charged
 *  (budgetCostFor). It defaults to `cost`.
 *
 *  NEVER THROWS for an infrastructure fault: a Budget object or KV failure is
 *  `unavailable` (503) with the cause logged, and a keyless request's counters
 *  are rolled back first, so the account never loses a preview to an outage. */
export async function reserve(
    env: Env, code: string, rec: CodeRecord, cost: number, now: number, ip?: string | null, budgetCost: number = cost,
    once?: ReserveReq["once"], parts?: ReserveReq["parts"]
): Promise<ReserveOutcome> {
    const rpmLimit = rpmLimitFor(rec);
    // SKIPPED when the daily cap makes it unreachable: every successful
    // reserve adds at least 1 to the day's count, so a bearer gets at most
    // dailyCap successes per UTC day. With dailyCap < rpmLimit (taste: 3 < 20)
    // the minute counter could never reach its limit.
    const rpmTracked = rec.dailyCap >= rpmLimit;
    const redact = [code, ip ?? ""];

    if (!countsInKv(code, rec)) {
        const monthCap = monthlyCapFor(env, rec.plan);
        const body: ReserveReq = {
            cost: budgetCost,
            freezeAt: freezeAtFor(env, isFreeTraffic(rec)),
            day: { key: dayRowKey(code, now), add: cost, cap: rec.dailyCap },
            ...(monthCap !== null ? { month: { key: monthRowKey(code, now), add: budgetCost, cap: monthCap } } : {}),
            ...(rpmTracked ? { rpm: { key: code, limit: rpmLimit } } : {}),
            ...(once ? { once } : {}),
            ...(parts ? { parts } : {}),
            now
        };
        let d: ReserveRes;
        try {
            const res = await budgetStub(env).fetch("https://budget.internal/reserve", { method: "POST", body: JSON.stringify(body) });
            d = await res.json() as ReserveRes;
            if (typeof d?.allowed !== "boolean") throw new Error(`budget answered ${res.status} without a decision`);
        } catch (e) {
            console.warn("reserve: budget call failed, request refused", { error: redacted(e, redact) });
            return { ok: false, reason: "unavailable", retryAfterMs: 60_000 };
        }
        if (d.allowed) return { ok: true, used: d.used ?? cost, cap: rec.dailyCap, charged: typeof d.charged === "number" ? d.charged : cost };
        const used = d.used ?? 0;
        if (d.reason === "rate_limited") return { ok: false, reason: "rate_limited", retryAfterMs: 60_000 - (now % 60_000) };
        if (d.reason === "cap_exceeded") return { ok: false, reason: "cap_exceeded", retryAfterMs: msUntilUtcMidnight(now), used, cap: rec.dailyCap };
        if (d.reason === "month_cap_exceeded") return { ok: false, reason: "month_cap_exceeded", retryAfterMs: msUntilNextUtcMonth(now), used, cap: rec.dailyCap };
        return { ok: false, reason: "capacity", retryAfterMs: 3_600_000 };
    }

    // ---- LEGACY KEYLESS (0.1.x taste/trial): KV counters, as before --------
    // 1) Per-minute rate limit (KV, soft).
    const rpmKey = `rl:${code}:${Math.floor(now / 60_000)}`;
    const dayKey = `use:${code}:${today(now)}`;
    let rpm: number, used: number;
    const guards = ipGuards(rec.plan, ip, now);
    const ipUsed: number[] = [];
    try {
        rpm = rpmTracked ? await readCount(env, rpmKey) : 0;
        if (rpm >= rpmLimit) return { ok: false, reason: "rate_limited", retryAfterMs: 60_000 - (now % 60_000) };

        // 2) Daily per-bearer cap.
        used = await readCount(env, dayKey);
        if (used + cost > rec.dailyCap) {
            return { ok: false, reason: "cap_exceeded", retryAfterMs: msUntilUtcMidnight(now), used, cap: rec.dailyCap };
        }

        // 2b) Daily ceilings per ADDRESS (an IPv6 /64, see ipBucket), shared by
        //     every free id behind it. The id is generated by the client, so it
        //     can be rerolled for another 3; the address behind it cannot be,
        //     cheaply. No header (not fronted by Cloudflare, or a unit test) ⇒
        //     skip the cap, never deny on its absence.
        for (const g of guards) {
            const n = await readCount(env, g.key);
            ipUsed.push(n);
            if (n + (g.unit === "cost" ? budgetCost : cost) > g.cap) {
                // Same shape as the per-bearer cap (spelling out "your address
                // is capped" would only teach a farmer what to evade).
                return { ok: false, reason: "cap_exceeded", retryAfterMs: msUntilUtcMidnight(now), used, cap: rec.dailyCap };
            }
        }
    } catch (e) {
        console.warn("reserve: keyless counter read failed, request refused", { error: redacted(e, redact) });
        return { ok: false, reason: "unavailable", retryAfterMs: 60_000 };
    }

    // 2c) KEYLESS FAILS CLOSED. The KV counters ARE the limit: nothing else
    //     stops one random free_ id from translating without end. So they are
    //     written BEFORE the budget is committed, and if any write fails the
    //     request is refused with "unavailable" (503) having spent nothing. A
    //     partial write is rolled back best-effort.
    const stub = budgetStub(env);
    const freezeAtK = freezeAtFor(env, true);
    // Ask the budget first: writing counters only to roll them back is pure KV
    // churn on exactly the day the relay is already out of money. Decided from
    // the total only (a stale "frozen" flag never refuses, see budget.ts).
    try {
        const st = await (await stub.fetch("https://budget.internal/status")).json() as { total?: number };
        if (typeof st.total === "number" && st.total >= freezeAtK) {
            return { ok: false, reason: "capacity", retryAfterMs: 3_600_000 };
        }
    } catch { /* unknown: fall through; the reserve below still decides */ }
    const writes: { key: string; before: number; after: number; ttl: number }[] = [
        { key: dayKey, before: used, after: used + cost, ttl: 172_800 },
        ...(rpmTracked ? [{ key: rpmKey, before: rpm, after: rpm + 1, ttl: 120 }] : []),
        ...guards.map((g, i) => ({
            key: g.key, before: ipUsed[i]!, after: ipUsed[i]! + (g.unit === "cost" ? budgetCost : cost), ttl: 172_800
        }))
    ];
    const done: typeof writes = [];
    const rollback = async () => {
        for (const w of done) {
            try { await env.CODES.put(w.key, String(w.before), { expirationTtl: w.ttl }); } catch { /* best effort */ }
        }
    };
    for (const w of writes) {
        try {
            await env.CODES.put(w.key, String(w.after), { expirationTtl: w.ttl });
            done.push(w);
        } catch (e) {
            console.warn("reserve: keyless counter write failed, request refused", { error: redacted(e, redact) });
            await rollback();
            return { ok: false, reason: "unavailable", retryAfterMs: 60_000 };
        }
    }
    let allowed: boolean;
    try {
        const bres = await stub.fetch("https://budget.internal/reserve", {
            method: "POST",
            body: JSON.stringify({ cost: budgetCost, freezeAt: freezeAtK, now } satisfies ReserveReq)
        });
        const decision = await bres.json() as { allowed?: unknown };
        if (typeof decision?.allowed !== "boolean") throw new Error(`budget answered ${bres.status} without a decision`);
        allowed = decision.allowed;
    } catch (e) {
        // The counters were written for a request that will not be served:
        // give them back. If the object did commit before its answer was lost,
        // the budget only ends up a little conservative.
        console.warn("reserve: budget call failed, request refused", { error: redacted(e, redact) });
        await rollback();
        return { ok: false, reason: "unavailable", retryAfterMs: 60_000 };
    }
    if (!allowed) {
        await rollback();
        return { ok: false, reason: "capacity", retryAfterMs: 3_600_000 };
    }
    return { ok: true, used: used + cost, cap: rec.dailyCap };
}

/** Return a reservation when the upstream call failed, so an outage never
 *  costs a user their quota. Best-effort; the global counter is left as-is so
 *  the budget guard stays conservative.
 *
 *  `plan` picks where the counters live (see countsInKv) and which address
 *  counters a legacy keyless request gives back (taste → use:ip:, trial →
 *  use:ipt: and use:iptc:). It defaults to taste so the pre-trial call
 *  signature keeps its exact meaning; `budgetCost` (default `cost`) is what the
 *  cost-unit counters give back. Never throws: it runs in waitUntil after the
 *  response, and a failed refund only leaves a counter slightly high. */
export async function refund(
    env: Env, code: string, cost: number, now: number, ip?: string | null,
    plan: CodeRecord["plan"] = "taste", budgetCost: number = cost, onceKey?: string
): Promise<void> {
    const redact = [code, ip ?? ""];
    if (!countsInKv(code, { plan })) {
        const rows = [{ key: dayRowKey(code, now), sub: cost }];
        // A preview's per-message marker (ReserveReq.once) goes back too, so a
        // failed first try leaves the retry counted as the first.
        if (onceKey) rows.push({ key: onceKey, sub: 1 });
        if (monthlyCapFor(env, plan) !== null) rows.push({ key: monthRowKey(code, now), sub: budgetCost });
        try {
            await budgetStub(env).fetch("https://budget.internal/refund", { method: "POST", body: JSON.stringify({ rows }) });
        } catch (e) {
            console.warn("refund: budget call failed, counter stays charged", { error: redacted(e, redact) });
        }
        return;
    }
    const giveBack = async (key: string, by: number, counter: string) => {
        let n: number;
        try { n = await readCount(env, key); } catch { return; }
        await softPut(env, key, String(Math.max(0, n - by)), 172_800, "refund", counter, redact);
    };
    await giveBack(`use:${code}:${today(now)}`, cost, "day");
    // A taste request also held a per-IP reservation; give that back too, or one
    // upstream outage burns a whole household's free taste for the day. Passed
    // only for taste/trial requests, so nothing else grows an ip counter.
    for (const g of ipGuards(plan, ip, now)) {
        await giveBack(g.key, g.unit === "cost" ? budgetCost : cost, g.unit === "cost" ? "ip_cost" : "ip");
    }
}

/** A preview sent in parts lost a part: give back all the message was charged
 *  today, reset its group and take back this call's part markers (budget.ts
 *  /refund-group). Never throws: a failure only leaves the count high. Returns what was given back. */
export async function refundGroup(
    env: Env, code: string, now: number, parts: NonNullable<ReserveReq["parts"]> & { refunds?: string; maxRefunds?: number }
): Promise<number> {
    try {
        const res = await budgetStub(env).fetch("https://budget.internal/refund-group", {
            method: "POST",
            body: JSON.stringify({
                day: dayRowKey(code, now), charge: parts.charge, group: parts.group,
                ...(parts.chars ? { chars: parts.chars } : {}),
                ...(parts.refunds ? { refunds: parts.refunds, maxRefunds: parts.maxRefunds ?? 0 } : {}),
                rows: [...new Set(parts.keys)].map(key => ({ key, sub: 1 }))
            })
        });
        const out = await res.json() as { refunded?: unknown };
        return typeof out.refunded === "number" ? out.refunded : 0;
    } catch (e) {
        console.warn("refund: budget group refund failed, counter stays charged", { error: redacted(e, [code]) });
    }
    return 0;
}

/** A DO-counted bearer's count for today (see countsInKv). Throws on failure. */
export async function readDayCount(env: Env, code: string, now: number): Promise<number> {
    const key = dayRowKey(code, now);
    const res = await budgetStub(env).fetch("https://budget.internal/peek", { method: "POST", body: JSON.stringify({ keys: [key] }) });
    const v = Number((await res.json() as { values?: Record<string, unknown> })?.values?.[key]);
    return Number.isFinite(v) ? v : 0;
}

/** Current usage for GET /v1/status. A counter that cannot be read shows 0,
 *  with the cause logged: status must not fail over a display number. */
export async function usage(env: Env, code: string, rec: CodeRecord, now: number): Promise<{ used: number; cap: number; resetsInMs: number }> {
    let used: number;
    if (countsInKv(code, rec)) {
        used = await readCount(env, `use:${code}:${today(now)}`);
    } else {
        try { used = await readDayCount(env, code, now); }
        catch (e) {
            console.warn("usage: budget read failed, showing 0", { error: redacted(e, [code]) });
            used = 0;
        }
    }
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
// The plans a PURCHASE may map to. "taste" and "trial" are deliberately NOT here: they are the
// synthetic keyless tier, so a product-id map must never be able to mint one
// (that would be a stored free_-style record with a purchased cap).
const KNOWN_PLANS = new Set(["free", "paid", "monthly", "annual", "lifetime", "automatic"]);

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

/** A staged lifecycle change waiting for its code (see applyLifecycle). */
interface PendingRow {
    revoked?: boolean;
    terminal?: boolean;
    revokedAt?: number;
    expiresAt?: number;
    mor_subscription_id?: string;
}

/**
 * Fold one staged pending row into a code record (mutates `rec`). The ONE place
 * this merge lives, used by license_key.created (before and after its write),
 * by applyLifecycle's post-stage re-check, and by the lazy fold in authCode.
 *   • A TERMINAL record is never resurrected: only the sub id link is taken.
 *   • revoked/terminal are sticky and, when set, PULL expiry to the staged
 *     (revoke-instant) value so the local expiry net denies too.
 *   • Otherwise expiry moves FORWARD only (max), so a stale staged value can
 *     never shorten a live record.
 */
function foldPending(rec: CodeRecord, pend: PendingRow): void {
    if (rec.terminal) {
        if (pend.mor_subscription_id) rec.mor_subscription_id = pend.mor_subscription_id;
        return;
    }
    if (pend.revoked) rec.status = "revoked";
    if (pend.terminal) { rec.terminal = true; if (typeof pend.revokedAt === "number") rec.revokedAt = pend.revokedAt; }
    if (typeof pend.expiresAt === "number") {
        rec.expiresAt = pend.revoked || pend.terminal
            ? pend.expiresAt
            : Math.max(rec.expiresAt ?? 0, pend.expiresAt);
    }
    if (pend.mor_subscription_id) rec.mor_subscription_id = pend.mor_subscription_id;
}

function parsePending(raw: string | null): PendingRow | undefined {
    if (raw === null) return undefined;
    try {
        const v = JSON.parse(raw);
        return v && typeof v === "object" ? v as PendingRow : undefined;
    } catch { return undefined; }
}

/** Read, fold and delete pending:<id> for each id. Returns true if any folded. */
async function drainPending(env: Env, rec: CodeRecord, ids: string[]): Promise<boolean> {
    let folded = false;
    for (const id of ids) {
        const pend = parsePending(await env.CODES.get(`pending:${id}`));
        if (!pend) continue;
        foldPending(rec, pend);
        await env.CODES.delete(`pending:${id}`);
        folded = true;
    }
    return folded;
}

/**
 * AUTH-TIME LAZY FOLD. Closes the webhook race that no in-handler re-check can:
 * subscription.active and license_key.created delivered concurrently, each
 * missing the other's write (KV reads can lag writes by up to ~60s), leaving the
 * real next_billing_date orphaned in pending:<sub_id> and the code on its 3-day
 * provisional expiry. Only runs when the record has a join id AND a finite expiry
 * within SUBSCRIPTION_GRACE_MS of now (provisional, near its end, or past), so a
 * healthy record pays no extra read. NEVER throws: any KV failure falls back to
 * the unmodified record, so the auth decision is exactly what it was before.
 */
async function lazyFoldPending(env: Env, code: string, rec: CodeRecord, now: number): Promise<CodeRecord> {
    if (rec.terminal) return rec;
    if (!rec.mor_subscription_id && !rec.orderRef) return rec;
    if (typeof rec.expiresAt !== "number" || rec.expiresAt - now > SUBSCRIPTION_GRACE_MS) return rec;
    const ids = [...new Set([rec.mor_subscription_id, rec.orderRef, rec.mor_order_id].filter((x): x is string => !!x))];
    try {
        const next: CodeRecord = { ...rec };
        let folded = false;
        for (const id of ids) {
            const pend = parsePending(await env.CODES.get(`pending:${id}`));
            if (!pend) continue;
            foldPending(next, pend);
            folded = true;
        }
        if (!folded) return rec;
        // Persist the record BEFORE deleting the rows, so a failure between the
        // two leaves a harmless re-foldable row rather than lost state.
        await env.CODES.put(`code:${code}`, JSON.stringify(next));
        for (const id of ids) await env.CODES.delete(`pending:${id}`);
        return next;
    } catch {
        return rec;
    }
}

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
    const orderKey = await env.CODES.get(`order:${orderId}`);
    if (!orderKey) {
        const prev = (safeParse(await env.CODES.get(`pending:${orderId}`)) as any) ?? {};
        if (d.revoked) prev.revoked = true;
        if (d.terminal) { prev.terminal = true; if (typeof d.revokedAt === "number") prev.revokedAt = d.revokedAt; }
        if (typeof d.expiresAt === "number") {
            prev.expiresAt = d.forward ? Math.max(prev.expiresAt ?? 0, d.expiresAt) : d.expiresAt;
        }
        if (d.mor_subscription_id) prev.mor_subscription_id = d.mor_subscription_id;
        // #4: TTL so a staged-but-never-completed order self-purges (no KV bloat).
        await env.CODES.put(`pending:${orderId}`, JSON.stringify(prev), { expirationTtl: PENDING_TTL_S });
        // Symmetric double-check: license_key.created may have written the index
        // while we were staging. If it is visible now, fold the staged row into
        // the code directly. (KV lag can still hide it; authCode's lazy fold is
        // the backstop for that.)
        const lateOrder = await env.CODES.get(`order:${orderId}`);
        if (!lateOrder) return "staged";
        const { key: lateKey, rec: lateRec } = await followReissue(env, lateOrder);
        if (!lateRec) return "staged";
        await drainPending(env, lateRec, [orderId]);
        await env.CODES.put(`code:${lateKey}`, JSON.stringify(lateRec));
        return "applied_after_stage";
    }
    // A reissued code forwards to the code that replaced it (see reissuedTo).
    const followed = await followReissue(env, orderKey);
    const key = followed.key;
    const rec = followed.rec;
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
        if (!cfg.mapped) console.warn("license key for an unmapped product: created revoked, no entitlement", { product: asStr(data.product_id).slice(0, 40) });
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
        const rawExisting = await env.CODES.get(`code:${key}`);
        const existing = safeParse(rawExisting);
        // A REISSUED key (admin reissue after a leak) stays dead: a replayed
        // create must not revive it or point its order: rows back at it. The
        // rows already name the new code, so renewals and refunds reach that.
        if (existing?.reissuedTo) return { action: "reissued_noop" };
        // #2: a subscription code must NEVER be born without an expiry, or a
        // missed/absent subscription event would leave it valid forever (the
        // authCode expiry net is skipped when expiresAt is undefined). Stamp a
        // finite PROVISIONAL expiry (now + GRACE); the real next_billing_date
        // supersedes it forward-only. Lifetime/free codes stay never-expiring.
        const provisional = isSubscription ? now + SUBSCRIPTION_GRACE_MS : undefined;
        const rec: CodeRecord = {
            // An unmapped product FAILS CLOSED: the code exists (so a later refund or a
            // support look-up can find it) but is born revoked and entitles to nothing.
            status: existing?.status === "revoked" || !cfg.mapped ? "revoked" : "active",
            dailyCap: cfg.dailyCap,
            plan: cfg.plan,
            mor_order_id: payId || undefined,               // the payment join id
            orderRef: subId || payId || undefined,          // keep orderRef populated for admin/refund parity
            mor_subscription_id: subId || existing?.mor_subscription_id,
            expiresAt: existing?.expiresAt ?? provisional,
            terminal: existing?.terminal,
            revokedAt: existing?.revokedAt,
            createdAt: existing ? existing.createdAt : now,
            // Unmapped product is a config error: fail safe on the cap AND flag it.
            note: cfg.mapped ? existing?.note : `unmapped product_id ${asStr(data.product_id).slice(0, 40)}: no entitlement`,
        };
        // Fold in any lifecycle state that arrived before this key, draining the
        // pending row for EACH join id (see ORDER-INDEPENDENCE). A refund that
        // raced ahead staged under pending:<payment_id>; a subscription event
        // under pending:<subscription_id> — fold both so the record converges.
        await drainPending(env, rec, joinIds);
        await env.CODES.put(`code:${key}`, JSON.stringify(rec));
        for (const id of joinIds) await env.CODES.put(`order:${id}`, key); // reverse index (both join ids)
        // Hand the key to the install that bought it, if a payment/subscription
        // event already said which one (see checkout.ts). A KV failure there
        // throws, so this webhook answers 500 and Dodo retries; everything
        // above is an idempotent upsert, so the retry is safe.
        await linkFromKey(env, key, joinIds);
        // POST-WRITE RE-CHECK: a lifecycle event running concurrently may have
        // missed our order: index and staged AFTER the drain above. Look once
        // more now that the index is written. (KV lag can still hide the row;
        // authCode's lazy fold is the backstop.)
        if (await drainPending(env, rec, joinIds)) await env.CODES.put(`code:${key}`, JSON.stringify(rec));
        // Owner stat: a genuinely NEW key is a conversion. A replayed/upserted
        // create (the row already existed) must not count twice. Counts only,
        // keyed by plan, and a stats failure is swallowed so it can never turn
        // this webhook into a 500 (Dodo would retry a purchase already applied).
        if (rawExisting === null) {
            try { await bumpStat(env, now, `conv:${cfg.plan}`); } catch { /* approximate metrics only */ }
        }
        return { action: cfg.mapped ? "created" : "created_unmapped_variant" };
    }

    // ---- Which install bought this (checkout.ts). Runs before the state
    // machine and never changes the code record itself. A KV failure throws
    // (500, Dodo retries): this is the only event that names the install.
    if (name.startsWith("payment.") || name.startsWith("subscription.")) {
        await recordPurchaseState(env, name, data);
        await linkFromLifecycle(env, name, data);
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
        // Only money that has actually gone back takes the code. A Refund object
        // carries status (succeeded | failed | pending | review) and is_partial
        // (dodopayments-node src/resources/refunds.ts). refund.succeeded should
        // only ever carry "succeeded", but terminal is permanent, so any other
        // status on it is not trusted to revoke. A PARTIAL refund (part of the
        // price, e.g. a goodwill or rounding refund) keeps the purchase: the
        // buyer still paid for it. Both are logged, so the owner can see a
        // refund the relay chose not to act on (and revoke by hand if meant).
        if (name === "refund.succeeded") {
            const st = data.status;
            if (st !== undefined && st !== null && st !== "succeeded") {
                console.warn("refund event not succeeded: code kept", { status: asStr(st).slice(0, 20), payment: asStr(data.payment_id).slice(0, 40) });
                return { action: "ignored_refund_not_succeeded" };
            }
            if (data.is_partial === true) {
                console.warn("partial refund: code kept", { payment: asStr(data.payment_id).slice(0, 40) });
                return { action: "ignored_partial_refund" };
            }
        }
        // The purchase is over: a new one may be bought from that install now.
        await clearBuying(env, asStr(data.payment_id));
        return { action: await applyLifecycle(env, asStr(data.payment_id), { revoked: true, terminal: true, expiresAt: now, revokedAt: now }) };
    }

    // ---- Everything else (payment.*, in-flight/won disputes, credit.*, …):
    // handled no-op (2xx). NEVER a throw — a throw becomes a 500 and, worse, must
    // never be able to turn a deny into an allow.
    return { action: "ignored" };
}

/** The value wrangler.jsonc ships LAUNCH_AT with. The release step replaces it. */
export const LAUNCH_AT_PLACEHOLDER = "SET_AT_RELEASE";

/**
 * LAUNCH_AT as epoch ms: a number, or an ISO date. NaN when unset, still the
 * placeholder, or unreadable. Everything keyed on launch (early grants,
 * grandfathering by date, the legacy trial cut-off) is off while it is NaN.
 */
export function launchAtMs(env: Env): number {
    const raw = env.LAUNCH_AT;
    if (raw === undefined || raw === null || raw === "" || raw === LAUNCH_AT_PLACEHOLDER) return NaN;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(String(raw));
    return Number.isFinite(t) ? t : NaN;
}
