import { describe, expect, it } from "vitest";

import { isRomanizedGuess } from "../romanized";

describe("isRomanizedGuess", () => {
    it("flags Arabic detected from Latin-only text", () => {
        // Google reported ar at confidence 1.00 for this and inverted the
        // negation — "I don't want to go home" for "I want to go home".
        expect(isRomanizedGuess("ar", "ana bghit nmchi l dar")).toBe(true);
        expect(isRomanizedGuess("ar", "baraka 3lik mn dak monster")).toBe(true);
    });

    it("does not flag Arabic written in Arabic script", () => {
        // Google is good at this; flagging it would cry wolf on the common case.
        expect(isRomanizedGuess("ar", "يعطيك العافية")).toBe(false);
    });

    it("does not flag languages that are natively Latin", () => {
        expect(isRomanizedGuess("es", "hola que tal")).toBe(false);
        expect(isRomanizedGuess("de", "sind die gruppenraume klimatisiert")).toBe(false);
        expect(isRomanizedGuess("ha", "ne")).toBe(false);   // Hausa IS Latin-script
    });

    it("does not flag a script-tagged code that already says Latin", () => {
        expect(isRomanizedGuess("ber-Latn", "wach nta labas")).toBe(false);
    });

    it("flags the other big non-Latin scripts", () => {
        expect(isRomanizedGuess("ru", "privet kak dela")).toBe(true);
        expect(isRomanizedGuess("ja", "konnichiwa")).toBe(true);
        expect(isRomanizedGuess("hi", "kya haal hai")).toBe(true);
    });
});
