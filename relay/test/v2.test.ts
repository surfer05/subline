import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { applyMorEvent, type Env } from "../src/codes";
import { installHash } from "../src/checkout";
import { signToken, verifyToken, MAX_INSTALLS } from "../src/entitle";
import { applyClaim, Promo } from "../src/promo";
import { codeRec, fakeBudget, fakeKV } from "./kv-mock";

// ===========================================================================
//  v2: the paid-only model. Automatic ($4.99 once), AI on top, promo codes,
//  accounts that join a buyer's codes, 3 computers per account.
// ===========================================================================

const VARIANTS = {
    pdt_month: { plan: "monthly", dailyCap: 2000 },
    pdt_year: { plan: "annual", dailyCap: 2000 },
    pdt_auto: { plan: "automatic", dailyCap: 3 }
};
const A = "free_" + "a".repeat(32);
const B = "free_" + "b".repeat(32);
const C = "free_" + "c".repeat(32);
const D = "free_" + "d".repeat(32);
const CLIENT = "vcTranslate/0.2.0";
const NOW = Date.now();
const LAUNCH = NOW - 86_400_000; // launched yesterday

/** A fake PROMO namespace that runs the REAL Promo class, one per name. */
function fakePromo() {
    const objects = new Map<string, Promo>();
    const get = (name: string) => {
        let o = objects.get(name);
        if (!o) {
            const store = new Map<string, unknown>();
            const state = {
                storage: {
                    get: async (k: string) => store.get(k),
                    put: async (k: string, v: unknown) => { store.set(k, v); },
                    deleteAll: async () => store.clear()
                },
                blockConcurrencyWhile: async (fn: () => Promise<void>) => fn()
            } as unknown as DurableObjectState;
            o = new Promo(state);
            objects.set(name, o);
        }
        return o;
    };
    return {
        idFromName: (n: string) => n,
        get: (n: string) => ({ fetch: (url: string, init?: any) => get(n).fetch(new Request(url, init)) })
    } as unknown as DurableObjectNamespace;
}

type KV = ReturnType<typeof fakeKV>;
function countingKV(seed: Record<string, string> = {}) {
    const kv = fakeKV(seed) as any;
    const puts: string[] = [];
    const put = kv.put;
    kv.put = async (k: string, v: string, o?: any) => { puts.push(k); return put(k, v, o); };
    kv._puts = puts;
    return kv as KV & { _puts: string[] };
}

const env = (kv: any, over: Partial<Env> = {}): Env => ({
    CODES: kv, GROQ_KEY: "gk", ADMIN_TOKEN: "admintok", MODEL: "m", BUDGET: fakeBudget().ns,
    VARIANTS, DODO_API_KEY: "dodo_secret", PROMO: fakePromo(), LAUNCH_AT: String(LAUNCH), ...over
});
const ctx = { waitUntil: (_: Promise<unknown>) => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const v2Headers = (install: string, bearer: string = install, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${bearer}`, "x-subline-client": CLIENT, "x-subline-api": "2",
    "x-subline-install": install, "content-type": "application/json", ...extra
});
const status = async (e: Env, install: string, bearer?: string) => {
    const res = await worker.fetch(new Request("https://relay/v1/status", { headers: v2Headers(install, bearer) }), e, ctx);
    return { status: res.status, body: await res.json() as any };
};
const redeem = async (e: Env, install: string, code: string, ip?: string) => {
    const res = await worker.fetch(new Request("https://relay/v1/redeem", {
        method: "POST", headers: v2Headers(install, install, ip ? { "cf-connecting-ip": ip } : {}), body: JSON.stringify({ code })
    }), e, ctx);
    return { status: res.status, body: await res.json() as any };
};
const translate = async (e: Env, install: string, bearer: string, mode?: string) => {
    const res = await worker.fetch(new Request("https://relay/v1/translate", {
        method: "POST", headers: v2Headers(install, bearer),
        body: JSON.stringify({ messages: [{ id: "0", author: "a", text: "hola que tal amigo como estas hoy" }], context: [], targetLang: "en", ...(mode ? { mode } : {}) })
    }), e, ctx);
    return { status: res.status, body: await res.json() as any };
};
const adminPromo = (e: Env, body: any, token = "admintok") => worker.fetch(new Request("https://relay/admin/promo", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body)
}), e, ctx);

/** A purchase made from `install`: the payment names it, then the key is created. */
async function buy(e: Env, install: string, key: string, product: string, pay: string, sub?: string) {
    const hash = await installHash(install);
    await applyMorEvent(e, { type: "payment.succeeded", data: { payment_id: pay, subscription_id: sub ?? null, metadata: { install: hash } } }, NOW);
    await applyMorEvent(e, { type: "license_key.created", data: { key, product_id: product, payment_id: pay, subscription_id: sub ?? null } }, NOW);
    if (sub) {
        await applyMorEvent(e, { type: "subscription.active", data: { subscription_id: sub, next_billing_date: new Date(NOW + 30 * 86_400_000).toISOString() } }, NOW);
    }
}

function stubProvider() {
    const content = JSON.stringify({ translations: [{ id: "0", lang: "es", text: "hi how are you today my friend", skip: false }] });
    const mock = vi.fn(async () => ({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content } }] }),
        clone() { return this; }, text: async () => ""
    }));
    vi.stubGlobal("fetch", mock);
    return mock;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("v2 status", () => {
    it("an install with nothing is not activated, with a token, and writes nothing", async () => {
        const kv = countingKV();
        const { status: s, body } = await status(env(kv), A);
        expect(s).toBe(200);
        expect(body).toMatchObject({ ok: true, automatic: false, ai: false, previews: { used: 0, cap: 0 } });
        expect(body.code).toBeUndefined();
        expect(typeof body.token).toBe("string");
        expect(body.tokenExpiresAt - body.now).toBe(7 * 86_400_000);
        expect(kv._puts).toEqual([]);
    });

    it("needs the install header, and an install bearer must be that install", async () => {
        const e = env(fakeKV());
        const bad = await worker.fetch(new Request("https://relay/v1/status", {
            headers: { authorization: `Bearer ${A}`, "x-subline-client": CLIENT, "x-subline-api": "2" }
        }), e, ctx);
        expect(bad.status).toBe(400);
        expect((await status(e, A, B)).status).toBe(400);
    });

    it("an older client (no x-subline-api) gets exactly the old answer", async () => {
        const e = env(fakeKV());
        const res = await worker.fetch(new Request("https://relay/v1/status", {
            headers: { authorization: `Bearer ${A}`, "x-subline-client": "vcTranslate/0.1.9", "x-subline-install": A }
        }), e, ctx);
        const body = await res.json() as any;
        expect(Object.keys(body).sort()).toEqual(["cap", "now", "ok", "plan", "resetsInMs", "trialEndsAt", "trialProvisional", "used"]);
        expect(body.plan).toBe("trial");
    });

    it("an Automatic purchase from this install switches it on and hands it the key, then costs no writes", async () => {
        const kv = countingKV();
        const e = env(kv);
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        const first = await status(e, A);
        expect(first.body).toMatchObject({ automatic: true, ai: false, code: "KEY-AUTO-1", previews: { used: 0, cap: 3 } });
        const before = kv._puts.length;
        const again = await status(e, A, "KEY-AUTO-1");
        expect(again.body).toMatchObject({ automatic: true, ai: false });
        expect(again.body.code).toBeUndefined();
        expect(kv._puts.length).toBe(before);
    });

    it("an Automatic key is one-time and never expires", async () => {
        const kv = fakeKV();
        const e = env(kv);
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        const rec = JSON.parse(kv._dump()["code:KEY-AUTO-1"]!);
        expect(rec.plan).toBe("automatic");
        expect(rec.expiresAt).toBeUndefined();
    });
});

describe("the entitlement token", () => {
    it("is signed with ENTITLEMENT_SECRET and verifies; a changed payload does not", async () => {
        const e = env(fakeKV(), { ENTITLEMENT_SECRET: "test-secret" });
        const { body } = await status(e, A);
        const p = await verifyToken(e, body.token, NOW);
        expect(p).toMatchObject({ v: 1, i: await installHash(A), a: false, ai: false });
        const [payload, sig] = body.token.split(".");
        const forged = btoa(JSON.stringify({ ...p, a: true })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
        expect(await verifyToken(e, `${forged}.${sig}`, NOW)).toBeNull();
        expect(await verifyToken(e, `${payload}.${sig}`, body.tokenExpiresAt + 1)).toBeNull();
    });

    it("goes out unsigned without the secret", async () => {
        const e = env(fakeKV());
        const t = await signToken(e, { v: 1, i: "x", a: true, ai: false, exp: NOW + 1000 });
        expect(t.endsWith(".")).toBe(true);
        expect(await verifyToken(e, t, NOW)).toBeNull();
    });
});

describe("accounts and the 3-computer limit", () => {
    it("one key works on 3 computers and refuses a 4th", async () => {
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        expect((await status(e, A)).body.automatic).toBe(true);
        expect((await status(e, B, "KEY-AUTO-1")).body.automatic).toBe(true);
        expect((await status(e, C, "KEY-AUTO-1")).body.automatic).toBe(true);
        const fourth = await status(e, D, "KEY-AUTO-1");
        expect(fourth.status).toBe(403);
        expect(fourth.body.error).toBe("device_limit");
        expect(MAX_INSTALLS).toBe(3);
        // The 3 that are in keep working.
        expect((await status(e, B, "KEY-AUTO-1")).body.automatic).toBe(true);
    });

    it("an unknown or revoked code is invalid_code", async () => {
        const e = env(fakeKV({ "code:DEAD": codeRec({ status: "revoked" }) }));
        expect((await status(e, A, "NOPE-NOPE")).body.error).toBe("invalid_code");
        expect((await status(e, A, "DEAD")).status).toBe(401);
    });

    it("an AI purchase joins the same account: the union unlocks both", async () => {
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await buy(e, A, "KEY-AI-1", "pdt_month", "pay_m", "sub_m");
        const s = await status(e, A, "KEY-AUTO-1");
        expect(s.body).toMatchObject({ automatic: true, ai: true });
        expect(s.body.aiUntil).toBeGreaterThan(NOW);
        // Another computer with only the Automatic key also gets AI.
        expect((await status(e, B, "KEY-AUTO-1")).body).toMatchObject({ automatic: true, ai: true });
    });
});

describe("refunds take away only what they paid for", () => {
    it("refunding AI keeps Automatic; refunding Automatic keeps AI", async () => {
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await buy(e, A, "KEY-AI-1", "pdt_month", "pay_m", "sub_m");
        await status(e, A, "KEY-AUTO-1");
        await applyMorEvent(e, { type: "refund.succeeded", data: { payment_id: "pay_m" } }, NOW);
        expect((await status(e, A, "KEY-AUTO-1")).body).toMatchObject({ automatic: true, ai: false });

        const e2 = env(fakeKV());
        await buy(e2, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e2, A);
        await buy(e2, A, "KEY-AI-1", "pdt_month", "pay_m", "sub_m");
        await status(e2, A, "KEY-AUTO-1");
        await applyMorEvent(e2, { type: "refund.succeeded", data: { payment_id: "pay_a" } }, NOW);
        expect((await status(e2, A, "KEY-AI-1")).body).toMatchObject({ automatic: false, ai: true });
    });
});

describe("launch grants", () => {
    it("an AI code from before launch gets Automatic, kept after it lapses, lost on a refund", async () => {
        const kv = fakeKV({
            "code:OLD-AI": codeRec({ plan: "monthly", dailyCap: 2000, expiresAt: NOW + 86_400_000, mor_order_id: "pay_old", orderRef: "sub_old" }),
            "order:pay_old": "OLD-AI"
        });
        const e = env(kv);
        expect((await status(e, A, "OLD-AI")).body).toMatchObject({ automatic: true, ai: true });
        // Lapsed (expired normally): AI goes, Automatic stays.
        const rec = JSON.parse(kv._dump()["code:OLD-AI"]!);
        await kv.put("code:OLD-AI", JSON.stringify({ ...rec, expiresAt: NOW - 1000 }));
        expect((await status(e, A)).body).toMatchObject({ automatic: true, ai: false });
        // Refunded: both go.
        await applyMorEvent(e, { type: "refund.succeeded", data: { payment_id: "pay_old" } }, NOW);
        expect((await status(e, A)).body).toMatchObject({ automatic: false, ai: false });
    });

    it("an AI code bought after launch is not grandfathered", async () => {
        const e = env(fakeKV({ "code:NEW-AI": codeRec({ plan: "monthly", dailyCap: 2000, createdAt: NOW, expiresAt: NOW + 86_400_000 }) }));
        expect((await status(e, A, "NEW-AI")).body).toMatchObject({ automatic: false, ai: true });
    });

    it("an install that existed before launch gets Automatic as an early user, once", async () => {
        const kv = countingKV({ [`trial:${"a".repeat(32)}`]: String(LAUNCH - 5000) });
        const e = env(kv);
        const first = await status(e, A);
        expect(first.body.automatic).toBe(true);
        expect(first.body.code).toMatch(/^slp_[a-z2-7]{16}$/);
        const rec = JSON.parse(kv._dump()[`code:${first.body.code}`]!);
        expect(rec).toMatchObject({ plan: "automatic", note: "early" });
        const n = kv._puts.length;
        const again = await status(e, A);
        expect(again.body.code).toBe(first.body.code);
        expect(kv._puts.length).toBe(n);
    });

    it("no early grant for an install first seen after launch, or with LAUNCH_AT unset", async () => {
        const seed = { [`trial:${"a".repeat(32)}`]: String(LAUNCH + 5000) };
        expect((await status(env(fakeKV(seed)), A)).body.automatic).toBe(false);
        const old = { [`trial:${"a".repeat(32)}`]: String(LAUNCH - 5000) };
        expect((await status(env(fakeKV(old), { LAUNCH_AT: "" }), A)).body.automatic).toBe(false);
    });
});

describe("v2 translate", () => {
    it("nothing without an entitlement", async () => {
        stubProvider();
        const r = await translate(env(fakeKV()), A, A);
        expect(r.status).toBe(402);
        expect(r.body.error).toBe("not_activated");
    });

    it("nothing once the only purchase was refunded", async () => {
        stubProvider();
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await applyMorEvent(e, { type: "refund.succeeded", data: { payment_id: "pay_a" } }, NOW);
        const r = await translate(e, A, A, "preview");
        expect(r.status).toBe(402);
        expect(r.body.error).toBe("not_activated");
    });

    it("Automatic gets previews only: 3 a day per account, cut on the relay", async () => {
        const up = stubProvider();
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        const full = await translate(e, A, "KEY-AUTO-1");
        expect(full.status).toBe(402);
        expect(full.body.error).toBe("ai_required");
        expect(up).not.toHaveBeenCalled();
        for (let i = 0; i < 3; i++) {
            const p = await translate(e, i === 2 ? B : A, "KEY-AUTO-1", "preview");
            expect(p.status).toBe(200);
            expect(p.body.results[0].truncated).toBe(true);
        }
        const fourth = await translate(e, A, "KEY-AUTO-1", "preview");
        expect(fourth.status).toBe(429);
        expect((await status(e, A, "KEY-AUTO-1")).body.previews).toEqual({ used: 3, cap: 3 });
    });

    it("AI gets full text, charged to the AI code", async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await buy(e, A, "KEY-AI-1", "pdt_month", "pay_m", "sub_m");
        await status(e, A, "KEY-AUTO-1");
        const r = await translate(e, A, "KEY-AUTO-1");
        expect(r.status).toBe(200);
        expect(r.body.results[0].text).toBe("hi how are you today my friend");
        const day = new Date(Date.now()).toISOString().slice(0, 10);
        expect(Number(kv._dump()[`use:KEY-AI-1:${day}`])).toBeGreaterThan(0);
    });

    it("a 4th computer is refused", async () => {
        stubProvider();
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await status(e, B, "KEY-AUTO-1");
        await status(e, C, "KEY-AUTO-1");
        expect((await translate(e, D, "KEY-AUTO-1", "preview")).status).toBe(403);
    });
});

describe("v2 checkout", () => {
    let calls: any[] = [];
    const mockDodo = () => {
        calls = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return new Response(JSON.stringify({ session_id: "cks_1", checkout_url: "https://checkout.dodopayments.com/session/cks_1" }), { status: 200 });
        }));
    };
    const checkout = async (e: Env, install: string, plan: string, bearer = install) => {
        const res = await worker.fetch(new Request("https://relay/v1/checkout", {
            method: "POST", headers: v2Headers(install, bearer), body: JSON.stringify({ plan })
        }), e, ctx);
        return { status: res.status, body: await res.json() as any };
    };

    it("sells Automatic to an install that has nothing, tied to its install", async () => {
        mockDodo();
        const r = await checkout(env(fakeKV()), A, "automatic");
        expect(r.status).toBe(200);
        expect(r.body.url).toMatch(/^https:\/\/checkout\.dodopayments\.com\//);
        expect(calls[0].body.product_cart[0].product_id).toBe("pdt_auto");
        expect(calls[0].body.metadata.install).toBe(await installHash(A));
    });

    it("AI needs Automatic first", async () => {
        mockDodo();
        const r = await checkout(env(fakeKV()), A, "monthly");
        expect(r.status).toBe(403);
        expect(r.body.error).toBe("automatic_required");
        expect(calls).toHaveLength(0);
    });

    it("an Automatic owner can buy AI, and cannot buy Automatic twice", async () => {
        mockDodo();
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        mockDodo();
        expect((await checkout(e, A, "annual", "KEY-AUTO-1")).status).toBe(200);
        expect(calls[0].body.product_cart[0].product_id).toBe("pdt_year");
        const twice = await checkout(e, A, "automatic", "KEY-AUTO-1");
        expect(twice.status).toBe(409);
        expect(twice.body.error).toBe("already_owned");
    });
});

describe("promo codes", () => {
    const setup = async (cap: number, kv: any = fakeKV()) => {
        const e = env(kv);
        const res = await adminPromo(e, { code: "LEAKCLUB", cap });
        expect(res.status).toBe(200);
        return e;
    };

    it("redeeming grants Automatic with a minted Subline code", async () => {
        const kv = fakeKV();
        const e = await setup(100, kv);
        const r = await redeem(e, A, "leakclub");
        expect(r.status).toBe(200);
        expect(r.body.code).toMatch(/^slp_[a-z2-7]{16}$/);
        expect(JSON.parse(kv._dump()[`code:${r.body.code}`]!)).toMatchObject({ plan: "automatic", note: "promo:LEAKCLUB" });
        expect((await status(e, A)).body).toMatchObject({ automatic: true, code: r.body.code });
        expect((await status(e, B, r.body.code)).body.automatic).toBe(true);
    });

    it("errors: unknown, malformed, already yours", async () => {
        const e = await setup(100);
        expect((await redeem(e, A, "NOPE1234")).body.error).toBe("not_found");
        expect((await redeem(e, A, "no")).status).toBe(404);
        expect((await redeem(e, A, "LEAKCLUB")).status).toBe(200);
        const again = await redeem(e, A, "LEAKCLUB");
        expect(again.status).toBe(409);
        expect(again.body.error).toBe("already");
    });

    it("an install that already owns Automatic is told it is already theirs", async () => {
        const e = await setup(100);
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        expect((await redeem(e, A, "LEAKCLUB")).body.error).toBe("already");
    });

    it("the cap is exact: cap 2, the third install is told it is fully claimed", async () => {
        const e = await setup(2);
        expect((await redeem(e, A, "LEAKCLUB")).status).toBe(200);
        expect((await redeem(e, B, "LEAKCLUB")).status).toBe(200);
        const third = await redeem(e, C, "LEAKCLUB");
        expect(third.status).toBe(410);
        expect(third.body.error).toBe("claimed");
    });

    it("100 is really 100 under concurrency", async () => {
        const e = await setup(100);
        const stub = e.PROMO!.get(e.PROMO!.idFromName("LEAKCLUB"));
        const hashes = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(16, "0"));
        const results = await Promise.all(hashes.map(async h =>
            (await (await stub.fetch("https://promo.internal/claim", { method: "POST", body: JSON.stringify({ install: h, cap: 100 }) })).json() as any).result));
        expect(results.filter(r => r === "ok")).toHaveLength(100);
        expect(results.filter(r => r === "claimed")).toHaveLength(50);
    });

    it("end to end, concurrent redemptions never pass the cap", async () => {
        const e = await setup(5);
        const installs = Array.from({ length: 12 }, (_, i) => "free_" + i.toString(16).padStart(32, "0"));
        const out = await Promise.all(installs.map(i => redeem(e, i, "LEAKCLUB")));
        expect(out.filter(r => r.status === 200)).toHaveLength(5);
        expect(out.filter(r => r.status === 410)).toHaveLength(7);
    });

    it("the claim decision is exact and one per install", () => {
        const s = { claimed: 0, installs: new Set<string>() };
        expect(applyClaim(s, "h1", 1)).toBe("ok");
        expect(applyClaim(s, "h1", 5)).toBe("already");
        expect(applyClaim(s, "h2", 1)).toBe("claimed");
    });

    it("3 redemptions per address a day", async () => {
        const e = await setup(100);
        const ip = "203.0.113.9";
        expect((await redeem(e, A, "LEAKCLUB", ip)).status).toBe(200);
        expect((await redeem(e, B, "LEAKCLUB", ip)).status).toBe(200);
        expect((await redeem(e, C, "LEAKCLUB", ip)).status).toBe(200);
        const fourth = await redeem(e, D, "LEAKCLUB", ip);
        expect(fourth.status).toBe(429);
        expect(fourth.body.error).toBe("rate_limited");
    });

    it("gives the slot back when the grant cannot be written", async () => {
        const kv = fakeKV() as any;
        const e = await setup(1, kv);
        const put = kv.put;
        kv.put = async (k: string, v: string, o?: any) => { if (k.startsWith("code:slp_")) throw new Error("kv down"); return put(k, v, o); };
        const r = await redeem(e, A, "LEAKCLUB");
        expect(r.status).toBe(503);
        expect(r.body.error).toBe("unavailable");
        kv.put = put;
        expect((await redeem(e, B, "LEAKCLUB")).status).toBe(200);
    });

    it("is unavailable without the PROMO binding, and only for v2 clients", async () => {
        const e = env(fakeKV({ "promo:LEAKCLUB": JSON.stringify({ cap: 100 }) }), { PROMO: undefined });
        expect((await redeem(e, A, "LEAKCLUB")).status).toBe(503);
        const legacy = await worker.fetch(new Request("https://relay/v1/redeem", {
            method: "POST", headers: { authorization: `Bearer ${A}`, "x-subline-client": CLIENT }, body: JSON.stringify({ code: "LEAKCLUB" })
        }), env(fakeKV()), ctx);
        expect(legacy.status).toBe(400);
    });
});

describe("POST /admin/promo and promo stats", () => {
    it("needs the admin token and a valid code and cap", async () => {
        const e = env(fakeKV());
        expect((await adminPromo(e, { code: "LEAKCLUB" }, "wrong")).status).toBe(401);
        expect((await adminPromo(e, { code: "abc" })).status).toBe(400);
        expect((await adminPromo(e, { code: "LEAK-CLUB" })).status).toBe(400);
        expect((await adminPromo(e, { code: "LEAKCLUB", cap: 0 })).status).toBe(400);
        expect((await adminPromo(e, { code: "LEAKCLUB", cap: 100001 })).status).toBe(400);
        const ok = await adminPromo(e, { code: "LEAKCLUB" });
        expect(await ok.json()).toEqual({ ok: true, code: "LEAKCLUB", cap: 100 });
    });

    it("refuses a promo that is already a working code", async () => {
        const e = env(fakeKV({ "code:ABCD1234": codeRec({ plan: "automatic" }) }));
        expect((await adminPromo(e, { code: "ABCD1234" })).status).toBe(409);
    });

    it("stats count redemptions and later AI purchases per promo", async () => {
        const e = env(fakeKV());
        await adminPromo(e, { code: "LEAKCLUB", cap: 10 });
        const r = await redeem(e, A, "LEAKCLUB");
        await redeem(e, B, "LEAKCLUB");
        await buy(e, A, "KEY-AI-1", "pdt_month", "pay_m", "sub_m");
        await status(e, A, r.body.code);
        const res = await worker.fetch(new Request("https://relay/admin/stats", { headers: { authorization: "Bearer admintok" } }), e, ctx);
        const body = await res.json() as any;
        expect(body.promos).toEqual([{ code: "LEAKCLUB", cap: 10, redemptions: 2, aiPurchases: 1 }]);
    });
});
