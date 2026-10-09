import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMorEvent, authCode, type Env } from "../src/codes";
import { installHash } from "../src/checkout";
import { codeRec, fakeBudget, fakeKV } from "./kv-mock";
import worker from "../src/index";

// ===========================================================================
//  THE PAYMENT-ID INDEX (order:<payment_id>) for one-time Automatic codes.
//
//  Live bug 2026-10-08: a real Automatic purchase left no order:<payment_id>
//  row, so refunds/disputes could not revoke it and purchase-status said
//  "unknown". Dodo types LicenseKey.payment_id as optional and nullable
//  ("if any"), and keys are issued through Entitlements, whose grant carries
//  the payment id. Payload shapes below are copied from Dodo's own types and
//  docs (dodopayments-typescript src/resources/{license-keys,payments,
//  refunds}.ts; docs.dodopayments.com developer-resources/webhooks/intents/
//  entitlement-grant and api-reference/entitlements/list-customer-grants).
//  Every value is a fake of the real shape; no real key or id is used.
// ===========================================================================

const VARIANTS = {
    pdt_0TestAutomatic00001: { plan: "automatic", dailyCap: 5 },
    pdt_0TestMonthly000001: { plan: "monthly", dailyCap: 2000 }
};
const AUTO = "pdt_0TestAutomatic00001";
const MONTH = "pdt_0TestMonthly000001";
const KEY = "LK-TEST-AUTO-0001";
const KEY_AI = "LK-TEST-AI-0001";
const PAY = "pay_0TestE3PpoqDs847SOh001";
const PAY_AI = "pay_0TestAiFirst000000001";
const SUB = "sub_0TestDijZQ0oOEtENb001";
const CUS = "cus_0TestCustomer0000001";
const SESSION = "cks_0TestSession00000001";
const FREE = "free_" + "c".repeat(32);
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

const env = (kv: any, over: Partial<Env> = {}): Env => ({
    CODES: kv, GROQ_KEY: "x", ADMIN_TOKEN: "admintok", MODEL: "m",
    BUDGET: fakeBudget().ns, VARIANTS, DODO_API_KEY: "dodo_test_key", ...over
});
const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

// --- Dodo payloads (real shapes) ------------------------------------------
/** license_key.created: data is a LicenseKey (SDK LicenseKeyCreatedWebhookEvent). */
const licenseKeyCreated = (over: Record<string, unknown> = {}) => ({
    business_id: "bus_0TestBusiness000001",
    type: "license_key.created",
    timestamp: iso(NOW),
    data: {
        payload_type: "LicenseKey",
        id: "lic_0TestKey00000000001",
        brand_id: "brd_0TestBrand000000001",
        business_id: "bus_0TestBusiness000001",
        created_at: iso(NOW),
        customer_id: CUS,
        instances_count: 0,
        key: KEY,
        product_id: AUTO,
        source: "auto",
        status: "active",
        activations_limit: null,
        expires_at: null,
        payment_id: null,          // the shape that left no index
        subscription_id: null,
        ...over
    }
});
/** A Payment (SDK payments.ts Payment), as payment.succeeded and GET /payments/{id} carry it. */
const payment = (over: Record<string, unknown> = {}) => ({
    payload_type: "Payment",
    billing: { country: "IN", city: null, state: null, street: null, zipcode: null },
    brand_id: "brd_0TestBrand000000001",
    business_id: "bus_0TestBusiness000001",
    created_at: iso(NOW),
    currency: "USD",
    customer: { customer_id: CUS, email: "buyer@example.com", name: "Buyer" },
    digital_products_delivered: true,
    disputes: [],
    is_multi_subscription: false,
    is_update_payment_method: false,
    metadata: {},
    payment_id: PAY,
    payment_provider: "stripe",
    refunds: [],
    retry_attempt: 0,
    settlement_amount: 589,
    settlement_currency: "USD",
    subscription_ids: [],
    total_amount: 589,
    checkout_session_id: SESSION,
    product_cart: [{ product_id: AUTO, quantity: 1 }],
    status: "succeeded",
    subscription_id: null,
    tax: 90,
    ...over
});
const paymentSucceeded = (data: Record<string, unknown>) => ({
    business_id: "bus_0TestBusiness000001", type: "payment.succeeded", timestamp: iso(NOW), data
});
/** refund.succeeded: data is a Refund (SDK refunds.ts). */
const refundSucceeded = (payment_id = PAY, over: Record<string, unknown> = {}) => ({
    business_id: "bus_0TestBusiness000001",
    type: "refund.succeeded",
    timestamp: iso(NOW),
    data: {
        payload_type: "Refund",
        brand_id: "brd_0TestBrand000000001",
        business_id: "bus_0TestBusiness000001",
        created_at: iso(NOW),
        customer: { customer_id: CUS, email: "buyer@example.com", name: "Buyer" },
        is_partial: false,
        metadata: {},
        payment_id,
        refund_id: "ref_0TestRefund00000001",
        status: "succeeded",
        amount: 589,
        currency: "USD",
        reason: null,
        ...over
    }
});
/** dispute.lost: data is a Dispute (SDK disputes.ts): payment_id, no customer. */
const disputeLost = (payment_id = PAY) => ({
    business_id: "bus_0TestBusiness000001",
    type: "dispute.lost",
    timestamp: iso(NOW),
    data: {
        payload_type: "Dispute", amount: "589", business_id: "bus_0TestBusiness000001", created_at: iso(NOW),
        currency: "USD", dispute_id: "dis_0TestDispute0000001", dispute_stage: "chargeback", dispute_status: "dispute_lost", payment_id
    }
});
/** An EntitlementGrant (docs entitlement-grant sample, license_key variant). */
const grant = (key: string, payment_id: string | null, subscription_id: string | null = null, status = "Delivered") => ({
    payload_type: "EntitlementGrant",
    id: `grant_${key}`,
    business_id: "bus_0TestBusiness000001",
    brand_id: "brd_0TestBrand000000001",
    entitlement_id: "ent_0TestEntitlement001",
    customer_id: CUS,
    payment_id,
    subscription_id,
    status,
    integration_type: "license_key",
    license_key: { id: `lic_${key}`, key, status: "active", expires_at: null, activations_used: 0, activations_limit: null },
    digital_product_delivery: null,
    delivered_at: iso(NOW),
    revoked_at: null,
    revocation_reason: null,
    error_code: null,
    error_message: null,
    oauth_url: null,
    oauth_expires_at: null,
    metadata: {},
    created_at: iso(NOW),
    updated_at: iso(NOW)
});

// --- a fake Dodo API (GET only) -------------------------------------------
interface Dodo {
    payments: Record<string, any>;
    grants: Record<string, any[]>;
    list?: any[];
    down?: boolean;
    calls: string[];
    auth: string[];
}
let dodo: Dodo;
function installDodo(d: Partial<Dodo> = {}) {
    dodo = { payments: {}, grants: {}, calls: [], auth: [], ...d };
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any) => {
        const u = new URL(String(input));
        dodo.calls.push(u.pathname + u.search);
        dodo.auth.push(String(init?.headers?.authorization ?? ""));
        if (dodo.down) return new Response("upstream", { status: 503 });
        if ((init?.method ?? "GET") !== "GET") return new Response("no", { status: 405 });
        let m = u.pathname.match(/^\/payments\/([^/]+)$/);
        if (m) {
            const p = dodo.payments[decodeURIComponent(m[1]!)];
            return p ? Response.json(p) : new Response(JSON.stringify({ message: "not found" }), { status: 404 });
        }
        m = u.pathname.match(/^\/customers\/([^/]+)\/entitlement-grants$/);
        if (m) {
            const page = Number(u.searchParams.get("page_number") ?? 0);
            const items = page === 0 ? dodo.grants[decodeURIComponent(m[1]!)] ?? [] : [];
            return Response.json({ items });
        }
        if (u.pathname === "/license_keys") return Response.json({ items: [] });
        if (u.pathname === "/payments") {
            const size = Number(u.searchParams.get("page_size") ?? 10);
            const page = Number(u.searchParams.get("page_number") ?? 0);
            return Response.json({ items: (dodo.list ?? []).slice(page * size, page * size + size) });
        }
        return new Response("no route", { status: 404 });
    }));
}
beforeEach(() => installDodo());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const recOf = (kv: ReturnType<typeof fakeKV>, key = KEY) => {
    const raw = kv._dump()[`code:${key}`];
    return raw ? JSON.parse(raw) : undefined;
};
const purchaseStatus = async (e: Env, id: string) => {
    const param = id.startsWith("sub_") ? "subscription_id" : "payment_id";
    const res = await worker.fetch(new Request(`https://relay/v1/purchase-status?${param}=${id}`), e, ctx);
    return (await res.json() as any).state;
};

// ===========================================================================
describe("license_key.created for a one-time product → order:<payment_id>", () => {
    it("payment_id on the key (documented field): indexed directly, Dodo not asked", async () => {
        const kv = fakeKV();
        const r = await applyMorEvent(env(kv), licenseKeyCreated({ payment_id: PAY }), NOW);
        expect(r.action).toBe("created");
        expect(kv._dump()[`order:${PAY}`]).toBe(KEY);
        expect(dodo.calls).toHaveLength(0);
    });

    it("payment_id null: the payment is found from the customer's grant, and the code is indexed", async () => {
        installDodo({ grants: { [CUS]: [grant(KEY, PAY)] } });
        const kv = fakeKV();
        const r = await applyMorEvent(env(kv), licenseKeyCreated(), NOW);
        expect(r.action).toBe("created");
        expect(kv._dump()[`order:${PAY}`]).toBe(KEY);
        expect(recOf(kv)).toMatchObject({ plan: "automatic", status: "active", mor_order_id: PAY });
        expect(dodo.calls[0]).toMatch(/^\/customers\/cus_0TestCustomer0000001\/entitlement-grants\?integration_type=license_key/);
        expect(dodo.auth.every(a => a === "Bearer dodo_test_key")).toBe(true);
    });

    it("payment_id null and the grant matches only by key id: still indexed", async () => {
        const g = grant("SOMETHING-ELSE", PAY);
        g.license_key.id = "lic_0TestKey00000000001";
        installDodo({ grants: { [CUS]: [g] } });
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseKeyCreated(), NOW);
        expect(kv._dump()[`order:${PAY}`]).toBe(KEY);
    });

    it("payment_id null and Dodo down: the webhook fails (Dodo retries) and no un-revokable code is made", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        installDodo({ down: true });
        const kv = fakeKV();
        await expect(applyMorEvent(env(kv), licenseKeyCreated(), NOW)).rejects.toThrow();
        expect(recOf(kv)).toBeUndefined();
        // The retry, with Dodo back, makes and indexes the code.
        installDodo({ grants: { [CUS]: [grant(KEY, PAY)] } });
        await applyMorEvent(env(kv), licenseKeyCreated(), NOW);
        expect(kv._dump()[`order:${PAY}`]).toBe(KEY);
    });

    it("payment_id null and Dodo names no payment: 500 (retried), never a silent 2xx that drops a paid key", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        installDodo({ grants: { [CUS]: [] } });
        const kv = fakeKV();
        await expect(applyMorEvent(env(kv), licenseKeyCreated(), NOW)).rejects.toThrow();
        expect(recOf(kv)).toBeUndefined();
    });

    it("a subscription key without payment_id is still made (sub id joins it); Dodo down only logs", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        installDodo({ down: true });
        const kv = fakeKV();
        const r = await applyMorEvent(env(kv), licenseKeyCreated({ key: KEY_AI, product_id: MONTH, subscription_id: SUB }), NOW);
        expect(r.action).toBe("created");
        expect(kv._dump()[`order:${SUB}`]).toBe(KEY_AI);
    });
});

describe("arrival order: payment.succeeded first, then license_key.created", () => {
    it("indexes order:<payment_id>, hands the key to the install, and purchase-status says active", async () => {
        const hash = await installHash(FREE);
        installDodo({ grants: { [CUS]: [grant(KEY, PAY)] } });
        const kv = fakeKV();
        const e = env(kv);
        // At payment time Dodo's grant may not exist yet: nothing to index.
        installDodo({ grants: {} });
        await applyMorEvent(e, paymentSucceeded(payment({ metadata: { install: hash } })), NOW);
        expect(kv._dump()[`order:${PAY}`]).toBeUndefined();
        expect(await purchaseStatus(e, PAY)).toBe("pending");
        // The key lands with no payment id; the grant now names the payment.
        installDodo({ grants: { [CUS]: [grant(KEY, PAY)] } });
        await applyMorEvent(e, licenseKeyCreated(), NOW);
        expect(kv._dump()[`order:${PAY}`]).toBe(KEY);
        expect(kv._dump()[`paid:${hash}`]).toBe(KEY);
        expect(await purchaseStatus(e, PAY)).toBe("active");
    });

    it("license_key.created first: payment.succeeded finds order:<payment_id> and asks Dodo nothing", async () => {
        installDodo({ grants: { [CUS]: [grant(KEY, PAY)] } });
        const kv = fakeKV();
        const e = env(kv);
        await applyMorEvent(e, licenseKeyCreated(), NOW);
        const before = dodo.calls.length;
        await applyMorEvent(e, paymentSucceeded(payment()), NOW);
        expect(dodo.calls.length).toBe(before);
        expect(await purchaseStatus(e, PAY)).toBe("active");
    });

    it("a code already made WITHOUT its index (the live state): payment.succeeded indexes it from Dodo", async () => {
        const hash = await installHash(FREE);
        installDodo({ grants: { [CUS]: [grant(KEY, PAY)] } });
        const kv = fakeKV({ [`code:${KEY}`]: codeRec({ plan: "automatic", dailyCap: 5, createdAt: NOW }) });
        const e = env(kv);
        expect(await purchaseStatus(e, PAY)).toBe("unknown");
        await applyMorEvent(e, paymentSucceeded(payment({ metadata: { install: hash } })), NOW);
        expect(kv._dump()[`order:${PAY}`]).toBe(KEY);
        expect(recOf(kv).mor_order_id).toBe(PAY);
        expect(kv._dump()[`paid:${hash}`]).toBe(KEY);
        expect(await purchaseStatus(e, PAY)).toBe("active");
    });

    it("payment.succeeded for an AI subscription never writes or moves order:<sub_id>", async () => {
        installDodo({ grants: { [CUS]: [grant(KEY_AI, PAY_AI, SUB)] } });
        const kv = fakeKV({
            [`code:${KEY_AI}`]: codeRec({ plan: "monthly", dailyCap: 2000, mor_subscription_id: SUB, orderRef: SUB, expiresAt: NOW + 30 * 86_400_000 }),
            [`order:${SUB}`]: KEY_AI
        });
        await applyMorEvent(env(kv), paymentSucceeded(payment({ payment_id: PAY_AI, subscription_id: SUB, product_cart: [{ product_id: MONTH, quantity: 1 }] })), NOW);
        expect(kv._dump()[`order:${SUB}`]).toBe(KEY_AI);
        expect(kv._dump()[`order:${PAY_AI}`]).toBe(KEY_AI);
        expect(recOf(kv, KEY_AI)).toMatchObject({ orderRef: SUB, mor_subscription_id: SUB, mor_order_id: PAY_AI });
    });
});

describe("refund / dispute of an Automatic code whose index is missing", () => {
    const seedUnindexed = (extra: Record<string, string> = {}) =>
        fakeKV({ [`code:${KEY}`]: codeRec({ plan: "automatic", dailyCap: 5, createdAt: NOW }), ...extra });

    it("refund.succeeded resolves the key from Dodo and revokes it for good", async () => {
        installDodo({ grants: { [CUS]: [grant(KEY, PAY, null, "Revoked")] } });
        const kv = seedUnindexed();
        const r = await applyMorEvent(env(kv), refundSucceeded(), NOW);
        expect(r.action).toBe("applied");
        expect(recOf(kv)).toMatchObject({ status: "revoked", terminal: true, mor_order_id: PAY });
        expect(kv._dump()[`order:${PAY}`]).toBe(KEY);
        expect((await authCode(env(kv), KEY)).ok).toBe(false);
    });

    it("dispute.lost (no customer on a Dispute) reads the payment first, then revokes", async () => {
        installDodo({ payments: { [PAY]: payment() }, grants: { [CUS]: [grant(KEY, PAY)] } });
        const kv = seedUnindexed();
        await applyMorEvent(env(kv), disputeLost(), NOW);
        expect(recOf(kv)).toMatchObject({ status: "revoked", terminal: true });
        expect(dodo.calls[0]).toBe(`/payments/${PAY}`);
    });

    it("never revokes the wrong code: a key Dodo names but recorded under ANOTHER payment is left alone", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        installDodo({ grants: { [CUS]: [grant(KEY, PAY)] } });
        const kv = fakeKV({ [`code:${KEY}`]: codeRec({ plan: "automatic", dailyCap: 5, mor_order_id: "pay_0TestOtherPayment0001" }) });
        const r = await applyMorEvent(env(kv), refundSucceeded(), NOW);
        expect(r.action).toBe("staged");
        expect(recOf(kv).status).toBe("active");
        expect(kv._dump()[`order:${PAY}`]).toBeUndefined();
    });

    it("never revokes the wrong code: a refund of another customer's payment touches nothing", async () => {
        installDodo({ grants: { [CUS]: [grant(KEY, PAY)] } });
        const kv = seedUnindexed();
        const other = "pay_0TestSomeoneElse000001";
        const r = await applyMorEvent(env(kv), refundSucceeded(other, { customer: { customer_id: "cus_0TestStranger000001", email: "x@example.com", name: "X" } }), NOW);
        expect(r.action).toBe("staged");
        expect(recOf(kv).status).toBe("active");
    });

    it("Dodo down: the revoke is staged AND the webhook fails so Dodo retries; the retry revokes", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        installDodo({ down: true });
        const kv = seedUnindexed();
        await expect(applyMorEvent(env(kv), refundSucceeded(), NOW)).rejects.toThrow();
        expect(kv._dump()[`pending:${PAY}`]).toBeDefined();
        expect(recOf(kv).status).toBe("active");
        installDodo({ grants: { [CUS]: [grant(KEY, PAY, null, "Revoked")] } });
        await applyMorEvent(env(kv), refundSucceeded(), NOW);
        expect(recOf(kv)).toMatchObject({ status: "revoked", terminal: true });
    });

    it("an indexed code is revoked without asking Dodo", async () => {
        const kv = fakeKV({ [`code:${KEY}`]: codeRec({ plan: "automatic", dailyCap: 5, mor_order_id: PAY }), [`order:${PAY}`]: KEY });
        await applyMorEvent(env(kv), refundSucceeded(), NOW);
        expect(recOf(kv).terminal).toBe(true);
        expect(dodo.calls).toHaveLength(0);
    });

    it("a refund that raced ahead of a key with no payment id still lands as revoked", async () => {
        installDodo({ grants: { [CUS]: [] } });
        const kv = fakeKV();
        await applyMorEvent(env(kv), refundSucceeded(), NOW);
        expect(kv._dump()[`pending:${PAY}`]).toBeDefined();
        installDodo({ grants: { [CUS]: [grant(KEY, PAY, null, "Revoked")] } });
        await applyMorEvent(env(kv), licenseKeyCreated(), NOW);
        expect(recOf(kv)).toMatchObject({ status: "revoked", terminal: true });
    });
});

describe("entitlement_grant.created (license_key) completes the index of an existing code", () => {
    it("writes order:<payment_id> for the code it names, and never makes a code", async () => {
        const kv = fakeKV({ [`code:${KEY}`]: codeRec({ plan: "automatic", dailyCap: 5 }) });
        const evt = { business_id: "bus_0TestBusiness000001", type: "entitlement_grant.created", timestamp: iso(NOW), data: grant(KEY, PAY) };
        expect((await applyMorEvent(env(kv), evt, NOW)).action).toBe("grant_indexed");
        expect(kv._dump()[`order:${PAY}`]).toBe(KEY);
        const kv2 = fakeKV();
        expect((await applyMorEvent(env(kv2), evt, NOW)).action).toBe("grant_no_code");
        expect(kv2._dump()).toEqual({});
    });
});

// ===========================================================================
describe("POST /admin/backfill-orders", () => {
    const admin = (body: unknown, token = "admintok") => new Request("https://relay/admin/backfill-orders", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body)
    });
    const OTHER_KEY = "LK-TEST-AUTO-0002";
    const PAY_OK = "pay_0TestAlreadyIndexed001";
    const PAY_REFUNDED = "pay_0TestRefundedFull00001";
    const KEY_REFUNDED = "LK-TEST-AUTO-0003";
    const seed = () => fakeKV({
        // The live bug's state: an Automatic code with no payment index.
        [`code:${KEY}`]: codeRec({ plan: "automatic", dailyCap: 5, createdAt: NOW }),
        // An AI subscription with only its sub index.
        [`code:${KEY_AI}`]: codeRec({ plan: "monthly", dailyCap: 2000, mor_subscription_id: SUB, orderRef: SUB, expiresAt: NOW + 30 * 86_400_000 }),
        [`order:${SUB}`]: KEY_AI,
        // Already fine.
        [`code:${OTHER_KEY}`]: codeRec({ plan: "automatic", dailyCap: 5, mor_order_id: PAY_OK }),
        [`order:${PAY_OK}`]: OTHER_KEY,
        // Refunded at Dodo while unindexed: still live here.
        [`code:${KEY_REFUNDED}`]: codeRec({ plan: "automatic", dailyCap: 5 })
    });
    const dodoState = () => ({
        list: [
            payment(),
            payment({ payment_id: PAY_AI, subscription_id: SUB, product_cart: [{ product_id: MONTH, quantity: 1 }], has_license_key: true }),
            payment({ payment_id: PAY_OK, has_license_key: true }),
            payment({ payment_id: PAY_REFUNDED, refund_status: "full", has_license_key: true }),
            payment({ payment_id: "pay_0TestNoLicenseKey00001", has_license_key: false })
        ].map((p: any) => ({ ...p, has_license_key: p.has_license_key ?? true })),
        grants: { [CUS]: [grant(KEY, PAY), grant(KEY_AI, PAY_AI, SUB), grant(OTHER_KEY, PAY_OK), grant(KEY_REFUNDED, PAY_REFUNDED, null, "Revoked")] }
    });

    it("refuses without the admin token", async () => {
        const kv = seed();
        const res = await worker.fetch(admin({}, "wrong"), env(kv), ctx);
        expect(res.status).toBe(401);
        expect(dodo.calls).toHaveLength(0);
    });

    it("dry run (the default): counts only, writes nothing, prints no key or payment id", async () => {
        installDodo(dodoState());
        const kv = seed();
        const before = JSON.stringify(kv._dump());
        const res = await worker.fetch(admin({ pageSize: 100 }), env(kv), ctx);
        expect(res.status).toBe(200);
        const text = await res.text();
        const body = JSON.parse(text);
        expect(body).toMatchObject({ ok: true, dryRun: true, nextPage: null });
        expect(body.counts).toEqual({
            payments: 5, withLicenseKey: 4, alreadyIndexed: 1, indexed: 3, conflict: 0,
            noCode: 0, notFoundAtDodo: 0, dodoUnavailable: 0, refundedButLive: 1
        });
        expect(JSON.stringify(kv._dump())).toBe(before);
        for (const secret of [KEY, KEY_AI, OTHER_KEY, KEY_REFUNDED, PAY, PAY_AI, CUS, "dodo_test_key"]) expect(text).not.toContain(secret);
    });

    it("apply: fills the missing rows, leaves order:<sub_id> and existing rows as they were", async () => {
        installDodo(dodoState());
        const kv = seed();
        const res = await worker.fetch(admin({ apply: true, pageSize: 100 }), env(kv), ctx);
        const body = await res.json() as any;
        expect(body).toMatchObject({ ok: true, dryRun: false });
        expect(body.counts).toMatchObject({ indexed: 3, alreadyIndexed: 1, refundedButLive: 1 });
        const d = kv._dump();
        expect(d[`order:${PAY}`]).toBe(KEY);
        expect(d[`order:${PAY_AI}`]).toBe(KEY_AI);
        expect(d[`order:${PAY_REFUNDED}`]).toBe(KEY_REFUNDED);
        expect(d[`order:${SUB}`]).toBe(KEY_AI);
        expect(d[`order:${PAY_OK}`]).toBe(OTHER_KEY);
        expect(JSON.parse(d[`code:${KEY_AI}`]!)).toMatchObject({ orderRef: SUB, mor_subscription_id: SUB, mor_order_id: PAY_AI });
        // Now a refund of the Automatic purchase reaches its code, and the thanks page says active.
        expect(await purchaseStatus(env(kv), PAY)).toBe("active");
        // A second run finds nothing left to do.
        const again = await (await worker.fetch(admin({ apply: true, pageSize: 100 }), env(kv), ctx)).json() as any;
        expect(again.counts).toMatchObject({ indexed: 0, alreadyIndexed: 4 });
    });

    it("pages: nextPage walks the list; an order: row naming another code is a conflict, never overwritten", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        installDodo(dodoState());
        const kv = seed();
        await kv.put(`order:${PAY}`, "LK-SOMEONE-ELSE");
        await kv.put("code:LK-SOMEONE-ELSE", codeRec({ plan: "automatic", dailyCap: 5 }));
        const p0 = await (await worker.fetch(admin({ apply: true, pageSize: 2 }), env(kv), ctx)).json() as any;
        expect(p0).toMatchObject({ page: 0, nextPage: 1 });
        expect(p0.counts.payments).toBe(2);
        expect(kv._dump()[`order:${PAY}`]).toBe("LK-SOMEONE-ELSE");
        const p2 = await (await worker.fetch(admin({ apply: true, page: 2, pageSize: 2 }), env(kv), ctx)).json() as any;
        expect(p2).toMatchObject({ page: 2, nextPage: null });
    });

    it("Dodo down: 503 for the list, counted per customer otherwise; nothing written", async () => {
        installDodo({ down: true });
        const kv = seed();
        const before = JSON.stringify(kv._dump());
        const res = await worker.fetch(admin({ apply: true }), env(kv), ctx);
        expect(res.status).toBe(503);
        expect(JSON.stringify(kv._dump())).toBe(before);
    });
});
