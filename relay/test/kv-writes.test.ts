import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import worker from "../src/index";
import {
    reserve, refund, ipBucket, budgetCostFor, tasteRecord, trialRecord, startTrial,
    TRIAL_IP_DAILY_COST_CAP, type Env
} from "../src/codes";
import { fakeKV, codeRec, fakeBudget } from "./kv-mock";

// ===========================================================================
//  KV WRITE DISCIPLINE, SPEND UNITS, AND THE SERVER CLOCK (v0.1.6 review)
//
//  - /v1/status never writes; a trial is written only after a successful
//    reserve; a failing KV write never fails a request.
//  - The global budget and the trial's per-IP cost cap are charged real spend
//    (messages + ceil(promptChars/1000)); the bearer's used/cap stay messages.
//  - IPv6 callers are bucketed on their /64.
//  - `now` rides header'd responses only; legacy bodies are byte-identical.
// ===========================================================================

const HEX_A = "a".repeat(32), HEX_B = "b".repeat(32), HEX_C = "c".repeat(32);
const ID_A = "free_" + HEX_A, ID_B = "free_" + HEX_B, ID_C = "free_" + HEX_C;
const PAID = "slp_realpaidcode";
const IP = "203.0.113.7";
const CLIENT = "vcTranslate/0.1.6";
const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);
const DAY = 86_400_000;
const D0 = "2026-09-10";

/** A KV that counts every put by key, so write amplification is assertable. */
function countingKV(seed: Record<string, string> = {}) {
    const kv = fakeKV(seed) as any;
    const puts: string[] = [];
    const put = kv.put;
    kv.put = async (k: string, v: string, o?: any) => { puts.push(k); return put(k, v, o); };
    kv._puts = puts;
    return kv as ReturnType<typeof fakeKV> & { _puts: string[] };
}

function makeEnv(kv: any, over: Partial<Env> = {}) {
    const budget = fakeBudget();
    const e: Env = { CODES: kv, GROQ_KEY: "gk", ADMIN_TOKEN: "admin-tok", MODEL: "m", BUDGET: budget.ns, ...over };
    return { e, budget: budget.state };
}

const pending: Promise<unknown>[] = [];
const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {}
} as unknown as ExecutionContext;
/** Await ALL waitUntil work, including work queued while settling. */
async function settle() { while (pending.length) await Promise.all(pending.splice(0)); }

function stubProvider(text = "hi") {
    const content = JSON.stringify({
        translations: Array.from({ length: 10 }, (_, i) => ({ id: String(i), lang: "es", text, skip: false }))
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content } }] }),
        clone() { return this; }, text: async () => ""
    })));
}

interface Opts { client?: boolean; ip?: string; mode?: string; text?: string }
const translateReq = (bearer: string, o: Opts = {}) => new Request("https://relay/v1/translate", {
    method: "POST",
    headers: {
        authorization: `Bearer ${bearer}`, "content-type": "application/json",
        ...(o.client ? { "x-subline-client": CLIENT } : {}),
        ...(o.ip ? { "cf-connecting-ip": o.ip } : {})
    },
    body: JSON.stringify({
        messages: [{ id: "0", author: "a", text: o.text ?? "hola" }], context: [], targetLang: "en",
        ...(o.mode ? { mode: o.mode } : {})
    })
});
const press = async (e: Env, bearer: string, o: Opts = {}) => {
    const res = await worker.fetch(translateReq(bearer, o), e, ctx);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
};
const status = async (e: Env, bearer: string, client = false) => {
    const res = await worker.fetch(new Request("https://relay/v1/status", {
        headers: { authorization: `Bearer ${bearer}`, ...(client ? { "x-subline-client": CLIENT } : {}) }
    }), e, ctx);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
};

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); pending.length = 0; });

// ---------------------------------------------------------------------------
describe("fix 1: status is read-only; a KV write failure never fails a request", () => {
    it("status never writes, for a fresh header'd id, a known id, a legacy id, or a paid code", async () => {
        const kv = countingKV({ [`trial:${HEX_B}`]: String(T0 - DAY), [`code:${PAID}`]: codeRec({ plan: "monthly" }) });
        const { e } = makeEnv(kv);
        expect((await status(e, ID_A, true)).body).toMatchObject({ plan: "trial", trialEndsAt: T0 + 7 * DAY });
        expect((await status(e, ID_B, true)).body).toMatchObject({ plan: "trial", trialEndsAt: T0 + 6 * DAY });
        expect((await status(e, ID_C)).body).toMatchObject({ plan: "taste" });
        expect((await status(e, PAID, true)).body).toMatchObject({ plan: "monthly" });
        await settle();
        expect(kv._puts).toEqual([]);
    });

    it("a KV whose put always throws: a paid translate still answers 200 with results", async () => {
        stubProvider("hello");
        const kv = fakeKV({ [`code:${PAID}`]: codeRec({ plan: "monthly", dailyCap: 1500 }) }) as any;
        kv.put = async () => { throw new Error("KV put failed: 503"); };
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { e } = makeEnv(kv);
        const r = await press(e, PAID, { ip: IP });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, used: 2, cap: 1500, rpmLimit: 60 });
        expect(r.body.results).toEqual([{ id: "0", lang: "es", text: "hello", skip: false }]);
        await expect(settle()).resolves.toBeUndefined();
        // The failure is logged with its cause, never with the code or address.
        expect(warn).toHaveBeenCalled();
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).toContain("KV put failed: 503");
        expect(logged).not.toContain(PAID);
        expect(logged).not.toContain(IP);
    });

    it("N1: the same throwing KV fails CLOSED for keyless: taste, trial and preview get 503, nothing spent, no model call", async () => {
        stubProvider();
        const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
        const kv = fakeKV({ [`code:${PAID}`]: codeRec({ plan: "monthly", dailyCap: 1500 }) }) as any;
        kv.put = async () => { throw new Error("KV put failed"); };
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { e, budget } = makeEnv(kv);
        let served = 0;
        for (let i = 0; i < 50; i++) {
            for (const r of [
                await press(e, ID_A, { client: true, ip: IP }),                  // trial
                await press(e, ID_B, { ip: IP }),                                 // legacy taste
                await press(e, ID_C, { client: true, mode: "preview", ip: IP })   // preview
            ]) {
                if (r.status === 200) served++;
                else {
                    expect(r.status).toBe(503);
                    expect(r.body).toMatchObject({ ok: false, error: "temporarily unavailable" });
                }
            }
        }
        expect(served).toBe(0);
        expect(budget.total).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
        // …while a paid code on the same broken KV is still served (fail-open).
        const paid = await press(e, PAID, { ip: IP });
        expect(paid.status).toBe(200);
        expect(fetchMock).toHaveBeenCalled();
        await expect(settle()).resolves.toBeUndefined();
    });

    it("NEW-2: a frozen budget costs a keyless request ZERO KV writes", async () => {
        stubProvider();
        const kv = countingKV();
        const { e, budget } = makeEnv(kv);
        budget.frozen = true;
        for (const r of [
            await press(e, ID_A, { client: true, ip: IP }),
            await press(e, ID_B, { ip: IP }),
            await press(e, ID_C, { client: true, mode: "preview", ip: IP })
        ]) {
            expect(r.status).toBe(429);
            expect(r.body).toMatchObject({ ok: false, error: "temporarily unavailable" });
        }
        await settle();
        expect(kv._puts).toEqual([]);
    });

    it("N1: a keyless request whose budget is refused rolls its counters back", async () => {
        stubProvider();
        const kv = fakeKV();
        const { e } = makeEnv(kv, { GLOBAL_BUDGET_MESSAGES: "1" } as any);
        await press(e, ID_A, { ip: IP });      // spends the whole budget
        const before = { ...kv._dump() };
        const r = await press(e, ID_B, { ip: IP });
        expect(r.status).toBe(429);
        const after = kv._dump();
        expect(after[`use:${ID_B}:${new Date(T0).toISOString().slice(0, 10)}`] ?? "0").toBe("0");
        for (const k of Object.keys(before).filter(k => k.startsWith("use:ip:"))) expect(after[k]).toBe(before[k]);
    });

    it("a failing refund write never rejects (it runs after the response)", async () => {
        const kv = fakeKV() as any;
        kv.put = async () => { throw new Error("down"); };
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { e } = makeEnv(kv);
        await expect(refund(e, ID_A, 1, T0, IP, "trial", 3)).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
describe("fix 2: rl: is skipped only where the daily cap makes it unreachable", () => {
    it("taste (cap 3 < rpm 20) writes no rl:, trial and paid still do", async () => {
        const kv = countingKV();
        const { e } = makeEnv(kv);
        await reserve(e, ID_A, tasteRecord(), 1, T0);
        expect(kv._puts.some(k => k.startsWith("rl:"))).toBe(false);
        await reserve(e, ID_B, trialRecord(), 1, T0);
        expect(kv._puts.filter(k => k.startsWith("rl:"))).toEqual([`rl:${ID_B}:${Math.floor(T0 / 60_000)}`]);
        await reserve(e, PAID, { status: "active", plan: "monthly", dailyCap: 1500 }, 1, T0);
        expect(kv._puts.filter(k => k.startsWith("rl:"))).toHaveLength(2);
    });

    it("the trial rate limit still bites at 20 a minute", async () => {
        const kv = fakeKV({ [`rl:${ID_A}:${Math.floor(T0 / 60_000)}`]: "20" });
        const { e } = makeEnv(kv);
        expect(await reserve(e, ID_A, trialRecord(), 1, T0)).toMatchObject({ ok: false, reason: "rate_limited" });
    });

    it("KV put count per path (first request of the day, then a repeat)", async () => {
        stubProvider();
        const kv = countingKV({ [`code:${PAID}`]: codeRec({ plan: "monthly", dailyCap: 1500 }) });
        const { e } = makeEnv(kv);
        const count = async (fn: () => Promise<unknown>) => {
            const before = kv._puts.length;
            await fn(); await settle();
            return kv._puts.slice(before);
        };
        const table: Record<string, string[]> = {};
        table["legacy taste translate (1st of day)"] = await count(() => press(e, ID_C, { ip: IP }));
        table["legacy taste translate (repeat)"] = await count(() => press(e, ID_C, { ip: IP }));
        table["trial translate (first request)"] = await count(() => press(e, ID_A, { client: true, ip: IP }));
        table["trial translate (subsequent)"] = await count(() => press(e, ID_A, { client: true, ip: IP }));
        await kv.put(`trial:${HEX_B}`, String(T0 - 8 * DAY)); // B's trial is over
        table["taste preview, v0.1.6 (1st of day)"] = await count(() => press(e, ID_B, { client: true, ip: IP, mode: "preview" }));
        table["taste preview, v0.1.6 (repeat)"] = await count(() => press(e, ID_B, { client: true, ip: IP, mode: "preview" }));
        table["paid translate (1st of day)"] = await count(() => press(e, PAID));
        table["paid translate (repeat)"] = await count(() => press(e, PAID));
        table["status legacy"] = await count(() => status(e, ID_C));
        table["status v0.1.6 fresh id"] = await count(() => status(e, "free_" + "d".repeat(32), true));
        table["status v0.1.6 known id"] = await count(() => status(e, ID_A, true));
        table["admin stats"] = await count(() => worker.fetch(new Request("https://relay/admin/stats?days=30", {
            headers: { authorization: "Bearer admin-tok" }
        }), e, ctx));

        // Key FAMILY, without the day/id/address: "stat:<day>:previews" → "stat:previews".
        const family = (k: string) => {
            const p = k.split(":");
            if (p[0] === "stat") return "stat:" + p.slice(2).join(":");
            if (p[0] === "seen") return "seen:" + p[1];
            if (p[0] === "use" && p[1]!.startsWith("ip")) return "use:" + p[1];
            return p[0]!;
        };
        const shape = (keys: string[]) => keys.map(family).sort();
        expect(Object.fromEntries(Object.entries(table).map(([k, v]) => [k, shape(v)]))).toEqual({
            "legacy taste translate (1st of day)": ["seen:free", "stat:free_active", "use", "use:ip"],
            "legacy taste translate (repeat)": ["use", "use:ip"],
            "trial translate (first request)": [
                "rl", "seen:free", "seen:trial", "stat:free_active", "stat:trial_active", "stat:trials_started",
                "trial", "use", "use:ipt", "use:iptc"
            ],
            "trial translate (subsequent)": ["rl", "use", "use:ipt", "use:iptc"],
            "taste preview, v0.1.6 (1st of day)": ["seen:free", "stat:free_active", "stat:previews", "use", "use:ip"],
            "taste preview, v0.1.6 (repeat)": ["stat:previews", "use", "use:ip"],
            "paid translate (1st of day)": ["rl", "seen:paid", "stat:paid_active", "use"],
            "paid translate (repeat)": ["rl", "use"],
            "status legacy": [],
            "status v0.1.6 fresh id": [],
            "status v0.1.6 known id": [],
            "admin stats": [],
        });
    });
});

// ---------------------------------------------------------------------------
describe("fix 3: spend units, the trial cost cap, and IPv6 /64 buckets", () => {
    const LONG = "x".repeat(4000); // 4000 + author "a" + "en" = 4003 chars → +5 units

    it("taste and trial: the global budget is charged messages + ceil(chars/1000); used stays messages", async () => {
        stubProvider();
        const { e, budget } = makeEnv(fakeKV());
        expect((await press(e, ID_C, { text: LONG })).body).toMatchObject({ ok: true, used: 1, cap: 3 });
        expect(budget.total).toBe(6);
        expect((await press(e, ID_A, { client: true, text: LONG })).body).toMatchObject({ ok: true, used: 1, cap: 300 });
        expect(budget.total).toBe(12);
        expect((await status(e, ID_A, true)).body.used).toBe(1);
        expect(budgetCostFor(1, 4003)).toBe(6);
    });

    it("the per-IP cost-unit cap trips on long messages well before the message cap", async () => {
        stubProvider();
        const kv = fakeKV({ [`use:iptc:${IP}:${D0}`]: String(TRIAL_IP_DAILY_COST_CAP - 5) });
        const { e, budget } = makeEnv(kv);
        const r = await press(e, ID_A, { client: true, ip: IP, text: LONG });
        expect(r.status).toBe(429);
        expect(r.body.error).toBe("daily limit reached");
        expect(kv._dump()[`use:ipt:${IP}:${D0}`]).toBeUndefined(); // 0 of 600 messages used
        expect(budget.total).toBe(0); // refused before any spend
        // A short line (1 message + 1 unit = 2) still fits: 1195 + 2 = 1197 ≤ 1200.
        expect((await press(e, ID_A, { client: true, ip: IP })).status).toBe(200);
        expect(kv._dump()[`use:iptc:${IP}:${D0}`]).toBe("1197");
        expect(kv._dump()[`use:ipt:${IP}:${D0}`]).toBe("1");
    });

    it("an upstream failure refunds the cost-unit counter by the cost units", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({
            ok: false, status: 500, headers: new Headers(), json: async () => ({}), clone() { return this; }, text: async () => ""
        })));
        const kv = fakeKV();
        const { e } = makeEnv(kv);
        expect((await press(e, ID_A, { client: true, ip: IP, text: LONG })).status).toBe(503);
        await settle();
        expect(kv._dump()[`use:iptc:${IP}:${D0}`]).toBe("0");
        expect(kv._dump()[`use:ipt:${IP}:${D0}`]).toBe("0");
        expect(kv._dump()[`use:${ID_A}:${D0}`]).toBe("0");
    });

    it("ipBucket: IPv4 as is, IPv6 on its /64 whatever the spelling, mapped IPv4 as IPv4", () => {
        expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
        expect(ipBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
        expect(ipBucket("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
        expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
        expect(ipBucket("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
        expect(ipBucket("::1")).toBe("0:0:0:0::/64");
        expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
        expect(ipBucket("not:an:ip:::")).toBe("not:an:ip:::"); // unparseable: its own bucket
    });

    it("two IPv6 addresses in one /64 share the taste address cap; another /64 does not", async () => {
        stubProvider();
        const { e } = makeEnv(fakeKV());
        for (let i = 0; i < 3; i++) expect((await press(e, ID_A, { ip: "2001:db8:1:2::a" })).status).toBe(200);
        for (let i = 0; i < 3; i++) expect((await press(e, ID_B, { ip: "2001:db8:1:2:dead:beef:0:1" })).status).toBe(200);
        expect((await press(e, ID_C, { ip: "2001:db8:1:2::ffff" })).status).toBe(429);
        expect((await press(e, ID_C, { ip: "2001:db8:1:3::a" })).status).toBe(200);
    });

    it("the trial counters are bucketed on the /64 too", async () => {
        const kv = fakeKV();
        const { e } = makeEnv(kv);
        await reserve(e, ID_A, trialRecord(), 1, T0, "2001:db8:1:2::a", 2);
        await reserve(e, ID_B, trialRecord(), 1, T0, "2001:db8:1:2::b", 2);
        expect(kv._dump()[`use:ipt:2001:db8:1:2::/64:${D0}`]).toBe("2");
        expect(kv._dump()[`use:iptc:2001:db8:1:2::/64:${D0}`]).toBe("4");
    });
});

// ---------------------------------------------------------------------------
describe("fix 4: `now` for header'd clients only; legacy bodies byte-identical", () => {
    it("legacy status and translate bodies are exactly the pre-v0.1.6 bytes", async () => {
        stubProvider();
        const { e } = makeEnv(fakeKV());
        const s = await status(e, ID_A);
        expect(s.text).toBe(JSON.stringify({ ok: true, plan: "taste", used: 0, cap: 3, resetsInMs: DAY - (T0 % DAY) }));
        const t = await press(e, ID_A, { ip: IP });
        expect(t.text).toBe(JSON.stringify({ ok: true, results: [{ id: "0", lang: "es", text: "hi", skip: false }], used: 1, cap: 3, rpmLimit: 20 }));
    });

    it("header'd status, translate success, and the 402 carry the server clock", async () => {
        stubProvider();
        const kv = fakeKV();
        const { e } = makeEnv(kv);
        expect((await status(e, ID_A, true)).body.now).toBe(T0);
        expect((await press(e, ID_A, { client: true })).body).toMatchObject({ ok: true, now: T0 });
        await kv.put(`trial:${HEX_B}`, String(T0 - 8 * DAY));
        const r = await press(e, ID_B, { client: true, mode: "auto" });
        expect(r.status).toBe(402);
        expect(r.body).toEqual({ ok: false, error: "trial ended", trialEndsAt: T0 - DAY, now: T0 });
    });
});

// ---------------------------------------------------------------------------
describe("fix 5: a failed trial lookup refuses mode auto instead of spending taste", () => {
    function trialLookupDown() {
        const kv = fakeKV() as any;
        const get = kv.get;
        kv.get = async (k: string) => { if (k.startsWith("trial:")) throw new Error("KV get failed"); return get(k); };
        return kv;
    }

    it("N4: mode auto → 503 temporarily unavailable (never 'trial ended'), nothing reserved", async () => {
        stubProvider();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const kv = trialLookupDown();
        const { e, budget } = makeEnv(kv);
        const r = await press(e, ID_A, { client: true, mode: "auto", ip: IP });
        expect(r.status).toBe(503);
        expect(r.body).toMatchObject({ ok: false, error: "temporarily unavailable" });
        expect(JSON.stringify(r.body)).not.toContain("trial ended");
        await settle();
        expect(kv._dump()).toEqual({});
        expect(budget.total).toBe(0);
    });

    it("a hand press in the same outage still gets taste", async () => {
        stubProvider();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { e } = makeEnv(trialLookupDown());
        expect((await press(e, ID_A, { client: true })).body).toMatchObject({ ok: true, used: 1, cap: 3 });
    });
});

// ---------------------------------------------------------------------------
describe("startTrial", () => {
    it("a failing stats bump does not fail the trial write", async () => {
        const kv = fakeKV() as any;
        const put = kv.put;
        kv.put = async (k: string, v: string, o?: any) => { if (k.startsWith("stat:")) throw new Error("down"); return put(k, v, o); };
        await expect(startTrial(makeEnv(kv).e, ID_A, T0)).resolves.toBeUndefined();
        expect(kv._dump()[`trial:${HEX_A}`]).toBe(String(T0));
    });
});
