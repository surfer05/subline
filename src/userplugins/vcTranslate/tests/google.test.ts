import { describe, expect, it, vi } from "vitest";
import { translateWithGoogle } from "../engines/google";
import type { BatchRequest } from "../types";

const req = (texts: string[]): BatchRequest => ({
    messages: texts.map((t, i) => ({ id: String(i), author: "a", text: t })),
    context: [],
    targetLang: "en"
});

const okResponse = (translated: string, detected: string) => ({
    ok: true,
    json: async () => [[[translated, "orig", null, null, 10]], null, detected]
});

describe("translateWithGoogle", () => {
    it("maps a translated message to a Result", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse("let's go", "es"));
        const [result] = await translateWithGoogle(req(["vamos"]), fetchImpl as any);
        expect(result).toEqual({ id: "0", lang: "es", text: "let's go", skip: false });
    });

    it("marks messages already in the target language as skipped", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse("hello", "en"));
        const [result] = await translateWithGoogle(req(["hello"]), fetchImpl as any);
        expect(result).toEqual({ id: "0", skip: true });
    });

    it("joins multi-segment translations", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [[["one ", "a"], ["two", "b"]], null, "de"]
        });
        const [result] = await translateWithGoogle(req(["eins zwei"]), fetchImpl as any);
        expect(result).toEqual({ id: "0", lang: "de", text: "one two", skip: false });
    });

    it("translates every message in the batch", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse("x", "fr"));
        const results = await translateWithGoogle(req(["a", "b", "c"]), fetchImpl as any);
        expect(results).toHaveLength(3);
        expect(results.map(r => r.id)).toEqual(["0", "1", "2"]);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("throws only when the endpoint refused EVERY message", async () => {
        // Unchanged for a total refusal — that is a real block, and runTier
        // needs it to park Google. What changed is what "refused" has to mean:
        // all of them, not any of them. See the next test.
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
        await expect(translateWithGoogle(req(["hola"]), fetchImpl as any)).rejects.toThrow();
    });

    // THE REGRESSION THIS CLOSES, measured 2026-08-29. Google's free endpoint
    // throttles INDIVIDUAL requests under burst, not the IP: a real run of ten
    // messages at concurrency 4 came back 9x200 and 1x429, and the two requests
    // AFTER the refused one succeeded immediately.
    //
    // The old code threw on that single 429, discarding nine finished
    // translations with it. runTier then wrote "delayed" over all ten and — once
    // Google gained a cooldown — parked the whole fast tier for a minute, during
    // which every new message deferred too. A partial, self-healing throttle had
    // been turned into a sustained outage, and the LLM became the reader's only
    // translator, which is exactly the latency they were complaining about.
    it("keeps the translations it got when only some requests were throttled", async () => {
        // Keyed on the message text, not call order: the slice runs
        // concurrently, so call order is not deterministic. "c" is refused
        // every time, including its retry; the rest always succeed.
        const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes("q=c")) return { ok: false, status: 429, json: async () => ({}) };
            return okResponse("hi", "es");
        });

        const results = await translateWithGoogle(
            req(["a", "b", "c", "d"]), fetchImpl as any, { retryDelayMs: 0 }
        );

        // Three real translations survive; the throttled one is reported as a
        // TRANSPORT failure, so the plugin renders it as waiting, not broken.
        expect(results.filter(r => "text" in r)).toHaveLength(3);
        const throttled = results.find(r => "failed" in r) as any;
        expect(throttled).toBeDefined();
        expect(throttled.transport).toBe(true);
        expect(results).toHaveLength(4);
    });

    it("retries a sole-translator message up to three extra times", async () => {
        // patientRetries: Google is the reader's ONLY translator, so seconds
        // spent retrying buy translations instead of delaying a quality flush
        // that does not exist. Measured odds of ~1-in-7 per request make a
        // single retry leave most messages waiting.
        let n = 0;
        const fetchImpl = vi.fn().mockImplementation(async () => {
            n++;
            if (n <= 3) return { ok: false, status: 429, json: async () => ({}) };
            return okResponse("hi", "es");
        });

        const results = await translateWithGoogle(
            { ...req(["hola"]), patientRetries: true }, fetchImpl as any, { retryDelayMs: 0 }
        );

        expect(results).toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it("stays at one quick retry when a quality engine is behind it", async () => {
        // Without patientRetries every extra Google retry delays the reactive
        // quality flush - the thing that actually rescues the reader there.
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

        await expect(translateWithGoogle(req(["hola"]), fetchImpl as any, { retryDelayMs: 0 }))
            .rejects.toThrow();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("retries a throttled message once before giving up on it", async () => {
        // The measured behaviour: requests immediately after a refused one
        // succeed. One cheap retry converts the common case into no loss at
        // all — nine-plus-one instead of nine-and-a-gap.
        let n = 0;
        const fetchImpl = vi.fn().mockImplementation(async () => {
            n++;
            if (n === 1) return { ok: false, status: 429, json: async () => ({}) };
            return okResponse("hi", "es");
        });

        const results = await translateWithGoogle(req(["a"]), fetchImpl as any, { retryDelayMs: 0 });

        expect(results).toEqual([{ id: "0", lang: "es", text: "hi", skip: false }]);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("attaches a Retry-After header as retryAfterMs on the thrown error", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            headers: { get: (n: string) => (n === "retry-after" ? "20" : null) },
            json: async () => ({})
        });

        let caught: unknown;
        try {
            await translateWithGoogle(req(["hola"]), fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect((caught as { retryAfterMs?: number }).retryAfterMs).toBe(20_000);
    });

    it("leaves retryAfterMs undefined when there is no Retry-After header", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

        let caught: unknown;
        try {
            await translateWithGoogle(req(["hola"]), fetchImpl as any);
        } catch (e) {
            caught = e;
        }

        expect((caught as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
    });

    // The shape guards below are per-MESSAGE failures, not whole-request ones:
    // they mark that message failed rather than returning garbage for it, and
    // leave the rest of the batch alone. `failed: true` is the assertion that
    // matters — a bogus translation must never come back in its place.
    it("marks a message failed on an unexpected response shape rather than returning garbage", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ error: "nope" }) });
        await expect(translateWithGoogle(req(["hola"]), fetchImpl as any))
            .resolves.toEqual([{ id: "0", failed: true }]);
    });

    it("url-encodes the message text", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse("hi", "es"));
        await translateWithGoogle(req(["a&b c?"]), fetchImpl as any);
        const url = fetchImpl.mock.calls[0][0] as string;
        expect(url).toContain(encodeURIComponent("a&b c?"));
    });

    it("marks a message failed when the detected-language field is not a string", async () => {
        // Segments are valid but body[2] is a number. Without the shape guard
        // this returns a Result with lang=123, i.e. bogus data rendered as a
        // real translation.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [[["hola", "orig"]], null, 123]
        });
        await expect(translateWithGoogle(req(["x"]), fetchImpl as any))
            .resolves.toEqual([{ id: "0", failed: true }]);
    });

    it("marks a message failed when the segments array is missing", async () => {
        // body[0] is null rather than an array of segments.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [null, null, "es"]
        });
        await expect(translateWithGoogle(req(["x"]), fetchImpl as any))
            .resolves.toEqual([{ id: "0", failed: true }]);
    });

    it("marks a message failed when the response is an object rather than an array", async () => {
        // A numeric-keyed object satisfies body[0] and body[2] but is not the
        // array wrapper the endpoint contracts for. Without the Array.isArray(body)
        // guard this returns a bogus translation {lang:"es",text:"hola"}.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => JSON.parse('{"0":[["hola","orig"]],"2":"es"}')
        });
        await expect(translateWithGoogle(req(["x"]), fetchImpl as any))
            .resolves.toEqual([{ id: "0", failed: true }]);
    });

    it("degrades only the failing message, keeping the rest of the batch", async () => {
        // Without Promise.allSettled one bad message rejects the whole chunk,
        // so the two good translations are thrown away and native.ts retries
        // all three.
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(okResponse("one", "es"))
            .mockResolvedValueOnce({ ok: true, json: async () => [[["   ", "orig"]], null, "es"] })
            .mockResolvedValueOnce(okResponse("three", "es"));

        const results = await translateWithGoogle(req(["uno", "dos", "tres"]), fetchImpl as any);

        expect(results).toEqual([
            { id: "0", lang: "es", text: "one", skip: false },
            { id: "1", failed: true },
            { id: "2", lang: "es", text: "three", skip: false }
        ]);
    });

    it("does NOT throw a non-OK status away with the messages that succeeded", async () => {
        // WAS: "still throws ... even when other messages succeeded", on the
        // reasoning that "a transport failure is NOT per-message". That is true
        // of a batch endpoint and false of this one — Google is one request per
        // message, and it refuses individual requests under burst. Throwing
        // discarded every translation that had already come back.
        //
        // 503 rather than 429 on purpose: no retry applies, so this pins the
        // partial-failure rule itself rather than the retry that usually hides
        // it.
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(okResponse("one", "es"))
            .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

        const results = await translateWithGoogle(req(["uno", "dos"]), fetchImpl as any);

        expect(results).toHaveLength(2);
        expect(results[0]).toEqual({ id: "0", lang: "es", text: "one", skip: false });
        expect(results[1]).toEqual({ id: "1", failed: true, transport: true });
    });

    it("caps concurrency at 4 and returns results in request order", async () => {
        // Every other test in this file uses <= 3 messages, which makes the
        // chunk loop degenerate: with a single chunk, CONCURRENCY and the
        // push order are both unobservable. Nine messages force three chunks.
        const texts = Array.from({ length: 9 }, (_, i) => `m${i}`);

        let inFlight = 0;
        let maxInFlight = 0;
        let started = 0;
        const pending: (() => void)[] = [];

        const fetchImpl = vi.fn().mockImplementation(() => {
            const n = started++;
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            // Deferred: nothing resolves until the test releases it, so the
            // requests genuinely overlap instead of completing one at a time.
            return new Promise(resolve => {
                pending.push(() => {
                    inFlight--;
                    resolve(okResponse(`t${n}`, "es") as any);
                });
            });
        });

        let done = false;
        const p = translateWithGoogle(req(texts), fetchImpl as any)
            .then(r => { done = true; return r; });

        for (let round = 0; round < 20 && !done; round++) {
            await new Promise(r => setTimeout(r, 0));
            // Release in REVERSE start order, so completion order differs from
            // request order and the output ordering cannot come from timing.
            pending.splice(0, pending.length).reverse().forEach(release => release());
        }

        const results = await p;
        expect(results.map(r => r.id)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
        expect(fetchImpl).toHaveBeenCalledTimes(9);
        expect(maxInFlight).toBeLessThanOrEqual(4);
        // And the cap is actually reached, so the assertion above is not
        // passing merely because requests were serialised.
        expect(maxInFlight).toBe(4);
    });
});

describe("translateWithGoogle — pass-through detection", () => {
    it("skips when the translation is identical to the source", async () => {
        // Google misdetects English slang and echoes it back verbatim.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [[["hbu", "hbu", null, null, 10]], null, "fy"]
        });
        const [result] = await translateWithGoogle(req(["hbu"]), fetchImpl as any);
        expect(result).toEqual({ id: "0", skip: true });
    });

    it("ignores case and spacing when comparing", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [[["  U2   <2 ", "u2 <2"]], null, "zh-CN"]
        });
        const [result] = await translateWithGoogle(req(["u2 <2"]), fetchImpl as any);
        expect(result).toEqual({ id: "0", skip: true });
    });

    it("still returns a real translation when the text actually changed", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [[["let's go", "vamos"]], null, "es"]
        });
        const [result] = await translateWithGoogle(req(["vamos"]), fetchImpl as any);
        expect(result).toEqual({ id: "0", lang: "es", text: "let's go", skip: false });
    });
});

describe("source language and detection confidence", () => {
    /** A real response carries the confidence at index 6. */
    const withConfidence = (translated: string, detected: string, conf: number | null) => ({
        ok: true,
        json: async () => [[[translated, "orig", null, null, 3]], null, detected,
            null, null, null, conf]
    });

    const urlOf = (fetchImpl: any) => String(fetchImpl.mock.calls[0][0]);

    it("auto-detects when no source language was resolved", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(withConfidence("no", "de", 1));
        await translateWithGoogle(req(["ne"]), fetchImpl as any);
        expect(urlOf(fetchImpl)).toContain("sl=auto");
    });

    it("pins sl to the resolved source language instead of auto-detecting", async () => {
        // THE fix. Live, "ne" under sl=auto returns Hausa "it is"; under sl=de
        // it returns "no". Same request, opposite meaning — so which `sl` goes
        // on the wire is the whole behaviour worth asserting.
        const fetchImpl = vi.fn().mockResolvedValue(withConfidence("no", "de", null));
        const r: BatchRequest = {
            messages: [{ id: "0", author: "a", text: "ne", sourceLang: "de" }],
            context: [],
            targetLang: "en"
        };
        await translateWithGoogle(r, fetchImpl as any);
        expect(urlOf(fetchImpl)).toContain("sl=de");
        expect(urlOf(fetchImpl)).not.toContain("sl=auto");
    });

    it("passes the detection confidence through so the renderer can flag a guess", async () => {
        // 0.217 is the number the live endpoint actually returned for "ne".
        const fetchImpl = vi.fn().mockResolvedValue(withConfidence("it is", "ha", 0.21705426));
        const [result] = await translateWithGoogle(req(["ne"]), fetchImpl as any);
        expect(result).toMatchObject({ lang: "ha", text: "it is", conf: 0.21705426 });
    });

    it("reports no confidence when the response carries none", async () => {
        // A pinned request gets null here — nothing was detected, so there is
        // nothing to be unsure about, and the renderer must not show a "?".
        const fetchImpl = vi.fn().mockResolvedValue(withConfidence("no", "de", null));
        const [result] = await translateWithGoogle(req(["ne"]), fetchImpl as any);
        expect((result as any).conf).toBeUndefined();
    });
});
    // 2026-09-02, one house, one Airtel connection, the throttle active: the
    // BROWSER got 200 from this endpoint while the plugin got 429 — same IP,
    // same minute, caught by the beacon (updatedAt == lastError.at). The
    // plugin was sending fetchImpl(url) with no headers at all, more naked
    // than curl. The free endpoint throttles by (IP, request shape); a bare
    // request is the first thing it sheds. So every request now carries what
    // a real browser would send. Not a trick — the browser's own shape.
    describe("request shape", () => {
        it("sends browser-shaped headers on every request", async () => {
            const seen: any[] = [];
            const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: any) => {
                seen.push(init?.headers);
                return okResponse("hello", "es");
            });

            await translateWithGoogle(req(["hola"]), fetchImpl as any);

            expect(seen).toHaveLength(1);
            expect(seen[0]).toMatchObject({
                "User-Agent": expect.stringContaining("Mozilla/5.0"),
                "Accept-Language": expect.stringContaining("en"),
                "Referer": "https://translate.google.com/"
            });
        });

        it("keeps the headers on the 429 retry", async () => {
            // The retry exists because the request AFTER a refusal usually
            // succeeds — but only if it is the same kind of request. A retry
            // that dropped the headers would be a worse request than the one
            // that was just refused.
            const seen: any[] = [];
            const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: any) => {
                seen.push(init?.headers);
                return seen.length === 1
                    ? { ok: false, status: 429, json: async () => ({}) }
                    : okResponse("hello", "es");
            });

            await translateWithGoogle(req(["hola"]), fetchImpl as any, { retryDelayMs: 0 });

            expect(seen).toHaveLength(2);
            expect(seen[1]).toMatchObject({ "User-Agent": expect.stringContaining("Mozilla/5.0") });
        });
    });

