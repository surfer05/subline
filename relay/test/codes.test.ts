import { describe, it, expect } from "vitest";
import { authCode, reserve, refund, usage, mintCode, type Env } from "../src/codes";
import { fakeKV, codeRec } from "./kv-mock";

const env = (kv: any): Env => ({ CODES: kv, GROQ_KEY: "x", ADMIN_TOKEN: "a", MODEL: "m" });
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
    it("commits the reservation BEFORE spend (used rises without any translate call)", async () => {
        const kv = fakeKV();
        await reserve(env(kv), "c", rec, 3, NOW);
        expect(Number(kv._dump()["use:c:2026-09-04"])).toBe(3);
    });
    it("rate-limits a burst on one code", async () => {
        const kv = fakeKV();
        const r = JSON.parse(codeRec({ dailyCap: 100000, plan: "free" }));
        for (let i = 0; i < 20; i++) expect(await reserve(env(kv), "c", r, 1, NOW)).toMatchObject({ ok: true });
        expect(await reserve(env(kv), "c", r, 1, NOW)).toMatchObject({ ok: false, reason: "rate_limited" });
    });
    it("freezes the whole relay at the global budget and refuses further reserves", async () => {
        const kv = fakeKV({ "budget:total": "1399999" });
        const e = { ...env(kv), GLOBAL_BUDGET_MESSAGES: "1400000" };
        expect(await reserve(e, "c", rec, 1, NOW)).toMatchObject({ ok: true }); // hits 1.4M, sets frozen
        expect(kv._dump()["budget:frozen"]).toBe("1");
        expect(await reserve(e, "c", rec, 1, NOW)).toMatchObject({ ok: false, reason: "capacity" });
    });
});

describe("refund", () => {
    it("returns quota when the upstream failed", async () => {
        const rec = JSON.parse(codeRec({ dailyCap: 10 }));
        const kv = fakeKV();
        await reserve(env(kv), "c", rec, 5, NOW);
        await refund(env(kv), "c", 5, NOW);
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
