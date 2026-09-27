import { describe, expect, it, vi } from "vitest";
import {
    fetchRelayCheckout, fetchRelayStatus, RELAY_CHECKOUT_URL, RELAY_STATUS_URL, translateWithRelay, translateWithRelayDetailed
} from "../engines/relay";
import type { BatchRequest } from "../types";

const req = (texts: string[]): BatchRequest => ({
    messages: texts.map((t, i) => ({ id: String(i), author: "a", text: t })),
    context: [],
    targetLang: "en"
});

describe("translateWithRelay", () => {
    it("posts the batch with the code as a Bearer token and returns the results", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, results: [{ id: "0", lang: "es", text: "hi", skip: false }], used: 1, cap: 500 })
        });
        const out = await translateWithRelay(req(["hola"]), "slp_abc", fetchImpl as any);
        expect(out).toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
        const [, init] = fetchImpl.mock.calls[0];
        expect(init.headers.authorization).toBe("Bearer slp_abc");
        expect(JSON.parse(init.body).messages[0].text).toBe("hola");
    });

    it("throws an HTTP-429 error carrying the relay's retry hint, so the queue pauses", async () => {
        // The relay rate-limited this code. native.ts's translateBatch reads
        // "HTTP 429" off the message and the retryAfterMs off the error, exactly
        // as it does for a keyed engine.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 429, json: async () => ({ ok: false, error: "daily limit reached", retryAfterMs: 42000 })
        });
        await expect(translateWithRelay(req(["hola"]), "slp_abc", fetchImpl as any))
            .rejects.toMatchObject({ message: expect.stringContaining("HTTP 429"), retryAfterMs: 42000 });
    });

    it("carries the ceiling the relay states on a success, so the gate can tune to it", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ ok: true, results: [{ id: "0", skip: true }], used: 1, cap: 2000, rpmLimit: 60 })
        });
        const out = await translateWithRelayDetailed(req(["hola"]), "slp_abc", fetchImpl as any);
        // `used`/`cap` are new on this outcome (the taste tier reads them —
        // see taste.ts). They were always in this fixture's body and were
        // always parsed and dropped; now they are carried, so an exact-match
        // assertion has to name them.
        expect(out).toEqual({ results: [{ id: "0", skip: true }], rpmLimit: 60, used: 1, cap: 2000 });
    });

    it("leaves the ceiling undefined when an older relay states none", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ ok: true, results: [] })
        });
        expect(await translateWithRelayDetailed(req(["hola"]), "slp_abc", fetchImpl as any)).toEqual({ results: [], rpmLimit: undefined });
    });

    it("carries the ceiling a rate-limit 429 states, on the error the renderer retunes from", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 429,
            json: async () => ({ ok: false, error: "slow down", retryAfterMs: 12000, quotaLimitPerMinute: 20 })
        });
        await expect(translateWithRelay(req(["hola"]), "slp_abc", fetchImpl as any))
            .rejects.toMatchObject({ retryAfterMs: 12000, quotaLimitPerMinute: 20 });
    });

    it("throws when the relay returns ok:false even on a 200", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ ok: false, error: "temporarily unavailable" })
        });
        await expect(translateWithRelay(req(["hola"]), "slp_abc", fetchImpl as any)).rejects.toThrow(/relay: HTTP 200/);
    });

    it("throws on a body that is not JSON", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 503, json: async () => { throw new Error("not json"); }
        });
        await expect(translateWithRelay(req(["hola"]), "slp_abc", fetchImpl as any)).rejects.toThrow(/relay: HTTP 503/);
    });
});

describe("fetchRelayStatus", () => {
    it("reads today's count with the same bearer, spending nothing", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ ok: true, plan: "taste", used: 2, cap: 3 })
        });
        const out = await fetchRelayStatus("free_" + "a".repeat(32), fetchImpl as any);
        expect(out).toEqual({ plan: "taste", used: 2, cap: 3 });

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe(RELAY_STATUS_URL);
        expect(init.method).toBe("GET");
        expect(init.headers.authorization).toBe(`Bearer free_${"a".repeat(32)}`);
        // No body, and no message text anywhere near it: asking how many are
        // left must never itself be a translation request.
        expect(init.body).toBeUndefined();
    });

    it("throws rather than inventing a count when the relay is unreachable", async () => {
        // The caller treats a throw as "count unknown", never as "none left" —
        // a transient network fault must not take a free user's three away.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 502, json: async () => { throw new Error("not json"); }
        });
        await expect(fetchRelayStatus("free_abc", fetchImpl as any)).rejects.toThrow(/relay: HTTP 502/);
    });

    it("rejects a malformed count instead of showing it to the user", async () => {
        // This number is rendered as "N of 3 left today". A NaN or a missing
        // cap reaching the button is worse than no button at all.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ ok: true, plan: "taste", used: "two" })
        });
        await expect(fetchRelayStatus("free_abc", fetchImpl as any)).rejects.toThrow(/malformed status/);
    });
});

describe("the purchase on /v1/status", () => {
    const status = (body: any) => fetchRelayStatus("free_" + "a".repeat(32), vi.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => ({ ok: true, plan: "trial", used: 0, cap: 300, ...body })
    }) as any);

    it("passes a linked purchase through", async () => {
        expect((await status({ purchase: { code: " LK-1 ", plan: "annual" } })).purchase).toEqual({ code: "LK-1", plan: "annual" });
    });

    it("ignores a malformed one", async () => {
        expect((await status({ purchase: { code: "", plan: "annual" } })).purchase).toBeUndefined();
        expect((await status({ purchase: { code: 7 } })).purchase).toBeUndefined();
        expect((await status({ purchase: "LK-1" })).purchase).toBeUndefined();
        expect((await status({})).purchase).toBeUndefined();
    });
});

describe("fetchRelayCheckout", () => {
    it("posts the plan with the install bearer and returns the URL", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ ok: true, url: "https://checkout.dodopayments.com/session/cks_1" })
        });
        const url = await fetchRelayCheckout("free_" + "a".repeat(32), "annual", fetchImpl as any);
        expect(url).toBe("https://checkout.dodopayments.com/session/cks_1");
        const [target, init] = fetchImpl.mock.calls[0];
        expect(target).toBe(RELAY_CHECKOUT_URL);
        expect(RELAY_CHECKOUT_URL).toBe("https://subline-relay.rahul05alok.workers.dev/v1/checkout");
        expect(init.method).toBe("POST");
        expect(init.headers.authorization).toBe(`Bearer free_${"a".repeat(32)}`);
        expect(init.headers["x-subline-client"]).toMatch(/^vcTranslate\//);
        expect(JSON.parse(init.body)).toEqual({ plan: "annual" });
    });

    it("throws on a refusal, so the caller uses the static link", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 503, json: async () => ({ ok: false, error: "checkout unavailable" })
        });
        await expect(fetchRelayCheckout("free_x", "monthly", fetchImpl as any)).rejects.toThrow(/HTTP 503 checkout unavailable/);
    });

    it("gives up after its timeout", async () => {
        const fetchImpl = vi.fn((_u: string, init: any) => new Promise((_r, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }));
        await expect(fetchRelayCheckout("free_x", "monthly", fetchImpl as any, 5)).rejects.toThrow(/aborted/);
    });
});
