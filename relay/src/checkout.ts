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
import { ipBucket, isNewClient, isTasteBearer, variantConfig, type CodeRecord, type Env } from "./codes";
import { installOf, isApiV2, resolveEntitlement } from "./entitle";

export const DEFAULT_DODO_API_BASE = "https://live.dodopayments.com";
export const DEFAULT_CHECKOUT_RETURN_URL = "https://surfer05.github.io/subline/";

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
 */
export const AUTOMATIC_PRODUCT_PLACEHOLDER = "pdt_AUTOMATIC_PENDING";

/** Session rows only need to outlive the session itself (24 h by default). */
export const CHECKOUT_TTL_S = 2 * 86_400;
/** Same lifetime as the webhook pending rows: bridges out-of-order delivery. */
export const INST_TTL_S = 3 * 86_400;
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
    let body: any;
    try { body = JSON.parse(await req.text()); } catch { return fail("bad request", 400); }
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
    let body: any;
    try { body = JSON.parse(await req.text()); } catch { return fail("bad request", 400); }
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
    if (plan !== "automatic" && !r.automatic) return fail("automatic_required", 403);
    // The installer asks to come back to a "go back to the installer" page.
    const from = body?.return === "installer" ? "installer" : "discord";
    return createSession(env, r.hash, productId, now, req.headers.get("cf-connecting-ip"), from);
}

/**
 * Rate-limit, then ask Dodo for a checkout session tied to this install hash.
 * Shared by the legacy and the v2 checkout.
 */
async function createSession(
    env: Env, hash: string, productId: string, now: number, ip: string | null, from: "discord" | "installer" = "discord"
): Promise<Response> {
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
    return json({ ok: true, url });
}

/* --------------------------------------------------------------- linking -- */

/**
 * A payment.* or subscription.* event: record which install it belongs to and,
 * if the key already exists, hand it to that install. Never throws.
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
        console.warn("purchase link (lifecycle) failed", { error: cause(e) });
    }
}

/** license_key.created: if an install is already known for this purchase, hand it the key. Never throws. */
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
        console.warn("purchase link (key) failed", { error: cause(e) });
    }
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
