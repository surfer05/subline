import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { applyMorEvent, type Env } from "../src/codes";
import { installHash } from "../src/checkout";
import { EARLY_CUTOFF_MS as CUTOFF, isAiPlan, launchAt, signToken, verifyToken, MAX_INSTALLS } from "../src/entitle";
import { applyClaim, applyIpBegin, applyIpEnd, Promo, REDEEM_IP_DAILY_FAILURES, REDEEM_IP_DAILY_SUCCESSES } from "../src/promo";
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
        // Before launch (LAUNCH_AT still the placeholder) an older client is
        // answered exactly as before, trial and all.
        const e = env(fakeKV(), { LAUNCH_AT: "SET_AT_RELEASE" });
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
        expect(first.body).toMatchObject({ automatic: true, ai: false, code: "KEY-AUTO-1", previews: { used: 0, cap: 5 } });
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

    it("an unknown or revoked code is named as dead, and the install still answers for itself", async () => {
        const e = env(fakeKV({ "code:DEAD": codeRec({ status: "revoked" }) }));
        const unknown = await status(e, A, "NOPE-NOPE");
        expect(unknown.status).toBe(200);
        expect(unknown.body).toMatchObject({ automatic: false, ai: false, deadCode: "NOPE-NOPE" });
        const revoked = await status(e, A, "DEAD");
        expect(revoked.body).toMatchObject({ automatic: false, deadCode: "DEAD" });
        expect(revoked.body.code).toBeUndefined();
    });

    it("an AI purchase joins the same account: the union unlocks both", async () => {
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await buy(e, A, "KEY-AI-1", "pdt_month", "pay_m", "sub_m");
        const s = await status(e, A, "KEY-AUTO-1");
        expect(s.body).toMatchObject({ automatic: true, ai: true });
        expect(s.body.aiUntil).toBeGreaterThan(NOW);
        // Another computer with only the Automatic key gets Automatic, not AI:
        // AI stays with the install that bought it (see the sharing tests).
        expect((await status(e, B, "KEY-AUTO-1")).body).toMatchObject({ automatic: true, ai: false });
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
    it("an AI code from before launch gets Automatic for good: kept after it lapses and after a refund", async () => {
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
        // Refunded: the refund takes AI (already gone); the grant on the account stays.
        await applyMorEvent(e, { type: "refund.succeeded", data: { payment_id: "pay_old" } }, NOW);
        expect((await status(e, A)).body).toMatchObject({ automatic: true, ai: false });
    });

    it("an AI code bought after launch is not grandfathered", async () => {
        const e = env(fakeKV({ "code:NEW-AI": codeRec({ plan: "monthly", dailyCap: 2000, createdAt: NOW, expiresAt: NOW + 86_400_000 }) }));
        expect((await status(e, A, "NEW-AI")).body).toMatchObject({ automatic: false, ai: true });
    });

    it("an install that existed before launch gets Automatic as an early user, once", async () => {
        const kv = countingKV({ [`trial:${"a".repeat(32)}`]: String(CUTOFF - 5000) });
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

    it("early evidence counts only before the fixed cutoff, whatever LAUNCH_AT says", async () => {
        // A trial started after the cutoff never counts, even with LAUNCH_AT still in the future.
        const seed = { [`trial:${"a".repeat(32)}`]: String(CUTOFF + 5000) };
        expect((await status(env(fakeKV(seed), { LAUNCH_AT: String(NOW + 10 * 86_400_000) }), A)).body.automatic).toBe(false);
        // A trial from before the cutoff counts, with LAUNCH_AT unset.
        const old = { [`trial:${"a".repeat(32)}`]: String(CUTOFF - 5000) };
        expect((await status(env(fakeKV(old), { LAUNCH_AT: "" }), A)).body.automatic).toBe(true);
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

    it("Automatic gets previews only: 5 a day per account, cut on the relay", async () => {
        const up = stubProvider();
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        const full = await translate(e, A, "KEY-AUTO-1");
        expect(full.status).toBe(402);
        expect(full.body.error).toBe("ai_required");
        expect(up).not.toHaveBeenCalled();
        for (let i = 0; i < 5; i++) {
            const p = await translate(e, i === 4 ? B : A, "KEY-AUTO-1", "preview");
            expect(p.status).toBe(200);
            expect(p.body.results[0].truncated).toBe(true);
        }
        const sixth = await translate(e, A, "KEY-AUTO-1", "preview");
        expect(sixth.status).toBe(429);
        expect((await status(e, A, "KEY-AUTO-1")).body.previews).toEqual({ used: 5, cap: 5 });
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

// ===========================================================================
//  Audit round (2026-09-29).
// ===========================================================================

const statusH = async (e: Env, install: string, bearer: string | undefined, extra: Record<string, string>) => {
    const res = await worker.fetch(new Request("https://relay/v1/status", { headers: v2Headers(install, bearer, extra) }), e, ctx);
    return { status: res.status, body: await res.json() as any };
};
const checkoutV2 = async (e: Env, install: string, plan: string, bearer = install, extra: Record<string, unknown> = {}) => {
    const res = await worker.fetch(new Request("https://relay/v1/checkout", {
        method: "POST", headers: v2Headers(install, bearer), body: JSON.stringify({ plan, ...extra })
    }), e, ctx);
    return { status: res.status, body: await res.json() as any };
};
const legacyStatus = async (e: Env, install: string) => {
    const res = await worker.fetch(new Request("https://relay/v1/status", {
        headers: { authorization: `Bearer ${install}`, "x-subline-client": "vcTranslate/0.1.9" }
    }), e, ctx);
    return await res.json() as any;
};
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

describe("checkout: the placeholder product and the installer return", () => {
    let calls: any[] = [];
    const mockDodo = () => {
        calls = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return new Response(JSON.stringify({ session_id: "cks_1", checkout_url: "https://checkout.dodopayments.com/session/cks_1" }), { status: 200 });
        }));
    };

    it("treats the placeholder Automatic id as not configured: 503, and Dodo is never asked", async () => {
        mockDodo();
        const e = env(fakeKV(), { VARIANTS: { ...VARIANTS, pdt_auto: undefined, pdt_AUTOMATIC_PENDING: { plan: "automatic", dailyCap: 5 } } as any });
        const r = await checkoutV2(e, A, "automatic");
        expect(r.status).toBe(503);
        expect(r.body.error).toBe("checkout unavailable");
        expect(calls).toHaveLength(0);
    });

    it("returns to the installer's page when the installer asks, and to Discord's otherwise", async () => {
        mockDodo();
        const e = env(fakeKV());
        await checkoutV2(e, A, "automatic", A, { return: "installer" });
        expect(new URL(calls[0].body.return_url).searchParams.get("from")).toBe("installer");
        mockDodo();
        await checkoutV2(e, B, "automatic");
        expect(new URL(calls[0].body.return_url).searchParams.get("from")).toBe("discord");
    });

    it("already owned stays 409", async () => {
        mockDodo();
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        expect((await checkoutV2(e, A, "automatic", "KEY-AUTO-1")).status).toBe(409);
    });
});

describe("legacy clients after launch (item 3)", () => {
    it("a new id gets the taste allowance, never a new trial, and nothing is written", async () => {
        const kv = countingKV();
        const body = await legacyStatus(env(kv), A);
        expect(body).toMatchObject({ plan: "taste", cap: 3 });
        expect(body.trialProvisional).toBeUndefined();
        expect(kv._puts).toEqual([]);
    });

    it("a trial that started before launch keeps running out naturally", async () => {
        const e = env(fakeKV({ [`trial:${"a".repeat(32)}`]: String(NOW - 2 * 86_400_000) }));
        const body = await legacyStatus(e, A);
        expect(body).toMatchObject({ plan: "trial", cap: 300 });
        expect(body.trialEndsAt).toBe(NOW - 2 * 86_400_000 + 7 * 86_400_000);
    });

    it("before launch (placeholder) a new id still gets a trial, as today", async () => {
        const body = await legacyStatus(env(fakeKV(), { LAUNCH_AT: "SET_AT_RELEASE" }), A);
        expect(body).toMatchObject({ plan: "trial", cap: 300, trialProvisional: true });
    });
});

describe("promo attempts per address, counted in the Durable Object (item 4)", () => {
    const setup = async (cap = 100) => {
        const e = env(fakeKV());
        expect((await adminPromo(e, { code: "LEAKCLUB", cap })).status).toBe(200);
        return e;
    };
    const installs = (n: number, from = 0) => Array.from({ length: n }, (_, i) => "free_" + (i + from).toString(16).padStart(32, "0"));

    it("3 successful claims a day, then rate_limited", async () => {
        const e = await setup();
        const ip = "203.0.113.9";
        const [a, b, c, d] = installs(4);
        for (const i of [a!, b!, c!]) expect((await redeem(e, i, "LEAKCLUB", ip)).status).toBe(200);
        expect((await redeem(e, d!, "LEAKCLUB", ip)).body.error).toBe("rate_limited");
        // Another address is unaffected.
        expect((await redeem(e, d!, "LEAKCLUB", "198.51.100.7")).status).toBe(200);
    });

    it("10 failed attempts a day, then rate_limited, even for a real code", async () => {
        const e = await setup();
        const ip = "203.0.113.10";
        for (let i = 0; i < 10; i++) expect((await redeem(e, A, "NOPE" + i + "XYZ", ip)).status).toBe(404);
        const eleventh = await redeem(e, A, "LEAKCLUB", ip);
        expect(eleventh.status).toBe(429);
        expect(eleventh.body.error).toBe("rate_limited");
    });

    it("an IPv6 /64 is one address", async () => {
        const e = await setup();
        const [a, b, c, d] = installs(4, 100);
        await redeem(e, a!, "LEAKCLUB", "2001:db8:1:2::1");
        await redeem(e, b!, "LEAKCLUB", "2001:db8:1:2::2");
        await redeem(e, c!, "LEAKCLUB", "2001:db8:1:2:aaaa::3");
        expect((await redeem(e, d!, "LEAKCLUB", "2001:db8:1:2:ffff::9")).status).toBe(429);
    });

    it("a concurrent burst of real claims gets exactly 3 through", async () => {
        const e = await setup();
        const out = await Promise.all(installs(20, 200).map(i => redeem(e, i, "LEAKCLUB", "203.0.113.11")));
        expect(out.filter(r => r.status === 200)).toHaveLength(3);
        expect(out.filter(r => r.status === 429)).toHaveLength(17);
    });

    it("a concurrent burst of bad codes counts at most 10 failures", async () => {
        const e = await setup();
        const ip = "203.0.113.12";
        const first = await Promise.all(Array.from({ length: 30 }, (_, i) => redeem(e, A, "BAD" + i + "CODE", ip)));
        const tried = first.filter(r => r.status === 404).length;
        expect(tried).toBeGreaterThan(0);
        expect(tried).toBeLessThanOrEqual(10);
        // Keep going one by one: the total that ever reaches the lookup is 10.
        let more = 0;
        for (let i = 0; i < 20; i++) if ((await redeem(e, A, "MORE" + i + "BAD", ip)).status === 404) more++;
        expect(tried + more).toBe(10);
    });

    it("the begin/end decision is exact", () => {
        const s = { ok: 0, fail: 0, inflight: 0 };
        expect(applyIpBegin(s)).toBe(true);
        expect(applyIpBegin(s)).toBe(true);
        expect(applyIpBegin(s)).toBe(true);
        expect(applyIpBegin(s)).toBe(false); // 3 in flight fill the success allowance
        applyIpEnd(s, "none");
        expect(s).toEqual({ ok: 0, fail: 0, inflight: 2 });
        applyIpEnd(s, "ok");
        applyIpEnd(s, "fail");
        expect(s).toEqual({ ok: 1, fail: 1, inflight: 0 });
        expect(REDEEM_IP_DAILY_SUCCESSES).toBe(3);
        expect(REDEEM_IP_DAILY_FAILURES).toBe(10);
    });
});

describe("AI plans are listed, unknown products fail closed (item 5)", () => {
    it("lists AI plans explicitly; admin free-plan beta codes are AI on purpose", () => {
        for (const p of ["monthly", "annual", "paid", "lifetime", "free"] as const) expect(isAiPlan(p)).toBe(true);
        for (const p of ["automatic", "taste", "trial"] as const) expect(isAiPlan(p)).toBe(false);
        expect(isAiPlan("mystery" as any)).toBe(false);
    });

    it("a license key for an unknown product entitles to nothing and is logged", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const e = env(fakeKV());
        await buy(e, A, "KEY-GHOST", "pdt_ghost", "pay_g");
        expect(warn.mock.calls.some(c => String(c[0]).includes("unmapped product"))).toBe(true);
        warn.mockRestore();
        const s = await status(e, A, "KEY-GHOST");
        expect(s.body).toMatchObject({ automatic: false, ai: false, deadCode: "KEY-GHOST" });
    });
});

describe("a dead AI code never takes Automatic (item 6)", () => {
    const setupOwner = async () => {
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await buy(e, A, "KEY-AI-1", "pdt_month", "pay_m", "sub_m");
        const s = await status(e, A, "KEY-AI-1");
        expect(s.body).toMatchObject({ automatic: true, ai: true });
        return e;
    };

    it("cancel: after the period ends AI goes, Automatic stays, and the Automatic code is handed back", async () => {
        const e = await setupOwner();
        await applyMorEvent(e, { type: "subscription.cancelled", data: { subscription_id: "sub_m", next_billing_date: new Date(NOW - 1000).toISOString() } }, NOW);
        const s = await status(e, A, "KEY-AI-1");
        expect(s.body).toMatchObject({ automatic: true, ai: false, deadCode: "KEY-AI-1", code: "KEY-AUTO-1" });
    });

    it("expiry: the same", async () => {
        const e = await setupOwner();
        await applyMorEvent(e, { type: "subscription.expired", data: { subscription_id: "sub_m" } }, NOW);
        const s = await status(e, A, "KEY-AI-1");
        expect(s.body).toMatchObject({ automatic: true, ai: false, deadCode: "KEY-AI-1", code: "KEY-AUTO-1" });
    });

    it("refund: the same", async () => {
        const e = await setupOwner();
        await applyMorEvent(e, { type: "refund.succeeded", data: { payment_id: "pay_m" } }, NOW);
        const s = await status(e, A, "KEY-AI-1");
        expect(s.body).toMatchObject({ automatic: true, ai: false, deadCode: "KEY-AI-1", code: "KEY-AUTO-1" });
    });

    it("prefers the Automatic code over a live AI code when handing one back", async () => {
        const e = await setupOwner();
        const s = await status(e, A, "NOT-A-CODE");
        expect(s.body).toMatchObject({ automatic: true, ai: true, deadCode: "NOT-A-CODE", code: "KEY-AUTO-1" });
    });

    it("grandfathered Automatic survives a subscription.expired webhook", async () => {
        const kv = fakeKV({
            "code:OLD-AI": codeRec({ plan: "monthly", dailyCap: 2000, expiresAt: NOW + 86_400_000, mor_order_id: "pay_old", mor_subscription_id: "sub_old", orderRef: "sub_old" }),
            "order:sub_old": "OLD-AI", "order:pay_old": "OLD-AI"
        });
        const e = env(kv);
        expect((await status(e, A, "OLD-AI")).body).toMatchObject({ automatic: true, ai: true });
        await applyMorEvent(e, { type: "subscription.expired", data: { subscription_id: "sub_old" } }, NOW);
        expect((await status(e, A, "OLD-AI")).body).toMatchObject({ automatic: true, ai: false, deadCode: "OLD-AI" });
    });
});

describe("early users (items 7/8)", () => {
    const aHash = async () => installHash(A);

    it("a pre-launch usage counter counts, but only with the prior-use hint", async () => {
        const before = day(CUTOFF - 3_600_000 * 20);
        const seed = { [`use:${A}:${before}`]: "2" };
        expect((await status(env(fakeKV(seed)), A)).body.automatic).toBe(false);
        const withHint = await statusH(env(fakeKV(seed)), A, undefined, { "x-subline-prior": "1" });
        expect(withHint.body).toMatchObject({ automatic: true, grant: "early" });
        expect(withHint.body.code).toMatch(/^slp_/);
    });

    it("a pre-launch seen: marker counts with the hint", async () => {
        const before = day(CUTOFF - 36 * 3_600_000);
        const seed = { [`seen:free:${before}:${await aHash()}`]: "1" };
        const r = await statusH(env(fakeKV(seed)), A, undefined, { "x-subline-prior": "1" });
        expect(r.body).toMatchObject({ automatic: true, grant: "early" });
    });

    it("the hint alone grants nothing, and a record from after launch does not count", async () => {
        const plain = await statusH(env(fakeKV()), A, undefined, { "x-subline-prior": "1" });
        expect(plain.body).toMatchObject({ automatic: false });
        expect(plain.body.grant).toBeUndefined();
        const after = { [`use:${A}:${day(CUTOFF + 3_600_000)}`]: "2" };
        expect((await statusH(env(fakeKV(after)), A, undefined, { "x-subline-prior": "1" })).body.automatic).toBe(false);
    });

    it("grant:early is on the first granting answer only", async () => {
        const e = env(fakeKV({ [`trial:${"a".repeat(32)}`]: String(CUTOFF - 5000) }));
        expect((await status(e, A)).body.grant).toBe("early");
        expect((await status(e, A)).body.grant).toBeUndefined();
    });

    it("early grants do not depend on LAUNCH_AT, even while it is the placeholder", async () => {
        const e = env(fakeKV({ [`trial:${"a".repeat(32)}`]: String(CUTOFF - 30 * 86_400_000) }), { LAUNCH_AT: "SET_AT_RELEASE" });
        expect((await status(e, A)).body.automatic).toBe(true);
        expect(launchAt(e)).toBeNaN();
    });
});

describe("computer slots with last-seen (item 9)", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("writes the last-seen day at most once a day per install", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
        const kv = countingKV();
        const e = env(kv);
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        const n = kv._puts.length;
        await status(e, A, "KEY-AUTO-1");
        await status(e, A, "KEY-AUTO-1");
        expect(kv._puts.length).toBe(n);
        vi.setSystemTime(NOW + 86_400_000);
        await status(e, A, "KEY-AUTO-1");
        expect(kv._puts.slice(n)).toEqual([expect.stringMatching(/^acct:/)]);
    });

    it("a 4th computer is refused while all 3 were seen in the last 30 days", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await status(e, B, "KEY-AUTO-1");
        await status(e, C, "KEY-AUTO-1");
        vi.setSystemTime(NOW + 29 * 86_400_000);
        const d = await status(e, D, "KEY-AUTO-1");
        expect(d.status).toBe(403);
        expect(d.body.error).toBe("device_limit");
    });

    it("the least recently seen computer gives up its slot after 30 days unseen", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
        const kv = fakeKV();
        const e = env(kv);
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await status(e, B, "KEY-AUTO-1");
        vi.setSystemTime(NOW + 10 * 86_400_000);
        await status(e, C, "KEY-AUTO-1");
        await status(e, A, "KEY-AUTO-1");   // A seen again on day 10
        vi.setSystemTime(NOW + 31 * 86_400_000);
        // B was last seen on day 0: 31 days unseen, so D takes its slot.
        expect((await status(e, D, "KEY-AUTO-1")).body.automatic).toBe(true);
        expect(kv._dump()[`ia:${await installHash(B)}`]).toBeUndefined();
        // B coming back is now the 4th, and A, C, D were all seen recently.
        expect((await status(e, B, "KEY-AUTO-1")).status).toBe(403);
    });

    it("POST /admin/reset-installs frees an account's computers", async () => {
        const e = env(fakeKV());
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await status(e, B, "KEY-AUTO-1");
        await status(e, C, "KEY-AUTO-1");
        expect((await status(e, D, "KEY-AUTO-1")).status).toBe(403);
        const reset = (token: string, body: any) => worker.fetch(new Request("https://relay/admin/reset-installs", {
            method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body)
        }), e, ctx);
        expect((await reset("wrong", { code: "KEY-AUTO-1" })).status).toBe(401);
        expect((await reset("admintok", { code: "NOPE" })).status).toBe(404);
        const ok = await reset("admintok", { code: "KEY-AUTO-1" });
        expect(await ok.json()).toEqual({ ok: true, cleared: 3 });
        expect((await status(e, D, "KEY-AUTO-1")).body.automatic).toBe(true);
    });
});

describe("AI stays with the install that bought it (item 10)", () => {
    const setupOwner = async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await buy(e, A, "KEY-AI-1", "pdt_month", "pay_m", "sub_m");
        expect((await status(e, A, "KEY-AUTO-1")).body).toMatchObject({ automatic: true, ai: true });
        return { e, kv };
    };

    it("a friend who enters the owner's Automatic key gets Automatic only and spends no AI", async () => {
        const { e, kv } = await setupOwner();
        const friend = await status(e, B, "KEY-AUTO-1");
        expect(friend.body).toMatchObject({ automatic: true, ai: false });
        expect(friend.body.aiUntil).toBeUndefined();
        const r = await translate(e, B, "KEY-AUTO-1");
        expect(r.status).toBe(402);
        expect(r.body.error).toBe("ai_required");
        expect(kv._dump()[`use:KEY-AI-1:${day(Date.now())}`]).toBeUndefined();
        // Previews work, per account.
        expect((await translate(e, B, "KEY-AUTO-1", "preview")).status).toBe(200);
    });

    it("the buyer keeps AI with the Automatic key as its bearer", async () => {
        const { e } = await setupOwner();
        expect((await translate(e, A, "KEY-AUTO-1")).status).toBe(200);
    });

    it("entering the AI key itself gives AI on that computer", async () => {
        const { e } = await setupOwner();
        expect((await status(e, C, "KEY-AI-1")).body).toMatchObject({ automatic: true, ai: true });
    });

    it("a friend who buys AI from their own computer gets AI there", async () => {
        const { e } = await setupOwner();
        await status(e, B, "KEY-AUTO-1");
        await buy(e, B, "KEY-AI-2", "pdt_month", "pay_m2", "sub_m2");
        expect((await status(e, B, "KEY-AUTO-1")).body).toMatchObject({ automatic: true, ai: true });
    });
});

describe("checking a typed code (x-subline-check)", () => {
    it("says what it would give without linking anything or writing", async () => {
        const kv = countingKV();
        const e = env(kv);
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        const n = kv._puts.length;
        const acctBefore = kv._dump()[`acct:${kv._dump()[`ia:${await installHash(A)}`]}`];
        const r = await statusH(e, B, "KEY-AUTO-1", { "x-subline-check": "1" });
        expect(r.status).toBe(200);
        expect(r.body.check).toEqual({ valid: true, automatic: true, ai: false });
        expect(r.body).toMatchObject({ automatic: false, ai: false });
        expect(r.body.code).toBeUndefined();
        expect(kv._puts.length).toBe(n);
        expect(kv._dump()[`acct:${kv._dump()[`ia:${await installHash(A)}`]}`]).toBe(acctBefore);
        expect(kv._dump()[`ia:${await installHash(B)}`]).toBeUndefined();
        // Confirming links it.
        expect((await status(e, B, "KEY-AUTO-1")).body.automatic).toBe(true);
    });

    it("a dead or unknown code is not valid; an AI code says ai", async () => {
        const e = env(fakeKV({ "code:NEW-AI": codeRec({ plan: "monthly", createdAt: NOW, expiresAt: NOW + 86_400_000 }) }));
        expect((await statusH(e, A, "NOPE-NOPE", { "x-subline-check": "1" })).body.check).toEqual({ valid: false, automatic: false, ai: false });
        expect((await statusH(e, A, "NEW-AI", { "x-subline-check": "1" })).body.check).toEqual({ valid: true, automatic: false, ai: true });
    });

    it("is a device_limit when the code's account has 3 recent computers, still with no writes", async () => {
        const kv = countingKV();
        const e = env(kv);
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        await status(e, B, "KEY-AUTO-1");
        await status(e, C, "KEY-AUTO-1");
        const n = kv._puts.length;
        const r = await statusH(e, D, "KEY-AUTO-1", { "x-subline-check": "1" });
        expect(r.status).toBe(403);
        expect(r.body.error).toBe("device_limit");
        expect(kv._puts.length).toBe(n);
    });
});

describe("KV writes per call (pinned)", () => {
    it("redeem: the code, the install and code index, and the account; 4 in all", async () => {
        const kv = countingKV();
        const e = env(kv);
        expect((await adminPromo(e, { code: "LEAKCLUB", cap: 10 })).status).toBe(200);
        const n = kv._puts.length;
        expect((await redeem(e, A, "LEAKCLUB", "203.0.113.20")).status).toBe(200);
        const w = kv._puts.slice(n);
        expect(w).toHaveLength(4);
        expect(w.filter(k => k.startsWith("code:slp_"))).toHaveLength(1);
        expect(w.some(k => k.startsWith("rl:"))).toBe(false); // the address count lives in the DO now
    });

    it("status for nothing owned: none; known install, same day: none; check: none", async () => {
        const kv = countingKV();
        const e = env(kv);
        await status(e, A);
        expect(kv._puts).toEqual([]);
        await buy(e, A, "KEY-AUTO-1", "pdt_auto", "pay_a");
        await status(e, A);
        const n = kv._puts.length;
        await status(e, A, "KEY-AUTO-1");
        await statusH(e, B, "KEY-AUTO-1", { "x-subline-check": "1" });
        expect(kv._puts.length).toBe(n);
    });
});
