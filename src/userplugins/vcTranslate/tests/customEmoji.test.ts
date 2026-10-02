import { describe, expect, it } from "vitest";

import { cleanTranslation, dropCustomEmoji, sourceEmoji } from "../customEmoji";

// Clearly fake ids (all ones, twos, ...), never real snowflakes.
const E1 = "<:cake:111111111111111111>";
const E2 = "<a:SHAKE:222222222222222222>";
const E3 = "<:heart:333333333333333333>";
const FIELD = `<@900000000000000009> HAPPY BIRTHDAY${E1} Wszystkiego najlepszego z okazji urodzin!${E2} my dear 19 years old boy${E3}`;

describe("dropCustomEmoji: what is sent", () => {
    it("the field message: every custom emoji gone, single spaces, no stray space at the end", () => {
        expect(dropCustomEmoji(FIELD)).toBe("<@900000000000000009> HAPPY BIRTHDAY Wszystkiego najlepszego z okazji urodzin! my dear 19 years old boy");
    });

    it("animated and static alike", () => {
        expect(dropCustomEmoji(`hi ${E2} there`)).toBe("hi there");
        expect(dropCustomEmoji(`hi ${E1} there`)).toBe("hi there");
    });

    it("25 custom emoji in one message", () => {
        const many = Array.from({ length: 25 }, (_, i) => `<:e${i}:${String(i + 1).repeat(18).slice(0, 18)}>`).join(" ");
        expect(dropCustomEmoji(`Hola ${many} amigos`)).toBe("Hola amigos");
    });

    it("an emoji between every word, with and without spaces", () => {
        expect(dropCustomEmoji(`uno${E1}dos${E2}tres ${E3} cuatro`)).toBe("uno dos tres cuatro");
    });

    it("an emoji-only text becomes empty", () => {
        expect(dropCustomEmoji(`${E1} ${E2}\n${E3}`)).toBe("");
    });

    it("keeps line breaks and tidies the line ends around a removed emoji", () => {
        expect(dropCustomEmoji(`${E1} primera línea\nsegunda ${E2}\n\ntercera`)).toBe("primera línea\nsegunda\n\ntercera");
    });

    it("right-to-left text around emoji", () => {
        expect(dropCustomEmoji(`مرحبا ${E1} بالجميع ${E2}`)).toBe("مرحبا بالجميع");
    });

    it("text without a custom emoji is returned exactly, double spaces and all", () => {
        const t = "hola  amigo :wave: 👋 <@1> https://x.example/<a>";
        expect(dropCustomEmoji(t)).toBe(t);
    });

    it("unicode emoji are plain text and stay", () => {
        expect(dropCustomEmoji(`feliz 🎂 ${E1} día 🎉`)).toBe("feliz 🎂 día 🎉");
    });
});

describe("cleanTranslation: what is shown", () => {
    it("the field's broken answer renders clean: ids, :NAME: and raw-id pseudo-emoji gone", () => {
        const broken = "@viktor HAPPY BIRTHDAY:111111111111111111: Happy birthday!:SHAKE: my dear 19 years old boy:333333333333333333:";
        expect(cleanTranslation(broken, FIELD)).toBe("@viktor HAPPY BIRTHDAY Happy birthday! my dear 19 years old boy");
    });

    it("a raw custom emoji token in a translation is removed", () => {
        expect(cleanTranslation(`Happy birthday ${E1}!`, FIELD)).toBe("Happy birthday !");
        expect(cleanTranslation(`see ${E2} you`, "")).toBe("see you");
    });

    it("a bare emoji id from the source is removed; a long number the author typed stays", () => {
        const source = `my order 987654321098765432 ${E1}`;
        expect(cleanTranslation("mi pedido 987654321098765432 111111111111111111", source)).toBe("mi pedido 987654321098765432");
    });

    it("a :NAME: whose NAME is NOT a source emoji is real text and stays", () => {
        expect(cleanTranslation("use :wave: and :ok:", `hola ${E1}`)).toBe("use :wave: and :ok:");
    });

    it(":NAME: matches regardless of case", () => {
        expect(cleanTranslation("hi :shake: friend", `hola ${E2}`)).toBe("hi friend");
    });

    it("a clock time is not taken for an emoji id", () => {
        expect(cleanTranslation("at 12:30:45 today", "")).toBe("at 12:30:45 today");
        expect(cleanTranslation("x :123456789012345678: y", "")).toBe("x y");
    });

    it("old cached junk is cleaned, including at the start and end of lines", () => {
        expect(cleanTranslation(":cake: Feliz día\nadiós :111111111111111111:", FIELD)).toBe("Feliz día\nadiós");
    });

    it("a line that is only junk becomes empty", () => {
        expect(cleanTranslation(":cake: :SHAKE: :111111111111111111:", FIELD)).toBe("");
    });

    it("a clean translation is returned exactly", () => {
        const t = "Happy  birthday,  my dear!";
        expect(cleanTranslation(t, FIELD)).toBe(t);
    });

    it("right-to-left translation with junk", () => {
        expect(cleanTranslation("عيد ميلاد سعيد :cake: يا صديقي", FIELD)).toBe("عيد ميلاد سعيد يا صديقي");
    });

    it("sourceEmoji reads names and ids of static and animated emoji", () => {
        const { names, ids } = sourceEmoji(FIELD);
        expect([...names].sort()).toEqual(["cake", "heart", "shake"]);
        expect(ids.has("222222222222222222")).toBe(true);
    });
});
