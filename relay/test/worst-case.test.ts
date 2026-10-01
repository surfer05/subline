import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { applyMorEvent, costFor, reserve, type CodeRecord, type Env } from "../src/codes";
import { installHash } from "../src/checkout";
import { resolveEntitlement } from "../src/entitle";
import { applyBudget } from "../src/budget";
import { translate, translateWithFallback, type BatchRequest, type Provider } from "../src/translate";
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
        await vi.advanceTimersByTimeAsync(23_000);
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

    it("six /64s inside one /48: the sixth is refused (rate_limited, net_limited)", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const e = promoEnv();
        const out: number[] = [];
        for (let n = 1; n <= 6; n++) out.push((await redeem(e, fresh(n), `2001:db8:1:${n}::1`)).status);
        expect(out).toEqual([200, 200, 200, 200, 200, 429]);
        const last = await redeem(e, fresh(7), "2001:db8:1:7::1");
        expect(await last.json()).toEqual({ ok: false, error: "rate_limited", reason: "net_limited" });
        const count = await (await e.PROMO!.get(e.PROMO!.idFromName("LEAKCLUB")).fetch("https://promo.internal/count")).json() as any;
        expect(count.claimed).toBe(5);
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
