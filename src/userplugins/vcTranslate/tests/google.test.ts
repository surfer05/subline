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

    it("throws on an unexpected response shape rather than returning garbage", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ error: "nope" }) });
        await expect(translateWithGoogle(req(["hola"]), fetchImpl as any)).rejects.toThrow();
    });

    it("url-encodes the message text", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse("hi", "es"));
        await translateWithGoogle(req(["a&b c?"]), fetchImpl as any);
        const url = fetchImpl.mock.calls[0][0] as string;
        expect(url).toContain(encodeURIComponent("a&b c?"));
    });

    it("throws when the detected-language field is not a string", async () => {
        // Segments are valid but body[2] is a number. Without the shape guard
        // this returns a Result with lang=123 instead of throwing, i.e. bogus
        // data rendered as a real translation.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [[["hola", "orig"]], null, 123]
        });
        await expect(translateWithGoogle(req(["x"]), fetchImpl as any)).rejects.toThrow();
    });

    it("throws when the segments array is missing", async () => {
        // body[0] is null rather than an array of segments.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [null, null, "es"]
        });
        await expect(translateWithGoogle(req(["x"]), fetchImpl as any)).rejects.toThrow();
    });
});
