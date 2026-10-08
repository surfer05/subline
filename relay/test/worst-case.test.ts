import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { applyMorEvent, costFor, reserve, type CodeRecord, type Env } from "../src/codes";
import { installHash } from "../src/checkout";
import { resolveEntitlement } from "../src/entitle";
import { applyBudget } from "../src/budget";
import { chunkBatch, MAX_PARALLEL_CHUNKS, translate, translateBatch, translateWithFallback, type BatchRequest, type Provider } from "../src/translate";
import { Promo } from "../src/promo";
import { codeRec, fakeBudget, fakeDOStorage, fakeKV } from "./kv-mock";

// ===========================================================================
//  WORST CASES (relay review, 2026-10). Each test here fails on the code
//  before its fix: the relay must sail through KV running out of writes, slow
//  or broken providers, long messages, a frozen budget, scripted promo drains
//  and oversized bodies.
// ===========================================================================

const VARIANTS = {
    pdt_month: { plan: "monthly", dailyCap: 2000 },
    pdt_year: { plan: "annual", dailyCap: 2000 },
    pdt_auto: { plan: "automatic", dailyCap: 5 }
};
const A = "free_" + "a".repeat(32);
const CLIENT = "vcTranslate/0.2.1";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);

const budgets = new WeakMap<object, ReturnType<typeof fakeBudget>>();
const budgetOf = (kv: any) => { let b = budgets.get(kv); if (!b) { b = fakeBudget(); budgets.set(kv, b); } return b; };

function fakePromo() {
    const objects = new Map<string, Promo>();
    const get = (name: string) => {
        let o = objects.get(name);
        if (!o) {
            const { storage } = fakeDOStorage();
            o = new Promo({ storage, blockConcurrencyWhile: async (fn: () => Promise<void>) => fn() } as unknown as DurableObjectState);
            objects.set(name, o);
        }
        return o;
    };
    return {
        idFromName: (n: string) => n,
        get: (n: string) => ({ fetch: (url: string, init?: any) => get(n).fetch(new Request(url, init)) })
    } as unknown as DurableObjectNamespace;
}

const env = (kv: any, over: Partial<Env> = {}): Env => ({
    CODES: kv, GROQ_KEY: "gk", ADMIN_TOKEN: "admintok", MODEL: "m", BUDGET: budgetOf(kv).ns,
    VARIANTS, DODO_API_KEY: "dodo_secret", LAUNCH_AT: String(T0 - 30 * DAY), ...over
});

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
async function settle() { while (pending.length) await Promise.all(pending.splice(0)); }

const v2Headers = (install: string, bearer: string = install, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${bearer}`, "x-subline-client": CLIENT, "x-subline-api": "2",
    "x-subline-install": install, "content-type": "application/json", ...extra
});
const status = async (e: Env, install: string, bearer?: string) => {
    const res = await worker.fetch(new Request("https://relay/v1/status", { headers: v2Headers(install, bearer) }), e, ctx);
    return { status: res.status, body: await res.json() as any };
};
const v2translate = async (e: Env, install: string, bearer: string, mode?: string) => {
    const res = await worker.fetch(new Request("https://relay/v1/translate", {
        method: "POST", headers: v2Headers(install, bearer),
        body: JSON.stringify({ messages: [{ id: "0", author: "a", text: "hola amigo" }], context: [], targetLang: "en", ...(mode ? { mode } : {}) })
    }), e, ctx);
    return { status: res.status, body: await res.json() as any };
};

/** A purchase made from `install`: the payment names it, then the key is created. */
async function buy(e: Env, install: string, key: string, product: string, pay: string, sub?: string, now = Date.now()) {
    const hash = await installHash(install);
    await applyMorEvent(e, { type: "payment.succeeded", data: { payment_id: pay, subscription_id: sub ?? null, metadata: { install: hash } } }, now);
    await applyMorEvent(e, { type: "license_key.created", data: { key, product_id: product, payment_id: pay, subscription_id: sub ?? null } }, now);
    if (sub) await applyMorEvent(e, { type: "subscription.active", data: { subscription_id: sub, next_billing_date: new Date(now + 30 * DAY).toISOString() } }, now);
}

const okModel = (rows: unknown[] = [{ id: "0", lang: "es", text: "hello friend", skip: false }]) => ({
    ok: true, status: 200, headers: new Headers(),
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations: rows }) } }] }),
    clone() { return this; }, text: async () => ""
});
const errModel = (status: number, headers: Record<string, string> = {}) => ({
    ok: false, status, headers: new Headers(headers), clone() { return this; }, text: async () => ""
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); pending.length = 0; });

// ---------------------------------------------------------------------------
describe("1. KV writes run out: the daily seen marker is best-effort", () => {
    it("day 2 with every KV put failing: status and AI translate still answer 200", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(T0);
        vi.stubGlobal("fetch", vi.fn(async () => okModel()));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const kv = fakeKV() as any;
        const e = env(kv);
        await buy(e, A, "KEY-AUTO", "pdt_auto", "pay_a");
        await status(e, A);
        await buy(e, A, "KEY-AI", "pdt_month", "pay_m", "sub_m");
        expect((await status(e, A, "KEY-AUTO")).body).toMatchObject({ automatic: true, ai: true });

        vi.setSystemTime(T0 + DAY);
        kv.put = async () => { throw new Error("KV put failed: 429 Too Many Requests"); };
        const s = await status(e, A, "KEY-AUTO");
        expect(s.status).toBe(200);
        expect(s.body).toMatchObject({ automatic: true, ai: true });
        const t = await v2translate(e, A, "KEY-AUTO");
        expect(t.status).toBe(200);
        expect(t.body.results[0]).toMatchObject({ text: "hello friend" });
        await settle();
    });
});

// ---------------------------------------------------------------------------
describe("2. 'Up to 2,000 ✦ a day' holds in ordinary live chat", () => {
    it("1 short message with 8 context lines costs 1, so the 2,000th still fits", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => okModel()));
        const kv = fakeKV({ "code:slp_ai": codeRec({ plan: "monthly", dailyCap: 2000 }) });
        const e = env(kv);
        const rec = JSON.parse(codeRec({ plan: "monthly", dailyCap: 2000 })) as CodeRecord;
        expect(await reserve(e, "slp_ai", rec, 1999, Date.now())).toMatchObject({ ok: true });
        const res = await worker.fetch(new Request("https://relay/v1/translate", {
            method: "POST", headers: { authorization: "Bearer slp_ai", "content-type": "application/json" },
            body: JSON.stringify({
                messages: [{ id: "0", author: "a", text: "x".repeat(100) }],
                context: Array.from({ length: 8 }, () => ({ author: "b", text: "y".repeat(90) })),
                targetLang: "en"
            })
        }), e, ctx);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, used: 2000, cap: 2000 });
    });

    it("an oversized prompt still pays for its size", () => {
        const rec: CodeRecord = { status: "active", plan: "monthly", dailyCap: 2000 };
        expect(costFor(rec, 1, 31_000)).toBeGreaterThanOrEqual(30);
        expect(costFor(rec, 5, 600)).toBe(5);
    });
});

// ---------------------------------------------------------------------------
//  Webhook signing (Standard Webhooks), for the router-level tests below.
const RAW_KEY = new TextEncoder().encode("worst-case-signing-key");
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const SECRET = "whsec_" + b64(RAW_KEY);
async function signedPost(e: Env, evt: unknown): Promise<Response> {
    const body = JSON.stringify(evt);
    const id = "msg_" + Math.random().toString(36).slice(2);
    const ts = Math.floor(Date.now() / 1000).toString();
    const k = await crypto.subtle.importKey("raw", RAW_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${id}.${ts}.${body}`));
    return worker.fetch(new Request("https://relay/webhook/mor", {
        method: "POST", body,
        headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": "v1," + b64(new Uint8Array(mac)) }
    }), e, ctx);
}

describe("3. a failed purchase-link write makes Dodo retry instead of losing the purchase", () => {
    it("inst: put fails on payment.succeeded → 500; the retry links and Automatic switches on", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const kv = fakeKV() as any;
        const put = kv.put;
        let broken = true;
        kv.put = async (k: string, v: string, o?: any) => { if (broken && k.startsWith("inst:")) throw new Error("KV down"); return put(k, v, o); };
        const e = env(kv, { MOR_WEBHOOK_SECRET: SECRET });
        const hash = await installHash(A);
        const pay = { type: "payment.succeeded", data: { payment_id: "pay_1", product_cart: [{ product_id: "pdt_auto" }], metadata: { install: hash } } };
        expect((await signedPost(e, pay)).status).toBe(500);
        broken = false;
        expect((await signedPost(e, pay)).status).toBe(200);
        expect((await signedPost(e, { type: "license_key.created", data: { key: "KEY-1", product_id: "pdt_auto", payment_id: "pay_1" } })).status).toBe(200);
        const r = await resolveEntitlement(e, A, A, Date.now());
        expect(r).toMatchObject({ ok: true, automatic: true });
    });

    it("paid: put fails on license_key.created → 500; the retry links", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const kv = fakeKV() as any;
        const put = kv.put;
        let broken = true;
        kv.put = async (k: string, v: string, o?: any) => { if (broken && k.startsWith("paid:")) throw new Error("KV down"); return put(k, v, o); };
        const e = env(kv, { MOR_WEBHOOK_SECRET: SECRET });
        const hash = await installHash(A);
        expect((await signedPost(e, { type: "payment.succeeded", data: { payment_id: "pay_2", metadata: { install: hash } } })).status).toBe(200);
        const key = { type: "license_key.created", data: { key: "KEY-2", product_id: "pdt_auto", payment_id: "pay_2" } };
        expect((await signedPost(e, key)).status).toBe(500);
        broken = false;
        expect((await signedPost(e, key)).status).toBe(200);
        expect((await resolveEntitlement(e, A, A, Date.now()))).toMatchObject({ ok: true, automatic: true });
    });
});

// ---------------------------------------------------------------------------
describe("4. a purchase still being confirmed is never sold twice", () => {
    const checkout = (e: Env, plan: string, bearer = A) => worker.fetch(new Request("https://relay/v1/checkout", {
        method: "POST", headers: v2Headers(A, bearer), body: JSON.stringify({ plan })
    }), e, ctx);
    const dodo = () => {
        let n = 0;
        const calls: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            calls.push(String(url));
            n++;
            return new Response(JSON.stringify({ session_id: "cks_" + n, checkout_url: "https://checkout.dodopayments.com/session/cks_" + n }), { status: 200 });
        }));
        return calls;
    };

    it("AI monthly pending (mandate not live yet) → an annual checkout is 409 purchase_pending, Dodo not asked", async () => {
        const kv = fakeKV();
        const e = env(kv);
        await buy(e, A, "KEY-AUTO", "pdt_auto", "pay_a");
        expect((await status(e, A)).body).toMatchObject({ automatic: true, ai: false });
        const hash = await installHash(A);
        // The subscription exists and names the install, but no key is live yet.
        await applyMorEvent(e, { type: "subscription.on_hold", data: { subscription_id: "sub_p", product_id: "pdt_month", metadata: { install: hash } } }, Date.now());
        const calls = dodo();
        const res = await checkout(e, "annual", "KEY-AUTO");
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ ok: false, error: "purchase_pending" });
        expect(calls.filter(u => u.endsWith("/checkouts"))).toHaveLength(0);
    });

    it("Automatic paid but its key not created yet → buying Automatic again is 409 purchase_pending", async () => {
        const kv = fakeKV();
        const e = env(kv);
        const hash = await installHash(A);
        await applyMorEvent(e, { type: "payment.succeeded", data: { payment_id: "pay_x", product_cart: [{ product_id: "pdt_auto" }], metadata: { install: hash } } }, Date.now());
        dodo();
        const res = await checkout(e, "automatic");
        expect(res.status).toBe(409);
        expect((await res.json() as any).error).toBe("purchase_pending");
    });

    it("a failed payment clears the marker, so the buyer can try again", async () => {
        const kv = fakeKV();
        const e = env(kv);
        const hash = await installHash(A);
        await applyMorEvent(e, { type: "payment.succeeded", data: { payment_id: "pay_y", product_cart: [{ product_id: "pdt_auto" }], metadata: { install: hash } } }, Date.now());
        await applyMorEvent(e, { type: "payment.failed", data: { payment_id: "pay_y", product_cart: [{ product_id: "pdt_auto" }], metadata: { install: hash } } }, Date.now());
        dodo();
        expect((await checkout(e, "automatic")).status).toBe(200);
    });

    it("two clicks on Buy reopen the same checkout: one Dodo session", async () => {
        const kv = fakeKV();
        const e = env(kv);
        const calls = dodo();
        const a = await (await checkout(e, "automatic")).json() as any;
        const b = await (await checkout(e, "automatic")).json() as any;
        expect(b.url).toBe(a.url);
        expect(calls.filter(u => u.endsWith("/checkouts"))).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe("5. the global budget: a raised limit unfreezes, and the owner can see it", () => {
    it("applyBudget decides from total and freezeAt only (a stale frozen flag does not refuse)", () => {
        expect(applyBudget({ total: 100, frozen: true }, 1, 1000)).toMatchObject({ allowed: true, total: 101 });
    });

    it("a Budget object that froze at 100 allows the next reserve at freezeAt 1000", async () => {
        const b = fakeBudget();
        const call = async (cost: number, freezeAt: number) =>
            (await (b.ns.get("global" as any) as any).fetch("https://budget.internal/reserve", { method: "POST", body: JSON.stringify({ cost, freezeAt }) })).json();
        expect(await call(100, 100)).toMatchObject({ allowed: true, frozen: true });
        expect(await call(1, 100)).toMatchObject({ allowed: false });
        expect(await call(1, 1000)).toMatchObject({ allowed: true, total: 101 });
    });

    it("GET /admin/budget shows the total and freeze point; POST /admin/budget/reset starts over; stats include it", async () => {
        const kv = fakeKV();
        const e = env(kv, { GLOBAL_BUDGET_MESSAGES: "1000" });
        budgetOf(kv).state.total = 1200;
        const admin = (path: string, method = "GET", token = "admintok") =>
            worker.fetch(new Request("https://relay" + path, { method, headers: { authorization: `Bearer ${token}` } }), e, ctx);
        expect((await admin("/admin/budget", "GET", "wrong")).status).toBe(401);
        const view = await admin("/admin/budget");
        expect(view.status).toBe(200);
        expect(await view.json()).toMatchObject({ ok: true, total: 1200, freezeAt: 1000, freeFreezeAt: 900, frozen: true });
        const stats = await (await admin("/admin/stats")).json() as any;
        expect(stats.budget).toMatchObject({ total: 1200, freezeAt: 1000 });
        const reset = await admin("/admin/budget/reset", "POST");
        expect(reset.status).toBe(200);
        expect(await reset.json()).toMatchObject({ ok: true, total: 0, frozen: false });
        expect(budgetOf(kv).state.total).toBe(0);
    });

    it("free traffic stops at 90% of the budget, so it cannot freeze paying users", async () => {
        const kv = fakeKV();
        const e = env(kv, { GLOBAL_BUDGET_MESSAGES: "1000" });
        budgetOf(kv).state.total = 950;
        const taste: CodeRecord = { status: "active", plan: "taste", dailyCap: 5 };
        expect(await reserve(e, "pv:acct1", taste, 1, Date.now())).toMatchObject({ ok: false, reason: "capacity" });
        const paid: CodeRecord = { status: "active", plan: "monthly", dailyCap: 2000 };
        expect(await reserve(e, "slp_paid", paid, 1, Date.now())).toMatchObject({ ok: true });
    });
});

// ---------------------------------------------------------------------------
const OR = "https://openrouter.ai/api/v1/chat/completions";
function fakeMetrics() {
    const rows: any[] = [];
    return { ds: { writeDataPoint: (p: any) => { rows.push(p); } } as unknown as AnalyticsEngineDataset, rows };
}
const paidEnv = (kv: any, metrics?: AnalyticsEngineDataset): Env => ({
    ...env(kv), OPENROUTER_KEY: "or", MODEL: "openai/gpt-oss-120b", ...(metrics ? { METRICS: metrics } : {})
});
const paidPress = (e: Env) => worker.fetch(new Request("https://relay/v1/translate", {
    method: "POST", headers: { authorization: "Bearer slp_ai", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ id: "0", author: "a", text: "hola" }], context: [], targetLang: "en" })
}), e, ctx);

describe("6. a primary out of credit (402) or with a dead key is never hidden", () => {
    it("OpenRouter 402 + Groq 429: the user is told to wait (Groq's retry-after), the row says relay_credit", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url === OR ? errModel(402) : errModel(429, { "retry-after": "7" })));
        const m = fakeMetrics();
        const kv = fakeKV({ "code:slp_ai": codeRec({ plan: "monthly", dailyCap: 2000 }) });
        const res = await paidPress(paidEnv(kv, m.ds));
        await settle();
        expect(res.status).toBe(429);
        expect(await res.json()).toMatchObject({ ok: false, error: "translation service busy", retryAfterMs: 7000 });
        expect(m.rows.at(-1)!.blobs[0]).toBe("relay_credit");
    });

    it("OpenRouter 402 + Groq ok: one warning with status 402 (no text) and a primary_fail row", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url === OR ? errModel(402) : okModel()));
        const m = fakeMetrics();
        const kv = fakeKV({ "code:slp_ai": codeRec({ plan: "monthly", dailyCap: 2000 }) });
        const res = await paidPress(paidEnv(kv, m.ds));
        await settle();
        expect(res.status).toBe(200);
        const primaryWarns = warn.mock.calls.filter(c => String(c[0]).startsWith("primary provider failed"));
        expect(primaryWarns).toHaveLength(1);
        expect(primaryWarns[0]![1]).toMatchObject({ kind: "openrouter", status: 402 });
        expect(JSON.stringify(primaryWarns)).not.toContain("hola");
        const pf = m.rows.find(r => r.blobs[0] === "primary_fail");
        expect(pf?.blobs[3]).toBe("402");
    });

    it("OpenRouter 401 + Groq 503: labelled relay_key_fail", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url === OR ? errModel(401) : errModel(503)));
        const m = fakeMetrics();
        const kv = fakeKV({ "code:slp_ai": codeRec({ plan: "monthly", dailyCap: 2000 }) });
        await paidPress(paidEnv(kv, m.ds));
        await settle();
        expect(m.rows.at(-1)!.blobs[0]).toBe("relay_key_fail");
    });
});

// ---------------------------------------------------------------------------
const breq = (texts: string[]): BatchRequest => ({
    messages: texts.map((t, i) => ({ id: String(i), author: "a", text: t })), context: [], targetLang: "en"
});
const orProvider: Provider = { kind: "openrouter", apiKey: "or", model: "openai/gpt-oss-120b" };
const groqProvider: Provider = { kind: "groq", apiKey: "gk", model: "openai/gpt-oss-120b" };
/** A fetch that never answers until its signal aborts. */
const hang = (_url: string, init: any) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
});

describe("7. a slow primary does not use up the time the fallback needs", () => {
    it("primary hangs: after its own deadline the fallback answers", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const urls: string[] = [];
        vi.stubGlobal("fetch", vi.fn((url: string, init: any) => { urls.push(url); return url === OR ? hang(url, init) : Promise.resolve(okModel()); }));
        const outer = new AbortController();
        let result: unknown = null;
        void translateWithFallback(breq(["hola"]), orProvider, groqProvider, outer.signal).then(r => { result = r; }, e => { result = e; });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(urls.some(u => u.includes("groq.com"))).toBe(true);
        expect(result).toEqual([{ id: "0", lang: "es", text: "hello friend", skip: false }]);
    });

    it("both hang: the request is answered 429 with a wait (never a 5xx the client would retry and pay twice)", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.stubGlobal("fetch", vi.fn((url: string, init: any) => hang(url, init)));
        const kv = fakeKV({ "code:slp_ai": codeRec({ plan: "monthly", dailyCap: 2000 }) });
        let res: Response | null = null;
        void paidPress(paidEnv(kv)).then(r => { res = r; });
        await vi.advanceTimersByTimeAsync(27_000);
        expect(res).not.toBeNull();
        expect(res!.status).toBe(429);
        expect(await res!.json()).toMatchObject({ ok: false, error: "translation service busy", retryAfterMs: 60_000 });
    });
});

// ---------------------------------------------------------------------------
describe("8. long messages never fail the whole batch", () => {
    const press = (body: unknown) => worker.fetch(new Request("https://relay/v1/translate", {
        method: "POST", headers: { authorization: "Bearer slp_ai", "content-type": "application/json" }, body: JSON.stringify(body)
    }), env(fakeKV({ "code:slp_ai": codeRec({ plan: "monthly", dailyCap: 100_000 }) })), ctx);

    it("a context line over 4,000 characters: 200, not 400", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => okModel()));
        const res = await press({ messages: [{ id: "0", author: "a", text: "hola" }], context: [{ author: "b", text: "x".repeat(4001) }], targetLang: "en" });
        expect(res.status).toBe(200);
    });

    it("a ~34 KB batch from a v0.2.0 client (24 long Japanese lines + 1 short): 200, every message answered", async () => {
        const rows = Array.from({ length: 25 }, (_, i) => ({ id: String(i), lang: "ja", text: "t" + i, skip: false }));
        vi.stubGlobal("fetch", vi.fn(async () => okModel(rows)));
        const messages = [...Array.from({ length: 24 }, (_, i) => ({ id: String(i), author: "a", text: "日本語".repeat(152) })), { id: "24", author: "a", text: "ok" }];
        const body = { messages, context: [], targetLang: "en" };
        expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeGreaterThan(32_768);
        const res = await press(body);
        expect(res.status).toBe(200);
        expect(((await res.json()) as any).results).toHaveLength(25);
    });

    it("one message over 4,000 characters fails alone; the rest are translated", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => okModel([{ id: "1", lang: "es", text: "short one", skip: false }])));
        const res = await press({ messages: [{ id: "0", author: "a", text: "x".repeat(4001) }, { id: "1", author: "a", text: "hola" }], context: [], targetLang: "en" });
        expect(res.status).toBe(200);
        expect(((await res.json()) as any).results).toEqual([{ id: "0", failed: true }, { id: "1", lang: "es", text: "short one", skip: false }]);
    });
});

// ---------------------------------------------------------------------------
describe("9. previews do not depend on KV writes", () => {
    it("with every KV put failing, an Automatic owner's previews still work, and two at once both succeed", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => okModel()));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const kv = fakeKV() as any;
        const e = env(kv);
        await buy(e, A, "KEY-AUTO", "pdt_auto", "pay_a");
        await status(e, A);
        kv.put = async () => { throw new Error("KV put failed: 429"); };
        const [p1, p2] = await Promise.all([v2translate(e, A, "KEY-AUTO", "preview"), v2translate(e, A, "KEY-AUTO", "preview")]);
        expect(p1.status).toBe(200);
        expect(p2.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
describe("11. one network cannot drain a promo", () => {
    const redeem = (e: Env, install: string, ip: string) => worker.fetch(new Request("https://relay/v1/redeem", {
        method: "POST", headers: v2Headers(install, install, { "cf-connecting-ip": ip }), body: JSON.stringify({ code: "LEAKCLUB" })
    }), e, ctx);
    const promoEnv = () => {
        const kv = fakeKV({ "promo:LEAKCLUB": JSON.stringify({ cap: 100, created: 0 }) });
        return env(kv, { PROMO: fakePromo() });
    };
    const fresh = (n: number) => "free_" + n.toString(16).padStart(32, "0");

    it("31 /64s inside one /48: the 31st is refused (rate_limited, net_limited), as one IPv4 address would be", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const e = promoEnv();
        const out: number[] = [];
        for (let n = 1; n <= 31; n++) out.push((await redeem(e, fresh(n), `2001:db8:1:${n.toString(16)}::1`)).status);
        expect(out).toEqual([...Array(30).fill(200), 429]);
        const last = await redeem(e, fresh(32), "2001:db8:1:ff::1");
        expect(await last.json()).toEqual({ ok: false, error: "rate_limited", reason: "net_limited" });
        const count = await (await e.PROMO!.get(e.PROMO!.idFromName("LEAKCLUB")).fetch("https://promo.internal/count")).json() as any;
        expect(count.claimed).toBe(30);
    });

    it("six claims from six different /48s all succeed (a real burst is not slowed)", async () => {
        const e = promoEnv();
        for (let n = 1; n <= 6; n++) expect((await redeem(e, fresh(100 + n), `2001:db8:${n}:1::1`)).status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
describe("12. parseable JSON in the wrong shape is an upstream failure", () => {
    it("{\"results\":[...]} is read as the rows", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({
            ok: true, status: 200, headers: new Headers(), clone() { return this; }, text: async () => "",
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ results: [{ id: "0", lang: "es", text: "hola", skip: false }] }) } }] })
        })));
        expect(await translate(breq(["hi"]), groqProvider)).toEqual([{ id: "0", lang: "es", text: "hola", skip: false }]);
    });

    it("a shape with no requested id gives the fallback its turn", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url === OR ? ({
            ok: true, status: 200, headers: new Headers(), clone() { return this; }, text: async () => "",
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations: { "0": { lang: "es", text: "x" } } }) } }] })
        }) : okModel()));
        expect(await translateWithFallback(breq(["hola"]), orProvider, groqProvider)).toEqual([{ id: "0", lang: "es", text: "hello friend", skip: false }]);
    });

    it("with no fallback it rejects 502, so the router refunds", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({
            ok: true, status: 200, headers: new Headers(), clone() { return this; }, text: async () => "",
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ foo: 1 }) } }] })
        })));
        await expect(translate(breq(["hola"]), groqProvider)).rejects.toMatchObject({ status: 502 });
    });
});

// ---------------------------------------------------------------------------
describe("13. an infrastructure fault inside reserve is a clean 503", () => {
    it("legacy keyless: the Budget object throwing rolls the counters back", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const kv = fakeKV();
        const broken = {
            idFromName: () => "global",
            get: () => ({ fetch: async (url: string) => {
                if (String(url).endsWith("/status")) return new Response(JSON.stringify({ total: 0 }));
                throw new Error("DO reset");
            } })
        } as unknown as DurableObjectNamespace;
        const e = { ...env(kv), BUDGET: broken };
        const taste: CodeRecord = { status: "active", plan: "taste", dailyCap: 3 };
        const r = await reserve(e, A, taste, 1, T0, "203.0.113.9");
        expect(r).toMatchObject({ ok: false, reason: "unavailable" });
        const day = new Date(T0).toISOString().slice(0, 10);
        expect(kv._dump()[`use:${A}:${day}`] ?? "0").toBe("0");
    });

    it("router: a KV read failing during auth answers a JSON 503 and writes a metric row", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const kv = fakeKV() as any;
        kv.get = async () => { throw new Error("KV get failed"); };
        const m = fakeMetrics();
        const res = await worker.fetch(new Request("https://relay/v1/translate", {
            method: "POST", headers: { authorization: "Bearer slp_x", "content-type": "application/json" },
            body: JSON.stringify({ messages: [{ id: "0", text: "hola" }], context: [], targetLang: "en" })
        }), { ...env(kv), METRICS: m.ds }, ctx);
        await settle();
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ ok: false, error: "temporarily unavailable" });
        expect(m.rows).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe("14. an oversized body is refused without reading it all", () => {
    /** A body stream that throws if more than ~40 KB is ever pulled from it. */
    function bomb() {
        let sent = 0;
        return new ReadableStream<Uint8Array>({
            pull(c) {
                if (sent > 40 * 1024 * 4) throw new Error("read past the limit");
                sent += 16 * 1024;
                c.enqueue(new Uint8Array(16 * 1024).fill(0x20));
            }
        });
    }
    const post = (path: string, headers: Record<string, string>, body: ReadableStream | string, e: Env) =>
        worker.fetch(new Request("https://relay" + path, { method: "POST", headers, body, duplex: "half" } as RequestInit), e, ctx);

    it("translate: a huge streamed body with no Content-Length is 413, and the stream is not drained", async () => {
        const res = await post("/v1/translate", { authorization: `Bearer ${A}` }, bomb(), env(fakeKV(), { LAUNCH_AT: "SET_AT_RELEASE" }));
        expect(res.status).toBe(413);
    });

    it("translate: a declared 10 MB body is 413 before the first read", async () => {
        let pulled = 0;
        const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1)); c.close(); } });
        const res = await post("/v1/translate", { authorization: `Bearer ${A}`, "content-length": "10000000" }, body, env(fakeKV(), { LAUNCH_AT: "SET_AT_RELEASE" }));
        expect(res.status).toBe(413);
        expect(pulled).toBeLessThanOrEqual(1);
    });

    it("redeem and the webhook refuse it too", async () => {
        const e = env(fakeKV(), { PROMO: fakePromo(), MOR_WEBHOOK_SECRET: SECRET });
        expect((await post("/v1/redeem", v2Headers(A), bomb(), e)).status).toBe(413);
        expect((await post("/webhook/mor", {}, bomb(), e)).status).toBe(413);
    });
});

// ---------------------------------------------------------------------------
describe("15. /admin/codes mint never overwrites a customer's code", () => {
    const mint = (e: Env, body: unknown) => worker.fetch(new Request("https://relay/admin/codes", {
        method: "POST", headers: { authorization: "Bearer admintok", "content-type": "application/json" }, body: JSON.stringify(body)
    }), e, ctx);

    it("an existing code is 409 and stays byte-identical", async () => {
        const row = codeRec({ status: "revoked", terminal: true, expiresAt: 1, plan: "monthly" });
        const kv = fakeKV({ "code:K": row });
        const res = await mint(env(kv), { action: "mint", code: "K" });
        expect(res.status).toBe(409);
        expect(kv._dump()["code:K"]).toBe(row);
    });

    it("a bad dailyCap is 400", async () => {
        for (const dailyCap of ["Infinity", -5, 0, 10_001]) {
            expect((await mint(env(fakeKV()), { action: "mint", dailyCap })).status).toBe(400);
        }
    });

    it("an orderRef that exists is 409 and its row is unchanged; a fresh mint is 200", async () => {
        const kv = fakeKV({ "order:sub_real": "LK-REAL" });
        expect((await mint(env(kv), { action: "mint", orderRef: "sub_real" })).status).toBe(409);
        expect(kv._dump()["order:sub_real"]).toBe("LK-REAL");
        expect((await mint(env(kv), { action: "mint", dailyCap: 100 })).status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
describe("16. a long ✦ batch is not cut off while the primary is healthy", () => {
    /** A model that answers every id in 0..n-1 after `ms(bodyChars)`. */
    const slowModel = (ms: (chars: number) => number, n: number) => (url: string, init: any) => new Promise((resolve, reject) => {
        const body = String(init?.body ?? "");
        const rows = Array.from({ length: n }, (_, i) => ({ id: String(i), lang: "ja", text: "t" + i, skip: false }));
        const t = setTimeout(() => resolve(okModel(rows)), ms(body.length));
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); });
    });

    it("a 3,900-character batch whose primary needs 15 s: the primary answers, the fallback is never called", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const urls: string[] = [];
        const model = slowModel(() => 15_000, 2);
        vi.stubGlobal("fetch", vi.fn((url: string, init: any) => { urls.push(url); return model(url, init); }));
        let result: any = null;
        void translateWithFallback(breq(["あ".repeat(1_950), "い".repeat(1_950)]), orProvider, groqProvider, new AbortController().signal)
            .then(r => { result = r; }, e => { result = e; });
        await vi.advanceTimersByTimeAsync(16_000);
        expect(urls.every(u => u === OR)).toBe(true);
        expect(result).toEqual([{ id: "0", lang: "ja", text: "t0", skip: false }, { id: "1", lang: "ja", text: "t1", skip: false }]);
    });

    it("a 120 KB batch from a 0.2.0 client (20 x 2,000 CJK characters) is answered in time, in order, in at most 6 parallel calls", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        // Latency grows with the text: 2 s plus 1 ms per character sent. The
        // whole batch as ONE call would need about 42 s on each provider.
        const model = slowModel(chars => 2_000 + chars, 20);
        const calls: string[] = [];
        vi.stubGlobal("fetch", vi.fn((url: string, init: any) => { calls.push(url); return model(url, init); }));
        const kv = fakeKV({ "code:slp_ai": codeRec({ plan: "monthly", dailyCap: 2000 }) });
        const messages = Array.from({ length: 20 }, (_, i) => ({ id: String(i), author: "a", text: String.fromCharCode(0x3042 + i).repeat(2_000) }));
        const body = JSON.stringify({ messages, context: [], targetLang: "en" });
        expect(new TextEncoder().encode(body).length).toBeGreaterThan(120_000);
        let res: Response | null = null;
        void worker.fetch(new Request("https://relay/v1/translate", {
            method: "POST", headers: { authorization: "Bearer slp_ai", "content-type": "application/json" }, body
        }), paidEnv(kv), ctx).then(r => { res = r; });
        await vi.advanceTimersByTimeAsync(26_000);
        expect(res).not.toBeNull();
        expect(res!.status).toBe(200);
        const out = await res!.json() as any;
        expect(out.results.map((r: any) => r.id)).toEqual(messages.map(m => m.id));
        expect(out.results.every((r: any) => r.skip === false && r.text === "t" + r.id)).toBe(true);
        expect(calls.filter(u => u === OR).length).toBeLessThanOrEqual(MAX_PARALLEL_CHUNKS);
        expect(calls.some(u => u.includes("groq.com"))).toBe(false);
    });

    it("an ordinary batch (25 short messages) is still one upstream call", async () => {
        const req = breq(Array.from({ length: 25 }, (_, i) => "message number " + i));
        expect(chunkBatch(req)).toEqual([req]);
    });

    it("chunks keep the order, the context, and never cut a message", () => {
        const req: BatchRequest = { ...breq(Array.from({ length: 40 }, (_, i) => "x".repeat(1_000 + i))), context: [{ author: "c", text: "ctx" }] };
        const chunks = chunkBatch(req);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.length).toBeLessThanOrEqual(MAX_PARALLEL_CHUNKS);
        expect(chunks.flatMap(c => c.messages)).toEqual(req.messages);
        expect(chunks.every(c => c.context === req.context && c.targetLang === "en")).toBe(true);
    });

    it("one chunk failing on both providers fails the request (no half batch), and the rest are stopped", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        let hung = 0, stopped = 0;
        vi.stubGlobal("fetch", vi.fn((url: string, init: any) => {
            if (!String(init?.body ?? "").includes("zzzz")) { hung++; init?.signal?.addEventListener("abort", () => { stopped++; }); }
            // The first chunk's calls fail fast; every other call hangs.
            return String(init?.body ?? "").includes("zzzz") ? Promise.resolve(errModel(429, { "retry-after": "5" })) : hang(url, init);
        }));
        const req = breq(Array.from({ length: 4 }, (_, i) => (i === 0 ? "z" : "y").repeat(3_000)));
        await expect(translateBatch(req, orProvider, groqProvider, new AbortController().signal)).rejects.toMatchObject({ status: 429, timedOut: false });
        expect(hung).toBeGreaterThan(0);
        expect(stopped).toBe(hung);
    });
});

// ---------------------------------------------------------------------------
describe("17. a promo is not blocked for real people sharing an IPv4 network", () => {
    const redeem = (e: Env, install: string, ip: string) => worker.fetch(new Request("https://relay/v1/redeem", {
        method: "POST", headers: v2Headers(install, install, { "cf-connecting-ip": ip }), body: JSON.stringify({ code: "KPOPCLUB" })
    }), e, ctx);
    const fresh = (n: number) => "free_" + (5000 + n).toString(16).padStart(32, "0");

    it("eight members behind one CGNAT /24 all redeem a 100-slot promo", async () => {
        const e = env(fakeKV({ "promo:KPOPCLUB": JSON.stringify({ cap: 100, created: 0 }) }), { PROMO: fakePromo() });
        const out: number[] = [];
        for (let n = 1; n <= 8; n++) out.push((await redeem(e, fresh(n), `100.64.7.${n}`)).status);
        expect(out).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);
    });
});

// ---------------------------------------------------------------------------
describe("18. a lapsed subscriber is not told their payment is still being confirmed", () => {
    it("AI renewal fails (on_hold) and AI ends: buying AI again opens a checkout, not 409 purchase_pending", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const t0 = Date.now();
        vi.setSystemTime(t0);
        const kv = fakeKV();
        const e = env(kv);
        await buy(e, A, "KEY-AUTO", "pdt_auto", "pay_a", undefined, t0);
        await buy(e, A, "KEY-AI", "pdt_month", "pay_m", "sub_m", t0);
        expect((await status(e, A, "KEY-AUTO")).body).toMatchObject({ automatic: true, ai: true });
        const later = t0 + 40 * DAY;
        vi.setSystemTime(later);
        const hash = await installHash(A);
        await applyMorEvent(e, { type: "subscription.on_hold", data: { subscription_id: "sub_m", product_id: "pdt_month", metadata: { install: hash } } }, later);
        expect((await status(e, A, "KEY-AUTO")).body).toMatchObject({ automatic: true, ai: false });
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ session_id: "cks_9", checkout_url: "https://checkout.dodopayments.com/session/cks_9" }), { status: 200 })));
        const res = await worker.fetch(new Request("https://relay/v1/checkout", {
            method: "POST", headers: v2Headers(A, "KEY-AUTO"), body: JSON.stringify({ plan: "monthly" })
        }), e, ctx);
        expect(res.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
describe("19. AI is never sold twice, and no checkout is paid twice before the first webhook", () => {
    const checkout = (e: Env, plan: string, bearer = "KEY-AUTO") => worker.fetch(new Request("https://relay/v1/checkout", {
        method: "POST", headers: v2Headers(A, bearer), body: JSON.stringify({ plan })
    }), e, ctx);
    /** Dodo: POST /checkouts makes cks_<n>; GET /checkouts/<id> answers from `state`
     *  (a payment_status, "404", or "down" to throw). */
    const dodo = (state: Record<string, string | null> = {}) => {
        let n = 0;
        const posts: string[] = [], gets: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
            const u = String(url);
            if (init?.method === "GET") {
                const id = u.split("/").pop()!;
                gets.push(id);
                const st = id in state ? state[id] : null;
                if (st === "down") throw new Error("network down");
                if (st === "404") return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 });
                return new Response(JSON.stringify({ id, created_at: new Date().toISOString(), payment_status: st }), { status: 200 });
            }
            n++;
            posts.push(u);
            return new Response(JSON.stringify({ session_id: "cks_" + n, checkout_url: "https://checkout.dodopayments.com/session/cks_" + n }), { status: 200 });
        }));
        return { posts, gets, state };
    };
    const owner = async (withAi: boolean) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(T0);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const kv = fakeKV() as any;
        const e = env(kv);
        await buy(e, A, "KEY-AUTO", "pdt_auto", "pay_a", undefined, T0);
        await status(e, A, "KEY-AUTO");
        if (withAi) await buy(e, A, "KEY-AI", "pdt_month", "pay_m", "sub_m", T0);
        expect((await status(e, A, "KEY-AUTO")).body).toMatchObject({ automatic: true, ai: withAi });
        return { kv, e };
    };

    it("AI active + monthly → 409 already_owned, Dodo never asked", async () => {
        const { e } = await owner(true);
        const d = dodo();
        const res = await checkout(e, "monthly");
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ ok: false, error: "already_owned" });
        expect(d.posts).toHaveLength(0);
    });

    it("AI active + annual → 409 already_owned, with either saved code", async () => {
        const { e } = await owner(true);
        const d = dodo();
        for (const bearer of ["KEY-AUTO", "KEY-AI"]) {
            const res = await checkout(e, "annual", bearer);
            expect(res.status).toBe(409);
            expect((await res.json() as any).error).toBe("already_owned");
        }
        expect(d.posts).toHaveLength(0);
    });

    it("Automatic owned + Automatic → 409 already_owned", async () => {
        const { e } = await owner(false);
        const d = dodo();
        const res = await checkout(e, "automatic");
        expect(res.status).toBe(409);
        expect((await res.json() as any).error).toBe("already_owned");
        expect(d.posts).toHaveLength(0);
    });

    it("two checkouts 1 s apart, the first already paid (no webhook yet) → the second is 409 purchase_pending", async () => {
        const { e } = await owner(false);
        const d = dodo();
        expect((await checkout(e, "monthly")).status).toBe(200);
        d.state.cks_1 = "succeeded";
        vi.setSystemTime(T0 + 1000);
        for (const plan of ["monthly", "annual"]) {
            const res = await checkout(e, plan);
            expect(res.status).toBe(409);
            expect((await res.json() as any).error).toBe("purchase_pending");
        }
        expect(d.posts).toHaveLength(1);
    });

    it("money still moving (processing, 3DS) blocks even after the window", async () => {
        const { e } = await owner(false);
        const d = dodo();
        expect((await checkout(e, "automatic", A)).status).toBe(409); // owned: control
        expect((await checkout(e, "annual")).status).toBe(200);
        for (const st of ["processing", "requires_customer_action", "requires_capture"]) {
            d.state.cks_1 = st;
            vi.setSystemTime(T0 + 5 * 3_600_000);
            const res = await checkout(e, "monthly");
            expect(res.status).toBe(409);
            expect((await res.json() as any).error).toBe("purchase_pending");
        }
        expect(d.posts).toHaveLength(1);
    });

    it("two clicks 1 s apart on an unpaid checkout reopen the same session; another plan is allowed", async () => {
        const { e } = await owner(false);
        const d = dodo();
        const a = await (await checkout(e, "monthly")).json() as any;
        vi.setSystemTime(T0 + 1000);
        const b = await (await checkout(e, "monthly")).json() as any;
        expect(b.url).toBe(a.url);
        expect(d.posts).toHaveLength(1);
        const c = await checkout(e, "annual");
        expect(c.status).toBe(200);
        expect(d.posts).toHaveLength(2);
    });

    it("abandoned checkout, retried after the window → a new checkout opens", async () => {
        const { e } = await owner(false);
        const d = dodo();
        const a = await (await checkout(e, "monthly")).json() as any;
        vi.setSystemTime(T0 + 31 * 60_000);
        const res = await checkout(e, "monthly");
        expect(res.status).toBe(200);
        expect((await res.json() as any).url).not.toBe(a.url);
        expect(d.posts).toHaveLength(2);
    });

    it("Dodo cannot be asked: refused inside the 30-min window, allowed after it", async () => {
        const { e } = await owner(false);
        const d = dodo();
        expect((await checkout(e, "monthly")).status).toBe(200);
        d.state.cks_1 = "down";
        vi.setSystemTime(T0 + 10 * 60_000);
        const inside = await checkout(e, "annual");
        expect(inside.status).toBe(409);
        expect((await inside.json() as any).error).toBe("purchase_pending");
        vi.setSystemTime(T0 + 30 * 60_000 + 1);
        expect((await checkout(e, "annual")).status).toBe(200);
        expect(d.posts).toHaveLength(2);
    });

    it("a session Dodo no longer knows (404) or a failed payment does not block", async () => {
        const { e } = await owner(false);
        const d = dodo();
        expect((await checkout(e, "monthly")).status).toBe(200);
        d.state.cks_1 = "failed";
        vi.setSystemTime(T0 + 1000);
        expect((await checkout(e, "monthly")).status).toBe(200);
        d.state.cks_1 = "404"; d.state.cks_2 = "cancelled";
        expect((await checkout(e, "monthly")).status).toBe(200);
        expect(d.posts).toHaveLength(3);
    });

    it("webhook arrives after the marker → purchase_pending, then already_owned once it is live", async () => {
        const { e } = await owner(false);
        const d = dodo();
        expect((await checkout(e, "monthly")).status).toBe(200);
        const hash = await installHash(A);
        await applyMorEvent(e, { type: "payment.succeeded", data: { payment_id: "pay_n", subscription_id: "sub_n", checkout_session_id: "cks_1", product_id: "pdt_month", metadata: { install: hash } } }, T0);
        const res = await checkout(e, "annual");
        expect(res.status).toBe(409);
        expect((await res.json() as any).error).toBe("purchase_pending");
        await applyMorEvent(e, { type: "license_key.created", data: { key: "KEY-AI-2", product_id: "pdt_month", payment_id: "pay_n", subscription_id: "sub_n" } }, T0);
        await applyMorEvent(e, { type: "subscription.active", data: { subscription_id: "sub_n", next_billing_date: new Date(T0 + 30 * DAY).toISOString() } }, T0);
        expect((await status(e, A, "KEY-AUTO")).body).toMatchObject({ ai: true });
        const again = await checkout(e, "monthly");
        expect(again.status).toBe(409);
        expect((await again.json() as any).error).toBe("already_owned");
        expect(d.posts).toHaveLength(1);
    });

    it("marker present but the payment failed: payment.failed clears it, so a retry opens even with Dodo down", async () => {
        const { kv, e } = await owner(false);
        const d = dodo();
        expect((await checkout(e, "monthly")).status).toBe(200);
        const hash = await installHash(A);
        expect(kv._dump()[`cko:${hash}:ai`]).toBeDefined();
        await applyMorEvent(e, { type: "payment.failed", data: { payment_id: "pay_f", subscription_id: "sub_f", checkout_session_id: "cks_1", product_id: "pdt_month", metadata: { install: hash } } }, T0);
        expect(kv._dump()[`cko:${hash}:ai`]).toBeUndefined();
        d.state.cks_1 = "down";
        vi.setSystemTime(T0 + 60_000);
        expect((await checkout(e, "monthly")).status).toBe(200);
        expect(d.posts).toHaveLength(2);
    });

    it("KV read failure on the marker → 503, no checkout made (fail closed)", async () => {
        const { kv, e } = await owner(false);
        const d = dodo();
        const get = kv.get;
        kv.get = async (k: string, ...rest: any[]) => { if (k.startsWith("cko:")) throw new Error("KV get failed"); return get(k, ...rest); };
        const res = await checkout(e, "monthly");
        expect(res.status).toBe(503);
        expect((await res.json() as any).error).toBe("checkout unavailable");
        expect(d.posts).toHaveLength(0);
    });

    it("one KV write per new checkout for the marker, none on a reopen", async () => {
        const { kv, e } = await owner(false);
        dodo();
        const put = kv.put;
        const keys: string[] = [];
        kv.put = async (k: string, v: string, o?: any) => { keys.push(k); return put(k, v, o); };
        await checkout(e, "monthly");
        expect(keys.filter(k => k.startsWith("cko:"))).toHaveLength(1);
        expect(keys.some(k => k.startsWith("open:"))).toBe(false);
        keys.length = 0;
        await checkout(e, "monthly");
        expect(keys.filter(k => k.startsWith("cko:") || k.startsWith("checkout:"))).toHaveLength(0);
    });
});
