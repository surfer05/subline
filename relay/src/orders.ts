/**
 * PAYMENT → LICENSE KEY, FROM DODO'S OWN RECORDS.
 *
 * Why this exists. Refunds and disputes name only a payment id, so every code
 * must be reachable as `order:<payment_id>` (codes.ts REVERSE-INDEX SCHEME).
 * That row is written from license_key.created's `data.payment_id`. Dodo
 * types that field as optional and nullable ("the payment associated with
 * the license key, if any": dodopayments-typescript src/resources/
 * license-keys.ts, LicenseKey.payment_id?: string | null), and keys are now
 * issued through Entitlements, whose grant carries the payment id on its
 * own. When the webhook has no payment id, these reads find it from Dodo.
 *
 * DODO CALLS USED (Bearer DODO_API_KEY, base DODO_API_BASE; all GET, read-only):
 *   • GET /payments/{payment_id} → Payment { customer: { customer_id },
 *     subscription_id? } (docs: api-reference/payments/get-payments-1;
 *     SDK payments.retrieve).
 *   • GET /customers/{customer_id}/entitlement-grants?integration_type=license_key
 *     &page_size=100&page_number=N → { items: EntitlementGrant[] }, each with
 *     payment_id?, subscription_id?, license_key?: { id, key, ... } (docs:
 *     api-reference/entitlements/list-customer-grants; SDK
 *     customers.listEntitlementGrants). Grants of every status are read: a
 *     refund revokes the grant at Dodo before our refund webhook lands.
 *   • GET /license_keys?customer_id=… &page_size=100&page_number=N →
 *     { items: LicenseKey[] } with key, id, payment_id? (docs:
 *     api-reference/licenses/list-license-keys; deprecated but documented).
 *     Only a second source, read when the grants did not answer.
 *   • GET /payments?status=succeeded&page_size=&page_number= → { items:
 *     PaymentListResponse[] } with payment_id, customer, has_license_key,
 *     refund_status? (docs: api-reference/payments/get-payments). Backfill only.
 *
 * Every function here NEVER throws and NEVER logs a key or the API key. The
 * caller decides what an unavailable answer means.
 */
import type { Env } from "./codes";
import { DEFAULT_DODO_API_BASE } from "./checkout";

export type Lookup<T> = { ok: true; value: T } | { ok: false; reason: "not_configured" | "unavailable" };

/** One license key Dodo issued, with the purchase that issued it. */
export interface IssuedKey {
    key: string;
    keyId: string;
    paymentId: string;
    subscriptionId: string;
}

const MAX_PAGES = 10;
const PAGE_SIZE = 100;

function base(env: Env): string {
    return (env.DODO_API_BASE || DEFAULT_DODO_API_BASE).replace(/\/+$/, "");
}

function cause(e: unknown): string {
    return String((e as any)?.message ?? e).slice(0, 200);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** GET a Dodo path. 404 → null; any other failure → "unavailable". */
async function dodoGet(env: Env, path: string): Promise<any | null | "unavailable"> {
    let res: Response;
    try {
        res = await fetch(`${base(env)}${path}`, { method: "GET", headers: { authorization: `Bearer ${env.DODO_API_KEY}` } });
    } catch (e) {
        console.warn("dodo lookup failed", { path: path.split("?")[0]!.slice(0, 80), error: cause(e) });
        return "unavailable";
    }
    if (res.status === 404) return null;
    if (!res.ok) {
        console.warn("dodo lookup refused", { path: path.split("?")[0]!.slice(0, 80), status: res.status });
        return "unavailable";
    }
    try { return await res.json(); } catch {
        console.warn("dodo lookup unreadable", { path: path.split("?")[0]!.slice(0, 80) });
        return "unavailable";
    }
}

/** Every page of a Dodo list endpoint ({ items: [] }), bounded. */
async function dodoList(env: Env, path: string): Promise<any[] | null | "unavailable"> {
    const out: any[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
        const sep = path.includes("?") ? "&" : "?";
        const body = await dodoGet(env, `${path}${sep}page_size=${PAGE_SIZE}&page_number=${page}`);
        if (body === "unavailable") return "unavailable";
        if (body === null) return page === 0 ? null : out;
        const items = Array.isArray(body?.items) ? body.items : [];
        out.push(...items);
        if (items.length < PAGE_SIZE) break;
    }
    return out;
}

/** The customer (and subscription, if any) behind a payment. */
export async function paymentInfo(env: Env, paymentId: string): Promise<Lookup<{ customerId: string; subscriptionId: string } | null>> {
    if (!env.DODO_API_KEY) return { ok: false, reason: "not_configured" };
    const p = await dodoGet(env, `/payments/${encodeURIComponent(paymentId)}`);
    if (p === "unavailable") return { ok: false, reason: "unavailable" };
    if (p === null || str(p?.payment_id) !== paymentId) return { ok: true, value: null };
    const customerId = str(p?.customer?.customer_id);
    return { ok: true, value: customerId ? { customerId, subscriptionId: str(p?.subscription_id) } : null };
}

/**
 * Every license key Dodo issued to a customer, with its payment. From the
 * customer's license-key grants; the legacy key list is read too when the
 * grants are missing or carry no payment id, so either source is enough.
 */
export async function keysOfCustomer(env: Env, customerId: string): Promise<Lookup<IssuedKey[]>> {
    if (!env.DODO_API_KEY) return { ok: false, reason: "not_configured" };
    const cid = encodeURIComponent(customerId);
    const found = new Map<string, IssuedKey>();
    const add = (key: string, keyId: string, paymentId: string, subscriptionId: string) => {
        if (!key) return;
        const prev = found.get(key);
        found.set(key, {
            key,
            keyId: prev?.keyId || keyId,
            paymentId: prev?.paymentId || paymentId,
            subscriptionId: prev?.subscriptionId || subscriptionId
        });
    };
    const grants = await dodoList(env, `/customers/${cid}/entitlement-grants?integration_type=license_key`);
    if (Array.isArray(grants)) {
        for (const g of grants) {
            if (g?.integration_type !== undefined && g.integration_type !== "license_key") continue;
            add(str(g?.license_key?.key), str(g?.license_key?.id), str(g?.payment_id), str(g?.subscription_id));
        }
    }
    const complete = Array.isArray(grants) && found.size > 0 && [...found.values()].every(k => k.paymentId || k.subscriptionId);
    let legacy: any[] | null | "unavailable" = null;
    if (!complete) {
        legacy = await dodoList(env, `/license_keys?customer_id=${cid}`);
        if (Array.isArray(legacy)) {
            for (const k of legacy) add(str(k?.key), str(k?.id), str(k?.payment_id), str(k?.subscription_id));
        }
    }
    // Unavailable when the grants could not be read and the key list did not
    // answer either: "Dodo has no key" must never be concluded from an outage.
    if (grants === "unavailable" && !Array.isArray(legacy)) return { ok: false, reason: "unavailable" };
    if (!complete && legacy === "unavailable") return { ok: false, reason: "unavailable" };
    return { ok: true, value: [...found.values()] };
}

/** The keys a payment paid for (normally one). Empty when Dodo has none. */
export async function keysForPayment(env: Env, paymentId: string, customerId?: string): Promise<Lookup<string[]>> {
    if (!env.DODO_API_KEY) return { ok: false, reason: "not_configured" };
    if (!paymentId) return { ok: true, value: [] };
    let cid = customerId || "";
    if (!cid) {
        const info = await paymentInfo(env, paymentId);
        if (!info.ok) return info;
        if (!info.value) return { ok: true, value: [] };
        cid = info.value.customerId;
    }
    const keys = await keysOfCustomer(env, cid);
    if (!keys.ok) return keys;
    return { ok: true, value: keys.value.filter(k => k.paymentId === paymentId).map(k => k.key) };
}

/** The payment that issued `key` (matched by key string or key id). Null when Dodo has none. */
export async function paymentForKey(env: Env, key: string, keyId: string, customerId: string): Promise<Lookup<string | null>> {
    if (!env.DODO_API_KEY) return { ok: false, reason: "not_configured" };
    if (!customerId) return { ok: true, value: null };
    const keys = await keysOfCustomer(env, customerId);
    if (!keys.ok) return keys;
    const hit = keys.value.find(k => k.key === key || (!!keyId && k.keyId === keyId));
    return { ok: true, value: hit?.paymentId || null };
}

/** One page of succeeded payments (backfill). Null past the last page. */
export async function succeededPayments(env: Env, page: number, pageSize: number): Promise<Lookup<any[]>> {
    if (!env.DODO_API_KEY) return { ok: false, reason: "not_configured" };
    const body = await dodoGet(env, `/payments?status=succeeded&page_size=${pageSize}&page_number=${page}`);
    if (body === "unavailable") return { ok: false, reason: "unavailable" };
    return { ok: true, value: Array.isArray(body?.items) ? body.items : [] };
}
