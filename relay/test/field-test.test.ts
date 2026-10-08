import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { applyMorEvent, type Env } from "../src/codes";
import { CKO_LOCK_WAIT_MS, DEFAULT_CHECKOUT_RETURN_URL, discordReturnUrl, installHash, PURCHASE_STATUS_PER_MINUTE } from "../src/checkout";
import { CKO_LOCK_STALE_MS, Promo } from "../src/promo";
import { fakeBudget, fakeDOStorage, fakeKV } from "./kv-mock";

// ===========================================================================
//  Field test 2026-10-08 (docs/audits/field-test-2026-10-08.md), relay items
//  R6 (refunds and disputes, through the signed webhook), R7 (public purchase
//  status), R8 (site links) and G1 (one checkout at a time per install+kind
//  across Cloudflare locations). Each block fails on the code before its fix.
// ===========================================================================

declare global { interface ImportMeta { url: string } }
const { readFileSync, readdirSync } = await import("node:" + "fs") as {
    readFileSync: (p: URL, enc: string) => string; readdirSync: (p: URL) => string[];
};

const VARIANTS = {
    pdt_month: { plan: "monthly", dailyCap: 2000 },
    pdt_year: { plan: "annual", dailyCap: 2000 },
    pdt_auto: { plan: "automatic", dailyCap: 5 }
};
const A = "free_" + "a".repeat(32);
const CLIENT = "vcTranslate/0.2.3";
const DAY = 86_400_000;
// Dodo-shaped ids (prefix + 21 letters/digits), as the return URL carries them.
const PAY = "pay_2IjeQm4hqU6RA4Z4kwDee";
const PAY_AI = "pay_7HbqX0aLmN3pQrStUvWxY";
const SUB = "sub_9KcdE1fGhIjK2lMnOpQrS";
const KEY_AUTO = "SUBL-AUTO-1111-2222";
const KEY_AI = "SUBL-AI-3333-4444";

/** A fake PROMO namespace that runs the REAL Promo class, one per name. */
function fakePromo(opts: { down?: boolean } = {}) {
    const objects = new Map<string, Promo>();
    const names: string[] = [];
    const get = (name: string) => {
        let o = objects.get(name);
        if (!o) {
            const { storage } = fakeDOStorage();
            o = new Promo({ storage, blockConcurrencyWhile: async (fn: () => Promise<void>) => fn() } as unknown as DurableObjectState);
            objects.set(name, o);
        }
        return o;
    };
    const ns = {
        idFromName: (n: string) => n,
        get: (n: string) => ({
            fetch: async (url: string, init?: any) => {
                if (opts.down) throw new Error("durable object unreachable");
                names.push(n);
                return get(n).fetch(new Request(url, init));
            }
        })
    } as unknown as DurableObjectNamespace;
    return { ns, names, objects, opts };
}

// --- Standard Webhooks signing, exactly as Dodo does it (see dodo.test.ts) --
const RAW_KEY = new TextEncoder().encode("dodo-relay-signing-key-bytes");
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const SECRET = "whsec_" + b64(RAW_KEY);
let msgN = 0;
async function webhook(e: Env, type: string, data: Record<string, unknown>) {
    const body = JSON.stringify({ business_id: "biz_1", type, timestamp: new Date().toISOString(), data });
    const id = `msg_${++msgN}`;
    const ts = Math.floor(Date.now() / 1000).toString();
    const k = await crypto.subtle.importKey("raw", RAW_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${id}.${ts}.${body}`));
    const res = await worker.fetch(new Request("https://relay/webhook/mor", {
        method: "POST", body,
        headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": "v1," + b64(new Uint8Array(mac)) }
    }), e, ctx);
    expect(res.status).toBe(200);
}

const budgets = new WeakMap<object, ReturnType<typeof fakeBudget>>();
const budgetOf = (kv: any) => { let b = budgets.get(kv); if (!b) { b = fakeBudget(); budgets.set(kv, b); } return b; };
const env = (kv: any, over: Partial<Env> = {}): Env => ({
    CODES: kv, GROQ_KEY: "gk", ADMIN_TOKEN: "admintok", MODEL: "m", BUDGET: budgetOf(kv).ns,
    VARIANTS, DODO_API_KEY: "dodo_secret", MOR_WEBHOOK_SECRET: SECRET, LAUNCH_AT: String(Date.now() - 30 * DAY), ...over
});
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const v2Headers = (install: string, bearer: string = install, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${bearer}`, "x-subline-client": CLIENT, "x-subline-api": "2",
    "x-subline-install": install, "content-type": "application/json", ...extra
});
/** The plugin's entitlement check (index.tsx refreshEntitlement → GET /v1/status, v2). */
const status = async (e: Env, install: string, bearer?: string) => {
    const res = await worker.fetch(new Request("https://relay/v1/status", { headers: v2Headers(install, bearer) }), e, ctx);
    return { status: res.status, body: await res.json() as any };
};

/** Automatic, then AI, bought from install A, every step a signed webhook. */
async function buyBoth(e: Env) {
    const hash = await installHash(A);
    await webhook(e, "payment.succeeded", { payload_type: "Payment", payment_id: PAY, product_cart: [{ product_id: "pdt_auto", quantity: 1 }], metadata: { install: hash }, status: "succeeded" });
    await webhook(e, "license_key.created", { payload_type: "LicenseKey", id: "lic_1", key: KEY_AUTO, product_id: "pdt_auto", payment_id: PAY, subscription_id: null, status: "active" });
    expect((await status(e, A, KEY_AUTO)).body).toMatchObject({ automatic: true, ai: false });
    await webhook(e, "payment.succeeded", { payload_type: "Payment", payment_id: PAY_AI, subscription_id: SUB, metadata: { install: hash }, status: "succeeded" });
    await webhook(e, "license_key.created", { payload_type: "LicenseKey", id: "lic_2", key: KEY_AI, product_id: "pdt_month", payment_id: PAY_AI, subscription_id: SUB, status: "active" });
    await webhook(e, "subscription.active", { payload_type: "Subscription", subscription_id: SUB, product_id: "pdt_month", status: "active", next_billing_date: new Date(Date.now() + 30 * DAY).toISOString() });
    expect((await status(e, A, KEY_AUTO)).body).toMatchObject({ automatic: true, ai: true });
}

const refund = (payment_id: string, over: Record<string, unknown> = {}) => ({
    payload_type: "Refund", refund_id: "ref_1", business_id: "biz_1", payment_id, is_partial: false,
    status: "succeeded", amount: 499, currency: "USD", reason: null, created_at: new Date().toISOString(), ...over
});
const dispute = (payment_id: string, dispute_status: string) => ({
    payload_type: "Dispute", dispute_id: "dis_1", business_id: "biz_1", payment_id, amount: "4.99", currency: "USD",
    dispute_stage: "chargeback", dispute_status, created_at: new Date().toISOString()
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// ---------------------------------------------------------------------------
describe("R6. refunds and lost disputes take the code; nothing else does (signed webhooks)", () => {
    for (const [type, data] of [
        ["refund.succeeded", refund(PAY)],
        ["dispute.lost", dispute(PAY, "dispute_lost")],
        ["dispute.accepted", dispute(PAY, "dispute_accepted")]
    ] as const) {
        it(`${type} on the Automatic payment → the next entitlement check says not active`, async () => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            const e = env(fakeKV(), { PROMO: fakePromo().ns });
            await buyBoth(e);
            await webhook(e, type, data);
            // What a running Discord sees on its next check with the saved code:
            // Automatic gone (AI alone stays, it was paid for separately) and the
            // code reported dead, so the plugin drops it.
            const s = await status(e, A, KEY_AUTO);
            expect(s.status).toBe(200);
            expect(s.body).toMatchObject({ automatic: false, ai: true, deadCode: KEY_AUTO });
        });
    }

    it("refund.succeeded on the AI payment ends AI; with only Automatic left the plan is Automatic", async () => {
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        await buyBoth(e);
        await webhook(e, "refund.succeeded", refund(PAY_AI));
        expect((await status(e, A, KEY_AI)).body).toMatchObject({ automatic: true, ai: false, deadCode: KEY_AI });
        // A legacy (v1) status check with the refunded code is refused outright.
        const v1 = await worker.fetch(new Request("https://relay/v1/status", { headers: { authorization: `Bearer ${KEY_AI}` } }), e, ctx);
        expect(v1.status).toBe(403);
    });

    it("both refunded → not activated at the next check (automatic:false, ai:false)", async () => {
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        await buyBoth(e);
        await webhook(e, "refund.succeeded", refund(PAY));
        await webhook(e, "dispute.lost", dispute(PAY_AI, "dispute_lost"));
        expect((await status(e, A, KEY_AUTO)).body).toMatchObject({ automatic: false, ai: false });
        expect((await status(e, A)).body).toMatchObject({ automatic: false, ai: false });
    });

    const keep: [string, string, Record<string, unknown>][] = [
        ["refund pending", "refund.succeeded", refund(PAY, { status: "pending" })],
        ["refund in review", "refund.succeeded", refund(PAY, { status: "review" })],
        ["refund failed (status)", "refund.succeeded", refund(PAY, { status: "failed" })],
        ["refund.failed", "refund.failed", refund(PAY, { status: "failed" })],
        ["partial refund", "refund.succeeded", refund(PAY, { is_partial: true, amount: 1 })],
        ["refund with no payment id", "refund.succeeded", refund("", { payment_id: undefined })],
        ["refund of another payment", "refund.succeeded", refund("pay_SomeoneElse0000000000")],
        ["dispute.opened", "dispute.opened", dispute(PAY, "dispute_opened")],
        ["dispute.challenged", "dispute.challenged", dispute(PAY, "dispute_challenged")],
        ["dispute.won", "dispute.won", dispute(PAY, "dispute_won")],
        ["dispute.cancelled", "dispute.cancelled", dispute(PAY, "dispute_cancelled")],
        ["dispute.expired", "dispute.expired", dispute(PAY, "dispute_expired")]
    ];
    for (const [label, type, data] of keep) {
        it(`${label} → the code stays active`, async () => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            const kv = fakeKV();
            const e = env(kv, { PROMO: fakePromo().ns });
            await buyBoth(e);
            await webhook(e, type, data);
            const s = await status(e, A, KEY_AUTO);
            expect(s.body).toMatchObject({ automatic: true, ai: true });
            expect(s.body.deadCode).toBeUndefined();
            const rec = JSON.parse(kv._dump()[`code:${KEY_AUTO}`]!);
            expect(rec.status).toBe("active");
            expect(rec.terminal).toBeUndefined();
        });
    }

    it("a partial refund is logged with its payment, never silently ignored", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const kv = fakeKV();
        const e = env(kv);
        await applyMorEvent(e, { type: "license_key.created", data: { key: KEY_AUTO, product_id: "pdt_auto", payment_id: PAY } }, Date.now());
        expect((await applyMorEvent(e, { type: "refund.succeeded", data: refund(PAY, { is_partial: true }) }, Date.now())).action).toBe("ignored_partial_refund");
        expect(warn).toHaveBeenCalledWith("partial refund: code kept", { payment: PAY });
        expect((await applyMorEvent(e, { type: "refund.succeeded", data: refund(PAY, { status: "review" }) }, Date.now())).action).toBe("ignored_refund_not_succeeded");
        // A full refund after them still revokes.
        await applyMorEvent(e, { type: "refund.succeeded", data: refund(PAY) }, Date.now());
        expect(JSON.parse(kv._dump()[`code:${KEY_AUTO}`]!)).toMatchObject({ status: "revoked", terminal: true });
    });
});

// ---------------------------------------------------------------------------
describe("R7. GET /v1/purchase-status for the thanks page", () => {
    const get = (e: Env, query: string, headers: Record<string, string> = {}) =>
        worker.fetch(new Request(`https://relay/v1/purchase-status${query}`, { headers }), e, ctx);
    const state = async (e: Env, query: string) => {
        const res = await get(e, query);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(Object.keys(body)).toEqual(["state"]); // never anything else
        return body.state as string;
    };

    it("unknown → pending (paid, key on its way) → active, for the payment and the subscription", async () => {
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        expect(await state(e, `?payment_id=${PAY_AI}`)).toBe("unknown");
        await webhook(e, "payment.succeeded", { payment_id: PAY_AI, subscription_id: SUB, metadata: {}, status: "succeeded" });
        expect(await state(e, `?payment_id=${PAY_AI}`)).toBe("pending");
        expect(await state(e, `?subscription_id=${SUB}`)).toBe("pending");
        await webhook(e, "license_key.created", { key: KEY_AI, product_id: "pdt_month", payment_id: PAY_AI, subscription_id: SUB });
        expect(await state(e, `?payment_id=${PAY_AI}`)).toBe("active");
        expect(await state(e, `?subscription_id=${SUB}`)).toBe("active");
    });

    it("a site purchase with no install (the /buy page) still turns active", async () => {
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        await webhook(e, "payment.succeeded", { payment_id: PAY, metadata: {}, status: "succeeded" });
        expect(await state(e, `?payment_id=${PAY}`)).toBe("pending");
        await webhook(e, "license_key.created", { key: KEY_AUTO, product_id: "pdt_auto", payment_id: PAY });
        expect(await state(e, `?payment_id=${PAY}`)).toBe("active");
    });

    it("processing → pending; failed or cancelled → failed; a late processing never undoes failed", async () => {
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        await webhook(e, "payment.processing", { payment_id: PAY, status: "processing" });
        expect(await state(e, `?payment_id=${PAY}`)).toBe("pending");
        await webhook(e, "payment.failed", { payment_id: PAY, status: "failed" });
        expect(await state(e, `?payment_id=${PAY}`)).toBe("failed");
        await webhook(e, "payment.processing", { payment_id: PAY, status: "processing" });
        expect(await state(e, `?payment_id=${PAY}`)).toBe("failed");
        await webhook(e, "payment.cancelled", { payment_id: "pay_Cancelled00000000000", status: "cancelled" });
        expect(await state(e, "?payment_id=pay_Cancelled00000000000")).toBe("failed");
    });

    it("a failed renewal never marks a paid subscription failed", async () => {
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        await webhook(e, "subscription.active", { subscription_id: SUB, product_id: "pdt_month", next_billing_date: new Date(Date.now() + 30 * DAY).toISOString() });
        await webhook(e, "payment.failed", { payment_id: "pay_Renewal000000000000", subscription_id: SUB, status: "failed" });
        expect(await state(e, `?subscription_id=${SUB}`)).toBe("pending");
    });

    it("a refunded purchase is not active (and never called failed)", async () => {
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        await webhook(e, "payment.succeeded", { payment_id: PAY, metadata: {}, status: "succeeded" });
        await webhook(e, "license_key.created", { key: KEY_AUTO, product_id: "pdt_auto", payment_id: PAY });
        await webhook(e, "refund.succeeded", refund(PAY));
        expect(await state(e, `?payment_id=${PAY}`)).toBe("unknown");
    });

    it("strict ids: anything but exactly one well-formed id is 400, before any read", async () => {
        const kv = fakeKV();
        const reads: string[] = [];
        const g = kv.get;
        (kv as any).get = async (k: string) => { reads.push(k); return g(k); };
        const e = env(kv, { PROMO: fakePromo().ns });
        for (const q of [
            "", "?payment_id=", `?payment_id=${PAY}&subscription_id=${SUB}`, `?payment_id=${PAY}&payment_id=${PAY}`,
            "?payment_id=sub_9KcdE1fGhIjK2lMnOpQrS", "?subscription_id=pay_2IjeQm4hqU6RA4Z4kwDee", "?payment_id=pay_short",
            "?payment_id=pay_" + "a".repeat(65), "?payment_id=pay_2IjeQm4hqU6RA4Z4kw%3Aee", "?payment_id=pay_2IjeQm4hqU6RA4Z4kw-ee",
            "?payment_id=PAY_2IjeQm4hqU6RA4Z4kwDee", "?id=pay_2IjeQm4hqU6RA4Z4kwDee", "?payment_id=%20pay_2IjeQm4hqU6RA4Z4kwDee"
        ]) {
            const res = await get(e, q);
            expect(res.status, q).toBe(400);
            expect(await res.json()).toEqual({ state: "unknown", error: "bad request" });
            expect(res.headers.get("cache-control")).toBe("no-store");
        }
        expect(reads).toEqual([]);
        expect((await worker.fetch(new Request(`https://relay/v1/purchase-status?payment_id=${PAY}`, { method: "POST" }), e, ctx)).status).toBe(405);
    });

    it("at most two KV reads and no KV write per poll", async () => {
        const kv = fakeKV();
        const e = env(kv, { PROMO: fakePromo().ns });
        await webhook(e, "payment.succeeded", { payment_id: PAY, metadata: {}, status: "succeeded" });
        await webhook(e, "license_key.created", { key: KEY_AUTO, product_id: "pdt_auto", payment_id: PAY });
        const reads: string[] = [], writes: string[] = [];
        const g = kv.get, p = kv.put;
        (kv as any).get = async (k: string) => { reads.push(k); return g(k); };
        (kv as any).put = async (k: string, v: string, o?: any) => { writes.push(k); return p(k, v, o); };
        for (const q of [`?payment_id=${PAY}`, `?payment_id=pay_Unknown000000000000000`, `?subscription_id=${SUB}`]) {
            reads.length = 0;
            await state(e, q);
            expect(reads.length, q).toBeLessThanOrEqual(2);
        }
        expect(writes).toEqual([]);
    });

    it("no personal data: never the key, email, plan or install", async () => {
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        await webhook(e, "payment.succeeded", { payment_id: PAY, metadata: { install: await installHash(A) }, customer: { email: "buyer@example.com" } });
        await webhook(e, "license_key.created", { key: KEY_AUTO, product_id: "pdt_auto", payment_id: PAY });
        const text = await (await get(e, `?payment_id=${PAY}`)).text();
        expect(text).toBe(JSON.stringify({ state: "active" }));
    });

    it("CORS for https://subline.page and the old github.io address only; preflight answered", async () => {
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        for (const origin of ["https://subline.page", "https://surfer05.github.io"]) {
            const res = await get(e, `?payment_id=${PAY}`, { origin });
            expect(res.headers.get("access-control-allow-origin")).toBe(origin);
            expect(res.headers.get("vary")).toBe("Origin");
        }
        for (const origin of ["https://evil.example", "http://subline.page", "https://subline.page.evil.example"]) {
            const res = await get(e, `?payment_id=${PAY}`, { origin });
            expect(res.status).toBe(200);
            expect(res.headers.get("access-control-allow-origin")).toBeNull();
        }
        const pre = await worker.fetch(new Request("https://relay/v1/purchase-status", { method: "OPTIONS", headers: { origin: "https://subline.page" } }), e, ctx);
        expect(pre.status).toBe(204);
        expect(pre.headers.get("access-control-allow-origin")).toBe("https://subline.page");
        expect(pre.headers.get("access-control-allow-methods")).toBe("GET");
    });

    it("cache-friendly: active may be cached; pending and unknown only for a poll", async () => {
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        expect((await get(e, `?payment_id=${PAY}`)).headers.get("cache-control")).toBe("public, max-age=3");
        await webhook(e, "payment.succeeded", { payment_id: PAY, metadata: {} });
        expect((await get(e, `?payment_id=${PAY}`)).headers.get("cache-control")).toBe("public, max-age=3");
        await webhook(e, "license_key.created", { key: KEY_AUTO, product_id: "pdt_auto", payment_id: PAY });
        expect((await get(e, `?payment_id=${PAY}`)).headers.get("cache-control")).toBe("public, max-age=300");
    });

    it(`rate-limited per address: ${PURCHASE_STATUS_PER_MINUTE} a minute, then 429; another address is not affected`, async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.UTC(2026, 9, 8, 12, 0, 5));
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        const ip = { "cf-connecting-ip": "203.0.113.7" };
        for (let i = 0; i < PURCHASE_STATUS_PER_MINUTE; i++) expect((await get(e, `?payment_id=${PAY}`, ip)).status).toBe(200);
        const over = await get(e, `?payment_id=${PAY}`, ip);
        expect(over.status).toBe(429);
        expect(await over.json()).toMatchObject({ state: "unknown", error: "slow down", retryAfterMs: 55_000 });
        expect((await get(e, `?payment_id=${PAY}`, { "cf-connecting-ip": "198.51.100.9" })).status).toBe(200);
        vi.setSystemTime(Date.UTC(2026, 9, 8, 12, 1, 0));
        expect((await get(e, `?payment_id=${PAY}`, ip)).status).toBe(200);
    });

    it("the limiter being down does not break the page (fail open, logged)", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const e = env(fakeKV(), { PROMO: fakePromo({ down: true }).ns });
        const res = await get(e, `?payment_id=${PAY}`, { "cf-connecting-ip": "203.0.113.7" });
        expect(res.status).toBe(200);
        expect(warn).toHaveBeenCalledWith("purchase status: rate limiter unreachable, allowing", expect.anything());
    });

    it("Dodo is never called", async () => {
        const f = vi.fn();
        vi.stubGlobal("fetch", f);
        const e = env(fakeKV(), { PROMO: fakePromo().ns });
        await get(e, `?payment_id=${PAY}`);
        await get(e, `?subscription_id=${SUB}`);
        expect(f).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe("R8. site links point at https://subline.page", () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
        .split("\n").map((l: string) => l.replace(/^\s*\/\/.*$/, "")).join("\n");

    it("wrangler.jsonc CHECKOUT_RETURN_URL and the code default", () => {
        expect(config).toMatch(/"CHECKOUT_RETURN_URL"\s*:\s*"https:\/\/subline\.page\/"/);
        expect(DEFAULT_CHECKOUT_RETURN_URL).toBe("https://subline.page/");
        expect(discordReturnUrl(undefined)).toBe("https://subline.page/?from=discord");
        expect(discordReturnUrl(undefined, "installer")).toBe("https://subline.page/?from=installer");
    });

    it("query strings keep working: ours is kept, Dodo's appended params parse beside it", () => {
        const u = new URL(discordReturnUrl("https://subline.page/?ref=x"));
        expect(u.searchParams.get("ref")).toBe("x");
        expect(u.searchParams.get("from")).toBe("discord");
        // Dodo appends its own parameters to whatever return_url it was given.
        const back = new URL(u.toString() + `&payment_id=${PAY}&status=succeeded`);
        expect(back.origin).toBe("https://subline.page");
        expect(back.searchParams.get("payment_id")).toBe(PAY);
        expect(back.searchParams.get("from")).toBe("discord");
    });

    it("no source file sends anyone to the old github.io site (only the CORS allow-list names it)", () => {
        const dir = new URL("../src/", import.meta.url);
        for (const f of readdirSync(dir)) {
            const text = readFileSync(new URL(f, dir), "utf8");
            const hits = text.split("\n").filter(l => l.includes("github.io") && !l.includes("SITE_ORIGINS"));
            expect(hits, f).toEqual([]);
        }
        expect(config).not.toContain("github.io");
    });
});

// ---------------------------------------------------------------------------
describe("G1. one checkout per install and kind, across Cloudflare locations", () => {
    const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
    /** Dodo: POST /checkouts makes cks_<n>; GET /checkouts/<id> answers `state[id]`
     *  (a payment_status, or "down" to throw). */
    const dodo = (state: Record<string, string | null> = {}) => {
        let n = 0;
        const posts: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
            const u = String(url);
            if (init?.method === "GET") {
                const id = u.split("/").pop()!;
                const st = id in state ? state[id] : null;
                if (st === "down") throw new Error("network down");
                return new Response(JSON.stringify({ id, payment_status: st }), { status: 200 });
            }
            n++;
            posts.push(u);
            // Dodo takes a moment, so concurrent requests really overlap.
            await new Promise(r => setTimeout(r, 20));
            return new Response(JSON.stringify({ session_id: "cks_" + n, checkout_url: "https://checkout.dodopayments.com/session/cks_" + n }), { status: 200 });
        }));
        return { posts, state };
    };
    /**
     * Two Cloudflare locations: one shared store, but a `cko:` / `checkout:`
     * row written at one location is not yet visible at the other (KV is
     * eventually consistent, ~60 s). Everything else is shared, so both
     * locations know the install owns Automatic.
     */
    function twoLocations() {
        const shared = fakeKV() as any;
        const view = (name: string) => {
            const local = new Map<string, string>();
            const lagging = (k: string) => k.startsWith("cko:") || k.startsWith("checkout:");
            return {
                get: async (k: string) => lagging(k) ? (local.has(k) ? local.get(k)! : null) : shared.get(k),
                put: async (k: string, v: string, o?: any) => lagging(k) ? void local.set(k, v) : shared.put(k, v, o),
                delete: async (k: string) => lagging(k) ? void local.delete(k) : shared.delete(k),
                _name: name
            } as unknown as KVNamespace;
        };
        return { shared, a: view("a"), b: view("b") };
    }
    async function setup() {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(T0);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const loc = twoLocations();
        const promo = fakePromo();
        const ea = env(loc.a, { PROMO: promo.ns, BUDGET: budgetOf(loc.shared).ns });
        const eb = env(loc.b, { PROMO: promo.ns, BUDGET: budgetOf(loc.shared).ns });
        const hash = await installHash(A);
        await applyMorEvent(ea, { type: "payment.succeeded", data: { payment_id: PAY, metadata: { install: hash } } }, T0);
        await applyMorEvent(ea, { type: "license_key.created", data: { key: KEY_AUTO, product_id: "pdt_auto", payment_id: PAY } }, T0);
        expect((await status(ea, A, KEY_AUTO)).body).toMatchObject({ automatic: true });
        return { ea, eb, promo, hash };
    }
    const checkout = (e: Env, plan: string) => worker.fetch(new Request("https://relay/v1/checkout", {
        method: "POST", headers: v2Headers(A, KEY_AUTO), body: JSON.stringify({ plan })
    }), e, ctx);

    it("two requests at the same moment through two locations → one Dodo session, the same URL", async () => {
        const { ea, eb } = await setup();
        const d = dodo();
        const [ra, rb] = await Promise.all([checkout(ea, "monthly"), checkout(eb, "monthly")]);
        expect(ra.status).toBe(200);
        expect(rb.status).toBe(200);
        const [a, b] = [await ra.json() as any, await rb.json() as any];
        expect(b.url).toBe(a.url);
        expect(d.posts).toHaveLength(1);
    });

    it("one after the other through two locations (KV not yet propagated) → still one session", async () => {
        const { ea, eb } = await setup();
        const d = dodo();
        const a = await (await checkout(ea, "annual")).json() as any;
        vi.setSystemTime(T0 + 1000);
        const b = await (await checkout(eb, "annual")).json() as any;
        expect(b.url).toBe(a.url);
        expect(d.posts).toHaveLength(1);
    });

    it("the first session already paid (no webhook yet) → the other location answers 409 purchase_pending", async () => {
        const { ea, eb } = await setup();
        const d = dodo();
        expect((await checkout(ea, "monthly")).status).toBe(200);
        d.state.cks_1 = "succeeded";
        const res = await checkout(eb, "annual");
        expect(res.status).toBe(409);
        expect((await res.json() as any).error).toBe("purchase_pending");
        expect(d.posts).toHaveLength(1);
    });

    it("keeps the 30-minute fallback: Dodo down → refused inside the window, allowed after it", async () => {
        const { ea, eb } = await setup();
        const d = dodo();
        expect((await checkout(ea, "monthly")).status).toBe(200);
        d.state.cks_1 = "down";
        vi.setSystemTime(T0 + 10 * 60_000);
        const inside = await checkout(eb, "monthly");
        expect(inside.status).toBe(409);
        expect((await inside.json() as any).error).toBe("purchase_pending");
        vi.setSystemTime(T0 + 30 * 60_000 + 1);
        expect((await checkout(eb, "monthly")).status).toBe(200);
        expect(d.posts).toHaveLength(2);
    });

    it("payment.failed clears the lock object's sessions too, so a retry opens even with Dodo down", async () => {
        const { ea, eb, hash } = await setup();
        const d = dodo();
        expect((await checkout(ea, "monthly")).status).toBe(200);
        await applyMorEvent(eb, { type: "payment.failed", data: { payment_id: "pay_Failed000000000000000", subscription_id: "sub_Failed000000000000000", checkout_session_id: "cks_1", product_id: "pdt_month", metadata: { install: hash } } }, T0);
        d.state.cks_1 = "down";
        vi.setSystemTime(T0 + 60_000);
        expect((await checkout(eb, "monthly")).status).toBe(200);
        expect(d.posts).toHaveLength(2);
    });

    it("Automatic and AI are separate locks: one never waits for the other", async () => {
        const { ea, promo, hash } = await setup();
        dodo();
        await checkout(ea, "monthly");
        expect(promo.names).toContain(`cko:${hash}:ai`);
        expect(promo.names).not.toContain(`cko:${hash}:automatic`);
    });

    it("a worker that died holding the lock blocks for at most a minute", async () => {
        const { ea, promo, hash } = await setup();
        const d = dodo();
        // Take the lock and never release it.
        const held = await (await (promo.ns.get(promo.ns.idFromName(`cko:${hash}:ai`)) as any).fetch("https://promo.internal/cko/begin", { method: "POST" })).json() as any;
        expect(held.result).toBe("go");
        vi.setSystemTime(T0 + CKO_LOCK_STALE_MS);
        expect((await checkout(ea, "monthly")).status).toBe(200);
        expect(d.posts).toHaveLength(1);
    });

    it("while another checkout holds the lock, a request waits, then gives up with a clean 503 and no session", async () => {
        const { ea, promo, hash } = await setup();
        const d = dodo();
        await (promo.ns.get(promo.ns.idFromName(`cko:${hash}:ai`)) as any).fetch("https://promo.internal/cko/begin", { method: "POST" });
        // Real timers (the poll waits), a frozen clock well inside the stale minute.
        vi.setSystemTime(T0 + 1000);
        const started = performance.now();
        const res = await checkout(ea, "monthly");
        expect(performance.now() - started).toBeGreaterThanOrEqual(CKO_LOCK_WAIT_MS - 50);
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ ok: false, error: "checkout unavailable" });
        expect(d.posts).toHaveLength(0);
    }, 20_000);

    it("lock object unreachable → 503 before any Dodo session (fail closed)", async () => {
        const { ea } = await setup();
        const d = dodo();
        const e = { ...ea, PROMO: fakePromo({ down: true }).ns };
        const res = await checkout(e, "monthly");
        expect(res.status).toBe(503);
        expect(d.posts).toHaveLength(0);
    });
});
