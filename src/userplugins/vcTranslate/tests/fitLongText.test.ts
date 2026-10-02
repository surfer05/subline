import { describe, expect, it } from "vitest";

import { fitLongText, SURFACE_MAX_LONG_TEXT_CHARS } from "../surfaces/service";

/**
 * A long surface text (an embed description, a forward, server rules) is cut
 * to fit. The cut must never land inside a Discord token: half a link or half
 * a code block would reach the translator as text.
 */
describe("fitLongText never cuts inside a token", () => {
    const filler = (n: number) => "palabra ".repeat(Math.ceil(n / 8)).slice(0, n);

    it("a link straddling the limit is left whole: the cut moves before it", () => {
        const url = "https://example.com/" + "a".repeat(200);
        const text = filler(SURFACE_MAX_LONG_TEXT_CHARS - 50) + url + " fin";
        const { text: out, partial } = fitLongText(text);
        expect(partial).toBe(true);
        expect(out.includes("https://")).toBe(false);
        expect(out.length).toBeLessThanOrEqual(SURFACE_MAX_LONG_TEXT_CHARS);
    });

    it("a code block straddling the limit is left whole", () => {
        const code = "```\n" + "x = 1\n".repeat(60) + "```";
        const text = filler(SURFACE_MAX_LONG_TEXT_CHARS - 100) + code + " después";
        const { text: out } = fitLongText(text);
        expect((out.match(/```/g) ?? []).length % 2).toBe(0);
    });

    it("a short text is untouched", () => {
        expect(fitLongText("hola https://example.com")).toEqual({ text: "hola https://example.com", partial: false });
    });
});
