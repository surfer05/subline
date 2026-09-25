import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import worker from "../src/index";
import {
    reserve, refund, rpmLimitFor, costFor, trialRecord, resolveFreePlan, startTrial, isNewClient,
    TRIAL_MS, TRIAL_DAILY_CAP, TRIAL_IP_DAILY_CAP, TRIAL_KEY_TTL_S, type Env
} from "../src/codes";
import { previewText } from "../src/translate";
import { fakeKV, codeRec, fakeBudget } from "./kv-mock";

// ===========================================================================
//  v0.1.6 — THE 7-DAY TRIAL AND PREVIEW MODE
//
//  A new client marks itself with `x-subline-client`. Its free_ bearer gets a
//  7-day trial (300/day, per-IP 600) from first sight, then falls back to the
//  taste tier. A legacy client (no header) must see NO change at all.
// ===========================================================================

const HEX_A = "a".repeat(32), HEX_B = "b".repeat(32);
const ID_A = "free_" + HEX_A;
const ID_B = "free_" + HEX_B;
const IP = "203.0.113.7";
const CLIENT = "vcTranslate/0.1.5";
const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);
const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function watchKV(seed: Record<string, string> = {}) {
    const kv = fakeKV(seed) as any;
    const reads: string[] = [];
    const get = kv.get;
    kv.get = async (k: string) => { reads.push(k); return get(k); };
    kv._reads = reads;
    return kv as ReturnType<typeof fakeKV> & { _reads: string[] };
}

function fakeMetrics() {
    const rows: any[] = [];
    return { ds: { writeDataPoint: (p: any) => { rows.push(p); } } as unknown as AnalyticsEngineDataset, rows };
}

const env = (kv: any, over: Partial<Env> = {}): Env =>
    ({ CODES: kv, GROQ_KEY: "gk", ADMIN_TOKEN: "admin-tok", MODEL: "m", BUDGET: fakeBudget().ns, ...over });

const pending: Promise<unknown>[] = [];
const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {}
} as unknown as ExecutionContext;
const settle = () => Promise.all(pending.splice(0));

/** Stub the upstream: message i translates to texts[i % texts.length]. */
function stubProvider(texts: string[] = ["hi"]) {
    const content = JSON.stringify({
        translations: Array.from({ length: 10 }, (_, i) => ({ id: String(i), lang: "es", text: texts[i % texts.length], skip: false }))
    });
    const mock = vi.fn(async () => ({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content } }] }),
        clone() { return this; }, text: async () => ""
    }));
    vi.stubGlobal("fetch", mock);
    return mock;
}

interface Opts { client?: boolean; ip?: string; mode?: unknown; n?: number }
const translateReq = (bearer: string, o: Opts = {}) =>
    new Request("https://relay/v1/translate", {
        method: "POST",
        headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            ...(o.client ? { "x-subline-client": CLIENT } : {}),
            ...(o.ip ? { "cf-connecting-ip": o.ip } : {})
        },
        body: JSON.stringify({
            messages: Array.from({ length: o.n ?? 1 }, (_, i) => ({ id: String(i), author: "a", text: "hola" })),
            context: [], targetLang: "en",
            ...(o.mode !== undefined ? { mode: o.mode } : {})
        })
    });
const press = async (e: Env, bearer: string, o: Opts = {}) => {
    const res = await worker.fetch(translateReq(bearer, o), e, ctx);
    return { status: res.status, body: await res.json() as any };
};
const status = async (e: Env, bearer: string, client = false) => {
    const res = await worker.fetch(new Request("https://relay/v1/status", {
        headers: { authorization: `Bearer ${bearer}`, ...(client ? { "x-subline-client": CLIENT } : {}) }
    }), e, ctx);
    return { status: res.status, body: await res.json() as any };
};
const at = (ms: number) => vi.setSystemTime(ms);

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); at(T0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); pending.length = 0; });

// ---------------------------------------------------------------------------
describe("the client marker", () => {
    it("accepts the plugin's shape and rejects anything else", () => {
        for (const ok of ["vcTranslate/0.1.5", "a", "x".repeat(40), "A.b_c/d+e-1"]) expect(isNewClient(ok), ok).toBe(true);
        for (const bad of [null, undefined, "", "x".repeat(41), "has space", "semi;colon", "é"]) expect(isNewClient(bad as any), String(bad)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe("trial start: written on the first successful translate, never by status", () => {
    it("a header'd status call on a fresh id shows a PROVISIONAL trial and writes nothing", async () => {
        const kv = fakeKV() as any;
        let puts = 0;
        const put = kv.put;
        kv.put = async (k: string, v: string, o?: any) => { puts++; return put(k, v, o); };
        const r = await status(env(kv), ID_A, true);
        expect(r.body).toEqual({ ok: true, plan: "trial", used: 0, cap: 300, resetsInMs: r.body.resetsInMs, trialEndsAt: T0 + TRIAL_MS, trialProvisional: true, now: T0 });
        await settle();
        expect(puts).toBe(0);
        expect(kv._dump()).toEqual({});
    });

    it("the first successful translate writes trial:<id> with a 90-day TTL and counts trials_started", async () => {
        stubProvider();
        const kv = fakeKV();
        await press(env(kv), ID_A, { client: true, ip: IP });
        await settle();
        expect(kv._dump()[`trial:${HEX_A}`]).toBe(String(T0));
        expect(kv._opts(`trial:${HEX_A}`)).toEqual({ expirationTtl: 90 * 86_400 });
        expect(TRIAL_KEY_TTL_S).toBe(90 * 86_400);
        expect(kv._dump()[`stat:${dayOf(T0)}:trials_started`]).toBe("1");
    });

    it("a translate REFUSED by reserve (per-IP cap) starts no trial and writes no stats", async () => {
        stubProvider();
        const kv = fakeKV({ [`use:ipt:${IP}:${dayOf(T0)}`]: "600" });
        const r = await press(env(kv), ID_A, { client: true, ip: IP });
        expect(r.status).toBe(429);
        await settle();
        expect(Object.keys(kv._dump())).toEqual([`use:ipt:${IP}:${dayOf(T0)}`]);
    });

    it("a malformed batch from a fresh id writes nothing either", async () => {
        const kv = fakeKV();
        const res = await worker.fetch(new Request("https://relay/v1/translate", {
            method: "POST",
            headers: { authorization: `Bearer ${ID_A}`, "content-type": "application/json", "x-subline-client": CLIENT },
            body: JSON.stringify({ messages: [], context: [], targetLang: "en" })
        }), env(kv), ctx);
        expect(res.status).toBe(400);
        await settle();
        expect(kv._dump()).toEqual({});
    });

    it("a header'd translate also starts it, and later calls do not move first-seen", async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        expect((await press(e, ID_A, { client: true })).body).toMatchObject({ ok: true, used: 1, cap: 300, rpmLimit: 20 });
        at(T0 + 3 * DAY);
        await press(e, ID_A, { client: true });
        expect(kv._dump()[`trial:${HEX_A}`]).toBe(String(T0));
        expect((await status(e, ID_A, true)).body.trialEndsAt).toBe(T0 + TRIAL_MS);
    });

    it("resolveFreePlan is read-only: provisional until startTrial writes", async () => {
        const kv = fakeKV();
        const e = env(kv);
        expect(await resolveFreePlan(e, ID_A, T0)).toMatchObject({ provisional: true, trialActive: true, trialEndsAt: T0 + TRIAL_MS });
        expect(kv._dump()).toEqual({});
        await startTrial(e, ID_A, T0);
        expect(await resolveFreePlan(e, ID_A, T0 + DAY)).toMatchObject({ provisional: false, trialActive: true, trialEndsAt: T0 + TRIAL_MS });
    });
});

// ---------------------------------------------------------------------------
describe("an active trial", () => {
    it("is plan trial: cap 300, rpm 20, messages-only cost", async () => {
        expect(trialRecord()).toEqual({ status: "active", plan: "trial", dailyCap: 300 });
        expect(TRIAL_DAILY_CAP).toBe(300);
        expect(rpmLimitFor(trialRecord())).toBe(20);
        expect(costFor(trialRecord(), 1, 4000)).toBe(1);
        expect(costFor(trialRecord(), 3, 12000)).toBe(3);
    });

    it("mode auto is served while the trial is active", async () => {
        stubProvider();
        const r = await press(env(fakeKV()), ID_A, { client: true, mode: "auto" });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, cap: 300 });
    });

    it("metrics rows carry the trial plan label", async () => {
        stubProvider();
        const m = fakeMetrics();
        await press(env(fakeKV(), { METRICS: m.ds }), ID_A, { client: true });
        await settle();
        expect(m.rows.map(r => [r.blobs[0], r.blobs[2]])).toEqual([["ok", "trial"]]);
    });
});

// ---------------------------------------------------------------------------
describe("per-IP trial ceiling (use:ipt:)", () => {
    it("two trial ids behind one address share 600 messages a day", async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        const ipKey = `use:ipt:${IP}:${dayOf(T0)}`;
        await press(e, ID_A, { client: true, ip: IP }); // starts trial A
        await press(e, ID_B, { client: true, ip: IP }); // starts trial B
        expect(kv._dump()[ipKey]).toBe("2");
        await kv.put(ipKey, "599");
        expect((await press(e, ID_A, { client: true, ip: IP })).status).toBe(200); // 600th
        const over = await press(e, ID_B, { client: true, ip: IP });
        expect(over.status).toBe(429);
        expect(Object.keys(over.body).sort()).toEqual(["error", "ok", "retryAfterMs"]);
        expect(over.body.error).toBe("daily limit reached");
        // The taste counter is untouched: the tiers keep separate ip counters.
        expect(Object.keys(kv._dump()).some(k => k.startsWith("use:ip:"))).toBe(false);
        expect(TRIAL_IP_DAILY_CAP).toBe(600);
    });

    it("is skipped without cf-connecting-ip", async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        expect((await press(e, ID_A, { client: true })).status).toBe(200);
        expect(Object.keys(kv._dump()).some(k => k.startsWith("use:ipt:"))).toBe(false);
    });

    it("refund gives back use:ipt: for a trial, and the legacy call still means use:ip:", async () => {
        const kv = fakeKV();
        const e = env(kv);
        const d = dayOf(T0);
        await reserve(e, ID_A, trialRecord(), 2, T0, IP);
        expect(kv._dump()[`use:ipt:${IP}:${d}`]).toBe("2");
        await refund(e, ID_A, 2, T0, IP, "trial");
        expect(kv._dump()[`use:ipt:${IP}:${d}`]).toBe("0");
        expect(kv._dump()[`use:${ID_A}:${d}`]).toBe("0");
        expect(kv._dump()[`use:ip:${IP}:${d}`]).toBeUndefined();
    });

    it("an upstream failure during a trial refunds the trial ip counter", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({
            ok: false, status: 500, headers: new Headers(), json: async () => ({}), clone() { return this; }, text: async () => ""
        })));
        const kv = fakeKV();
        const r = await press(env(kv), ID_A, { client: true, ip: IP });
        expect(r.status).toBe(503);
        await settle();
        expect(kv._dump()[`use:ipt:${IP}:${dayOf(T0)}`]).toBe("0");
    });
});

// ---------------------------------------------------------------------------
describe("after day 7", () => {
    it("the same bearer is back on taste: 3/day, status plan taste with trialEndsAt", async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        await press(e, ID_A, { client: true }); // the first translate starts the trial
        await settle();
        at(T0 + TRIAL_MS - 1);
        expect((await status(e, ID_A, true)).body.plan).toBe("trial");
        at(T0 + 7 * DAY + 1);
        const s = await status(e, ID_A, true);
        expect(s.body).toMatchObject({ ok: true, plan: "taste", used: 0, cap: 3, trialEndsAt: T0 + TRIAL_MS });
        for (const used of [1, 2, 3]) expect((await press(e, ID_A, { client: true })).body).toMatchObject({ ok: true, used, cap: 3 });
        expect((await press(e, ID_A, { client: true })).status).toBe(429);
    });

    it("mode auto is refused with 402 trial ended, reserving nothing", async () => {
        stubProvider();
        const kv = fakeKV();
        const m = fakeMetrics();
        const e = env(kv, { METRICS: m.ds });
        await kv.put(`trial:${HEX_A}`, String(T0 - 8 * DAY));
        const r = await press(e, ID_A, { client: true, mode: "auto", ip: IP });
        expect(r.status).toBe(402);
        expect(r.body).toEqual({ ok: false, error: "trial ended", trialEndsAt: T0 - 8 * DAY + TRIAL_MS, now: T0 });
        await settle();
        expect(Object.keys(kv._dump()).some(k => k.startsWith("use:") || k.startsWith("rl:"))).toBe(false);
        expect(m.rows.map(r => [r.blobs[0], r.blobs[2]])).toEqual([["trial_ended", "taste"]]);
    });

    it("mode auto WITHOUT the header is ignored: taste as usual", async () => {
        stubProvider();
        const r = await press(env(fakeKV()), ID_A, { mode: "auto" });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, used: 1, cap: 3 });
    });

    it("an unknown mode is ignored", async () => {
        stubProvider();
        const kv = fakeKV();
        await kv.put(`trial:${HEX_A}`, String(T0 - 8 * DAY));
        expect((await press(env(kv), ID_A, { client: true, mode: "turbo" })).status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
describe("a legacy (v0.1.5) client is untouched", () => {
    it("never reads or writes a trial: key, and status has exactly today's keys", async () => {
        stubProvider();
        const kv = watchKV();
        const e = env(kv);
        const s = await status(e, ID_A);
        expect(Object.keys(s.body).sort()).toEqual(["cap", "ok", "plan", "resetsInMs", "used"]);
        expect(s.body).toMatchObject({ ok: true, plan: "taste", used: 0, cap: 3 });
        const t = await press(e, ID_A, { ip: IP });
        expect(Object.keys(t.body).sort()).toEqual(["cap", "ok", "results", "rpmLimit", "used"]);
        expect(t.body).toMatchObject({ ok: true, used: 1, cap: 3, rpmLimit: 20 });
        expect(t.body.results[0]).toEqual({ id: "0", lang: "es", text: "hi", skip: false });
        await settle();
        expect(kv._reads.some(k => k.startsWith("trial:"))).toBe(false);
        expect(Object.keys(kv._dump()).some(k => k.startsWith("trial:"))).toBe(false);
        expect(kv._dump()[`use:ip:${IP}:${dayOf(T0)}`]).toBe("1");
    });

    it("a malformed header is treated as legacy", async () => {
        const kv = fakeKV();
        const res = await worker.fetch(new Request("https://relay/v1/status", {
            headers: { authorization: `Bearer ${ID_A}`, "x-subline-client": "not valid!" }
        }), env(kv), ctx);
        const body = await res.json() as any;
        expect(body.plan).toBe("taste");
        expect(body.trialEndsAt).toBeUndefined();
        expect(Object.keys(kv._dump()).some(k => k.startsWith("trial:"))).toBe(false);
    });

    it("a paid code with the header: no trial key, no trialEndsAt, only the server clock", async () => {
        const kv = fakeKV({ "code:slp_real": codeRec({ dailyCap: 500, plan: "monthly" }) });
        const s = await status(env(kv), "slp_real", true);
        expect(Object.keys(s.body).sort()).toEqual(["cap", "now", "ok", "plan", "resetsInMs", "used"]);
        expect(s.body.now).toBe(T0);
        expect(Object.keys(kv._dump()).some(k => k.startsWith("trial:"))).toBe(false);
    });

    it("/admin/codes cannot mint a trial plan", async () => {
        const kv = fakeKV();
        const res = await worker.fetch(new Request("https://relay/admin/codes", {
            method: "POST",
            headers: { authorization: "Bearer admin-tok", "content-type": "application/json" },
            body: JSON.stringify({ action: "mint", code: "slp_x", plan: "trial" })
        }), env(kv), ctx);
        expect((await res.json() as any).record.plan).toBe("free");
    });
});

// ---------------------------------------------------------------------------
describe("preview mode", () => {
    it("previewText: 6+ words → first 5 + truncated", () => {
        expect(previewText("one two three four five six seven")).toEqual({ text: "one two three four five", truncated: true });
    });
    it("previewText: short text is untouched and not flagged", () => {
        expect(previewText("  hello   there friend ")).toEqual({ text: "hello there friend", truncated: false });
        expect(previewText("a b c d e")).toEqual({ text: "a b c d e", truncated: false });
    });
    it("previewText: a long single CJK-like token is capped at 32 code points", () => {
        const long = "漢".repeat(50);
        const p = previewText(long);
        expect(Array.from(p.text)).toHaveLength(32);
        expect(p.truncated).toBe(true);
        // surrogate pairs are never split
        const emoji = "😀".repeat(40);
        expect(Array.from(previewText(emoji).text)).toEqual(Array(32).fill("😀"));
    });
    it("previewText: 5 long words over 32 code points are cut and trimmed", () => {
        const p = previewText("aaaaaaa bbbbbbb ccccccc ddddddd eeeeeee");
        expect(p.text).toBe("aaaaaaa bbbbbbb ccccccc ddddddd");
        expect(p.truncated).toBe(true);
    });

    it("a free bearer in preview gets the cut text, charged like a normal taste press", async () => {
        stubProvider(["one two three four five six seven", "short line"]);
        const kv = fakeKV();
        const e = env(kv);
        const r = await press(e, ID_A, { mode: "preview", n: 2 });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, used: 2, cap: 3 });
        expect(r.body.results[0]).toEqual({ id: "0", lang: "es", text: "one two three four five", skip: false, truncated: true });
        expect(r.body.results[1]).toEqual({ id: "1", lang: "es", text: "short line", skip: false });
        expect(JSON.stringify(r.body)).not.toContain("six seven");
        await settle();
        expect(kv._dump()[`stat:${dayOf(T0)}:previews`]).toBe("1");
    });

    it("a trial bearer in preview is also cut", async () => {
        stubProvider(["one two three four five six"]);
        const r = await press(env(fakeKV()), ID_A, { client: true, mode: "preview" });
        expect(r.body).toMatchObject({ cap: 300 });
        expect(r.body.results[0].truncated).toBe(true);
    });

    it("preview is ignored for a paid code: full text", async () => {
        stubProvider(["one two three four five six seven"]);
        const kv = fakeKV({ "code:slp_real": codeRec({ dailyCap: 500, plan: "monthly" }) });
        const r = await press(env(kv), "slp_real", { mode: "preview" });
        expect(r.body.results[0]).toEqual({ id: "0", lang: "es", text: "one two three four five six seven", skip: false });
        await settle();
        expect(kv._dump()[`stat:${dayOf(T0)}:previews`]).toBeUndefined();
    });

    it("preview reserves against the daily cap: the 4th preview is refused", async () => {
        stubProvider();
        const e = env(fakeKV());
        for (let i = 0; i < 3; i++) expect((await press(e, ID_A, { mode: "preview" })).status).toBe(200);
        expect((await press(e, ID_A, { mode: "preview" })).status).toBe(429);
    });
});
