import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMorEvent, type Env } from "../src/codes";
import { COUPON_SUFFIX_ALPHABET, couponCode, installHash, linkFromKey, linkFromLifecycle, randomSuffix } from "../src/checkout";
import { codeRec, fakeBudget, fakeKV } from "./kv-mock";
import worker from "../src/index";

// Response shapes from docs.dodopayments.com:
//   POST /checkouts  → { session_id, checkout_url }   (checkout-session guide)
//   POST /discounts  → DiscountResponse { discount_id, business_id, type, code, amount, ... }
const VARIANTS = {
    pdt_month: { plan: "monthly", dailyCap: 2000 },
    pdt_year: { plan: "annual", dailyCap: 2000 }
};
const FREE = "free_" + "a".repeat(32);
const OTHER = "free_" + "b".repeat(32);
const CLIENT = "vcTranslate/0.1.10";
const KEY = "LK-ABCD-1234";
const PAY = "pay_1", SUB = "sub_1", SESSION = "cks_Gi6KGJ2zFJo9rq9Ukifwa";
const NOW = Date.now();

const env = (kv: any, over: Partial<Env> = {}): Env => ({
    CODES: kv, GROQ_KEY: "x", ADMIN_TOKEN: "admintok", MODEL: "m",
    BUDGET: fakeBudget().ns, VARIANTS, DODO_API_KEY: "dodo_secret", ...over
});
const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

let calls: { url: string; init: any }[] = [];
function mockFetch(status = 200, body: any = { session_id: SESSION, checkout_url: `https://checkout.dodopayments.com/session/${SESSION}` }) {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
        calls.push({ url: String(url), init });
        return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }));
}
beforeEach(() => mockFetch());
afterEach(() => vi.unstubAllGlobals());

const checkoutReq = (plan: unknown, bearer?: string, ip?: string, client: string | null = CLIENT) => new Request("https://relay/v1/checkout", {
    method: "POST",
    headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(ip ? { "cf-connecting-ip": ip } : {}),
        ...(client !== null ? { "x-subline-client": client } : {})
    },
    body: JSON.stringify({ plan })
});

describe("POST /v1/checkout", () => {
    it("503s without DODO_API_KEY and writes nothing", async () => {
        const kv = fakeKV();
        const res = await worker.fetch(checkoutReq("monthly", FREE, "1.2.3.4"), env(kv, { DODO_API_KEY: undefined }), ctx);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ ok: false, error: "checkout unavailable" });
        expect(kv._dump()).toEqual({});
        expect(calls).toHaveLength(0);
    });

    it("creates a session with the product, return url, install hash and key", async () => {
        const kv = fakeKV();
        const res = await worker.fetch(checkoutReq("annual", FREE), env(kv), ctx);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, url: `https://checkout.dodopayments.com/session/${SESSION}` });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe("https://live.dodopayments.com/checkouts");
        expect(calls[0]!.init.headers.authorization).toBe("Bearer dodo_secret");
        const sent = JSON.parse(calls[0]!.init.body);
        const hash = await installHash(FREE);
        expect(hash).toMatch(/^[0-9a-f]{16}$/);
        expect(sent).toEqual({
            product_cart: [{ product_id: "pdt_year", quantity: 1 }],
            return_url: "https://surfer05.github.io/subline/",
            feature_flags: { redirect_immediately: true },
            metadata: { install: hash }
        });
        // Never the raw id.
        expect(calls[0]!.init.body).not.toContain(FREE);
        expect(kv._dump()[`checkout:${SESSION}`]).toBe(hash);
        expect(kv._opts(`checkout:${SESSION}`)).toEqual({ expirationTtl: 2 * 86_400 });
    });

    it("honours DODO_API_BASE and CHECKOUT_RETURN_URL", async () => {
        await worker.fetch(checkoutReq("monthly", FREE),
            env(fakeKV(), { DODO_API_BASE: "https://test.dodopayments.com", CHECKOUT_RETURN_URL: "https://x.test/" }), ctx);
        expect(calls[0]!.url).toBe("https://test.dodopayments.com/checkouts");
        const sent = JSON.parse(calls[0]!.init.body);
        expect(sent.product_cart[0].product_id).toBe("pdt_month");
        expect(sent.return_url).toBe("https://x.test/");
    });

    it("refuses anonymous or header-less checkout before any KV access or Dodo call", async () => {
        const cases: [Request, number, string][] = [
            [checkoutReq("monthly", undefined, "1.2.3.4"), 401, "unauthorized"],   // no bearer: no anonymous checkout
            [checkoutReq("monthly", "free_nothex", "1.2.3.4"), 400, "bad request"],
            [checkoutReq("monthly", FREE, "1.2.3.4", null), 400, "bad request"],    // no client header
            [checkoutReq("monthly", FREE, "1.2.3.4", "bad header!"), 400, "bad request"]
        ];
        for (const [req, status, error] of cases) {
            let touched = 0;
            const kv = fakeKV();
            const spy = {
                get: async (k: string) => { touched++; return kv.get(k); },
                put: async (k: string, v: string, o?: any) => { touched++; return kv.put(k, v, o); },
                delete: async (k: string) => { touched++; return kv.delete(k); }
            } as unknown as KVNamespace;
            const res = await worker.fetch(req, env(spy), ctx);
            expect(res.status).toBe(status);
            expect(await res.json()).toEqual({ ok: false, error });
            expect(touched).toBe(0);
        }
        expect(calls).toHaveLength(0);
    });

    it("rejects a bad plan, a non-free bearer, and GET", async () => {
        for (const r of [
            checkoutReq("lifetime", FREE),
            checkoutReq("monthly", "slp_abc"),
            checkoutReq("monthly", "free_nothex")
        ]) {
            const res = await worker.fetch(r, env(fakeKV()), ctx);
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ ok: false, error: "bad request" });
        }
        const get = await worker.fetch(new Request("https://relay/v1/checkout"), env(fakeKV()), ctx);
        expect(get.status).toBe(405);
        expect(calls).toHaveLength(0);
    });

    it("503s when Dodo refuses or returns no checkout_url", async () => {
        mockFetch(401, { code: "UNAUTHORIZED", message: "bad key" });
        let res = await worker.fetch(checkoutReq("monthly", FREE), env(fakeKV()), ctx);
        expect(res.status).toBe(503);
        mockFetch(200, { session_id: SESSION, checkout_url: null });
        res = await worker.fetch(checkoutReq("monthly", FREE), env(fakeKV()), ctx);
        expect(res.status).toBe(503);
    });

    it("limits one install to 6 an hour", async () => {
        const kv = fakeKV();
        for (let i = 0; i < 6; i++) expect((await worker.fetch(checkoutReq("monthly", FREE), env(kv), ctx)).status).toBe(200);
        const res = await worker.fetch(checkoutReq("monthly", FREE), env(kv), ctx);
        expect(res.status).toBe(429);
        const body: any = await res.json();
        expect(body.error).toBe("slow down");
        expect(body.retryAfterMs).toBeGreaterThan(0);
        expect(calls).toHaveLength(6);
        // Another install is not affected.
        expect((await worker.fetch(checkoutReq("monthly", OTHER), env(kv), ctx)).status).toBe(200);
    });

    it("limits one IP to 20 an hour across installs", async () => {
        const kv = fakeKV();
        for (let i = 0; i < 20; i++) {
            const id = "free_" + i.toString(16).padStart(32, "0");
            expect((await worker.fetch(checkoutReq("monthly", id, "9.9.9.9"), env(kv), ctx)).status).toBe(200);
        }
        const res = await worker.fetch(checkoutReq("monthly", "free_" + "f".repeat(32), "9.9.9.9"), env(kv), ctx);
        expect(res.status).toBe(429);
        expect(calls).toHaveLength(20);
        expect((await worker.fetch(checkoutReq("monthly", "free_" + "e".repeat(32), "8.8.8.8"), env(kv), ctx)).status).toBe(200);
    });
});

// ---------------------------------------------------------------- linking --
const licenseCreated = (over: any = {}) => ({
    type: "license_key.created",
    data: { payload_type: "LicenseKey", key: KEY, product_id: "pdt_month", subscription_id: SUB, payment_id: PAY, ...over }
});
const paymentSucceeded = (over: any = {}) => ({
    type: "payment.succeeded",
    data: { payload_type: "Payment", payment_id: PAY, subscription_id: SUB, checkout_session_id: SESSION, status: "succeeded", metadata: {}, ...over }
});
const subActive = (over: any = {}) => ({
    type: "subscription.active",
    data: {
        payload_type: "Subscription", subscription_id: SUB, product_id: "pdt_month", status: "active",
        next_billing_date: new Date(NOW + 30 * 86_400_000).toISOString(), metadata: {}, ...over
    }
});

describe("webhook linking: purchase → install", () => {
    let hash: string;
    beforeEach(async () => { hash = await installHash(FREE); });

    it("license first, then payment with metadata", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(kv._dump()[`paid:${hash}`]).toBeUndefined();
        await applyMorEvent(env(kv), paymentSucceeded({ metadata: { install: hash } }), NOW);
        expect(kv._dump()[`paid:${hash}`]).toBe(KEY);
        expect(kv._opts(`paid:${hash}`)).toEqual({ expirationTtl: 30 * 86_400 });
    });

    it("payment first, then license", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), paymentSucceeded({ metadata: { install: hash } }), NOW);
        expect(kv._dump()[`inst:${PAY}`]).toBe(hash);
        expect(kv._opts(`inst:${PAY}`)).toEqual({ expirationTtl: 3 * 86_400 });
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(kv._dump()[`paid:${hash}`]).toBe(KEY);
    });

    it("subscription first, then license (subscription id only)", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), subActive({ metadata: { install: hash } }), NOW);
        expect(kv._dump()[`inst:${SUB}`]).toBe(hash);
        await applyMorEvent(env(kv), licenseCreated({ payment_id: PAY }), NOW);
        expect(kv._dump()[`paid:${hash}`]).toBe(KEY);
    });

    it("license first, then subscription with metadata", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        await applyMorEvent(env(kv), subActive({ metadata: { install: hash } }), NOW);
        expect(kv._dump()[`paid:${hash}`]).toBe(KEY);
        // The existing state machine still ran: expiry moved to next_billing_date.
        expect(JSON.parse(kv._dump()[`code:${KEY}`]!).expiresAt).toBeGreaterThan(NOW + 20 * 86_400_000);
    });

    it("falls back to the checkout session row when metadata is missing", async () => {
        const kv = fakeKV({ [`checkout:${SESSION}`]: hash });
        await applyMorEvent(env(kv), paymentSucceeded({ metadata: {} }), NOW);
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(kv._dump()[`paid:${hash}`]).toBe(KEY);
    });

    it("ignores malformed metadata and unknown sessions", async () => {
        const kv = fakeKV();
        await applyMorEvent(env(kv), paymentSucceeded({ metadata: { install: FREE }, checkout_session_id: "cks_unknown" }), NOW);
        await applyMorEvent(env(kv), subActive({ metadata: { install: "ZZZZ" } }), NOW);
        await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(Object.keys(kv._dump()).filter(k => k.startsWith("paid:") || k.startsWith("inst:"))).toEqual([]);
        // The code was still minted.
        expect(kv._dump()[`code:${KEY}`]).toBeDefined();
    });

    it("replays are idempotent", async () => {
        const kv = fakeKV();
        for (let i = 0; i < 2; i++) {
            await applyMorEvent(env(kv), paymentSucceeded({ metadata: { install: hash } }), NOW);
            await applyMorEvent(env(kv), licenseCreated(), NOW);
        }
        expect(kv._dump()[`paid:${hash}`]).toBe(KEY);
        expect(Object.keys(kv._dump()).filter(k => k.startsWith("code:"))).toEqual([`code:${KEY}`]);
    });

    // A KV whose `key` reads null the first time and `value` afterwards: the
    // counterpart row written by a concurrent webhook just after our first look.
    const lateRow = (key: string, value: string) => {
        const kv = fakeKV();
        const get = kv.get.bind(kv);
        let seen = 0;
        (kv as any).get = async (k: string) => (k === key ? (seen++ === 0 ? null : value) : get(k));
        return kv;
    };

    it("lifecycle side re-reads once and completes the link when the key appears late", async () => {
        const kv = lateRow(`order:${PAY}`, KEY);
        await linkFromLifecycle(env(kv), "payment.succeeded", { payment_id: PAY, metadata: { install: hash } });
        expect(kv._dump()[`paid:${hash}`]).toBe(KEY);
    });

    it("key side re-reads once and completes the link when the install appears late", async () => {
        const kv = lateRow(`inst:${PAY}`, hash);
        await linkFromKey(env(kv), KEY, [PAY]);
        expect(kv._dump()[`paid:${hash}`]).toBe(KEY);
    });

    it("a KV failure while linking never breaks minting", async () => {
        const kv = fakeKV({ [`inst:${PAY}`]: hash });
        const put = kv.put.bind(kv);
        (kv as any).put = async (k: string, v: string, o?: any) => {
            if (k.startsWith("paid:")) throw new Error("kv down");
            return put(k, v, o);
        };
        const r = await applyMorEvent(env(kv), licenseCreated(), NOW);
        expect(r.action).toBe("created");
        expect(kv._dump()[`code:${KEY}`]).toBeDefined();
    });
});

// ----------------------------------------------------------------- status --
const statusReq = (bearer: string, client = true) => new Request("https://relay/v1/status", {
    headers: { authorization: `Bearer ${bearer}`, ...(client ? { "x-subline-client": CLIENT } : {}) }
});

describe("GET /v1/status: purchase hand-back", () => {
    let hash: string;
    beforeEach(async () => { hash = await installHash(FREE); });
    const seeded = (rec: any = {}) => fakeKV({
        [`paid:${hash}`]: KEY,
        [`code:${KEY}`]: codeRec({ plan: "monthly", dailyCap: 2000, expiresAt: NOW + 30 * 86_400_000, ...rec })
    });

    it("gives the key to the header'd holder of the free id", async () => {
        const res = await worker.fetch(statusReq(FREE), env(seeded()), ctx);
        const body: any = await res.json();
        expect(body.purchase).toEqual({ code: KEY, plan: "monthly" });
    });

    it("never to another install", async () => {
        const body: any = await (await worker.fetch(statusReq(OTHER), env(seeded()), ctx)).json();
        expect(body.purchase).toBeUndefined();
    });

    it("never to a legacy (header-less) client, whose response is unchanged", async () => {
        const withPaid: any = await (await worker.fetch(statusReq(FREE, false), env(seeded()), ctx)).json();
        const without: any = await (await worker.fetch(statusReq(FREE, false), env(fakeKV()), ctx)).json();
        const { resetsInMs: _a, ...a } = withPaid; const { resetsInMs: _b, ...b } = without;
        expect(a).toEqual(b);
        expect(withPaid.purchase).toBeUndefined();
    });

    it("not for a revoked, terminal or expired code", async () => {
        for (const rec of [{ status: "revoked" }, { terminal: true }, { expiresAt: NOW - 1000 }]) {
            const body: any = await (await worker.fetch(statusReq(FREE), env(seeded(rec)), ctx)).json();
            expect(body.purchase).toBeUndefined();
            expect(body.ok).toBe(true);
        }
    });

    it("a KV failure on the lookup does not fail status", async () => {
        const kv = seeded();
        const get = kv.get.bind(kv);
        (kv as any).get = async (k: string) => { if (k.startsWith("paid:")) throw new Error("kv down"); return get(k); };
        const res = await worker.fetch(statusReq(FREE), env(kv), ctx);
        expect(res.status).toBe(200);
        expect(((await res.json()) as any).purchase).toBeUndefined();
    });

    it("end to end: checkout, webhooks in any order, status", async () => {
        const kv = fakeKV();
        const e = env(kv);
        expect((await worker.fetch(checkoutReq("monthly", FREE), e, ctx)).status).toBe(200);
        await applyMorEvent(e, licenseCreated(), Date.now());
        await applyMorEvent(e, paymentSucceeded({ metadata: {} }), Date.now()); // session-row join
        const body: any = await (await worker.fetch(statusReq(FREE), e, ctx)).json();
        expect(body.purchase).toEqual({ code: KEY, plan: "monthly" });
    });
});

// ---------------------------------------------------------------- coupons --
const couponReq = (body: any, token = "admintok") => new Request("https://relay/admin/coupon", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
});

describe("POST /admin/coupon", () => {
    it("normalises names and appends the suffix, at most 16 in all", () => {
        expect(couponCode("alex", "K7Q")).toBe("ALEXK7Q");
        expect(couponCode("Zehra K.", "K7Q")).toBe("ZEHRAKK7Q");
        expect(couponCode("jo-2", "K7Q")).toBe("JO2K7Q");
        expect(couponCode("rahul05", "K7Q")).toBe("RAHUL05K7Q");
        expect(couponCode("a very long friend name here", "K7Q")).toBe("AVERYLONGFRIEK7Q");
        expect(couponCode("a very long friend name here")!.length).toBe(16);
        expect(couponCode("ab")).toBeNull();
        expect(couponCode("é!")).toBeNull();
        expect(couponCode(5)).toBeNull();
    });

    it("the suffix is 3 characters from the unambiguous alphabet, from the crypto RNG", () => {
        expect(COUPON_SUFFIX_ALPHABET).not.toMatch(/[0O1I]/);
        const seen = new Set<string>();
        for (let i = 0; i < 300; i++) {
            const code = couponCode("rahul05")!;
            expect(code).toMatch(/^RAHUL05[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{3}$/);
            seen.add(code);
        }
        // 32^3 = 32768 possibilities; 300 draws are all but certain to vary widely.
        expect(seen.size).toBeGreaterThan(250);
        // Deterministic RNG: bytes at or above 256 (a multiple of 32) never occur,
        // so byte b maps to alphabet[b % 32]; 0 → A, 31 → 9, 32 → A.
        const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint8Array) => {
            a.set([0, 31, 33, ...new Array(13).fill(0)]); return a;
        }) as any);
        expect(randomSuffix()).toBe("A9B");
        spy.mockRestore();
    });

    it("two coupons for the same name get different codes", async () => {
        const codes: string[] = [];
        for (let i = 0; i < 2; i++) {
            mockFetch(200, { discount_id: "dsc_" + i, code: "echo" });
            await worker.fetch(couponReq({ name: "alex" }), env(fakeKV()), ctx);
            codes.push(JSON.parse(calls[0]!.init.body).code);
        }
        for (const c of codes) expect(c).toMatch(/^ALEX[A-HJ-NP-Z2-9]{3}$/);
        expect(codes[0]).not.toBe(codes[1]);
    });

    it("creates a 100% off, 3-cycle, single-use monthly discount with the suffixed code", async () => {
        mockFetch(200, { discount_id: "dsc_1", business_id: "bus_1", type: "percentage", code: "ALEXK7Q", amount: 10000, times_used: 0 });
        const res = await worker.fetch(couponReq({ name: "alex" }), env(fakeKV()), ctx);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, code: "ALEXK7Q", discount_id: "dsc_1" });
        expect(calls[0]!.url).toBe("https://live.dodopayments.com/discounts");
        expect(calls[0]!.init.headers.authorization).toBe("Bearer dodo_secret");
        const sent = JSON.parse(calls[0]!.init.body);
        expect(sent.code).toMatch(/^ALEX[A-HJ-NP-Z2-9]{3}$/);
        expect(sent).toEqual({
            type: "percentage", amount: 10000, code: sent.code, name: "alex",
            restricted_to: ["pdt_month"], subscription_cycles: 3, usage_limit: 1
        });
    });

    it("400s a name too short", async () => {
        const res = await worker.fetch(couponReq({ name: "a!" }), env(fakeKV()), ctx);
        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it("maps a Dodo error to 502 with its message", async () => {
        mockFetch(409, { code: "DUPLICATE", message: "discount code already exists" });
        const res = await worker.fetch(couponReq({ name: "alex" }), env(fakeKV()), ctx);
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ ok: false, error: "dodo 409: discount code already exists" });
    });

    it("needs the admin token and the Dodo key", async () => {
        expect((await worker.fetch(couponReq({ name: "alex" }, "wrong"), env(fakeKV()), ctx)).status).toBe(401);
        expect((await worker.fetch(couponReq({ name: "alex" }), env(fakeKV(), { DODO_API_KEY: undefined }), ctx)).status).toBe(503);
        expect(calls).toHaveLength(0);
    });
});
