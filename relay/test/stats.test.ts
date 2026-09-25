import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import worker from "../src/index";
import { applyMorEvent, type Env } from "../src/codes";
import { clampDays, markActive } from "../src/stats";
import { fakeKV, codeRec, fakeBudget } from "./kv-mock";

// ===========================================================================
//  OWNER STATS — approximate daily counts in KV, read at GET /admin/stats.
//  Counts only: no stat/seen key and no response ever carries an id or code.
// ===========================================================================

const HEX_A = "a".repeat(32), HEX_B = "b".repeat(32);
const ID_A = "free_" + HEX_A;
const ID_B = "free_" + HEX_B;
const PAID = "slp_realpaidcode";
const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);
const DAY = 86_400_000;
const D0 = "2026-09-10";

const env = (kv: any, over: Partial<Env> = {}): Env => ({
    CODES: kv, GROQ_KEY: "gk", ADMIN_TOKEN: "admin-tok", MODEL: "m", BUDGET: fakeBudget().ns,
    VARIANTS: { prod_month: { plan: "monthly", dailyCap: 1500 }, prod_year: { plan: "annual", dailyCap: 1500 } },
    ...over
});

const pending: Promise<unknown>[] = [];
const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {}
} as unknown as ExecutionContext;
const settle = () => Promise.all(pending.splice(0));

function stubProvider() {
    const content = JSON.stringify({ translations: [{ id: "0", lang: "es", text: "hi", skip: false }] });
    vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content } }] }),
        clone() { return this; }, text: async () => ""
    })));
}

const press = async (e: Env, bearer: string, client = false) => {
    const res = await worker.fetch(new Request("https://relay/v1/translate", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(client ? { "x-subline-client": "vcTranslate/0.1.5" } : {}) },
        body: JSON.stringify({ messages: [{ id: "0", author: "a", text: "hola" }], context: [], targetLang: "en" })
    }), e, ctx);
    return { status: res.status, body: await res.json() as any };
};
const status = (e: Env, bearer: string, client = false) => worker.fetch(new Request("https://relay/v1/status", {
    headers: { authorization: `Bearer ${bearer}`, ...(client ? { "x-subline-client": "vcTranslate/0.1.5" } : {}) }
}), e, ctx);
const stats = async (e: Env, q = "", auth: string | null = "admin-tok", method = "GET") => {
    const res = await worker.fetch(new Request(`https://relay/admin/stats${q}`, {
        method, headers: auth ? { authorization: `Bearer ${auth}` } : {}
    }), e, ctx);
    return { status: res.status, text: await res.text() };
};
const licenseCreated = (key: string, product = "prod_month") => ({
    type: "license_key.created", timestamp: new Date(T0).toISOString(),
    data: { key, product_id: product, subscription_id: "sub_" + key, payment_id: "pay_" + key }
});

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); pending.length = 0; });

describe("distinct daily actives", () => {
    it("a free id counts once per day across translate and status, and again the next day", async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        await press(e, ID_A); await press(e, ID_A); await status(e, ID_A);
        await press(e, ID_B);
        await settle();
        expect(kv._dump()[`stat:${D0}:free_active`]).toBe("2");
        vi.setSystemTime(T0 + DAY);
        await press(e, ID_A);
        await settle();
        expect(kv._dump()[`stat:2026-09-11:free_active`]).toBe("1");
        // TTLs: stat 35 days, seen-marker 2 days.
        expect(kv._opts(`stat:${D0}:free_active`)).toEqual({ expirationTtl: 35 * 86_400 });
        const seen = Object.keys(kv._dump()).find(k => k.startsWith("seen:free:"))!;
        expect(kv._opts(seen)).toEqual({ expirationTtl: 2 * 86_400 });
    });

    it("trials_started once per id; trial_active distinct; free_active too", async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        await status(e, ID_A, true); await press(e, ID_A, true); await press(e, ID_A, true);
        await press(e, ID_B, true);
        await settle();
        const d = kv._dump();
        expect(d[`stat:${D0}:trials_started`]).toBe("2");
        expect(d[`stat:${D0}:trial_active`]).toBe("2");
        expect(d[`stat:${D0}:free_active`]).toBe("2");
    });

    it("paid_active counts distinct paid codes, and no stat or seen key contains a code or id", async () => {
        stubProvider();
        const kv = fakeKV({ [`code:${PAID}`]: codeRec({ plan: "monthly" }), "code:slp_other": codeRec({ plan: "annual" }) });
        const e = env(kv);
        await press(e, PAID); await press(e, PAID); await status(e, PAID);
        await press(e, "slp_other");
        await press(e, ID_A, true);
        await settle();
        expect(kv._dump()[`stat:${D0}:paid_active`]).toBe("2");
        const statKeys = Object.keys(kv._dump()).filter(k => k.startsWith("stat:") || k.startsWith("seen:"));
        for (const k of statKeys) {
            for (const secret of [PAID, "slp_other", ID_A, HEX_A]) expect(k).not.toContain(secret);
        }
        for (const k of statKeys.filter(k => k.startsWith("seen:"))) expect(k).toMatch(/^seen:(free|trial|paid):\d{4}-\d\d-\d\d:[0-9a-f]{16}$/);
    });

    it("an admin-minted plan:free code counts as neither free install nor paid", async () => {
        const kv = fakeKV();
        await markActive(env(kv), "slp_beta", "free", T0);
        expect(Object.keys(kv._dump())).toEqual([]);
    });
});

describe("conversions", () => {
    it("a new key bumps conv:<plan>; a replayed license_key.created does not double count", async () => {
        const kv = fakeKV();
        const e = env(kv);
        await applyMorEvent(e, licenseCreated("KEY-1"), T0);
        await applyMorEvent(e, licenseCreated("KEY-1"), T0); // replay/upsert
        await applyMorEvent(e, licenseCreated("KEY-2", "prod_year"), T0);
        await applyMorEvent(e, licenseCreated("KEY-3", "prod_unknown"), T0);
        const d = kv._dump();
        expect(d[`stat:${D0}:conv:monthly`]).toBe("1");
        expect(d[`stat:${D0}:conv:annual`]).toBe("1");
        expect(d[`stat:${D0}:conv:free`]).toBe("1");
    });

    it("a stats failure never fails the webhook", async () => {
        const kv = fakeKV() as any;
        const put = kv.put;
        kv.put = async (k: string, v: string, o?: any) => { if (k.startsWith("stat:")) throw new Error("kv down"); return put(k, v, o); };
        await expect(applyMorEvent(env(kv), licenseCreated("KEY-9"), T0)).resolves.toMatchObject({ action: "created" });
        expect(kv._dump()["code:KEY-9"]).toBeDefined();
    });
});

describe("GET /admin/stats", () => {
    it("401 without/with a wrong token, 503 when ADMIN_TOKEN unset, 405 for non-GET", async () => {
        const e = env(fakeKV());
        expect((await stats(e, "", null)).status).toBe(401);
        expect((await stats(e, "", "wrong")).status).toBe(401);
        expect((await stats(env(fakeKV(), { ADMIN_TOKEN: "" }))).status).toBe(503);
        expect((await stats(e, "", "admin-tok", "POST")).status).toBe(405);
    });

    it("clamps days to 1..30, default 14", () => {
        expect(clampDays(null)).toBe(14);
        expect(clampDays("")).toBe(14);
        expect(clampDays("abc")).toBe(14);
        expect(clampDays("0")).toBe(1);
        expect(clampDays("-5")).toBe(1);
        expect(clampDays("7")).toBe(7);
        expect(clampDays("999")).toBe(30);
    });

    it("returns newest-first daily counts, never a code or id", async () => {
        stubProvider();
        const kv = fakeKV({ [`code:${PAID}`]: codeRec({ plan: "monthly" }) });
        const e = env(kv);
        await press(e, ID_A, true);
        await press(e, PAID);
        await applyMorEvent(e, licenseCreated("KEY-1"), T0);
        const prev = await (async () => {
            const r = await worker.fetch(new Request("https://relay/v1/translate", {
                method: "POST",
                headers: { authorization: `Bearer ${ID_B}`, "content-type": "application/json" },
                body: JSON.stringify({ messages: [{ id: "0", text: "hola" }], context: [], targetLang: "en", mode: "preview" })
            }), e, ctx);
            return r.status;
        })();
        expect(prev).toBe(200);
        await settle();

        const r = await stats(e, "?days=999");
        expect(r.status).toBe(200);
        const body = JSON.parse(r.text);
        expect(body.ok).toBe(true);
        expect(body.approximate).toBe(true);
        expect(body.days).toHaveLength(30);
        expect(body.days[0]).toEqual({
            day: D0, activeFreeInstalls: 2, trialsStarted: 1, activeTrials: 1, activePaidCodes: 1, previewsServed: 1,
            conversions: { monthly: 1, annual: 0, lifetime: 0, paid: 0, free: 0 }
        });
        expect(body.days[1].day).toBe("2026-09-09");
        for (const s of [ID_A, HEX_A, ID_B, PAID, "KEY-1"]) expect(r.text).not.toContain(s);

        expect(JSON.parse((await stats(e, "?days=0")).text).days).toHaveLength(1);
        expect(JSON.parse((await stats(e)).text).days).toHaveLength(14);
    });
});

describe("stats never break a translation", () => {
    it("a throwing stats write leaves translate and status answering normally", async () => {
        stubProvider();
        const kv = fakeKV() as any;
        const put = kv.put, get = kv.get;
        kv.put = async (k: string, v: string, o?: any) => { if (k.startsWith("stat:") || k.startsWith("seen:")) throw new Error("kv down"); return put(k, v, o); };
        kv.get = async (k: string) => { if (k.startsWith("seen:")) throw new Error("kv down"); return get(k); };
        const e = env(kv);
        const r = await press(e, ID_A, true);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, used: 1, cap: 300 });
        expect((await status(e, ID_A, true)).status).toBe(200);
        await expect(settle()).resolves.toBeDefined(); // no rejected waitUntil promise
    });
});
