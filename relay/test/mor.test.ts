import { describe, it, expect } from "vitest";
import { applyMorEvent, authCode, variantConfig, type Env, type CodeRecord } from "../src/codes";
import { fakeKV, fakeBudget } from "./kv-mock";
import worker from "../src/index";

// --- fixtures ---------------------------------------------------------------
const VARIANTS = {
    "v_month": { plan: "monthly", dailyCap: 1500 },
    "v_life": { plan: "lifetime", dailyCap: 3000 },
};
const env = (kv: any, over: Partial<Env> = {}): Env => ({
    CODES: kv, GROQ_KEY: "x", ADMIN_TOKEN: "a", MODEL: "m",
    BUDGET: fakeBudget().ns, VARIANTS, ...over,
});
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const KEY = "3a1f6c20-1111-4aaa-bbbb-000000000001"; // an LS license-key UUID
const ORDER = "9001";
const SUB = "7001";

const rec = (kv: ReturnType<typeof fakeKV>, key = KEY): CodeRecord | undefined => {
    const raw = kv._dump()[`code:${key}`];
    return raw ? JSON.parse(raw) : undefined;
};

const licenseCreated = (over: any = {}) => ({
    meta: { event_name: "license_key_created", variant_id: "v_month", ...over.meta },
    data: { type: "license-keys", id: "lk_1", attributes: { key: KEY, order_id: ORDER, ...over.attrs } },
});
const subEvent = (name: string, attrs: any) => ({
    meta: { event_name: name },
    data: { type: "subscriptions", id: SUB, attributes: { order_id: ORDER, ...attrs } },
});

// ===========================================================================
describe("variantConfig — defensive, fail-safe", () => {
    it("maps a known variant", () => {
        expect(variantConfig(env(fakeKV()), "v_month")).toEqual({ plan: "monthly", dailyCap: 1500, mapped: true });
    });
    it("unknown/missing/empty variant falls back to the free cap, never unbounded", () => {
        expect(variantConfig(env(fakeKV()), "nope")).toEqual({ plan: "free", dailyCap: 500, mapped: false });
        expect(variantConfig(env(fakeKV()), "")).toMatchObject({ dailyCap: 500, mapped: false });
    });
    it("tolerates a stringified table and a garbage table", () => {
        expect(variantConfig({ ...env(fakeKV()), VARIANTS: JSON.stringify(VARIANTS) }, "v_life"))
            .toEqual({ plan: "lifetime", dailyCap: 3000, mapped: true });
        expect(variantConfig({ ...env(fakeKV()), VARIANTS: "{not json" }, "v_month")).toMatchObject({ mapped: false, dailyCap: 500 });
        expect(variantConfig({ ...env(fakeKV()), VARIANTS: undefined }, "v_month")).toMatchObject({ mapped: false });
    });
    it("a bad/negative cap in the table falls back to the free cap", () => {
        const e = { ...env(fakeKV()), VARIANTS: { "v_x": { plan: "monthly", dailyCap: -5 } } };
        expect(variantConfig(e, "v_x")).toMatchObject({ dailyCap: 500 });
    });
});

describe("license_key_created — create with plan/cap + reverse index", () => {
    it("upserts an active paid code, mor_order_id, and order→key index", async () => {
        const kv = fakeKV();
        const r = await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(r.action).toBe("created");
        expect(rec(kv)).toMatchObject({ status: "active", dailyCap: 1500, plan: "monthly", mor_order_id: ORDER });
        expect(kv._dump()[`order:${ORDER}`]).toBe(KEY);
        // #2: a subscription-tier code is stamped with a finite PROVISIONAL expiry
        // at creation (now + GRACE) so a missed/late subscription event can never
        // leave it never-expiring; a real renews_at supersedes it forward-only.
        expect(rec(kv)!.expiresAt).toBe(NOW + 3 * 86_400_000);
    });
    it("unknown variant_id mints at the free cap and flags it (fail safe)", async () => {
        const kv = fakeKV();
        const r = await applyMorEvent(env(kv), licenseCreated({ meta: { variant_id: "ghost" } }), NOW);
        expect(r.action).toBe("created_unmapped_variant");
        expect(rec(kv)).toMatchObject({ dailyCap: 500, plan: "free" });
        expect(rec(kv)!.note).toMatch(/unmapped variant/i);
    });
    it("is idempotent — same event twice yields one unchanged record", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        const first = kv._dump()[`code:${KEY}`];
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(Object.keys(kv._dump()).filter(k => k.startsWith("code:")).length).toBe(1);
        expect(kv._dump()[`code:${KEY}`]).toBe(first);
    });
    it("a lifetime (one-time) purchase never sets expiresAt", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated({ meta: { variant_id: "v_life" } }), NOW);
        expect(rec(kv)).toMatchObject({ plan: "lifetime", dailyCap: 3000 });
        expect(rec(kv)!.expiresAt).toBeUndefined();
    });
});

describe("subscription lifecycle", () => {
    const renews = NOW + 30 * 86_400_000;

    it("subscription_created sets expiresAt to renews_at and records the sub id", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_created", { status: "active", renews_at: iso(renews) }), NOW);
        expect(rec(kv)!.expiresAt).toBe(renews);
        expect(rec(kv)!.mor_subscription_id).toBe(SUB);
    });
    it("renewal (subscription_updated active) pushes expiresAt FORWARD", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_created", { status: "active", renews_at: iso(renews) }), NOW);
        const next = renews + 30 * 86_400_000;
        await applyMorEvent(env(kv), subEvent("subscription_updated", { status: "active", renews_at: iso(next) }), NOW);
        expect(rec(kv)!.expiresAt).toBe(next);
    });
    it("a replayed OLD renewal cannot shorten a live subscription (forward-only)", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_created", { status: "active", renews_at: iso(renews) }), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_created", { status: "active", renews_at: iso(NOW - 1000) }), NOW);
        expect(rec(kv)!.expiresAt).toBe(renews); // unchanged, not pulled back into the past
    });
    it("does NOT extend on a past_due update (dunning window)", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_created", { status: "active", renews_at: iso(renews) }), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_updated", { status: "past_due", renews_at: iso(renews + 999_999) }), NOW);
        expect(rec(kv)!.expiresAt).toBe(renews);
        expect(rec(kv)!.status).toBe("active"); // not revoked mid-dunning
    });

    it("cancelled ≠ expired: does NOT revoke, keeps access until ends_at", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        const ends = NOW + 5 * 86_400_000;
        await applyMorEvent(env(kv), subEvent("subscription_cancelled", { status: "cancelled", ends_at: iso(ends) }), NOW);
        expect(rec(kv)!.status).toBe("active");
        expect(rec(kv)!.expiresAt).toBe(ends);
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: true }); // still inside the period
    });
    it("subscription_expired revokes", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_expired", { status: "expired", ends_at: iso(NOW) }), NOW);
        expect(rec(kv)!.status).toBe("revoked");
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });
    it("a stale subscription_created replay cannot resurrect an expired code", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_expired", { status: "expired", ends_at: iso(NOW) }), NOW);
        // #1: expiry is TERMINAL — a replayed active event (even with a future
        // renews_at) cannot un-revoke it. The record STAYS revoked.
        await applyMorEvent(env(kv), subEvent("subscription_created", { status: "active", renews_at: iso(NOW - 1000) }), NOW);
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });
});

describe("refund / chargeback", () => {
    it("order_refunded resolves the key via the ORDER id (data.id) and revokes", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        // Order object: data.id IS the order id; attrs has no order_id.
        const refund = { meta: { event_name: "order_refunded" }, data: { type: "orders", id: ORDER, attributes: { status: "refunded" } } };
        const r = await applyMorEvent(env(kv), refund, NOW);
        expect(r.action).toBe("applied");
        expect(rec(kv)!.status).toBe("revoked");
    });
    it("payment_failed is ignored — never revokes", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        const pf = { meta: { event_name: "subscription_payment_failed" }, data: { type: "subscription-invoices", id: "inv_1", attributes: { subscription_id: 7001 } } };
        const r = await applyMorEvent(env(kv), pf, NOW);
        expect(r.action).toBe("ignored_dunning");
        expect(rec(kv)!.status).toBe("active");
    });
});

describe("order-independent delivery (staging via pending:<order_id>)", () => {
    it("a subscription event arriving BEFORE the key is folded in at creation", async () => {
        const kv = fakeKV();
        const renews = NOW + 30 * 86_400_000;
        const staged = await applyMorEvent(env(kv), subEvent("subscription_created", { status: "active", renews_at: iso(renews) }), NOW);
        expect(staged.action).toBe("staged");
        expect(rec(kv)).toBeUndefined(); // no code yet
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(rec(kv)!.expiresAt).toBe(renews);
        expect(rec(kv)!.mor_subscription_id).toBe(SUB);
        expect(kv._dump()[`pending:${ORDER}`]).toBeUndefined(); // consumed
    });
    it("a refund racing ahead of the key still lands as revoked once the key arrives", async () => {
        const kv = fakeKV();
        const refund = { meta: { event_name: "order_refunded" }, data: { type: "orders", id: ORDER, attributes: {} } };
        await applyMorEvent(env(kv), refund, NOW);
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(rec(kv)!.status).toBe("revoked");
    });
});

// ===========================================================================
//  Signature + transport (drives the real worker.fetch)
// ===========================================================================
const SECRET = "whsec_test_signing_secret";
async function sign(body: string, secret = SECRET): Promise<string> {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const post = (body: string, headers: Record<string, string>, e: Env) =>
    worker.fetch(new Request("https://relay/webhook/mor", { method: "POST", body, headers }), e, ctx);

describe("/webhook/mor — signature & transport", () => {
    const body = () => JSON.stringify(licenseCreated());

    it("503 when the secret is unset (never a silent 200)", async () => {
        const res = await post(body(), { "x-signature": "deadbeef" }, env(fakeKV()));
        expect(res.status).toBe(503);
    });
    it("valid signature ⇒ 200, mirrors the event, and NEVER echoes the code", async () => {
        const kv = fakeKV();
        const b = body();
        const res = await post(b, { "x-signature": await sign(b) }, env(kv, { MOR_WEBHOOK_SECRET: SECRET }));
        expect(res.status).toBe(200);
        const json = await res.json() as any;
        expect(json).toEqual({ ok: true });
        expect(JSON.stringify(json)).not.toContain(KEY); // the minted code must not leak in the body
        expect(kv._dump()[`code:${KEY}`]).toBeDefined();
    });
    it("tampered body ⇒ 401 and no state change", async () => {
        const kv = fakeKV();
        const b = body();
        const goodSig = await sign(b);
        const res = await post(b.replace(ORDER, "6666"), { "x-signature": goodSig }, env(kv, { MOR_WEBHOOK_SECRET: SECRET }));
        expect(res.status).toBe(401);
        expect(Object.keys(kv._dump()).length).toBe(0);
    });
    it("tampered signature ⇒ 401", async () => {
        const b = body();
        const res = await post(b, { "x-signature": (await sign(b)).replace(/.$/, "0") }, env(fakeKV(), { MOR_WEBHOOK_SECRET: SECRET }));
        expect(res.status).toBe(401);
    });
    it("missing X-Signature header ⇒ 401", async () => {
        const res = await post(body(), {}, env(fakeKV(), { MOR_WEBHOOK_SECRET: SECRET }));
        expect(res.status).toBe(401);
    });
    it("wrong-length signature ⇒ 401 without throwing", async () => {
        const res = await post(body(), { "x-signature": "abc" }, env(fakeKV(), { MOR_WEBHOOK_SECRET: SECRET }));
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
    it("(1a) refund → replayed active subscription_updated{future renews_at} STAYS revoked (refund bypass closed)", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_created", { status: "active", renews_at: iso(NOW + 30 * DAY) }), NOW);
        // refund arrives on the ORDER object (data.id == order id)
        const refund = { meta: { event_name: "order_refunded" }, data: { type: "orders", id: ORDER, attributes: {} } };
        await applyMorEvent(env(kv), refund, NOW);
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false });
        // duplicate / out-of-order / replayed active renewal with a STILL-FUTURE expiry
        await applyMorEvent(env(kv), subEvent("subscription_updated", { status: "active", renews_at: iso(NOW + 60 * DAY) }), NOW);
        expect(rec(kv)!.status).toBe("revoked");
        expect(rec(kv)!.terminal).toBe(true);
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });
    it("(1b) subscription_expired → later active event STAYS revoked", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_expired", { status: "expired", ends_at: iso(NOW) }), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_updated", { status: "active", renews_at: iso(NOW + 60 * DAY) }), NOW);
        expect(rec(kv)!.status).toBe("revoked");
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false, reason: "revoked" });
    });
    it("(1c) REGRESSION: a plain cancel is NOT terminal — an active event within the period still works", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subEvent("subscription_cancelled", { status: "cancelled", ends_at: iso(NOW + 5 * DAY) }), NOW);
        // customer changes their mind: an active event lands before the period ends
        await applyMorEvent(env(kv), subEvent("subscription_updated", { status: "active", renews_at: iso(NOW + 35 * DAY) }), NOW);
        expect(rec(kv)!.status).toBe("active");
        expect(rec(kv)!.terminal).toBeUndefined();
        expect(rec(kv)!.expiresAt).toBe(NOW + 35 * DAY);
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: true });
    });
});

describe("#2 subscription codes always carry a finite expiry (never-expire paywall bypass closed)", () => {
    it("(2a) a subscription code with ONLY license_key_created has a finite provisional expiry and lapses after GRACE", async () => {
        const kv = fakeKV();
        const longAgo = Date.now() - 10 * DAY; // provisional (=now+3d) is already in the past
        await applyMorEvent(env(kv), licenseCreated(), longAgo); // v_month == subscription tier
        const r = rec(kv)!;
        expect(typeof r.expiresAt).toBe("number");
        expect(r.expiresAt).toBe(longAgo + 3 * DAY); // now + GRACE (3 days)
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false, reason: "expired" });
    });
    it("(2b) an active subscription event with NO renews_at does not clear the provisional expiry", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        const prov = rec(kv)!.expiresAt;
        expect(typeof prov).toBe("number");
        await applyMorEvent(env(kv), subEvent("subscription_updated", { status: "active" }), NOW); // no renews_at
        expect(rec(kv)!.expiresAt).toBe(prov);
    });
    it("(2c) a lifetime (one-time) code correctly has NO expiresAt", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated({ meta: { variant_id: "v_life" } }), NOW);
        expect(rec(kv)!.expiresAt).toBeUndefined();
    });
});

describe("#4 staged pending:<order_id> self-purges (no KV bloat / latent state)", () => {
    it("writes pending with an expirationTtl", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), subEvent("subscription_created", { status: "active", renews_at: iso(NOW + 30 * DAY) }), NOW);
        expect(kv._dump()[`pending:${ORDER}`]).toBeDefined();
        expect(kv._opts(`pending:${ORDER}`)?.expirationTtl).toBeGreaterThan(0);
    });
});

describe("#5 a paid code minted with no order_id is refused (never un-revokable)", () => {
    it("does not mint a usable active code", async () => {
        const kv = fakeKV();
        const r = await applyMorEvent(env(kv), licenseCreated({ attrs: { order_id: "" } }), NOW);
        expect(r.action).toBe("ignored_no_order");
        expect(rec(kv)).toBeUndefined();
        expect(kv._dump()[`order:`]).toBeUndefined();
        expect(await authCode(env(kv), KEY)).toMatchObject({ ok: false });
    });
});
