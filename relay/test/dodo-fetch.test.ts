import { afterEach, describe, expect, it, vi } from "vitest";
import { DODO_GET_TIMEOUT_MS, DODO_POST_TIMEOUT_MS, WEBHOOK_DODO_BUDGET_MS, dodoFetch } from "../src/dodoFetch";

declare global { interface ImportMeta { url: string } }
const { readFileSync, readdirSync } = await import("node:" + "fs") as {
    readFileSync: (p: URL, enc: string) => string; readdirSync: (p: URL) => string[];
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("every Dodo call is bounded in time (dodoFetch)", () => {
    it("no source file calls fetch() directly except dodoFetch.ts and the model providers (translate.ts)", () => {
        const dir = new URL("../src/", import.meta.url);
        const files = readdirSync(dir).filter((f: string) => f.endsWith(".ts"));
        expect(files).toContain("checkout.ts");
        for (const f of files) {
            if (f === "dodoFetch.ts" || f === "translate.ts") continue;
            const code = readFileSync(new URL(f, dir), "utf8").split("\n").filter((l: string) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
            // A bare global fetch( call; `.fetch(` (Durable Object stubs) and `async fetch(` (handlers) are fine.
            const bare = code.match(/(?<![.\w])(?<!async )fetch\(/g) ?? [];
            expect({ file: f, bare: bare.length }).toEqual({ file: f, bare: 0 });
        }
    });

    it("a GET gets a 5 s signal, a POST 15 s, a deadline lowers both", async () => {
        const asked: number[] = [];
        const real = AbortSignal.timeout.bind(AbortSignal);
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { asked.push(ms); return real(ms); });
        const seen: unknown[] = [];
        vi.stubGlobal("fetch", vi.fn(async (_u: any, init: any) => { seen.push(init?.signal); return new Response("{}"); }));
        await dodoFetch("https://test.dodopayments.com/x", { method: "GET" });
        await dodoFetch("https://test.dodopayments.com/x", { method: "POST", body: "{}" });
        await dodoFetch("https://test.dodopayments.com/x", { method: "GET" }, Date.now() + 1_000);
        expect(asked[0]).toBe(DODO_GET_TIMEOUT_MS);
        expect(asked[1]).toBe(DODO_POST_TIMEOUT_MS);
        expect(asked[2]).toBeLessThanOrEqual(1_000);
        for (const s of seen) expect(s).toBeInstanceOf(AbortSignal);
        expect(WEBHOOK_DODO_BUDGET_MS).toBeLessThan(30_000); // Dodo's webhook timeout
    });

    it("past its deadline a call throws without reaching the network", async () => {
        const f = vi.fn(async () => new Response("{}"));
        vi.stubGlobal("fetch", f);
        await expect(dodoFetch("https://test.dodopayments.com/x", { method: "GET" }, Date.now() - 1)).rejects.toThrow(/budget/);
        expect(f).not.toHaveBeenCalled();
    });

    it("a hanging Dodo is cut off by the timeout", async () => {
        const real = AbortSignal.timeout.bind(AbortSignal);
        vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(20));
        vi.stubGlobal("fetch", vi.fn((_u: any, init: any) => new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason));
        })));
        await expect(dodoFetch("https://test.dodopayments.com/x", { method: "GET" })).rejects.toBeDefined();
    });
});
