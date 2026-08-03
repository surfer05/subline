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

    it("throws when the endpoint returns a non-OK status", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
        await expect(translateWithGoogle(req(["hola"]), fetchImpl as any)).rejects.toThrow();
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

    it("still throws on a non-OK status even when other messages succeeded", async () => {
        // A transport failure is NOT per-message: it must propagate so
        // native.ts can retry or classify the whole request.
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(okResponse("one", "es"))
            .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

        await expect(translateWithGoogle(req(["uno", "dos"]), fetchImpl as any))
            .rejects.toThrow(/503/);
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
