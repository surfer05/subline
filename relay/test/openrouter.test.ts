import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import { translate, translateWithFallback, type BatchRequest, type Provider } from "../src/translate";
import type { Env } from "../src/codes";
import { fakeKV, fakeBudget } from "./kv-mock";

// ===========================================================================
//  OPENROUTER — the primary provider, pinned to Groq's hosting.
//
//  Groq's Developer upgrade is closed, so the DIRECT Groq key is stuck on the
//  free tier's daily token ceiling. OpenRouter resells the same
//  openai/gpt-oss-120b pay as you go, so it goes first; the direct Groq key
//  stays on as the automatic fallback. Both serve the SAME model id, which is
//  exactly why the route is an explicit Provider.kind and never a regex on the
//  id.
// ===========================================================================

const OR = "https://openrouter.ai/api/v1/chat/completions";

const req = (texts: string[]): BatchRequest => ({
    messages: texts.map((t, i) => ({ id: String(i), author: "a", text: t })),
    context: [], targetLang: "en"
});
const openrouter = (model = "openai/gpt-oss-120b"): Provider => ({ kind: "openrouter", apiKey: "or-key", model });
const groqProvider: Provider = { kind: "groq", apiKey: "gk", model: "openai/gpt-oss-120b" };

const okBody = (content: string): any => ({
    ok: true, status: 200, headers: new Headers(),
    json: async () => ({ choices: [{ message: { content } }] }),
    clone() { return this; }, text: async () => ""
});
const errBody = (status: number, headers: Record<string, string> = {}, text = ""): any => ({
    ok: false, status, headers: new Headers(headers), clone() { return this; }, text: async () => text
});
const fixed = (rows: unknown[]) => JSON.stringify({ translations: rows });
const ONE = fixed([{ id: "0", lang: "es", text: "hi", skip: false }]);

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe("openrouter request shape", () => {
    /** Run one translate() through a capturing fetch and return the call. */
    async function capture(model = "openai/gpt-oss-120b") {
        const seen: { url: string; init: any }[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
            seen.push({ url, init });
            return okBody(ONE);
        }));
        const out = await translate(req(["hola"]), openrouter(model));
        return { out, calls: seen };
    }

    it("posts to the OpenRouter endpoint with the key and both attribution headers", async () => {
        const { out, calls } = await capture();
        expect(out).toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
        expect(calls).toHaveLength(1);
        const { url, init } = calls[0]!;
        expect(url).toBe(OR);
        expect(init.method).toBe("POST");
        expect(init.headers.authorization).toBe("Bearer or-key");
        expect(init.headers["content-type"]).toBe("application/json");
        expect(init.headers["HTTP-Referer"]).toBe("https://surfer05.github.io/subline/");
        expect(init.headers["X-Title"]).toBe("Subline");
        // The key never travels in the URL (proxy/access-log safety).
        expect(url).not.toContain("or-key");
    });

    it("pins routing to Groq hosting with the exact provider block", async () => {
        const { calls } = await capture();
        const body = JSON.parse(calls[0]!.init.body);
        expect(body.provider).toEqual({
            order: ["groq", "cerebras", "deepinfra"],
            allow_fallbacks: true,
            require_parameters: true,
            ignore: ["novita", "digitalocean", "sambanova", "amazon-bedrock"]
        });
    });

    it("passes env.MODEL through untouched and keeps the gpt-oss reasoning controls", async () => {
        const { calls } = await capture();
        const body = JSON.parse(calls[0]!.init.body);
        expect(body.model).toBe("openai/gpt-oss-120b");
        expect(body.temperature).toBe(0.2);
        expect(body.reasoning_effort).toBe("low");
        expect(body.reasoning_format).toBe("hidden");
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].role).toBe("user");
    });

    it("sends no reasoning controls for a model that is not a reasoning model", async () => {
        const { calls } = await capture("meta-llama/llama-3.3-70b-instruct");
        const body = JSON.parse(calls[0]!.init.body);
        expect(body.reasoning_effort).toBeUndefined();
        expect(body.provider).toBeTruthy(); // routing still pinned
    });

    it("the groq path is untouched: its own endpoint, no provider block, no extra headers", async () => {
        const seen: { url: string; init: any }[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { seen.push({ url, init }); return okBody(ONE); }));
        await translate(req(["hola"]), groqProvider);
        expect(seen[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
        expect(JSON.parse(seen[0]!.init.body).provider).toBeUndefined();
        expect(seen[0]!.init.headers["X-Title"]).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
describe("openrouter 400 retry: require_parameters can reject the reasoning controls", () => {
    /** First call 400s with `text`; second succeeds. Returns both bodies. */
    async function retryWith(text: string) {
        const bodies: any[] = [];
        vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
            bodies.push(JSON.parse(init.body));
            return bodies.length === 1 ? errBody(400, {}, text) : okBody(ONE);
        }));
        await translate(req(["hola"]), openrouter());
        return bodies;
    }

    it("a 400 naming the provider drops the reasoning controls but KEEPS the provider block", async () => {
        const bodies = await retryWith("No allowed provider supports the requested parameters");
        expect(bodies).toHaveLength(2);
        expect(bodies[0].reasoning_effort).toBe("low");
        expect(bodies[1].reasoning_effort).toBeUndefined();
        expect(bodies[1].reasoning_format).toBeUndefined();
        // The pin survives the retry: still Groq hosting first, still strict.
        expect(bodies[1].provider).toEqual(bodies[0].provider);
        expect(bodies[1].provider.order).toEqual(["groq", "cerebras", "deepinfra"]);
        expect(bodies[1].model).toBe("openai/gpt-oss-120b");
    });

    it("a 400 naming reasoning_effort retries the same way", async () => {
        const bodies = await retryWith("unsupported parameter: reasoning_effort");
        expect(bodies).toHaveLength(2);
        expect(bodies[1].reasoning_effort).toBeUndefined();
        expect(bodies[1].provider).toBeTruthy();
    });

    it("a 400 about something else is NOT retried, it surfaces as an error", async () => {
        const fetchMock = vi.fn(async () => errBody(400, {}, "context length exceeded"));
        vi.stubGlobal("fetch", fetchMock);
        await expect(translate(req(["hola"]), openrouter())).rejects.toMatchObject({ status: 400 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
describe("openrouter rate limits: the same retry-after handling as Groq", () => {
    it("carries a Retry-After header through as retryAfterMs", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => errBody(429, { "retry-after": "20" })));
        await expect(translate(req(["hola"]), openrouter())).rejects.toMatchObject({ status: 429, retryAfterMs: 20000 });
    });

    it("a 429 with a JSON body and NO header carries no hint, so the caller's default applies", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => errBody(429, {}, JSON.stringify({ error: { code: 429, message: "rate limited" } }))));
        await expect(translate(req(["hola"]), openrouter())).rejects.toEqual({ status: 429 });
    });
});

// ---------------------------------------------------------------------------
describe("parse hardening: a JSON document wrapped in prose", () => {
    const parsedVia = async (content: string, provider: Provider = openrouter()) => {
        vi.stubGlobal("fetch", vi.fn(async () => okBody(content)));
        return translate(req(["hola"]), provider);
    };
    const row = [{ id: "0", lang: "es", text: "hi", skip: false }];

    it("strips a preamble before the first brace", async () => {
        expect(await parsedVia("Here is the JSON you asked for:\n" + fixed(row)))
            .toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
    });

    it("strips a trailer after the last brace", async () => {
        expect(await parsedVia(fixed(row) + "\n\nLet me know if you need anything else."))
            .toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
    });

    it("strips both, around a bare array", async () => {
        expect(await parsedVia('Sure! [{"id":"0","lang":"es","text":"hi","skip":false}] Done.'))
            .toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
    });

    it("hardens the groq path too, not just openrouter", async () => {
        expect(await parsedVia("Output:\n" + fixed(row), groqProvider))
            .toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
    });

    it("content that is not JSON at all is a 502 upstream failure, never silent failures", async () => {
        await expect(parsedVia("I cannot help with that.")).rejects.toMatchObject({ status: 502 });
    });

    it("a truncated/broken JSON body is a 502 as well", async () => {
        await expect(parsedVia('{"translations":[{"id":"0","lang":')).rejects.toMatchObject({ status: 502 });
    });
});

// ---------------------------------------------------------------------------
describe("translateWithFallback: OpenRouter primary, direct Groq key second", () => {
    it("a 402 (out of credits) falls back to Groq and the user still gets a translation", async () => {
        const urls: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            urls.push(url);
            if (url === OR) return errBody(402, {}, JSON.stringify({ error: { code: 402, message: "insufficient credits" } }));
            return okBody(fixed([{ id: "0", lang: "es", text: "from-groq", skip: false }]));
        }));
        const out = await translateWithFallback(req(["hola"]), openrouter(), groqProvider);
        expect(out).toEqual([{ id: "0", lang: "es", text: "from-groq", skip: false }]);
        expect(urls[0]).toBe(OR);
        expect(urls[1]).toContain("groq.com");
    });

    it("rethrows the 402 when the Groq fallback also fails", async () => {
        vi.stubGlobal("fetch", vi.fn(async (url: string) =>
            url === OR ? errBody(402) : errBody(429)));
        await expect(translateWithFallback(req(["hola"]), openrouter(), groqProvider))
            .rejects.toMatchObject({ status: 429 });
    });
});

// ===========================================================================
//  END TO END: an upstream 402 must never look like a bad code.
// ===========================================================================
const pending: Promise<unknown>[] = [];
const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {}
} as unknown as ExecutionContext;

function fakeMetrics() {
    const rows: any[] = [];
    return { ds: { writeDataPoint: (p: any) => { rows.push(p); } } as unknown as AnalyticsEngineDataset, rows };
}

const CODE = "free_" + "d".repeat(32); // the keyless taste tier: no KV seeding needed
const translateReq = () => new Request("https://relay/v1/translate", {
    method: "POST",
    headers: { authorization: `Bearer ${CODE}`, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ id: "0", author: "a", text: "hola" }], context: [], targetLang: "en" })
});

describe("POST /v1/translate: an OpenRouter 402 is a relay fault, never the user's code", () => {
    it("tries Groq first, and maps a total failure to 503 with the relay_credit label", async () => {
        const urls: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            urls.push(url);
            return errBody(402, {}, JSON.stringify({ error: { code: 402, message: "insufficient credits" } }));
        }));
        const metrics = fakeMetrics();
        const env = {
            CODES: fakeKV(), GROQ_KEY: "gk", OPENROUTER_KEY: "or", ADMIN_TOKEN: "a",
            MODEL: "openai/gpt-oss-120b", BUDGET: fakeBudget().ns, METRICS: metrics.ds
        } as unknown as Env;

        const res = await worker.fetch(translateReq(), env, ctx);
        await Promise.all(pending.splice(0));

        expect(res.status).toBe(503);
        const body = await res.json() as any;
        expect(body).toEqual({ ok: false, error: "translation service unavailable" });
        // Nothing in the answer blames the caller's code.
        expect(JSON.stringify(body)).not.toMatch(/code|invalid|expired/i);
        // The Groq fallback got its turn before the 402 surfaced.
        expect(urls[0]).toBe(OR);
        expect(urls[1]).toContain("groq.com");
        expect(metrics.rows.at(-1)!.blobs[0]).toBe("relay_credit");
    });

    it("succeeds through the Groq fallback when only OpenRouter is out of credits", async () => {
        vi.stubGlobal("fetch", vi.fn(async (url: string) =>
            url === OR ? errBody(402) : okBody(fixed([{ id: "0", lang: "es", text: "hi", skip: false }]))));
        const env = {
            CODES: fakeKV(), GROQ_KEY: "gk", OPENROUTER_KEY: "or", ADMIN_TOKEN: "a",
            MODEL: "openai/gpt-oss-120b", BUDGET: fakeBudget().ns
        } as unknown as Env;

        const res = await worker.fetch(translateReq(), env, ctx);
        await Promise.all(pending.splice(0));
        expect(res.status).toBe(200);
        expect((await res.json() as any).results).toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
    });
});
