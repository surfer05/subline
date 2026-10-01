import { describe, it, expect } from "vitest";
import { authCode, reserve, refund, usage, mintCode, type Env } from "../src/codes";
import { dayRowKey } from "../src/budget";
import { fakeKV, codeRec, fakeBudget } from "./kv-mock";

// One Budget object per KV, as in production (one global object): the per-code
// counters live there now, so every call in a test must reach the same one.
const budgets = new WeakMap<object, ReturnType<typeof fakeBudget>>();
const budgetFor = (kv: any) => { let b = budgets.get(kv); if (!b) { b = fakeBudget(); budgets.set(kv, b); } return b; };
const env = (kv: any, budget?: any): Env =>
    ({ CODES: kv, GROQ_KEY: "x", ADMIN_TOKEN: "a", MODEL: "m", BUDGET: (budget ?? budgetFor(kv).ns) });
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);

describe("authCode", () => {
    it("no code → no_code", async () => {
        expect(await authCode(env(fakeKV()), null)).toEqual({ ok: false, reason: "no_code" });
    });
    it("unknown and malformed both read as unknown_code (no enumeration oracle)", async () => {
        expect(await authCode(env(fakeKV()), "slp_nope")).toEqual({ ok: false, reason: "unknown_code" });
        expect(await authCode(env(fakeKV({ "code:x": "{bad" })), "x")).toEqual({ ok: false, reason: "unknown_code" });
    });
    it("revoked → revoked", async () => {
        const kv = fakeKV({ "code:r": codeRec({ status: "revoked" }) });
        expect(await authCode(env(kv), "r")).toMatchObject({ ok: false, reason: "revoked" });
    });
    it("active → record", async () => {
        const kv = fakeKV({ "code:g": codeRec({ dailyCap: 500 }) });
        const r = await authCode(env(kv), "g");
        expect(r).toMatchObject({ ok: true, record: { dailyCap: 500 } });
    });
    it("expired locally even if no revoke webhook arrived (safety net)", async () => {
        const kv = fakeKV({ "code:e": codeRec({ expiresAt: Date.now() - 1000 }) });
        expect(await authCode(env(kv), "e")).toMatchObject({ ok: false, reason: "expired" });
    });
    it("a future expiresAt is still valid; absent expiresAt never expires", async () => {
        const soon = fakeKV({ "code:f": codeRec({ expiresAt: Date.now() + 60_000 }) });
        expect(await authCode(env(soon), "f")).toMatchObject({ ok: true });
        const none = fakeKV({ "code:l": codeRec({ plan: "lifetime" }) }); // no expiresAt
        expect(await authCode(env(none), "l")).toMatchObject({ ok: true });
    });
    it("a terminal record is denied even with a future expiry (refund/expire is permanent)", async () => {
        const kv = fakeKV({ "code:t": codeRec({ terminal: true, expiresAt: Date.now() + 60_000 }) });
        expect(await authCode(env(kv), "t")).toMatchObject({ ok: false, reason: "revoked" });
    });
});

describe("reserve — cap, rate, kill-switch, reserve-before-spend", () => {
    const rec = JSON.parse(codeRec({ dailyCap: 10 }));
    it("enforces the daily cap and reports retry until UTC midnight", async () => {
        const kv = fakeKV();
        expect(await reserve(env(kv), "c", rec, 8, NOW)).toMatchObject({ ok: true, used: 8 });
        const over = await reserve(env(kv), "c", rec, 5, NOW);
        expect(over).toMatchObject({ ok: false, reason: "cap_exceeded", used: 8, cap: 10 });
        expect((over as any).retryAfterMs).toBeGreaterThan(0);
    });
    it("commits the reservation BEFORE spend (used rises without any translate call), in the Budget object, not KV", async () => {
        const kv = fakeKV();
        await reserve(env(kv), "c", rec, 3, NOW);
        expect(budgetFor(kv).count(dayRowKey("c", NOW))).toBe(3);
        expect(kv._dump()).toEqual({});
    });
    it("rate-limits a burst on one code", async () => {
        const kv = fakeKV();
        const r = JSON.parse(codeRec({ dailyCap: 100000, plan: "free" }));
        for (let i = 0; i < 20; i++) expect(await reserve(env(kv), "c", r, 1, NOW)).toMatchObject({ ok: true });
        expect(await reserve(env(kv), "c", r, 1, NOW)).toMatchObject({ ok: false, reason: "rate_limited" });
    });
    it("gives a paid code 60 requests a minute (a request is a batch of up to 25 messages)", async () => {
        const kv = fakeKV();
        const r = JSON.parse(codeRec({ dailyCap: 100000, plan: "monthly" }));
        for (let i = 0; i < 60; i++) expect(await reserve(env(kv), "p", r, 1, NOW)).toMatchObject({ ok: true });
        expect(await reserve(env(kv), "p", r, 1, NOW)).toMatchObject({ ok: false, reason: "rate_limited" });
    });
    it("freezes the whole relay at the global budget (atomic DO) and refuses further reserves", async () => {
        const b = fakeBudget();
        const bigCap = JSON.parse(codeRec({ dailyCap: 1_000_000 }));
        const e = { ...env(fakeKV(), b.ns), GLOBAL_BUDGET_MESSAGES: "5" };
        expect(await reserve(e, "c", bigCap, 4, NOW)).toMatchObject({ ok: true });
        expect(await reserve(e, "c", bigCap, 4, NOW)).toMatchObject({ ok: true }); // total 8 >= 5 -> frozen
        expect(b.state.total).toBe(8);
        expect(await reserve(e, "c", bigCap, 1, NOW)).toMatchObject({ ok: false, reason: "capacity" });
    });

    it("WORST CASE: a frozen budget unfreezes as soon as the limit is raised (no stuck flag)", async () => {
        const b = fakeBudget();
        const bigCap = JSON.parse(codeRec({ dailyCap: 1_000_000 }));
        const low = { ...env(fakeKV(), b.ns), GLOBAL_BUDGET_MESSAGES: "5" };
        await reserve(low, "c", bigCap, 6, NOW); // total 6 >= 5: frozen
        expect(await reserve(low, "c", bigCap, 1, NOW)).toMatchObject({ ok: false, reason: "capacity" });
        const raised = { ...low, GLOBAL_BUDGET_MESSAGES: "1000" };
        expect(await reserve(raised, "c", bigCap, 1, NOW)).toMatchObject({ ok: true });
    });

    it("WORST CASE: the Budget object failing refuses the request as unavailable instead of throwing", async () => {
        const broken = { idFromName: () => "global", get: () => ({ fetch: async () => { throw new Error("DO overloaded"); } }) } as unknown as DurableObjectNamespace;
        const r = await reserve(env(fakeKV(), broken), "c", rec, 1, NOW);
        expect(r).toMatchObject({ ok: false, reason: "unavailable", retryAfterMs: 60_000 });
    });

    it("WORST CASE: the daily cap holds exactly under 20 concurrent reserves", async () => {
        const kv = fakeKV();
        const r10 = JSON.parse(codeRec({ dailyCap: 10, plan: "monthly" }));
        const out = await Promise.all(Array.from({ length: 20 }, () => reserve(env(kv), "c", r10, 1, NOW)));
        expect(out.filter(o => o.ok)).toHaveLength(10);
        expect(budgetFor(kv).count(dayRowKey("c", NOW))).toBe(10);
    });

    it("an optional monthly allowance refuses an AI code that spent it, even under its daily cap", async () => {
        const kv = fakeKV();
        const e = { ...env(kv), AI_MONTHLY_CAP: "10" };
        const r = JSON.parse(codeRec({ dailyCap: 2000, plan: "monthly" }));
        expect(await reserve(e, "m1", r, 1, NOW, null, 8)).toMatchObject({ ok: true });
        const over = await reserve(e, "m1", r, 1, NOW, null, 3);
        expect(over).toMatchObject({ ok: false, reason: "month_cap_exceeded", used: 1 });
        expect((over as any).retryAfterMs).toBe(Date.UTC(2026, 9, 1) - NOW);
        // Not configured: no monthly allowance at all.
        expect(await reserve(env(fakeKV()), "m2", r, 1, NOW, null, 30)).toMatchObject({ ok: true });
    });

    it("the global guard is committed even though per-code stays soft KV", async () => {
        const b = fakeBudget();
        const rec2 = JSON.parse(codeRec({ dailyCap: 1000 }));
        const e = { ...env(fakeKV(), b.ns), GLOBAL_BUDGET_MESSAGES: "1000000" };
        await reserve(e, "c", rec2, 7, NOW);
        expect(b.state.total).toBe(7);
    });
});

describe("refund", () => {
    it("returns quota when the upstream failed", async () => {
        const rec = JSON.parse(codeRec({ dailyCap: 10 }));
        const kv = fakeKV();
        await reserve(env(kv), "c", rec, 5, NOW);
        await refund(env(kv), "c", 5, NOW, null, rec.plan);
        const u = await usage(env(kv), "c", rec, NOW);
        expect(u.used).toBe(0);
    });
});

describe("mintCode", () => {
    it("is prefixed, opaque, and unique", () => {
        const a = mintCode(), b = mintCode();
        expect(a).toMatch(/^slp_[a-z2-7]{16}$/);
        expect(a).not.toBe(b);
    });
});
