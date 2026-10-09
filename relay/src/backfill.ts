/**
 * POST /admin/backfill-orders — fill missing `order:<payment_id>` rows from
 * Dodo's records (ADMIN_TOKEN; the Dodo key never leaves the relay).
 *
 * Codes made while license_key.created carried no payment id have no payment
 * index, so a refund or dispute could not find them and the thanks page said
 * "unknown". This walks Dodo's succeeded payments one page per call, asks Dodo
 * which license key each payment issued (orders.ts), and points the missing
 * row at that code through indexPayment (never retargets a row, never
 * touches a code recorded under another payment, never writes order:<sub_id>).
 *
 * Body: { apply?: boolean, page?: number, pageSize?: number (1..100, default 20) }.
 * DRY RUN unless apply === true: nothing is written. The answer is counts
 * only, never a key or a payment id, plus nextPage (null after the last page).
 * One page per call keeps each call well inside the Worker's subrequest limit;
 * scripts/backfill-orders.mjs loops the pages.
 */
import { followReissue, indexPayment, type Env, type IndexResult } from "./codes";
import { keysOfCustomer, succeededPayments, type IssuedKey, type Lookup } from "./orders";

export interface BackfillCounts {
    payments: number;
    withLicenseKey: number;
    alreadyIndexed: number;
    indexed: number;
    conflict: number;
    noCode: number;
    notFoundAtDodo: number;
    dodoUnavailable: number;
    /** A fully refunded payment whose code still works (report only). */
    refundedButLive: number;
}

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function backfillOrders(env: Env, body: any): Promise<Response> {
    const dryRun = body?.apply !== true;
    const page = Number.isInteger(body?.page) && body.page >= 0 ? body.page : 0;
    const pageSize = Number.isInteger(body?.pageSize) && body.pageSize >= 1 && body.pageSize <= 100 ? body.pageSize : 20;
    if (!env.DODO_API_KEY) return json({ ok: false, error: "dodo api key not set" }, 503);
    const list = await succeededPayments(env, page, pageSize);
    if (!list.ok) return json({ ok: false, error: `dodo ${list.reason}` }, 503);

    const c: BackfillCounts = {
        payments: 0, withLicenseKey: 0, alreadyIndexed: 0, indexed: 0, conflict: 0,
        noCode: 0, notFoundAtDodo: 0, dodoUnavailable: 0, refundedButLive: 0
    };
    const byCustomer = new Map<string, Lookup<IssuedKey[]>>();
    // Read-only (authCode could fold a pending row, a write in a dry run).
    const now = Date.now();
    const refundedLive = async (key: string) => {
        const { rec } = await followReissue(env, key);
        return !!rec && rec.status === "active" && !rec.terminal && !(rec.expiresAt && now > rec.expiresAt);
    };

    for (const p of list.value) {
        const payId = typeof p?.payment_id === "string" ? p.payment_id : "";
        if (!payId) continue;
        c.payments++;
        if (p?.has_license_key === false) continue;
        c.withLicenseKey++;
        const fullRefund = p?.refund_status === "full";
        const existing = await env.CODES.get(`order:${payId}`);
        if (existing !== null) {
            c.alreadyIndexed++;
            if (fullRefund && await refundedLive(existing)) c.refundedButLive++;
            continue;
        }
        const cid = typeof p?.customer?.customer_id === "string" ? p.customer.customer_id : "";
        if (!cid) { c.notFoundAtDodo++; continue; }
        let keys = byCustomer.get(cid);
        // Both sources (grants and the deprecated key list): a key issued before
        // Entitlements may be on the list alone.
        if (!keys) { keys = await keysOfCustomer(env, cid, () => false); byCustomer.set(cid, keys); }
        if (!keys.ok) { c.dodoUnavailable++; continue; }
        const mine = keys.value.filter(k => k.paymentId === payId);
        if (mine.length === 0) { c.notFoundAtDodo++; continue; }
        for (const k of mine) {
            const res: IndexResult = await indexPayment(env, payId, k.key, { dryRun });
            if (res === "indexed") c.indexed++;
            else if (res === "exists") c.alreadyIndexed++;
            else if (res === "conflict") c.conflict++;
            else c.noCode++;
            if ((res === "indexed" || res === "exists") && fullRefund && await refundedLive(k.key)) c.refundedButLive++;
        }
    }
    return json({
        ok: true, dryRun, page, pageSize,
        nextPage: list.value.length === pageSize ? page + 1 : null,
        counts: c
    });
}
