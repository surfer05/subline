import { describe, expect, it } from "vitest";
import { shouldSkip } from "../skip";

describe("shouldSkip", () => {
    it("skips your own messages", () => {
        expect(shouldSkip("hola amigos", true)).toBe(true);
    });

    it("skips empty and whitespace-only messages", () => {
        expect(shouldSkip("", false)).toBe(true);
        expect(shouldSkip("   \n ", false)).toBe(true);
    });

    it("skips messages that are only custom emotes", () => {
        expect(shouldSkip("<:pepe:123456789>", false)).toBe(true);
        expect(shouldSkip("<a:dance:987> <:kek:654>", false)).toBe(true);
    });

    it("skips messages that are only unicode emoji", () => {
        expect(shouldSkip("😂😂😂", false)).toBe(true);
    });

    it("skips messages that are only links", () => {
        expect(shouldSkip("https://example.com/clip", false)).toBe(true);
    });

    it("skips messages that are only mentions", () => {
        expect(shouldSkip("<@123> <@!456> <#789>", false)).toBe(true);
    });

    it("skips purely numeric messages", () => {
        expect(shouldSkip("2", false)).toBe(true);
        expect(shouldSkip("10 / 10", false)).toBe(true);
    });

    it("translates real text", () => {
        expect(shouldSkip("vamos a jugar", false)).toBe(false);
    });

    it("translates text mixed with a mention", () => {
        expect(shouldSkip("<@123> vamos", false)).toBe(false);
    });

    it("translates short but meaningful words", () => {
        expect(shouldSkip("да", false)).toBe(false);
    });

    it("skips keycap emoji sequences", () => {
        expect(shouldSkip("1️⃣2️⃣3️⃣", false)).toBe(true);
    });

    it("skips lone combining marks", () => {
        expect(shouldSkip("́", false)).toBe(true);
    });

    it("skips Arabic-Indic digits", () => {
        expect(shouldSkip("١٢٣", false)).toBe(true);
    });

    // Real non-Latin text must survive the strip pass and still translate.
    // The first three cases carry category-M characters and so exercise \p{M}
    // directly; the Arabic case has none — it guards the non-Latin/no-ASCII
    // path in general. Each test's own title says which it is.
    it("translates decomposed café (Latin with combining mark)", () => {
        expect(shouldSkip("café", false)).toBe(false);
    });

    it("translates Devanagari script (has virama, category Mn)", () => {
        expect(shouldSkip("नमस्ते", false)).toBe(false);
    });

    it("translates Thai script (has combining marks)", () => {
        expect(shouldSkip("สวัสดี", false)).toBe(false);
    });

    it("translates Arabic script (non-Latin with no ASCII)", () => {
        expect(shouldSkip("مرحبا", false)).toBe(false);
    });
});

describe("shouldSkip — repetition and laughter noise", () => {
    it("skips a message that is one word repeated", () => {
        // Google detected "GOJ GOJ GOJ GOJ" as Esperanto and rendered it as a
        // slur attributed to the sender.
        expect(shouldSkip("GOJ GOJ GOJ GOJ GOJ", false)).toBe(true);
        expect(shouldSkip("NEG NEG NEG NEG", false)).toBe(true);
        expect(shouldSkip("no no no", false)).toBe(true);
    });

    it("skips laughter in several languages", () => {
        for (const s of [
            "JAJAJAJAJ", "jajaja", "hahaha", "ahahahahhaa",
            "kkkkk", "wwww", "xddd", "lolol", "rsrsrs", "55555"
        ]) {
            expect(shouldSkip(s, false), s).toBe(true);
        }
    });

    it("does NOT skip real messages that merely repeat a word", () => {
        // Two DIFFERENT tokens, so the repeated-token rule must not fire.
        expect(shouldSkip("no no puedo", false)).toBe(false);
        expect(shouldSkip("muy muy bueno", false)).toBe(false);
    });

    it("does NOT skip short real words that brush the laughter alphabet", () => {
        expect(shouldSkip("haj", false)).toBe(false);   // under the 4-char floor
        expect(shouldSkip("aha bueno", false)).toBe(false);
        expect(shouldSkip("lo hago", false)).toBe(false);
    });

    it("does NOT skip a sentence that merely contains laughter", () => {
        expect(shouldSkip("jajaja que gracioso", false)).toBe(false);
        expect(shouldSkip("no puedo mas hahaha", false)).toBe(false);
    });
});
