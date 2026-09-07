import { describe, it, expect } from "vitest";
import { applyMorEvent, authCode, variantConfig, type Env, type CodeRecord } from "../src/codes";
import { fakeKV, fakeBudget } from "./kv-mock";
import worker from "../src/index";

// ===========================================================================
//  DODO PAYMENTS (Merchant of Record) — Standard-Webhooks webhook spine.
//
//  Every field path / event name below is confirmed against Dodo's docs and
//  the dodopayments-node SDK types (see the CONFIRMED block in codes.ts):
//    • root:  { business_id, type, timestamp, data }   (type = event name)
//    • license_key.created  data.key (== the Subline code), data.subscription_id,
//                           data.payment_id, data.product_id
//    • subscription.*       data.subscription_id, data.next_billing_date, data.status
//    • refund.succeeded     data.payment_id  (Refund carries NO subscription_id)
//    • dispute.*            data.payment_id  (Dispute carries NO subscription_id)
// ===========================================================================

// --- fixtures ---------------------------------------------------------------
const VARIANTS = {
    "prod_month": { plan: "monthly", dailyCap: 1500 },
    "prod_life": { plan: "lifetime", dailyCap: 3000 },
};
const env = (kv: any, over: Partial<Env> = {}): Env => ({
    CODES: kv, GROQ_KEY: "x", ADMIN_TOKEN: "a", MODEL: "m",
    BUDGET: fakeBudget().ns, VARIANTS, ...over,
});
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const KEY = "SUBLINE-3A1F-6C20-11AA-BBBB";   // a Dodo license-key string == the Subline code
const SUB = "sub_7001";                        // subscription id (subscription join key)
const PAY = "pay_9001";                        // payment id (one-time / refund / dispute join key)

const rec = (kv: ReturnType<typeof fakeKV>, key = KEY): CodeRecord | undefined => {
    const raw = kv._dump()[`code:${key}`];
    return raw ? JSON.parse(raw) : undefined;
};

// license_key.created — the ONLY event carrying data.key (the code value).
const licenseCreated = (over: any = {}) => ({
    business_id: "biz_1",
    type: "license_key.created",
    timestamp: iso(NOW),
    data: {
        payload_type: "LicenseKey",
        id: "lic_1",
        key: KEY,
        product_id: "prod_month",
        subscription_id: SUB,
        payment_id: PAY,
        status: "active",
        ...over.data,
    },
});
// subscription.* — join via data.subscription_id.
const subEvent = (type: string, data: any = {}) => ({
    business_id: "biz_1",
    type,
    timestamp: iso(NOW),
    data: { payload_type: "Subscription", subscription_id: SUB, product_id: "prod_month", ...data },
});
// refund.succeeded / dispute.* — join via data.payment_id (NO subscription_id exists on these).
const refundEvent = (payment_id = PAY) => ({
    business_id: "biz_1",
    type: "refund.succeeded",
    timestamp: iso(NOW),
    data: { payload_type: "Refund", refund_id: "ref_1", payment_id, status: "succeeded" },
});
const disputeEvent = (type: string, payment_id = PAY) => ({
    business_id: "biz_1",
    type,
    timestamp: iso(NOW),
    data: { payload_type: "Dispute", dispute_id: "dis_1", payment_id, dispute_status: "lost" },
});

// ===========================================================================
describe("variantConfig — defensive, fail-safe (keyed by Dodo product_id)", () => {
    it("maps a known product", () => {
        expect(variantConfig(env(fakeKV()), "prod_month")).toEqual({ plan: "monthly", dailyCap: 1500, mapped: true });
    });
    it("unknown/missing/empty product falls back to the free cap, never unbounded", () => {
        expect(variantConfig(env(fakeKV()), "nope")).toEqual({ plan: "free", dailyCap: 500, mapped: false });
        expect(variantConfig(env(fakeKV()), "")).toMatchObject({ dailyCap: 500, mapped: false });
    });
    it("tolerates a stringified table and a garbage table", () => {
        expect(variantConfig({ ...env(fakeKV()), VARIANTS: JSON.stringify(VARIANTS) }, "prod_life"))
            .toEqual({ plan: "lifetime", dailyCap: 3000, mapped: true });
        expect(variantConfig({ ...env(fakeKV()), VARIANTS: "{not json" }, "prod_month")).toMatchObject({ mapped: false, dailyCap: 500 });
        expect(variantConfig({ ...env(fakeKV()), VARIANTS: undefined }, "prod_month")).toMatchObject({ mapped: false });
    });
    it("a bad/negative cap in the table falls back to the free cap", () => {
        const e = { ...env(fakeKV()), VARIANTS: { "prod_x": { plan: "monthly", dailyCap: -5 } } };
        expect(variantConfig(e, "prod_x")).toMatchObject({ dailyCap: 500 });
    });
});

describe("license_key.created — create with plan/cap + reverse index (sub_id AND payment_id)", () => {
    it("upserts an active paid code and indexes it under BOTH the subscription id and the payment id", async () => {
        const kv = fakeKV();
        const r = await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(r.action).toBe("created");
        expect(rec(kv)).toMatchObject({ status: "active", dailyCap: 1500, plan: "monthly" });
        // BOTH indexes point at the code: subscription.* joins via sub id; refund/
        // dispute (which carry ONLY payment_id) join via payment id — so a
        // subscription can still be revoked on a chargeback.
        expect(kv._dump()[`order:${SUB}`]).toBe(KEY);
        expect(kv._dump()[`order:${PAY}`]).toBe(KEY);
        expect(rec(kv)!.mor_subscription_id).toBe(SUB);
        // #2: a subscription-tier code is stamped a finite PROVISIONAL expiry.
        expect(rec(kv)!.expiresAt).toBe(NOW + 3 * 86_400_000);
    });
    it("unknown product_id mints at the free cap and flags it (fail safe)", async () => {
        const kv = fakeKV();
        const r = await applyMorEvent(env(kv), licenseCreated({ data: { product_id: "ghost" } }), NOW);
        expect(r.action).toBe("created_unmapped_variant");
        expect(rec(kv)).toMatchObject({ dailyCap: 500, plan: "free" });
        expect(rec(kv)!.note).toMatch(/unmapped product/i);
    });
    it("is idempotent — same event twice yields one unchanged record", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        const first = kv._dump()[`code:${KEY}`];
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(Object.keys(kv._dump()).filter(k => k.startsWith("code:")).length).toBe(1);
        expect(kv._dump()[`code:${KEY}`]).toBe(first);
    });
    it("a lifetime (one-time) purchase indexes by payment_id and never sets expiresAt", async () => {
        const kv = fakeKV();
        // one-time purchases have no subscription_id
        await applyMorEvent(env(kv), licenseCreated({ data: { product_id: "prod_life", subscription_id: null } }), NOW);
        expect(rec(kv)).toMatchObject({ plan: "lifetime", dailyCap: 3000 });
        expect(rec(kv)!.expiresAt).toBeUndefined();
        expect(kv._dump()[`order:${PAY}`]).toBe(KEY);
    });
});

describe("subscription lifecycle (join via data.subscription_id, expiry from next_billing_date)", () => {
    const renews = NOW + 30 * 86_400_000;

    it("subscription.active sets expiresAt to next_billing_date and records the sub id", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.active", { status: "active", next_billing_date: iso(renews) }), NOW);
        expect(rec(kv)!.expiresAt).toBe(renews);
        expect(rec(kv)!.mor_subscription_id).toBe(SUB);
    });
    it("renewal (subscription.renewed) pushes expiresAt FORWARD", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.active", { status: "active", next_billing_date: iso(renews) }), NOW);
        const next = renews + 30 * 86_400_000;
        await applyMorEvent(env(kv), subEvent("subscription.renewed", { status: "active", next_billing_date: iso(next) }), NOW);
        expect(rec(kv)!.expiresAt).toBe(next);
    });
    it("a replayed OLD renewal cannot shorten a live subscription (forward-only)", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.active", { status: "active", next_billing_date: iso(renews) }), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.renewed", { status: "active", next_billing_date: iso(NOW - 1000) }), NOW);
        expect(rec(kv)!.expiresAt).toBe(renews); // unchanged, not pulled back into the past
    });
    it("on_hold (dunning) does NOT extend and does NOT revoke", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.active", { status: "active", next_billing_date: iso(renews) }), NOW);
        const r = await applyMorEvent(env(kv), subEvent("subscription.on_hold", { status: "on_hold", next_billing_date: iso(renews + 999_999) }), NOW);
        expect(r.action).toBe("ignored_dunning");
        expect(rec(kv)!.expiresAt).toBe(renews);
        expect(rec(kv)!.status).toBe("active"); // not revoked mid-dunning
    });
    it("subscription.failed (dunning, non-final) is ignored — never revokes", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        const r = await applyMorEvent(env(kv), subEvent("subscription.failed", { status: "failed" }), NOW);
        expect(r.action).toBe("ignored_dunning");
        expect(rec(kv)!.status).toBe("active");
    });

    it("cancelled ≠ expired: does NOT revoke, keeps access until next_billing_date (period end)", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        const ends = NOW + 5 * 86_400_000;
        await applyMorEvent(env(kv), subEvent("subscription.cancelled", { status: "cancelled", next_billing_date: iso(ends), cancelled_at: iso(NOW) }), NOW);
        expect(rec(kv)!.status).toBe("active");
        expect(rec(kv)!.expiresAt).toBe(ends);
        expect(rec(kv)!.terminal).toBeUndefined();
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: true }); // still inside the period
    });
    it("subscription.expired revokes (terminal)", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.expired", { status: "expired" }), NOW);
        expect(rec(kv)!.status).toBe("revoked");
        expect(rec(kv)!.terminal).toBe(true);
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });
    it("a stale subscription.active replay cannot resurrect an expired code", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.expired", { status: "expired" }), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.active", { status: "active", next_billing_date: iso(NOW + 60 * 86_400_000) }), NOW);
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });
});

describe("refund / chargeback (join via data.payment_id)", () => {
    it("refund.succeeded resolves the code via the payment id and revokes (terminal)", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        const r = await applyMorEvent(env(kv), refundEvent(), NOW);
        expect(r.action).toBe("applied");
        expect(rec(kv)!.status).toBe("revoked");
        expect(rec(kv)!.terminal).toBe(true);
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });
    it("dispute.lost revokes (terminal); dispute.won does NOT revoke", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        const won = await applyMorEvent(env(kv), disputeEvent("dispute.won"), NOW);
        expect(won.action).toBe("ignored"); // merchant kept the money — access preserved
        expect(rec(kv)!.status).toBe("active");
        const lost = await applyMorEvent(env(kv), disputeEvent("dispute.lost"), NOW);
        expect(lost.action).toBe("applied");
        expect(rec(kv)!.status).toBe("revoked");
        expect(rec(kv)!.terminal).toBe(true);
    });
    it("payment.failed is ignored — never revokes", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        const pf = { business_id: "biz_1", type: "payment.failed", timestamp: iso(NOW), data: { payload_type: "Payment", payment_id: PAY } };
        const r = await applyMorEvent(env(kv), pf, NOW);
        expect(r.action).toBe("ignored");
        expect(rec(kv)!.status).toBe("active");
    });
});

describe("order-independent delivery (staging via pending:<join_id>)", () => {
    it("a subscription event arriving BEFORE the key is folded in at creation", async () => {
        const kv = fakeKV();
        const renews = NOW + 30 * 86_400_000;
        const staged = await applyMorEvent(env(kv), subEvent("subscription.active", { status: "active", next_billing_date: iso(renews) }), NOW);
        expect(staged.action).toBe("staged");
        expect(rec(kv)).toBeUndefined(); // no code yet
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(rec(kv)!.expiresAt).toBe(renews);
        expect(rec(kv)!.mor_subscription_id).toBe(SUB);
        expect(kv._dump()[`pending:${SUB}`]).toBeUndefined(); // consumed
    });
    it("a refund racing ahead of the key still lands as revoked once the key arrives", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), refundEvent(), NOW); // pending:<payment_id>
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(rec(kv)!.status).toBe("revoked");
    });
});

describe("unknown / unhandled events fail SAFE", () => {
    it("an unknown event type is a handled no-op, never a throw (deny stays deny)", async () => {
        const kv = fakeKV();
        const r = await applyMorEvent(env(kv), { business_id: "b", type: "credit.added", timestamp: iso(NOW), data: {} }, NOW);
        expect(r.action).toBe("ignored");
    });
    it("a garbage payload does not throw", async () => {
        const kv = fakeKV();
        await expect(applyMorEvent(env(kv), {}, NOW)).resolves.toBeDefined();
        await expect(applyMorEvent(env(kv), { type: 123, data: null }, NOW)).resolves.toBeDefined();
    });
});

// ===========================================================================
//  Standard-Webhooks signature + transport (drives the real worker.fetch)
// ===========================================================================
//
//  Secret is whsec_<base64>. The raw HMAC key is base64-decode(secret minus the
//  whsec_ prefix). Signed content = `${webhook-id}.${webhook-timestamp}.${rawBody}`.
//  HMAC-SHA256 → base64; the webhook-signature header is a space-delimited list
//  of `v1,<base64>` entries. (All confirmed against the standardwebhooks JS lib
//  that Dodo's SDK uses.)
const RAW_KEY = new TextEncoder().encode("dodo-relay-signing-key-bytes");
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const SECRET = "whsec_" + b64(RAW_KEY);
const WID = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W";

async function swSign(id: string, ts: string, body: string, key = RAW_KEY): Promise<string> {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${id}.${ts}.${body}`));
    return "v1," + b64(new Uint8Array(mac));
}
const nowSecs = () => Math.floor(NOW_REAL() / 1000).toString();
const NOW_REAL = () => Date.now(); // signature freshness is checked against wall-clock

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const post = (body: string, headers: Record<string, string>, e: Env) =>
    worker.fetch(new Request("https://relay/webhook/mor", { method: "POST", body, headers }), e, ctx);

// build a valid, fresh signed request
async function signed(body: string, over: Partial<Record<"id" | "ts" | "sig", string>> = {}) {
    const id = over.id ?? WID;
    const ts = over.ts ?? nowSecs();
    const sig = over.sig ?? (await swSign(id, ts, body));
    return { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig };
}

describe("/webhook/mor — Standard-Webhooks signature & transport", () => {
    const body = () => JSON.stringify(licenseCreated());
    const withSecret = (kv: any) => env(kv, { MOR_WEBHOOK_SECRET: SECRET });

    it("503 when the secret is unset (never a silent 200)", async () => {
        const res = await post(body(), await signed(body()), env(fakeKV()));
        expect(res.status).toBe(503);
    });
    it("valid signature ⇒ 200, mirrors the event, and NEVER echoes the code", async () => {
        const kv = fakeKV();
        const b = body();
        const res = await post(b, await signed(b), withSecret(kv));
        expect(res.status).toBe(200);
        const json = await res.json() as any;
        expect(json).toEqual({ ok: true });
        expect(JSON.stringify(json)).not.toContain(KEY); // the minted code must not leak in the body
        expect(kv._dump()[`code:${KEY}`]).toBeDefined();
    });
    it("accepts a header carrying MULTIPLE signatures if ANY entry matches (key rotation)", async () => {
        const kv = fakeKV();
        const b = body();
        const h = await signed(b);
        h["webhook-signature"] = "v1,Zm9vYmFy " + h["webhook-signature"]; // a junk sig then the good one
        const res = await post(b, h, withSecret(kv));
        expect(res.status).toBe(200);
    });
    it("tampered body ⇒ 401 and no state change", async () => {
        const kv = fakeKV();
        const b = body();
        const h = await signed(b);
        const res = await post(b.replace(PAY, "pay_evil"), h, withSecret(kv));
        expect(res.status).toBe(401);
        expect(Object.keys(kv._dump()).length).toBe(0);
    });
    it("tampered signature ⇒ 401", async () => {
        const b = body();
        const h = await signed(b);
        h["webhook-signature"] = h["webhook-signature"].replace(/.$/, "A");
        const res = await post(b, h, withSecret(fakeKV()));
        expect(res.status).toBe(401);
    });
    it("wrong signing key ⇒ 401 (signature made with a different secret)", async () => {
        const b = body();
        const badSig = await swSign(WID, nowSecs(), b, new TextEncoder().encode("not-the-key"));
        const res = await post(b, await signed(b, { sig: badSig }), withSecret(fakeKV()));
        expect(res.status).toBe(401);
    });
    it("missing webhook-signature ⇒ 401", async () => {
        const h = await signed(body());
        delete (h as any)["webhook-signature"];
        expect((await post(body(), h, withSecret(fakeKV()))).status).toBe(401);
    });
    it("missing webhook-id ⇒ 401", async () => {
        const h = await signed(body());
        delete (h as any)["webhook-id"];
        expect((await post(body(), h, withSecret(fakeKV()))).status).toBe(401);
    });
    it("missing webhook-timestamp ⇒ 401", async () => {
        const h = await signed(body());
        delete (h as any)["webhook-timestamp"];
        expect((await post(body(), h, withSecret(fakeKV()))).status).toBe(401);
    });
    it("wrong-length / garbage signature ⇒ 401 without throwing", async () => {
        const h = await signed(body());
        h["webhook-signature"] = "abc";
        expect((await post(body(), h, withSecret(fakeKV()))).status).toBe(401);
    });
    it("a STALE timestamp (> 5 min old) ⇒ 401 (replay window closed)", async () => {
        const b = body();
        const staleTs = (Math.floor(Date.now() / 1000) - 6 * 60).toString(); // 6 minutes ago
        const sig = await swSign(WID, staleTs, b);
        const res = await post(b, { "webhook-id": WID, "webhook-timestamp": staleTs, "webhook-signature": sig }, withSecret(fakeKV()));
        expect(res.status).toBe(401);
    });
    it("a FUTURE timestamp (> 5 min ahead) ⇒ 401", async () => {
        const b = body();
        const futureTs = (Math.floor(Date.now() / 1000) + 6 * 60).toString();
        const sig = await swSign(WID, futureTs, b);
        const res = await post(b, { "webhook-id": WID, "webhook-timestamp": futureTs, "webhook-signature": sig }, withSecret(fakeKV()));
        expect(res.status).toBe(401);
    });
    it("a non-numeric timestamp ⇒ 401 without throwing", async () => {
        const b = body();
        const res = await post(b, { "webhook-id": WID, "webhook-timestamp": "not-a-number", "webhook-signature": await swSign(WID, "not-a-number", b) }, withSecret(fakeKV()));
        expect(res.status).toBe(401);
    });
});

// ===========================================================================
//  SECURITY FIXES — payment/lifecycle spine (terminal revoke, provisional
//  expiry, pending TTL, un-revokable-mint guard). Each test names the exploit
//  it closes; see the matching comments in codes.ts.
// ===========================================================================
const DAY = 86_400_000;

describe("#1 revocation is TERMINAL (refund/expire can never be un-revoked)", () => {
    it("(1a) refund → replayed active subscription event {future next_billing_date} STAYS revoked (refund bypass closed)", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.active", { status: "active", next_billing_date: iso(NOW + 30 * DAY) }), NOW);
        await applyMorEvent(env(kv), refundEvent(), NOW); // resolves via payment_id
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false });
        // duplicate / out-of-order / replayed active renewal with a STILL-FUTURE expiry (resolves via sub_id → SAME code)
        await applyMorEvent(env(kv), subEvent("subscription.renewed", { status: "active", next_billing_date: iso(NOW + 60 * DAY) }), NOW);
        expect(rec(kv)!.status).toBe("revoked");
        expect(rec(kv)!.terminal).toBe(true);
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });
    it("(1b) subscription.expired → later active event STAYS revoked", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.expired", { status: "expired" }), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.active", { status: "active", next_billing_date: iso(NOW + 60 * DAY) }), NOW);
        expect(rec(kv)!.status).toBe("revoked");
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });
    it("(1c) REGRESSION: a plain cancel is NOT terminal — an active event within the period still works", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.cancelled", { status: "cancelled", next_billing_date: iso(NOW + 5 * DAY) }), NOW);
        await applyMorEvent(env(kv), subEvent("subscription.active", { status: "active", next_billing_date: iso(NOW + 35 * DAY) }), NOW);
        expect(rec(kv)!.status).toBe("active");
        expect(rec(kv)!.terminal).toBeUndefined();
        expect(rec(kv)!.expiresAt).toBe(NOW + 35 * DAY);
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: true });
    });
});

describe("#2 subscription codes always carry a finite expiry (never-expire paywall bypass closed)", () => {
    it("(2a) a subscription code with ONLY license_key.created has a finite provisional expiry and lapses after GRACE", async () => {
        const kv = fakeKV();
        const longAgo = Date.now() - 10 * DAY; // provisional (=now+3d) is already in the past
        await applyMorEvent(env(kv), licenseCreated(), longAgo);
        const r = rec(kv)!;
        expect(typeof r.expiresAt).toBe("number");
        expect(r.expiresAt).toBe(longAgo + 3 * DAY);
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false, reason: "expired" });
    });
    it("(2b) an active subscription event with NO next_billing_date does not clear the provisional expiry", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        const prov = rec(kv)!.expiresAt;
        expect(typeof prov).toBe("number");
        await applyMorEvent(env(kv), subEvent("subscription.active", { status: "active" }), NOW); // no next_billing_date
        expect(rec(kv)!.expiresAt).toBe(prov);
    });
    it("(2c) a lifetime (one-time) code correctly has NO expiresAt", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated({ data: { product_id: "prod_life", subscription_id: null } }), NOW);
        expect(rec(kv)!.expiresAt).toBeUndefined();
    });
});

describe("#4 staged pending:<join_id> self-purges (no KV bloat / latent state)", () => {
    it("writes pending with an expirationTtl", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), subEvent("subscription.active", { status: "active", next_billing_date: iso(NOW + 30 * DAY) }), NOW);
        expect(kv._dump()[`pending:${SUB}`]).toBeDefined();
        expect(kv._opts(`pending:${SUB}`)?.expirationTtl).toBeGreaterThan(0);
    });
});

describe("#5 a paid code minted with no join key is refused (never un-revokable)", () => {
    it("does not mint a usable active code when both subscription_id and payment_id are absent", async () => {
        const kv = fakeKV();
        const r = await applyMorEvent(env(kv), licenseCreated({ data: { subscription_id: null, payment_id: null } }), NOW);
        expect(r.action).toBe("ignored_no_order");
        expect(rec(kv)).toBeUndefined();
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false });
    });
});
