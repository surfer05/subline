import { describe, expect, it, vi } from "vitest";
import { translateWithRelay, translateWithRelayDetailed } from "../engines/relay";
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
        expect(out).toEqual({ results: [{ id: "0", skip: true }], rpmLimit: 60 });
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
