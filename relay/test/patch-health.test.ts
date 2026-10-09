import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
    PatchHealth, validateReport, applyReport, emptyDay, alertMime,
    MAX_BUILDS_PER_INSTALL, MAX_REPORTS_PER_ADDRESS, MAX_EMAILS_PER_DAY, MAX_FAILED_PER_REPORT, KEEP_MS,
    MAX_PATCHES_PER_DAY, MAX_NEW_PATCHES_PER_ADDRESS, PATCH_PLUGINS, RESERVED_EMAILS
} from "../src/patchHealth";
const { readFileSync } = await import("node:" + "fs") as { readFileSync: (p: URL, enc: string) => string };
import { fakeDOStorage, fakeKV } from "./kv-mock";

/** A PatchHealth namespace running the REAL class, one instance per name. */
function fakePatchHealthNs() {
    const objects = new Map<string, { obj: PatchHealth; store: Map<string, unknown>; alarm: () => number | null; puts: { n: number } }>();
    const ns = {
        idFromName: (name: string) => name,
        get: (name: string) => {
            let o = objects.get(name);
            if (!o) {
                const { store, storage, alarm } = fakeDOStorage();
                const puts = { n: 0 };
                const put = storage.put;
                storage.put = async (k: any, v?: any) => { puts.n++; return put(k, v); };
                const obj = new PatchHealth({ storage, blockConcurrencyWhile: async (fn: () => Promise<void>) => fn() } as unknown as DurableObjectState);
                o = { obj, store, alarm, puts };
                objects.set(name, o);
            }
            const target = o.obj;
            return { fetch: (url: string, init?: any) => target.fetch(new Request(String(url), init)) };
        }
    } as unknown as DurableObjectNamespace;
    return { ns, objects };
}

function fakeEmail(fail = false) {
    const sent: Array<{ from: string; to: string; raw: string }> = [];
    return {
        sent,
        binding: { send: vi.fn(async (m: any) => { if (fail) throw new Error("destination not verified"); sent.push(m); return { messageId: "x" }; }) } as unknown as SendEmail
    };
}

function envWith(over: Record<string, unknown> = {}) {
    const ph = fakePatchHealthNs();
    const mail = fakeEmail();
    const env = {
        CODES: fakeKV(), ADMIN_TOKEN: "admintok", MODEL: "m", GROQ_KEY: "g",
        PATCH_HEALTH: ph.ns, ALERT_EMAIL: mail.binding, PATCH_ALERT_MIN_INSTALLS: "3",
        ...over
    } as any;
    return { env, ph, mail };
}

const ctx = { waitUntil: () => { }, passThroughOnException: () => { } } as unknown as ExecutionContext;

function install(n: number): string {
    return `free_${n.toString(16).padStart(32, "0")}`;
}

function report(over: Record<string, unknown> = {}) {
    return {
        v: 1, plugin: "0.2.3", build: "c1c141a33e78dd5f", channel: "stable", discordBuild: 451234,
        failed: [{ plugin: "MessageAccessoriesAPI", find: ".aBcDeF", state: "nofind" }],
        ...over
    };
}

function post(body: unknown, inst: string | null = install(1), ip = "203.0.113.7", extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", "x-subline-api": "2", "cf-connecting-ip": ip, ...extra };
    if (inst) headers["x-subline-install"] = inst;
    return new Request("https://relay.test/v1/patch-health", {
        method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body)
    });
}

const call = (env: any, req: Request) => worker.fetch(req, env, ctx);

describe("validateReport", () => {
    it("accepts the plugin's shape and collapses duplicate rows", () => {
        const r = validateReport(report({ failed: [
            { plugin: "VcTranslate", find: "forum-tag-", state: "nomatch" },
            { plugin: "VcTranslate", find: "forum-tag-", state: "nomatch" }
        ] }));
        expect(r?.failed).toEqual([{ plugin: "VcTranslate", find: "forum-tag-", state: "nomatch" }]);
    });

    it.each([
        ["an extra top-level field", report({ user: "123" })],
        ["message text smuggled into a row", report({ failed: [{ plugin: "VcTranslate", find: "x", state: "nofind", text: "hi" }] })],
        ["a newline in a find (header injection)", report({ failed: [{ plugin: "VcTranslate", find: "a\r\nBcc: x@y", state: "nofind" }] })],
        ["non-ASCII in a find", report({ failed: [{ plugin: "VcTranslate", find: "héllo", state: "nofind" }] })],
        ["a find past 160 chars", report({ failed: [{ plugin: "VcTranslate", find: "x".repeat(161), state: "nofind" }] })],
        ["an unknown state", report({ failed: [{ plugin: "VcTranslate", find: "x", state: "broken" }] })],
        ["a plugin name with spaces", report({ failed: [{ plugin: "Vc Translate", find: "x", state: "nofind" }] })],
        ["an empty failed list", report({ failed: [] })],
        ["too many rows", report({ failed: Array.from({ length: MAX_FAILED_PER_REPORT + 1 }, (_, i) => ({ plugin: "VcTranslate", find: `f${i}`, state: "nofind" })) })],
        ["an unknown channel", report({ channel: "beta" })],
        ["a fractional build number", report({ discordBuild: 1.5 })],
        ["a negative build number", report({ discordBuild: -1 })],
        ["a bad plugin version", report({ plugin: "0.2" })],
        ["a bad build id", report({ build: "zz" })],
        ["the wrong format version", report({ v: 2 })],
        ["an array", []],
        ["null", null]
    ])("rejects %s", (_, body) => {
        expect(validateReport(body)).toBeNull();
    });
});

describe("POST /v1/patch-health", () => {
    it("stores one report with ONE storage write and answers ok", async () => {
        const { env, ph, mail } = envWith();
        const res = await call(env, post(report()));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        const day = [...ph.objects.values()][0]!;
        expect(day.puts.n).toBe(1);
        expect(mail.sent).toHaveLength(0);
        // No raw install id or address is stored, only fingerprints.
        const dump = JSON.stringify([...day.store]);
        expect(dump).not.toContain(install(1));
        expect(dump).not.toContain("203.0.113.7");
        // Cleans itself up.
        expect(day.alarm()).not.toBeNull();
        expect(day.alarm()! - Date.now()).toBeGreaterThan(KEEP_MS - 60_000);
    });

    it("the largest valid report (20 rows of 160-char finds, longest names) fits the body limit and is accepted", async () => {
        const { env } = envWith();
        const big = report({ discordBuild: 99_999_999, channel: "canary", failed: Array.from({ length: MAX_FAILED_PER_REPORT }, (_, i) => ({
            plugin: "MessageAccessoriesAPI", find: String(i).padStart(3, "0") + "~".repeat(157), state: "nomatch"
        })) });
        expect(JSON.stringify(big).length).toBeLessThan(8_192);
        expect((await call(env, post(big))).status).toBe(200);
    });

    it("refuses a client without the v2 install header", async () => {
        const { env } = envWith();
        expect((await call(env, post(report(), null))).status).toBe(400);
        const noApi = new Request("https://relay.test/v1/patch-health", {
            method: "POST", headers: { "x-subline-install": install(1) }, body: JSON.stringify(report())
        });
        expect((await call(env, noApi)).status).toBe(400);
    });

    it("refuses a bad body, a non-JSON body, a GET and an oversized body without touching storage", async () => {
        const { env, ph } = envWith();
        expect((await call(env, post(report({ extra: 1 })))).status).toBe(400);
        expect((await call(env, post("{not json"))).status).toBe(400);
        expect((await call(env, new Request("https://relay.test/v1/patch-health"))).status).toBe(405);
        expect((await call(env, post("x".repeat(9000)))).status).toBe(413);
        expect(ph.objects.size).toBe(0);
    });

    it("answers 503 when the store is not bound", async () => {
        const { env } = envWith({ PATCH_HEALTH: undefined });
        expect((await call(env, post(report()))).status).toBe(503);
    });

    it("emails ONCE when the third distinct install reports the same patch, never again that day", async () => {
        const { env, mail } = envWith();
        await call(env, post(report(), install(1), "198.51.100.1"));
        await call(env, post(report(), install(2), "198.51.100.2"));
        expect(mail.sent).toHaveLength(0);
        await call(env, post(report(), install(3), "198.51.100.3"));
        expect(mail.sent).toHaveLength(1);
        const m = mail.sent[0]!;
        expect(m.from).toBe("alerts@subline.page");
        expect(m.to).toBe("rahul05alok@gmail.com");
        expect(m.raw).toContain("Subject: Subline patch failing: MessageAccessoriesAPI (3 installs)");
        expect(m.raw).toContain("Find:   .aBcDeF");
        expect(m.raw).toContain("stable:451234: nofind x3");
        expect(m.raw).toMatch(/^Message-ID: <[^>]+@subline\.page>$/m);
        // More installs, another build: still the one email.
        await call(env, post(report(), install(4), "198.51.100.4"));
        await call(env, post(report({ discordBuild: 451300 }), install(5), "198.51.100.5"));
        expect(mail.sent).toHaveLength(1);
    });

    it("one install reporting many times never reaches the threshold", async () => {
        const { env, mail } = envWith({ PATCH_ALERT_MIN_INSTALLS: "2" });
        for (let i = 0; i < 5; i++) await call(env, post(report(), install(1)));
        expect(mail.sent).toHaveLength(0);
    });

    it("the threshold is configurable", async () => {
        const { env, mail } = envWith({ PATCH_ALERT_MIN_INSTALLS: "1" });
        await call(env, post(report()));
        expect(mail.sent).toHaveLength(1);
    });

    it("a different patch gets its own single email", async () => {
        const { env, mail } = envWith({ PATCH_ALERT_MIN_INSTALLS: "1" });
        await call(env, post(report()));
        await call(env, post(report({ failed: [{ plugin: "VcTranslate", find: "forum-tag-", state: "nomatch" }] }), install(2)));
        expect(mail.sent).toHaveLength(2);
    });

    it("a failed send is retried by the next report, and logs why", async () => {
        const ph = fakePatchHealthNs();
        const bad = fakeEmail(true);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        const env = { CODES: fakeKV(), ADMIN_TOKEN: "t", MODEL: "m", GROQ_KEY: "g", PATCH_HEALTH: ph.ns, ALERT_EMAIL: bad.binding, PATCH_ALERT_MIN_INSTALLS: "1" } as any;
        await call(env, post(report()));
        expect(bad.binding.send).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls.some(c => JSON.stringify(c).includes("destination not verified"))).toBe(true);
        const good = fakeEmail();
        env.ALERT_EMAIL = good.binding;
        await call(env, post(report(), install(2)));
        expect(good.sent).toHaveLength(1);
        await call(env, post(report(), install(3)));
        expect(good.sent).toHaveLength(1);
        warn.mockRestore();
    });

    it("without the email binding it still counts, logs, and sends later once bound", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        const { env } = envWith({ ALERT_EMAIL: undefined, PATCH_ALERT_MIN_INSTALLS: "1" });
        expect((await call(env, post(report()))).status).toBe(200);
        expect(warn.mock.calls.some(c => String(c[0]).includes("no ALERT_EMAIL binding"))).toBe(true);
        const mail = fakeEmail();
        env.ALERT_EMAIL = mail.binding;
        await call(env, post(report(), install(2)));
        expect(mail.sent).toHaveLength(1);
        warn.mockRestore();
    });

    it("rate limits: the same build twice is a free duplicate; past the build limit is 429", async () => {
        const { env, ph } = envWith();
        expect((await call(env, post(report()))).status).toBe(200);
        const puts = () => [...ph.objects.values()][0]!.puts.n;
        expect(puts()).toBe(1);
        expect((await call(env, post(report()))).status).toBe(200);
        expect(puts()).toBe(1);
        for (let b = 1; b < MAX_BUILDS_PER_INSTALL; b++) {
            expect((await call(env, post(report({ discordBuild: 1000 + b })))).status).toBe(200);
        }
        const res = await call(env, post(report({ discordBuild: 9999 })));
        expect(res.status).toBe(429);
        expect(puts()).toBe(MAX_BUILDS_PER_INSTALL);
    });

    it("rate limits one address minting install ids", async () => {
        const { env, mail } = envWith({ PATCH_ALERT_MIN_INSTALLS: "1000" });
        for (let i = 0; i < MAX_REPORTS_PER_ADDRESS; i++) {
            expect((await call(env, post(report(), install(100 + i), "192.0.2.9"))).status).toBe(200);
        }
        expect((await call(env, post(report(), install(999), "192.0.2.9"))).status).toBe(429);
        // Another address is unaffected.
        expect((await call(env, post(report(), install(999), "192.0.2.10"))).status).toBe(200);
        expect(mail.sent).toHaveLength(0);
    });

    it("caps the emails a day, whatever is reported", () => {
        const day = emptyDay();
        let alerts = 0;
        for (let i = 0; i < MAX_EMAILS_PER_DAY + 5; i++) {
            const out = applyReport(day, { inst: `i${i}`, addr: `a${i}`, discordKey: "stable:1", failed: [{ plugin: "VcTranslate", find: `f${i}`, state: "nofind" }], minInstalls: 1 });
            alerts += out.alerts.length;
        }
        expect(alerts).toBe(MAX_EMAILS_PER_DAY);
    });

    it("a new day object starts from nothing; the old one reloads from storage", async () => {
        const { env, ph, mail } = envWith({ PATCH_ALERT_MIN_INSTALLS: "2" });
        await call(env, post(report()));
        // Reload the same day's object from its storage: the count survives.
        const day = [...ph.objects.values()][0]!;
        const { storage } = fakeDOStorage();
        for (const [k, v] of day.store) await storage.put(k, v);
        const reloaded = new PatchHealth({ storage, blockConcurrencyWhile: async (fn: () => Promise<void>) => fn() } as unknown as DurableObjectState);
        const view = await (await reloaded.fetch(new Request("https://x/view?day=d"))).json() as any;
        expect(view.reports).toBe(1);
        expect(view.patches[0].installs).toBe(1);
        expect(mail.sent).toHaveLength(0);
    });
});

describe("junk from one address cannot spend the alerts or hide a real breakage", () => {
    const junk = (tag: string) => Array.from({ length: MAX_FAILED_PER_REPORT }, (_, i) => ({ plugin: "VcTranslate", find: `junk-${tag}-${i}`, state: "nofind" }));

    it("3 made-up installs from one address with 20 junk rows send no email; a real row from 3 addresses still alerts", async () => {
        const { env, mail } = envWith();
        for (let n = 1; n <= 3; n++) expect((await call(env, post(report({ failed: junk("a") }), install(n), "192.0.2.50"))).status).toBe(200);
        expect(mail.sent).toHaveLength(0);
        // More junk from the same address: it cannot open more rows than its share.
        for (let n = 4; n <= 10; n++) await call(env, post(report({ failed: junk(`b${n}`) }), install(n), "192.0.2.50"));
        expect(mail.sent).toHaveLength(0);
        for (let n = 1; n <= 3; n++) await call(env, post(report(), install(100 + n), `198.51.100.${n}`));
        expect(mail.sent).toHaveLength(1);
        expect(mail.sent[0]!.raw).toContain("Subject: Subline patch failing: MessageAccessoriesAPI (3 installs)");
    });

    it("refuses a plugin name the client never reports", async () => {
        const { env } = envWith();
        const res = await call(env, post(report({ failed: [{ plugin: "FreeMoneyClickHere", find: "x", state: "nofind" }] })));
        expect(res.status).toBe(400);
        // The relay's list is the client's list.
        const client = readFileSync(new URL("../../src/userplugins/vcTranslate/patchHealth.ts", import.meta.url), "utf8");
        const listed = /HEALTH_PLUGINS = \[([^\]]*)\]/.exec(client)![1]!.match(/"([^"]+)"/g)!.map(x => x.slice(1, -1));
        expect([...PATCH_PLUGINS].sort()).toEqual(listed.sort());
    });

    it("a full table makes room by dropping a one-address row, never by dropping a real patch", () => {
        const day = emptyDay();
        let a = 0;
        // Many addresses fill the table with junk, each within its own share.
        while (day.patches.size < MAX_PATCHES_PER_DAY) {
            applyReport(day, { inst: `j${a}`, addr: `junk${a}`, discordKey: "stable:1", failed: junk(`t${a}`).map(f => ({ ...f, state: "nofind" as const })), minInstalls: 3 });
            a++;
        }
        for (let n = 0; n < 3; n++) {
            const out = applyReport(day, { inst: `r${n}`, addr: `real${n}`, discordKey: "stable:1", failed: [{ plugin: "MessagePopoverAPI", find: "real-find", state: "nomatch" }], minInstalls: 3 });
            if (n === 0) expect(out.result === "accepted" && out.deletes.length).toBe(1);
            if (n === 2) expect(out.alerts).toHaveLength(1);
        }
        expect(day.patches.size).toBe(MAX_PATCHES_PER_DAY);
        expect(day.patches.get("MessagePopoverAPI|real-find")?.addrs).toHaveLength(3);
        expect(MAX_NEW_PATCHES_PER_ADDRESS).toBeLessThan(MAX_PATCHES_PER_DAY);
    });

    it("keeps reserved emails for a patch many addresses report after the day's cap is spent", () => {
        const day = emptyDay();
        for (let i = 0; i < MAX_EMAILS_PER_DAY; i++) {
            applyReport(day, { inst: `i${i}`, addr: `a${i}`, discordKey: "stable:1", failed: [{ plugin: "VcTranslate", find: `f${i}`, state: "nofind" }], minInstalls: 1 });
        }
        expect(day.emails).toBe(MAX_EMAILS_PER_DAY);
        let alerts = 0;
        for (let n = 0; n < 2; n++) {
            alerts += applyReport(day, { inst: `w${n}`, addr: `w${n}`, discordKey: "stable:1", failed: [{ plugin: "NoticesAPI", find: "wide", state: "nofind" }], minInstalls: 1 }).alerts.length;
        }
        expect(alerts).toBe(1);
        expect(day.emails).toBeLessThanOrEqual(MAX_EMAILS_PER_DAY + RESERVED_EMAILS);
    });
});

describe("GET /admin/patch-health", () => {
    it("needs the admin token", async () => {
        const { env } = envWith();
        expect((await call(env, new Request("https://relay.test/admin/patch-health"))).status).toBe(401);
        expect((await call(env, new Request("https://relay.test/admin/patch-health", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    });

    it("lists today's reports, newest day first", async () => {
        const { env } = envWith();
        await call(env, post(report()));
        await call(env, post(report(), install(2)));
        const res = await call(env, new Request("https://relay.test/admin/patch-health?days=2", { headers: { authorization: "Bearer admintok" } }));
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.ok).toBe(true);
        expect(body.minInstalls).toBe(3);
        expect(body.days).toHaveLength(2);
        expect(body.days[0].day).toBe(new Date().toISOString().slice(0, 10));
        expect(body.days[0].reports).toBe(2);
        expect(body.days[0].patches[0]).toMatchObject({ plugin: "MessageAccessoriesAPI", find: ".aBcDeF", installs: 2, emailed: false, builds: { "stable:451234": { nofind: 2 } } });
        expect(body.days[1].reports).toBe(0);
    });
});

describe("alertMime", () => {
    it("is plain ASCII with CRLF lines and no header from report text but the plugin name", () => {
        const raw = alertMime("alerts@subline.page", "o@example.com", { id: "x", plugin: "VcTranslate", find: "forum-tag-", installs: 3, builds: { "ptb:1": { nomatch: 3 } } }, "2026-10-08", 0, "abc");
        expect(/^[\x00-\x7f]*$/.test(raw)).toBe(true);
        const head = raw.split("\r\n\r\n")[0]!.split("\r\n");
        expect(head.map(l => l.split(":")[0])).toEqual(["From", "To", "Subject", "Message-ID", "Date", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
    });
});
