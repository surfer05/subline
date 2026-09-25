import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import {
    authCode, reserve, refund, usage, rpmLimitFor, costFor, tasteRecord,
    TASTE_DAILY_CAP, TASTE_IP_DAILY_CAP, type Env, type CodeRecord
} from "../src/codes";
import { fakeKV, codeRec, fakeBudget } from "./kv-mock";

// ===========================================================================
//  THE TASTE TIER — a keyless install gets 3 quality translations a day.
//
//  The bearer is `free_<32 hex>`, generated on the install's own machine. It is
//  never minted and never stored: authCode resolves it to a SYNTHETIC record
//  ({ status:"active", plan:"taste", dailyCap:3 }) without reading KV, so there
//  is nothing to revoke and nothing whose cap could be raised. The daily cost
//  is MESSAGES ONLY, so 3 presses is 3 translations however long they are, and
//  a per-IP ceiling of 6 keeps a rerolled id from simply resetting the cap.
// ===========================================================================

const ID_A = "free_" + "a".repeat(32);
const ID_B = "free_" + "b".repeat(32);
const ID_C = "free_" + "c".repeat(32);
const IP = "203.0.113.7";

/** A KV that records every key read, so "never touches KV" is assertable. */
function watchKV(seed: Record<string, string> = {}) {
    const kv = fakeKV(seed) as any;
    const reads: string[] = [];
    const get = kv.get;
    kv.get = async (k: string) => { reads.push(k); return get(k); };
    kv._reads = reads;
    return kv as ReturnType<typeof fakeKV> & { _reads: string[] };
}

/** Analytics Engine stand-in: keeps the rows so plan labels are assertable. */
function fakeMetrics() {
    const rows: any[] = [];
    return { ds: { writeDataPoint: (p: any) => { rows.push(p); } } as unknown as AnalyticsEngineDataset, rows };
}

const env = (kv: any, over: Partial<Env> = {}): Env =>
    ({ CODES: kv, GROQ_KEY: "gk", ADMIN_TOKEN: "admin-tok", MODEL: "m", BUDGET: fakeBudget().ns, ...over });

// waitUntil work (metrics, refunds) is collected so tests can await it.
const pending: Promise<unknown>[] = [];
const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {}
} as unknown as ExecutionContext;
const settle = () => Promise.all(pending.splice(0));

/** Stub the upstream provider: one translation per id 0..9 (extra ids are
 *  ignored by the parser, so one fixture serves every batch size here). */
function stubProvider() {
    const content = JSON.stringify({
        translations: Array.from({ length: 10 }, (_, i) => ({ id: String(i), lang: "es", text: "hi", skip: false }))
    });
    const mock = vi.fn(async () => ({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ choices: [{ message: { content } }] }),
        clone() { return this; }, text: async () => ""
    }));
    vi.stubGlobal("fetch", mock);
    return mock;
}

const translateReq = (bearer: string, texts: string[], ip?: string) =>
    new Request("https://relay/v1/translate", {
        method: "POST",
        headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            ...(ip ? { "cf-connecting-ip": ip } : {})
        },
        body: JSON.stringify({
            messages: texts.map((t, i) => ({ id: String(i), author: "a", text: t })),
            context: [], targetLang: "en"
        })
    });
const press = async (e: Env, bearer: string, texts: string[] = ["hola"], ip?: string) => {
    const res = await worker.fetch(translateReq(bearer, texts, ip), e, ctx);
    return { status: res.status, body: await res.json() as any };
};
const statusReq = (bearer: string) =>
    new Request("https://relay/v1/status", { headers: { authorization: `Bearer ${bearer}` } });

afterEach(() => { vi.restoreAllMocks(); pending.length = 0; });

// ---------------------------------------------------------------------------
describe("taste auth: a synthetic record, never a KV row", () => {
    it("a valid free_<32 hex> bearer resolves to the taste record without reading KV", async () => {
        const kv = watchKV();
        expect(await authCode(env(kv), ID_A)).toEqual({
            ok: true, record: { status: "active", plan: "taste", dailyCap: 3 }
        });
        expect(kv._reads).toEqual([]); // no lookup at all: nothing to mint, nothing to revoke
    });

    it("every other free_ shape reads as unknown_code, with no KV lookup (no oracle)", async () => {
        const kv = watchKV();
        const bad = [
            "free_",                       // no id
            "free_abc",                    // too short
            "free_" + "a".repeat(31),      // 31 hex
            "free_" + "a".repeat(33),      // 33 hex
            "free_" + "A".repeat(32),      // uppercase is not [0-9a-f]
            "free_" + "g".repeat(32),      // not hex
            "free_" + "a".repeat(32) + "!",
            "free_" + "a".repeat(16) + "-" + "a".repeat(15),
        ];
        for (const b of bad) {
            expect(await authCode(env(kv), b), b).toEqual({ ok: false, reason: "unknown_code" });
        }
        expect(kv._reads).toEqual([]);
    });

    it("a free_ row written into KV cannot raise the cap: the synthetic record still wins", async () => {
        const kv = watchKV({ [`code:${ID_A}`]: codeRec({ dailyCap: 100000, plan: "lifetime" }) });
        expect(await authCode(env(kv), ID_A)).toMatchObject({ ok: true, record: { plan: "taste", dailyCap: 3 } });
    });

    it("a taste install gets the unpaid rate ceiling, and messages-only cost", () => {
        expect(rpmLimitFor(tasteRecord())).toBe(20);
        expect(TASTE_DAILY_CAP).toBe(3);
        expect(TASTE_IP_DAILY_CAP).toBe(6);
        // messages only: a 4000-char message costs exactly 1.
        expect(costFor(tasteRecord(), 1, 4000)).toBe(1);
        expect(costFor(tasteRecord(), 3, 12000)).toBe(3);
        // a real code keeps the prompt-size surcharge, unchanged.
        const paid: CodeRecord = { status: "active", plan: "monthly", dailyCap: 1500 };
        expect(costFor(paid, 1, 4000)).toBe(5);
    });
});

// ---------------------------------------------------------------------------
describe("POST /v1/translate: 3 a day, then the nudge", () => {
    it("allows exactly 3 messages a day, then 429s with the cap shape", async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        for (const expected of [1, 2, 3]) {
            const r = await press(e, ID_A);
            expect(r.status).toBe(200);
            expect(r.body).toMatchObject({ ok: true, used: expected, cap: 3, rpmLimit: 20 });
            expect(r.body.results).toHaveLength(1);
        }
        const over = await press(e, ID_A);
        expect(over.status).toBe(429);
        expect(over.body.ok).toBe(false);
        expect(over.body.error).toBe("daily limit reached");
        expect(over.body.retryAfterMs).toBeGreaterThan(0);
    });

    it("counts MESSAGES, not characters: three 4000-char presses still fit in the 3", async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        const long = ["x".repeat(4000)];
        for (const expected of [1, 2, 3]) {
            expect((await press(e, ID_A, long)).body).toMatchObject({ ok: true, used: expected, cap: 3 });
        }
        expect((await press(e, ID_A, long)).status).toBe(429);
    });

    it("a batch of 3 messages spends the whole day in one press", async () => {
        stubProvider();
        const e = env(fakeKV());
        expect((await press(e, ID_A, ["a", "b", "c"])).body).toMatchObject({ ok: true, used: 3, cap: 3 });
        expect((await press(e, ID_A)).status).toBe(429);
    });

    it("meters per install id, and writes no code: row for any of them", async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        await press(e, ID_A); await press(e, ID_A); await press(e, ID_A);
        expect((await press(e, ID_A)).status).toBe(429);
        expect((await press(e, ID_B)).body).toMatchObject({ ok: true, used: 1, cap: 3 });
        const keys = Object.keys(kv._dump());
        expect(keys.some(k => k.startsWith("code:"))).toBe(false);
        expect(keys).toContain(`use:${ID_A}:${new Date().toISOString().slice(0, 10)}`);
    });
});

// ---------------------------------------------------------------------------
describe("per-IP ceiling: rerolling the id does not reset the cap", () => {
    it("two different ids from the same address share 6 messages a day", async () => {
        stubProvider();
        const e = env(fakeKV());
        for (let i = 0; i < 3; i++) expect((await press(e, ID_A, ["hola"], IP)).status).toBe(200);
        for (let i = 0; i < 3; i++) expect((await press(e, ID_B, ["hola"], IP)).status).toBe(200);
        // A third, entirely fresh id from that address is out of address quota,
        // even though its own bearer counter is still at zero.
        const third = await press(e, ID_C, ["hola"], IP);
        expect(third.status).toBe(429);
        expect(third.body).toMatchObject({ ok: false, error: "daily limit reached" });
        expect(third.body.retryAfterMs).toBeGreaterThan(0);
        // Same body shape as the per-bearer cap: the client cannot tell which
        // ceiling it hit, and a farmer learns nothing to evade.
        expect(Object.keys(third.body).sort()).toEqual(["error", "ok", "retryAfterMs"]);
    });

    it("a different address has its own 6", async () => {
        stubProvider();
        const e = env(fakeKV());
        for (let i = 0; i < 3; i++) await press(e, ID_A, ["hola"], IP);
        for (let i = 0; i < 3; i++) await press(e, ID_B, ["hola"], IP);
        expect((await press(e, ID_C, ["hola"], "198.51.100.4")).status).toBe(200);
    });

    it("no cf-connecting-ip ⇒ the address cap is skipped, never a denial", async () => {
        stubProvider();
        const e = env(fakeKV());
        for (let i = 0; i < 3; i++) expect((await press(e, ID_A)).status).toBe(200);
        for (let i = 0; i < 3; i++) expect((await press(e, ID_B)).status).toBe(200);
        expect((await press(e, ID_C)).status).toBe(200); // 7th message, no IP cap to hit
    });

    it("a real code never grows an ip counter, even behind the same header", async () => {
        stubProvider();
        const kv = fakeKV({ "code:slp_real": codeRec({ dailyCap: 500, plan: "monthly" }) });
        const e = env(kv);
        expect((await press(e, "slp_real", ["hola"], IP)).status).toBe(200);
        expect(Object.keys(kv._dump()).some(k => k.startsWith("use:ip:"))).toBe(false);
    });

    it("an upstream failure refunds the address counter too", async () => {
        const kv = fakeKV();
        const e = env(kv);
        const day = new Date().toISOString().slice(0, 10);
        await reserve(e, ID_A, tasteRecord(), 1, Date.now(), IP);
        expect(kv._dump()[`use:ip:${IP}:${day}`]).toBe("1");
        await refund(e, ID_A, 1, Date.now(), IP);
        expect(kv._dump()[`use:ip:${IP}:${day}`]).toBe("0");
        expect(kv._dump()[`use:${ID_A}:${day}`]).toBe("0");
    });
});

// ---------------------------------------------------------------------------
describe("GET /v1/status: what the plugin reads at startup", () => {
    it("reports plan taste with the message counts", async () => {
        stubProvider();
        const kv = fakeKV();
        const e = env(kv);
        const first = await (await worker.fetch(statusReq(ID_A), e, ctx)).json() as any;
        expect(first).toMatchObject({ ok: true, plan: "taste", used: 0, cap: 3 });
        expect(first.resetsInMs).toBeGreaterThan(0);

        await press(e, ID_A, ["a", "b"]);
        const after = await (await worker.fetch(statusReq(ID_A), e, ctx)).json() as any;
        expect(after).toMatchObject({ ok: true, plan: "taste", used: 2, cap: 3 });
    });

    it("usage() reads the same counter a code uses, keyed by the bearer", async () => {
        const kv = fakeKV();
        const e = env(kv);
        await reserve(e, ID_A, tasteRecord(), 2, Date.now());
        expect(await usage(e, ID_A, tasteRecord(), Date.now())).toMatchObject({ used: 2, cap: 3 });
    });

    it("a malformed free_ bearer is treated exactly like an unknown code", async () => {
        const e = env(fakeKV());
        const bad = "free_nope";
        // translate: 401, same as any unknown code
        const t = await press(e, bad);
        expect(t.status).toBe(401);
        expect(t.body).toEqual({ ok: false, error: "invalid or missing code" });
        expect((await press(e, "slp_unknown")).status).toBe(401);
        // status: the endpoint's existing unknown-code status, unchanged
        const s = await worker.fetch(statusReq(bad), e, ctx);
        const ref = await worker.fetch(statusReq("slp_unknown"), e, ctx);
        expect(s.status).toBe(ref.status);
        expect(await s.json()).toEqual({ ok: false, error: "invalid or missing code" });
    });
});

// ---------------------------------------------------------------------------
describe("metrics: the funnel is countable", () => {
    it("labels taste rows with the plan, on both the taste and the cap_exceeded", async () => {
        stubProvider();
        const m = fakeMetrics();
        const e = env(fakeKV(), { METRICS: m.ds });
        for (let i = 0; i < 3; i++) await press(e, ID_A);
        await press(e, ID_A);
        await settle();
        const labels = m.rows.map(r => [r.blobs[0], r.blobs[2]]);
        expect(labels.filter(([o, p]) => o === "ok" && p === "taste")).toHaveLength(3);
        expect(labels).toContainEqual(["cap_exceeded", "taste"]);
        // The code itself is never in a row; only a short fingerprint.
        expect(JSON.stringify(m.rows)).not.toContain(ID_A);
    });

    it("a real code carries its own plan label, and an unauthenticated row carries none", async () => {
        stubProvider();
        const m = fakeMetrics();
        const e = env(fakeKV({ "code:slp_real": codeRec({ dailyCap: 500, plan: "monthly" }) }), { METRICS: m.ds });
        await press(e, "slp_real");
        await press(e, "slp_unknown");
        await settle();
        // Sorted: each row is written from its own waitUntil after an async
        // fingerprint digest, so arrival order between requests is not defined.
        expect(m.rows.map(r => [r.blobs[0], r.blobs[2]]).sort()).toEqual([
            ["ok", "monthly"],
            ["unknown_code", "-"],
        ]);
    });
});

// ---------------------------------------------------------------------------
describe("a real code is untouched, and free_ can never be minted", () => {
    it("a paid code still pays the prompt-size surcharge and keeps its own cap", async () => {
        stubProvider();
        const kv = fakeKV({ "code:slp_real": codeRec({ dailyCap: 500, plan: "monthly" }) });
        const r = await press(env(kv), "slp_real", ["x".repeat(4000)]);
        // 1 message + ceil((4000 + "a" + "en")/1000) = 1 + 5
        expect(r.body).toMatchObject({ ok: true, used: 6, cap: 500, rpmLimit: 60 });
    });

    it("POST /admin/codes refuses to mint a free_ code", async () => {
        const kv = fakeKV();
        const e = env(kv);
        const res = await worker.fetch(new Request("https://relay/admin/codes", {
            method: "POST",
            headers: { authorization: "Bearer admin-tok", "content-type": "application/json" },
            body: JSON.stringify({ action: "mint", code: ID_A, dailyCap: 100000 })
        }), e, ctx);
        expect(res.status).toBe(400);
        expect(Object.keys(kv._dump())).not.toContain(`code:${ID_A}`);
        // and the bearer still resolves to the 3/day synthetic record
        expect(await authCode(e, ID_A)).toMatchObject({ ok: true, record: { dailyCap: 3 } });
    });

    it("POST /admin/codes cannot revoke a taste bearer either", async () => {
        const kv = fakeKV();
        const e = env(kv);
        const res = await worker.fetch(new Request("https://relay/admin/codes", {
            method: "POST",
            headers: { authorization: "Bearer admin-tok", "content-type": "application/json" },
            body: JSON.stringify({ action: "revoke", code: ID_A })
        }), e, ctx);
        expect(res.status).toBe(404); // there is no row to revoke
        expect(await authCode(e, ID_A)).toMatchObject({ ok: true });
    });
});
