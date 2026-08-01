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

    // Real non-Latin text with combining marks must survive \p{M} stripping and still translate.
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
