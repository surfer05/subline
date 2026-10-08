/**
 * Buying without handling a key.
 *
 * THE FLOW. A free install asks the relay for a checkout (`POST /v1/checkout`,
 * bearer = its free_ id). The relay creates a Dodo Payments checkout session
 * whose metadata carries the INSTALL HASH (first 16 hex of SHA-256 of the free_
 * bearer, never the raw id), and remembers `checkout:<session_id>` → hash. The
 * buyer pays in their browser. Dodo's webhooks then arrive in any order:
 *   • payment.* / subscription.* carry the session metadata (and a payment
 *     carries checkout_session_id), so they name the install hash and the
 *     payment/subscription ids: stored as `inst:<id>` → hash.
 *   • license_key.created carries the key and the same payment/subscription
 *     ids, but no metadata.
 * Whichever lands second writes `paid:<hash>` → key. The plugin, still holding
 * its free_ id, polls `GET /v1/status`, which hands the key back ONLY to the
 * holder of the id whose hash it is. Nobody types or pastes a key.
 *
 * DOCS (docs.dodopayments.com):
 *   • POST /checkouts, Bearer API key, live/test base URLs:
 *     /api-reference/checkout-sessions/create, /api-reference/introduction
 *   • session metadata is "additional metadata associated with the payment",
 *     and webhook payloads include the object's metadata: /api-reference/metadata
 *   • a checkout's first payment has checkout_session_id set (DataFast
 *     integration page), the join used when metadata is missing
 *   • POST /discounts (basis points, code >= 3 chars uppercased, up to 16 chars,
 *     subscription_cycles, usage_limit, restricted_to):
 *     /api-reference/discounts/create-discount
 */
import { followReissue, ipBucket, isNewClient, isTasteBearer, variantConfig, type CodeRecord, type Env } from "./codes";
import { installOf, isApiV2, resolveEntitlement } from "./entitle";
import { readCappedText, SMALL_BODY_BYTES } from "./body";

export const DEFAULT_DODO_API_BASE = "https://live.dodopayments.com";
export const DEFAULT_CHECKOUT_RETURN_URL = "https://subline.page/";

/**
 * Where Dodo sends the buyer after paying. Every checkout this relay makes is
 * started from Discord (it needs the install id), so the site is told so with
 * `from=discord` and shows "go back to Discord" instead of the code and the
 * downloads. Added with the URL API, so a CHECKOUT_RETURN_URL that already has
 * a query keeps it. A malformed override falls back to the default.
 */
export function discordReturnUrl(configured: string | undefined, from: "discord" | "installer" = "discord"): string {
    let u: URL;
    try { u = new URL(configured || DEFAULT_CHECKOUT_RETURN_URL); } catch { u = new URL(DEFAULT_CHECKOUT_RETURN_URL); }
    u.searchParams.set("from", from);
    return u.toString();
}

/**
 * The Automatic product id wrangler.jsonc ships with until the owner creates
 * the real Dodo product. Checkout treats it as not configured (503, and Dodo is
 * never asked), and a test refuses to ship it (see test/placeholder.test.ts).
 * Spelled in parts so the release scanner (installer/scripts/placeholder.mjs),
 * which looks for the literal id in shipped files, does not flag this guard.
 */
export const AUTOMATIC_PRODUCT_PLACEHOLDER = ["pdt", "AUTOMATIC", "PENDING"].join("_");

/** Session rows only need to outlive the session itself (24 h by default). */
export const CHECKOUT_TTL_S = 2 * 86_400;
/** Same lifetime as the webhook pending rows: bridges out-of-order delivery. */
export const INST_TTL_S = 3 * 86_400;
/**
 * CHECKOUT-OPEN MARKER (no double pay before the first webhook).
 *
 * `cko:<hash>:<kind>` → JSON list of the newest CKO_MAX sessions this install
 * opened for that kind ({s: session id, u: url, p: product, f: from, at: ms}).
 * Written once per NEW session. It replaces the old `open:` row, so a
 * checkout costs the same number of KV writes as before. Before any new
 * session is made for that install and kind, the relay asks Dodo
 * (GET /checkouts/{id}, docs.dodopayments.com/api-reference/checkout-sessions/
 * get-checkouts: {id, created_at, payment_id?, payment_status?: IntentStatus})
 * how each listed session stands:
 *   • money moving or moved (succeeded, processing, 3DS, capture...) →
 *     409 purchase_pending. Never sold twice, however old the session.
 *   • no payment yet, or one that failed or was cancelled → no block. An
 *     abandoned checkout therefore blocks NOTHING while Dodo answers.
 *   • Dodo cannot be asked (network, 5xx, unknown status) → time-boxed:
 *     refuse only while the session is younger than CKO_WINDOW_MS (30 min),
 *     then let the buyer through (fail open after the window, so an outage
 *     never locks a buyer out for long).
 * The marker lives as long as a Dodo session can still be paid (24 h by
 * default; kept 48 h like the checkout: rows). A payment.failed / cancelled
 * webhook deletes it (linkFromLifecycle).
 *
 * WINDOW = 30 min: it covers a buyer still on the payment page, 3DS and a slow
 * first webhook when Dodo's status call is down, and it caps how long a Dodo
 * outage can block a later purchase. The same 30 min is how long a repeat
 * click reopens the SAME unpaid session.
 */
export const OPEN_SESSION_TTL_S = 30 * 60;
export const CKO_WINDOW_MS = OPEN_SESSION_TTL_S * 1000;
export const CKO_TTL_S = 2 * 86_400;
export const CKO_MAX = 3;
/** Long enough for an install that was offline when the purchase landed. */
export const PAID_TTL_S = 30 * 86_400;

export const CHECKOUT_INSTALL_PER_HOUR = 6;
export const CHECKOUT_IP_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

const HASH_RE = /^[0-9a-f]{16}$/;

/** First 16 hex of SHA-256(bearer). Identical to stats.ts fingerprint16. */
export async function installHash(bearer: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function apiBase(env: Env): string {
    return (env.DODO_API_BASE || DEFAULT_DODO_API_BASE).replace(/\/+$/, "");
}

/** The Dodo product id sold as `plan`, from the same VARIANTS table the webhook reads. */
export function productFor(env: Env, plan: string): string | null {
    let table: any = env.VARIANTS;
    if (typeof table === "string") { try { table = JSON.parse(table); } catch { table = undefined; } }
    if (!table || typeof table !== "object") return null;
    for (const id of Object.keys(table)) {
        if (id === AUTOMATIC_PRODUCT_PLACEHOLDER) continue;
        if (variantConfig(env, id).plan === plan) return id;
    }
    return null;
}

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (error: string, status: number, retryAfterMs?: number): Response =>
    json(retryAfterMs === undefined ? { ok: false, error } : { ok: false, error, retryAfterMs }, status);

/** Count one attempt against an hourly counter. False when the ceiling is reached. */
async function underHourly(env: Env, key: string, cap: number): Promise<boolean> {
    const raw = await env.CODES.get(key);
    const n = Number(raw ?? 0) || 0;
    if (n >= cap) return false;
    await env.CODES.put(key, String(n + 1), { expirationTtl: 2 * 3600 });
    return true;
}

function cause(e: unknown): string {
    return String((e as any)?.message ?? e).slice(0, 200);
}

/** POST /v1/checkout. */
export async function handleCheckout(req: Request, env: Env, now: number = Date.now()): Promise<Response> {
    if (req.method !== "POST") return fail("method not allowed", 405);
    if (isApiV2(req)) return handleCheckoutV2(req, env, now);
    // Only a v0.1.10+ plugin buys through here, as the free install it is:
    // a well-formed free_ bearer AND the client header, both checked before
    // any KV read or write and before Dodo is called. The site sells through
    // static links, so there is no anonymous checkout.
    const h = (req.headers.get("authorization") || "").trim();
    if (h === "") return fail("unauthorized", 401);
    const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!isTasteBearer(bearer)) return fail("bad request", 400);
    if (!isNewClient(req.headers.get("x-subline-client"))) return fail("bad request", 400);
    const text = await readCappedText(req, SMALL_BODY_BYTES);
    if (text === null) return fail("payload too large", 413);
    let body: any;
    try { body = JSON.parse(text); } catch { return fail("bad request", 400); }
    const plan = body?.plan;
    if (plan !== "monthly" && plan !== "annual") return fail("bad request", 400);

    // No key: the feature is off, and nothing is written.
    if (!env.DODO_API_KEY) return fail("checkout unavailable", 503);
    const productId = productFor(env, plan);
    if (!productId) {
        console.warn("checkout: no VARIANTS entry for plan", { plan });
        return fail("checkout unavailable", 503);
    }

    return createSession(env, await installHash(bearer), productId, now, req.headers.get("cf-connecting-ip"));
}

/**
 * v2 (paid-only) checkout: Automatic, or AI on top of it. The install id rides
 * in x-subline-install; the bearer is the saved code or the install id. AI
 * needs Automatic first (403 automatic_required), and Automatic cannot be
 * bought twice (409 already_owned). Checked before anything is written for a
 * refused request other than what entitlement resolution itself learns.
 */
async function handleCheckoutV2(req: Request, env: Env, now: number): Promise<Response> {
    const install = installOf(req);
    const h = (req.headers.get("authorization") || "").trim();
    const credential = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!install || !credential || !isNewClient(req.headers.get("x-subline-client"))) return fail("bad request", 400);
    if (credential.startsWith("free_") && credential !== install) return fail("bad request", 400);
    const text = await readCappedText(req, SMALL_BODY_BYTES);
    if (text === null) return fail("payload too large", 413);
    let body: any;
    try { body = JSON.parse(text); } catch { return fail("bad request", 400); }
    const plan = body?.plan;
    if (plan !== "automatic" && plan !== "monthly" && plan !== "annual") return fail("bad request", 400);
    if (!env.DODO_API_KEY) return fail("checkout unavailable", 503);
    const productId = productFor(env, plan);
    if (!productId) {
        console.warn("checkout: no VARIANTS entry for plan", { plan });
        return fail("checkout unavailable", 503);
    }
    const r = await resolveEntitlement(env, install, credential, now);
    if (!r.ok) return fail(r.error, r.status);
    if (plan === "automatic" && r.automatic) return fail("already_owned", 409);
    // AI is per install (entitle.ts): this install already has it, so a
    // second monthly or annual checkout would start a second subscription.
    if (plan !== "automatic" && r.ai) return fail("already_owned", 409);
    if (plan !== "automatic" && !r.automatic) return fail("automatic_required", 403);
    // A purchase of this kind is already on its way for this install (a
    // payment or subscription event named it, see linkFromLifecycle) but has
    // not switched on yet: a slow bank mandate, a late webhook. Selling it
    // again would charge twice (and for AI, start a second subscription).
    const kind: PurchaseKind = plan === "automatic" ? "automatic" : "ai";
    if (!(kind === "automatic" ? r.automatic : r.ai)) {
        let pending = false;
        try { pending = (await env.CODES.get(buyingKey(r.hash, kind))) !== null; }
        catch (e) { console.warn("checkout: pending purchase lookup failed, continuing", { error: cause(e) }); }
        if (pending) return fail("purchase_pending", 409);
    }
    // The installer asks to come back to a "go back to the installer" page.
    const from = body?.return === "installer" ? "installer" : "discord";
    return createSession(env, r.hash, productId, now, req.headers.get("cf-connecting-ip"), from, kind);
}

/**
 * Rate-limit, then ask Dodo for a checkout session tied to this install hash.
 * Shared by the legacy and the v2 checkout.
 */
async function createSession(
    env: Env, hash: string, productId: string, now: number, ip: string | null,
    from: "discord" | "installer" = "discord", kind: PurchaseKind = "ai"
): Promise<Response> {
    // G1: one check-and-create at a time per install and kind, across every
    // Cloudflare location (see promo.ts CHECKOUT LOCK). FAIL CLOSED when the
    // lock object cannot be reached, like a KV read error on the marker below.
    const lock = await takeCheckoutLock(env, hash, kind);
    if (lock === "unavailable") return fail("checkout unavailable", 503);
    if (lock === "busy") return fail("checkout unavailable", 503, CKO_LOCK_WAIT_MS);
    const made: { added?: OpenSession } = {};
    try {
        return await createSessionLocked(env, hash, productId, now, ip, from, kind, lock?.open ?? [], made);
    } finally {
        if (lock) await releaseCheckoutLock(env, hash, kind, lock.token, made.added);
    }
}

/** How long a checkout waits for another one of the same install and kind. */
export const CKO_LOCK_WAIT_MS = 8_000;
const CKO_LOCK_POLL_MS = 200;

function checkoutLockStub(env: Env, hash: string, kind: PurchaseKind): DurableObjectStub {
    return env.PROMO!.get(env.PROMO!.idFromName(checkoutOpenKey(hash, kind)));
}

/**
 * Take the install+kind checkout lock, waiting up to CKO_LOCK_WAIT_MS for a
 * checkout already running. Returns the lock token and the sessions the lock
 * object holds; null when there is no PROMO binding (tests, or a relay without
 * Durable Objects: the KV marker alone, as before); "busy" when the other
 * checkout still holds it; "unavailable" when the object cannot be reached.
 */
async function takeCheckoutLock(env: Env, hash: string, kind: PurchaseKind):
    Promise<{ token: string; open: OpenSession[] } | null | "busy" | "unavailable"> {
    if (!env.PROMO) return null;
    // Counted in polls, not clock time, so a frozen clock can never spin here.
    for (let tries = 0; ; tries++) {
        let out: any;
        try {
            const res = await checkoutLockStub(env, hash, kind).fetch("https://promo.internal/cko/begin", { method: "POST" });
            out = await res.json();
        } catch (e) {
            console.warn("checkout: lock object unreachable, refusing", { error: cause(e) });
            return "unavailable";
        }
        if (out?.result === "go" && typeof out.token === "string") {
            return { token: out.token, open: parseOpen(JSON.stringify(Array.isArray(out.open) ? out.open : [])) };
        }
        if (tries >= CKO_LOCK_WAIT_MS / CKO_LOCK_POLL_MS) {
            console.warn("checkout: another checkout for this install still running, refusing", { kind });
            return "busy";
        }
        await new Promise(r => setTimeout(r, CKO_LOCK_POLL_MS));
    }
}

/** Release the lock, recording the session just made (if any) in the lock object. */
async function releaseCheckoutLock(env: Env, hash: string, kind: PurchaseKind, token: string, added?: OpenSession): Promise<void> {
    try {
        await checkoutLockStub(env, hash, kind).fetch("https://promo.internal/cko/end", {
            method: "POST",
            body: JSON.stringify({ token, ...(added ? { add: added, ttlMs: CKO_TTL_S * 1000 } : {}) })
        });
    } catch (e) {
        // The lock goes stale on its own (CKO_LOCK_STALE_MS); the KV marker
        // still holds the session for the locations that already see it.
        console.warn("checkout: lock release failed", { error: cause(e) });
    }
}

/** Empty the lock object's session list (a failed or cancelled payment). Best-effort. */
async function clearCheckoutLock(env: Env, hash: string, kind: PurchaseKind): Promise<void> {
    if (!env.PROMO) return;
    try {
        await checkoutLockStub(env, hash, kind).fetch("https://promo.internal/cko/clear", { method: "POST" });
    } catch (e) {
        // Not needed for safety: Dodo answers "ended" for that session anyway.
        console.warn("checkout: lock object clear failed", { error: cause(e) });
    }
}

/** Sessions from the lock object and the KV marker, newest first, each once. */
function mergeOpen(a: OpenSession[], b: OpenSession[]): OpenSession[] {
    const seen = new Set<string>();
    return [...a, ...b].sort((x, y) => y.at - x.at).filter(o => !seen.has(o.s) && !!seen.add(o.s));
}

async function createSessionLocked(
    env: Env, hash: string, productId: string, now: number, ip: string | null,
    from: "discord" | "installer", kind: PurchaseKind, locked: OpenSession[], made: { added?: OpenSession }
): Promise<Response> {
    // The sessions this install already opened for this kind (see CKO_WINDOW_MS):
    // the lock object's list (strongly consistent) and the KV marker (kept so
    // rows written before the lock existed still count).
    // FAIL CLOSED on a KV read error: without the list, a paid but unconfirmed
    // session could be sold again, and the rate counter below needs KV anyway.
    const ckoKey = checkoutOpenKey(hash, kind);
    let open: OpenSession[];
    try {
        open = mergeOpen(locked, parseOpen(await env.CODES.get(ckoKey))).slice(0, CKO_MAX);
    } catch (e) {
        console.warn("checkout: open session lookup failed, refusing", { error: cause(e) });
        return fail("checkout unavailable", 503);
    }
    for (const o of open) {
        const st = await sessionState(env, o.s);
        const young = now - o.at < CKO_WINDOW_MS;
        if (st === "paying") return fail("purchase_pending", 409);
        if (st === "unknown" && young) {
            console.warn("checkout: session status unknown inside the window, refusing", { session: o.s });
            return fail("purchase_pending", 409);
        }
        // A second click while the same unpaid checkout is fresh reopens it,
        // so the buyer never holds two payable sessions for the same thing.
        if (st === "open" && young && o.p === productId && o.f === from) return json({ ok: true, url: o.u });
    }
    const hour = Math.floor(now / HOUR_MS);
    try {
        if (ip && !(await underHourly(env, `rl:coip:${ipBucket(ip)}:${hour}`, CHECKOUT_IP_PER_HOUR))) {
            return fail("slow down", 429, HOUR_MS - (now % HOUR_MS));
        }
        if (!(await underHourly(env, `rl:co:${hash}:${hour}`, CHECKOUT_INSTALL_PER_HOUR))) {
            return fail("slow down", 429, HOUR_MS - (now % HOUR_MS));
        }
    } catch (e) {
        console.warn("checkout: rate counter failed", { error: cause(e) });
        return fail("checkout unavailable", 503);
    }

    const payload: Record<string, unknown> = {
        product_cart: [{ product_id: productId, quantity: 1 }],
        return_url: discordReturnUrl(env.CHECKOUT_RETURN_URL, from),
        feature_flags: { redirect_immediately: true },
        metadata: { install: hash }
    };

    let res: Response;
    try {
        res = await fetch(`${apiBase(env)}/checkouts`, {
            method: "POST",
            headers: { authorization: `Bearer ${env.DODO_API_KEY}`, "content-type": "application/json" },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.warn("checkout: dodo request failed", { error: cause(e) });
        return fail("checkout unavailable", 503);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
        console.warn("checkout: dodo refused", { status: res.status, body: text.slice(0, 200) });
        return fail("checkout unavailable", 503);
    }
    let out: any;
    try { out = JSON.parse(text); } catch { out = null; }
    const url = typeof out?.checkout_url === "string" ? out.checkout_url : "";
    const sessionId = typeof out?.session_id === "string" ? out.session_id : "";
    if (!/^https:\/\//.test(url)) {
        console.warn("checkout: dodo returned no checkout_url", { status: res.status });
        return fail("checkout unavailable", 503);
    }
    if (sessionId) {
        try {
            await env.CODES.put(`checkout:${sessionId}`, hash, { expirationTtl: CHECKOUT_TTL_S });
        } catch (e) {
            // Metadata still carries the hash; the session row is only the fallback join.
            console.warn("checkout: session row write failed", { error: cause(e) });
        }
    }
    if (sessionId) {
        // FAIL OPEN on this write: the buyer already holds a valid session,
        // the lock object records it too (createSession), and the buying: row
        // from the first webhook still guards a repeat.
        made.added = { s: sessionId, u: url, p: productId, f: from, at: now };
        const next = [made.added, ...open].slice(0, CKO_MAX);
        try {
            await env.CODES.put(ckoKey, JSON.stringify(next), { expirationTtl: CKO_TTL_S });
        } catch (e) {
            console.warn("checkout: open session row write failed", { error: cause(e) });
        }
    }
    return json({ ok: true, url });
}

/** `cko:<hash>:<kind>`: the checkout sessions recently opened (see CKO_WINDOW_MS). */
export function checkoutOpenKey(hash: string, kind: PurchaseKind): string {
    return `cko:${hash}:${kind}`;
}

interface OpenSession { s: string; u: string; p: string; f: string; at: number }

function parseOpen(raw: string | null): OpenSession[] {
    if (!raw) return [];
    let v: unknown;
    try { v = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(v)) return [];
    return v.filter((o: any): o is OpenSession =>
        !!o && typeof o.s === "string" && o.s !== "" && typeof o.u === "string" && /^https:\/\//.test(o.u)
        && typeof o.p === "string" && typeof o.f === "string" && typeof o.at === "number"
    ).slice(0, CKO_MAX);
}

/** IntentStatus values that mean money is moving or has moved: never sell again. */
const PAYING = new Set([
    "succeeded", "processing", "requires_customer_action", "requires_merchant_action",
    "requires_capture", "partially_captured", "partially_captured_and_capturable"
]);
/** A payment not yet made: the session is still open and does not block. */
const NOT_PAYING = new Set(["requires_payment_method", "requires_confirmation"]);
/** A payment that is over without money: does not block. */
const ENDED = new Set(["failed", "cancelled"]);

/**
 * How a checkout session stands, from Dodo's GET /checkouts/{id}:
 * "paying" (block), "open" (no payment yet: reusable), "ended" (failed,
 * cancelled, or 404: the session is gone and cannot be paid), or "unknown"
 * (Dodo unreachable, refused, or a status this code does not know; the caller
 * time-boxes it). Never throws; never logs the API key.
 */
async function sessionState(env: Env, sessionId: string): Promise<"paying" | "open" | "ended" | "unknown"> {
    let res: Response;
    try {
        res = await fetch(`${apiBase(env)}/checkouts/${encodeURIComponent(sessionId)}`, {
            method: "GET",
            headers: { authorization: `Bearer ${env.DODO_API_KEY}` }
        });
    } catch (e) {
        console.warn("checkout: dodo session status request failed", { error: cause(e) });
        return "unknown";
    }
    if (res.status === 404) return "ended";
    const text = await res.text().catch(() => "");
    if (!res.ok) {
        console.warn("checkout: dodo session status refused", { status: res.status, body: text.slice(0, 200) });
        return "unknown";
    }
    let out: any;
    try { out = JSON.parse(text); } catch { out = undefined; }
    if (!out || typeof out !== "object") {
        console.warn("checkout: dodo session status unreadable", { status: res.status });
        return "unknown";
    }
    const st = out.payment_status;
    if (st === null || st === undefined) return "open";
    if (typeof st === "string") {
        if (PAYING.has(st)) return "paying";
        if (NOT_PAYING.has(st)) return "open";
        if (ENDED.has(st)) return "ended";
    }
    console.warn("checkout: dodo session status not known", { status: String(st).slice(0, 40) });
    return "unknown";
}

/* --------------------------------------------------------------- linking -- */

/** Which kind of purchase a payment or subscription event is about. */
export type PurchaseKind = "ai" | "automatic";

/**
 * `buying:<hash>:<kind>` → {plan, at}: a purchase of this kind is on its way for
 * this install. Written from the first payment or subscription event that names
 * the install, so a second checkout for the same kind is refused with 409
 * purchase_pending until it switches on (see handleCheckoutV2). Kept as long as
 * the inst: rows; a failed or cancelled payment removes it.
 */
export function buyingKey(hash: string, kind: PurchaseKind): string {
    return `buying:${hash}:${kind}`;
}

/** Events that end a purchase attempt without a purchase. */
const PURCHASE_ENDED = new Set([
    "payment.failed", "payment.cancelled", "subscription.failed", "subscription.cancelled", "subscription.expired"
]);

/** Dunning: a renewal could not be charged. On a subscription that was already
 *  live (it has a key) this is a lapse, not a purchase on its way: nothing will
 *  switch on by itself until the card is fixed, so the buyer must not be told
 *  "still being confirmed" (409 purchase_pending). On a subscription that never
 *  went live (no key yet: a mandate still being set up) it stays pending. */
const SUB_DUNNING_EVENTS = new Set(["subscription.on_hold", "subscription.past_due", "subscription.paused"]);

function purchaseKind(env: Env, name: string, data: any): { kind: PurchaseKind; plan: string | null } {
    const pid = typeof data?.product_id === "string" ? data.product_id
        : Array.isArray(data?.product_cart) && typeof data.product_cart[0]?.product_id === "string" ? data.product_cart[0].product_id
        : "";
    const plan = pid ? variantConfig(env, pid).plan ?? null : null;
    const isSub = name.startsWith("subscription.") || (typeof data?.subscription_id === "string" && data.subscription_id !== "");
    return { kind: isSub || plan === "monthly" || plan === "annual" ? "ai" : "automatic", plan };
}

/**
 * A payment.* or subscription.* event: record which install it belongs to and,
 * if the key already exists, hand it to that install.
 *
 * THROWS ON A KV FAILURE, on purpose. This is the only place a one-time
 * purchase learns its install (only payment.succeeded carries the metadata),
 * so a write that fails here must make the webhook answer 500 and Dodo retry
 * (every write is an idempotent overwrite). Swallowing it once left a paid
 * buyer with nothing switched on. A missing or malformed install hash is not a
 * failure: there is simply nothing to link.
 */
export async function linkFromLifecycle(env: Env, name: string, data: any): Promise<void> {
    try {
        let hash: string | null = null;
        const meta = data?.metadata?.install;
        if (typeof meta === "string" && HASH_RE.test(meta)) hash = meta;
        else if (name.startsWith("payment.") && typeof data?.checkout_session_id === "string" && data.checkout_session_id) {
            const row = await env.CODES.get(`checkout:${data.checkout_session_id}`);
            if (row && HASH_RE.test(row)) hash = row;
        }
        if (!hash) return;
        const { kind, plan } = purchaseKind(env, name, data);
        const subId = typeof data?.subscription_id === "string" ? data.subscription_id : "";
        const lapsed = SUB_DUNNING_EVENTS.has(name) && subId !== "" && (await env.CODES.get(`order:${subId}`)) !== null;
        if (PURCHASE_ENDED.has(name) || lapsed) {
            await env.CODES.delete(buyingKey(hash, kind));
            // The attempt is over: its checkout-open row must not hold a retry.
            if (PURCHASE_ENDED.has(name)) {
                await env.CODES.delete(checkoutOpenKey(hash, kind));
                await clearCheckoutLock(env, hash, kind);
            }
        } else await env.CODES.put(buyingKey(hash, kind), JSON.stringify({ plan, at: Date.now() }), { expirationTtl: INST_TTL_S });
        const ids = [data?.payment_id, data?.subscription_id]
            .filter((x: unknown): x is string => typeof x === "string" && x !== "");
        for (const id of ids) await env.CODES.put(`inst:${id}`, hash, { expirationTtl: INST_TTL_S });
        // Look for the key, then once more: license_key.created may be running
        // at the same moment, have read inst: before we wrote it, and written
        // order: after our first look. The same double-check as the pending
        // fold in applyLifecycle. (KV lag can still hide it for a while; the
        // other side's own re-read covers the reverse order.)
        for (let pass = 0; pass < 2; pass++) {
            for (const id of ids) {
                const key = await env.CODES.get(`order:${id}`);
                if (key) { await env.CODES.put(`paid:${hash}`, key, { expirationTtl: PAID_TTL_S }); return; }
            }
        }
    } catch (e) {
        console.warn("purchase link (lifecycle) failed, webhook will be retried", { event: name, error: cause(e) });
        throw e;
    }
}

/**
 * license_key.created: if an install is already known for this purchase, hand
 * it the key. THROWS ON A KV FAILURE (see linkFromLifecycle), so the webhook
 * answers 500 and Dodo retries; the key itself never reaches a log line.
 */
export async function linkFromKey(env: Env, key: string, joinIds: string[]): Promise<void> {
    try {
        // Called after the order: rows are written. Look for the install, then
        // once more, in case a concurrent payment/subscription event wrote
        // inst: just after our first look (and missed our order: row).
        for (let pass = 0; pass < 2; pass++) {
            for (const id of joinIds) {
                const hash = await env.CODES.get(`inst:${id}`);
                if (hash && HASH_RE.test(hash)) {
                    await env.CODES.put(`paid:${hash}`, key, { expirationTtl: PAID_TTL_S });
                    return;
                }
            }
        }
    } catch (e) {
        const msg = key ? cause(e).split(key).join("<redacted>") : cause(e);
        console.warn("purchase link (key) failed, webhook will be retried", { error: msg });
        throw e;
    }
}

/**
 * A refund or a lost dispute: the purchase it paid for is over, so a new one
 * of either kind may be bought from that install at once. Best-effort: a
 * failure only keeps the pending marker until it expires.
 */
export async function clearBuying(env: Env, paymentId: string): Promise<void> {
    if (!paymentId) return;
    try {
        const hash = await env.CODES.get(`inst:${paymentId}`);
        if (!hash || !HASH_RE.test(hash)) return;
        await env.CODES.delete(buyingKey(hash, "ai"));
        await env.CODES.delete(buyingKey(hash, "automatic"));
    } catch (e) {
        console.warn("purchase pending marker clear failed", { error: cause(e) });
    }
}

/* -------------------------------------------------------- purchase status -- */

/**
 * PUBLIC PURCHASE STATUS (R7) for the site's thanks page:
 *   GET /v1/purchase-status?payment_id=pay_…   or   ?subscription_id=sub_…
 *   → 200 {"state":"active"|"pending"|"failed"|"unknown"}
 *
 * Built only from what the webhooks already wrote; Dodo is never called (no
 * API key use from a public endpoint, and the webhook data answers it):
 *   1. `order:<id>` → key (license_key.created). Its code live (active, not
 *      terminal, not past expiry) → "active". A code that exists but is dead
 *      (refunded, revoked, an unmapped product) → "unknown": the buyer is
 *      never told a payment failed when it did not.
 *   2. Otherwise `pst:<id>` (recordPurchaseState): paid or pending →
 *      "pending" (the key is still on its way), failed → "failed".
 *   3. Nothing → "unknown" (no webhook yet, or a mistyped id).
 * At most two KV reads. KV is eventually consistent and caches a miss for up to
 * ~60 s per location, so "pending" can lag the webhook by about a minute.
 *
 * No personal data: no key, email, plan, amount or install is ever returned.
 * Strict input: exactly one of the two ids, Dodo's prefix plus 8 to 64 letters
 * or digits; anything else is 400 before any read. Rate-limited per address
 * (PURCHASE_STATUS_PER_MINUTE, an in-memory counter in a Promo object named for
 * the address and the minute). CORS for the site's origins only.
 */
export const PURCHASE_STATUS_PER_MINUTE = 120;
export const SITE_ORIGINS = ["https://subline.page", "https://surfer05.github.io"];
const PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{8,64}$/;
const SUBSCRIPTION_ID_RE = /^sub_[A-Za-z0-9]{8,64}$/;
/** Webhook evidence for a payment or subscription id; same life as the inst: rows. */
export const PST_TTL_S = INST_TTL_S;

type PstState = "paid" | "pending" | "failed";
/** The events that say how a payment or a first subscription stands. Others write nothing. */
const PST_FOR: Record<string, PstState> = {
    "payment.succeeded": "paid",
    "payment.processing": "pending",
    "payment.failed": "failed",
    "payment.cancelled": "failed",
    "subscription.active": "paid",
    "subscription.failed": "failed"
};
/** paid > failed > pending: a late or replayed event never moves a state backwards
 *  (a failed renewal never marks a paid subscription failed). */
const PST_RANK: Record<PstState, number> = { pending: 0, failed: 1, paid: 2 };

/**
 * Remember how a payment or subscription stands, for GET /v1/purchase-status.
 * One read and at most one write per id, only for the events in PST_FOR.
 * Best-effort: a failure only leaves the thanks page on "unknown"; it never
 * fails the webhook.
 */
export async function recordPurchaseState(env: Env, name: string, data: any): Promise<void> {
    const next = PST_FOR[name];
    if (!next) return;
    const ids = [data?.payment_id, data?.subscription_id]
        .filter((x: unknown): x is string => typeof x === "string" && (PAYMENT_ID_RE.test(x) || SUBSCRIPTION_ID_RE.test(x)));
    for (const id of new Set(ids)) {
        try {
            const prev = await env.CODES.get(`pst:${id}`) as PstState | null;
            if (prev && prev in PST_RANK && PST_RANK[prev] >= PST_RANK[next]) continue;
            await env.CODES.put(`pst:${id}`, next, { expirationTtl: PST_TTL_S });
        } catch (e) {
            console.warn("purchase state write failed", { event: name, error: cause(e) });
        }
    }
}

function siteCors(req: Request): Record<string, string> {
    const origin = req.headers.get("origin") || "";
    return {
        vary: "Origin",
        ...(SITE_ORIGINS.includes(origin) ? { "access-control-allow-origin": origin } : {})
    };
}

/** GET (and OPTIONS) /v1/purchase-status. */
export async function handlePurchaseStatus(req: Request, env: Env, now: number = Date.now()): Promise<Response> {
    const cors = siteCors(req);
    const answer = (body: Record<string, unknown>, status: number, cache: string, extra: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": cache, ...cors, ...extra } });
    if (req.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: { ...cors, "access-control-allow-methods": "GET", "access-control-max-age": "86400" }
        });
    }
    if (req.method !== "GET") return answer({ state: "unknown", error: "method not allowed" }, 405, "no-store", { allow: "GET, OPTIONS" });

    const q = new URL(req.url).searchParams;
    const pays = q.getAll("payment_id"), subs = q.getAll("subscription_id");
    let id = "";
    if (pays.length === 1 && subs.length === 0 && PAYMENT_ID_RE.test(pays[0]!)) id = pays[0]!;
    else if (subs.length === 1 && pays.length === 0 && SUBSCRIPTION_ID_RE.test(subs[0]!)) id = subs[0]!;
    if (!id) return answer({ state: "unknown", error: "bad request" }, 400, "no-store");

    const ip = req.headers.get("cf-connecting-ip");
    if (ip && env.PROMO) {
        const minute = Math.floor(now / 60_000);
        let allowed = true;
        try {
            const stub = env.PROMO.get(env.PROMO.idFromName(`ps:${ipBucket(ip)}:${minute}`));
            const out = await (await stub.fetch("https://promo.internal/rl/hit", {
                method: "POST", body: JSON.stringify({ limit: PURCHASE_STATUS_PER_MINUTE })
            })).json() as { allowed?: unknown };
            allowed = out.allowed === true;
        } catch (e) {
            // FAIL OPEN: a read-only answer with no personal data; a limiter
            // outage must not leave every buyer's thanks page on "unknown".
            console.warn("purchase status: rate limiter unreachable, allowing", { error: cause(e) });
        }
        if (!allowed) {
            const wait = 60_000 - (now % 60_000);
            return answer({ state: "unknown", error: "slow down", retryAfterMs: wait }, 429, "no-store",
                { "retry-after": String(Math.ceil(wait / 1000)) });
        }
    }

    let state: "active" | "pending" | "failed" | "unknown" = "unknown";
    try {
        const key = await env.CODES.get(`order:${id}`);
        if (key) {
            const { rec } = await followReissue(env, key);
            const live = !!rec && rec.status === "active" && !rec.terminal && !(rec.expiresAt && now > rec.expiresAt);
            state = live ? "active" : "unknown";
        } else {
            const pst = await env.CODES.get(`pst:${id}`);
            state = pst === "paid" || pst === "pending" ? "pending" : pst === "failed" ? "failed" : "unknown";
        }
    } catch (e) {
        console.warn("purchase status: lookup failed", { error: cause(e) });
        return answer({ state: "unknown", error: "temporarily unavailable" }, 503, "no-store");
    }
    // "active" is settled; the rest can still move ("failed" too: a
    // subscription retried after a failed first payment), so only for a poll.
    const cache = state === "active" ? "public, max-age=300" : "public, max-age=3";
    return answer({ state }, 200, cache);
}

/**
 * The purchase waiting for this free_ bearer, if any: the key and its plan,
 * only while that code is live. Read-only, and never throws (status must not
 * fail because of it).
 */
export async function purchaseFor(env: Env, bearer: string, now: number): Promise<{ code: string; plan: CodeRecord["plan"] } | null> {
    try {
        const key = await env.CODES.get(`paid:${await installHash(bearer)}`);
        if (!key) return null;
        const raw = await env.CODES.get(`code:${key}`);
        if (!raw) return null;
        const rec = JSON.parse(raw) as CodeRecord;
        if (rec.status !== "active" || rec.terminal) return null;
        if (rec.expiresAt && now > rec.expiresAt) return null;
        return { code: key, plan: rec.plan ?? "free" };
    } catch (e) {
        console.warn("purchase lookup failed", { error: cause(e) });
        return null;
    }
}

/* --------------------------------------------------------------- coupons -- */

/** The random suffix alphabet: no 0/O/1/I, so a code read aloud or typed is unambiguous. */
export const COUPON_SUFFIX_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const COUPON_SUFFIX_LEN = 5;
/** Dodo's DiscountResponse documents codes of up to 16 characters. */
export const COUPON_MAX_LEN = 16;

/** `n` characters from COUPON_SUFFIX_ALPHABET, crypto RNG, unbiased (rejection sampling). */
export function randomSuffix(n: number = COUPON_SUFFIX_LEN): string {
    const A = COUPON_SUFFIX_ALPHABET;
    const limit = 256 - (256 % A.length); // bytes at or above this would bias the modulo
    let out = "";
    const buf = new Uint8Array(16);
    while (out.length < n) {
        crypto.getRandomValues(buf);
        for (const b of buf) {
            if (b >= limit) continue;
            out += A[b % A.length];
            if (out.length === n) break;
        }
    }
    return out;
}

/**
 * A personal coupon code: the name (uppercase letters and digits, cut to fit)
 * plus a random 5-character suffix, at most 16 in all, e.g. RAHUL05K7Q2M. The
 * name keeps it personal; the suffix stops anyone guessing a friend's code from
 * their name. The name part must still be at least 3 characters (null
 * otherwise, which the endpoint answers with 400).
 */
export function couponCode(name: unknown, suffix: string = randomSuffix()): string | null {
    if (typeof name !== "string") return null;
    const base = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, COUPON_MAX_LEN - COUPON_SUFFIX_LEN);
    return base.length >= 3 ? base + suffix : null;
}

/** POST /admin/coupon body handler (auth already checked by the router). */
export async function createCoupon(env: Env, body: any): Promise<Response> {
    const code = couponCode(body?.name);
    if (!code) return fail("bad request", 400);
    if (!env.DODO_API_KEY) return fail("coupons unavailable", 503);
    const monthly = productFor(env, "monthly");
    if (!monthly) return fail("coupons unavailable", 503);
    let res: Response;
    try {
        res = await fetch(`${apiBase(env)}/discounts`, {
            method: "POST",
            headers: { authorization: `Bearer ${env.DODO_API_KEY}`, "content-type": "application/json" },
            body: JSON.stringify({
                type: "percentage",
                amount: 10_000,             // basis points: 100% off
                code,
                name: String(body.name).slice(0, 100),
                restricted_to: [monthly],
                subscription_cycles: 3,
                usage_limit: 1
            })
        });
    } catch (e) {
        return fail(`dodo request failed: ${cause(e)}`, 502);
    }
    const text = await res.text().catch(() => "");
    let out: any;
    try { out = JSON.parse(text); } catch { out = null; }
    if (!res.ok) {
        const msg = typeof out?.message === "string" ? out.message : text;
        return fail(`dodo ${res.status}: ${msg.slice(0, 200)}`, 502);
    }
    return json({ ok: true, code: typeof out?.code === "string" ? out.code : code, discount_id: out?.discount_id });
}
