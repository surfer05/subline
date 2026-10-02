import { describe, expect, it } from "vitest";

import { splitForUrl } from "../engines/google";
import { fitLlmRequest } from "../fitRequest";
import { contentTokens, fastKeepsWhatQualityLost, maskTokens, placeholder, repairTranslation, restoreTokens, tokenSpans, withContent } from "../placeholders";
import { fitLongText } from "../surfaces/service";

/** Clearly fake snowflakes. */
const E1 = "<:HAPPYBDAY:111111111111111111>";
const E2 = "<:SHAKE:222222222222222222>";
const E3 = "<a:wave:333333333333333333>";
const U = "<@444444444444444444>";
const R = "<@&555555555555555555>";
const C = "<#666666666666666666>";
const T = "<t:1700000000:R>";
const L = "https://example.com/a?b=c&d=e";
const P = (n: number) => placeholder(n);

describe("masking", () => {
    it("the field case: a mention and three custom emoji become ⟦1⟧..⟦4⟧, in order", () => {
        const src = `${U} HAPPY BIRTHDAY${E1} Wszystkiego najlepszego z okazji urodzin!${E2} my dear 19 years old boy${E3}`;
        const m = maskTokens(src);
        expect(m.text).toBe(`${P(1)} HAPPY BIRTHDAY${P(2)} Wszystkiego najlepszego z okazji urodzin!${P(3)} my dear 19 years old boy${P(4)}`);
        expect(m.tokens).toEqual([U, E1, E2, E3]);
        expect(m.text).not.toMatch(/\d{6,}/);
    });

    it("every token kind at once: mention, role, channel, emoji, link, timestamp, inline code, code block, @everyone", () => {
        const src = `${U} ${R} ${C} ${E1} ${L} ${T} \`npm i\` @everyone\n\`\`\`js\nconst a = <@1>;\n\`\`\``;
        const m = maskTokens(src);
        expect(m.tokens).toEqual([U, R, C, E1, L, T, "`npm i`", "@everyone", "```js\nconst a = <@1>;\n```"]);
        expect(m.text).toBe(`${P(1)} ${P(2)} ${P(3)} ${P(4)} ${P(5)} ${P(6)} ${P(7)} ${P(8)}\n${P(9)}`);
    });

    it("a link keeps its trailing punctuation outside the token", () => {
        const m = maskTokens(`mira ${L}.`);
        expect(m.tokens).toEqual([L]);
        expect(m.text).toBe(`mira ${P(1)}.`);
    });

    it("unicode emoji and plain text are not tokens", () => {
        const m = maskTokens("hola 😀🎉 amigo :smile: 12:30");
        expect(m.tokens).toEqual([]);
        expect(m.text).toBe("hola 😀🎉 amigo :smile: 12:30");
    });

    it("a source that literally contains placeholder-looking text masks it too, so it comes back as written", () => {
        const src = `escribe ${P(1)} y ⟦ aquí ${E1}`;
        const m = maskTokens(src);
        expect(m.tokens).toEqual([P(1), "⟦", E1]);
        expect(restoreTokens(m.text, m)).toBe(src);
    });

    it("is pure: the same text gives the same placeholders", () => {
        const src = `${E1} hola ${E2}`;
        expect(maskTokens(src)).toEqual(maskTokens(src));
    });

    it("tokenSpans covers each token exactly", () => {
        const src = `a ${E1} b ${L}`;
        expect(tokenSpans(src).map(([s, e]) => src.slice(s, e))).toEqual([E1, L]);
    });
});

describe("restoring", () => {
    const src = `${U} HAPPY BIRTHDAY${E1} Wszystkiego najlepszego z okazji urodzin!${E2} my dear 19 years old boy${E3}`;
    const m = maskTokens(src);

    it("puts the original tokens back by number", () => {
        expect(restoreTokens(`${P(1)} HAPPY BIRTHDAY${P(2)} Happy birthday!${P(3)} my dear 19 years old boy${P(4)}`, m))
            .toBe(`${U} HAPPY BIRTHDAY${E1} Happy birthday!${E2} my dear 19 years old boy${E3}`);
    });

    it("the field's broken answer: ids and :NAME: forms are turned back into the source's emoji, never shown raw", () => {
        const broken = `${P(1)} HAPPY BIRTHDAY:111111111111111111: Happy birthday!:SHAKE: my dear 19 years old boy:333333333333333333:`;
        const out = restoreTokens(broken, m);
        expect(out).toBe(`${U} HAPPY BIRTHDAY${E1} Happy birthday!${E2} my dear 19 years old boy${E3}`);
    });

    it("an old cached line from the readable era (\"@viktor ... :SHAKE:\") gets its emoji back and no id", () => {
        const out = repairTranslation("@viktor HAPPY BIRTHDAY:111111111111111111: Happy birthday!:SHAKE: my dear 19 years old boy:wave:", src);
        expect(out).toBe(`@viktor HAPPY BIRTHDAY${E1} Happy birthday!${E2} my dear 19 years old boy${E3}`);
    });

    it("a dropped placeholder is not added back anywhere", () => {
        expect(restoreTokens(`${P(1)} Happy birthday! my dear`, m)).toBe(`${U} Happy birthday! my dear`);
    });

    it("a duplicated placeholder restores each copy", () => {
        expect(restoreTokens(`${P(2)} yay ${P(2)}`, m)).toBe(`${E1} yay ${E1}`);
    });

    it("reordered placeholders are restored where they now stand", () => {
        expect(restoreTokens(`${P(4)} ${P(3)} ${P(2)} ${P(1)}`, m)).toBe(`${E3} ${E2} ${E1} ${U}`);
    });

    it("an invented number is dropped, with the spacing tidied", () => {
        expect(restoreTokens(`hi ${P(9)} there`, m)).toBe("hi there");
        expect(restoreTokens(`hi ${P(9)}, there`, m)).toBe("hi, there");
    });

    it("spaces a translator put inside a placeholder do not matter", () => {
        expect(restoreTokens("⟦ 2 ⟧ hi", m)).toBe(`${E1} hi`);
    });

    it("a placeholder cut by a truncation leaves nothing behind", () => {
        expect(restoreTokens(`Happy birthday ${P(2)} my d ⟦1`, m)).toBe(`Happy birthday ${E1} my d`);
    });

    it("a :NAME: emoji the source does not have stays as text; one the author typed as text stays too", () => {
        const plain = maskTokens("lol :kekw: so funny");
        expect(restoreTokens("lol :kekw: so funny", plain)).toBe("lol :kekw: so funny");
        expect(restoreTokens(":unknown: hi", m)).toBe(":unknown: hi");
    });

    it("a mangled emoji already shown once is removed, not doubled", () => {
        expect(restoreTokens(`${P(2)} hi :HAPPYBDAY:`, m)).toBe(`${E1} hi`);
    });

    it("a bare id the source carries as a token is removed; a long number the author wrote is kept", () => {
        expect(restoreTokens("call 111111111111111111 now", m)).toBe("call now");
        const phone = maskTokens("llama al 4915112345678901 ya");
        expect(restoreTokens("call 4915112345678901 now", phone)).toBe("call 4915112345678901 now");
        expect(restoreTokens("call 4915112345678902 now", phone)).toBe("call now");
    });

    it("a raw token the source never had (an invented mention) is removed", () => {
        expect(restoreTokens(`hey <@999999999999999999> ${P(1)}`, m)).toBe(`hey ${U}`);
    });

    it("only junk left gives an empty string", () => {
        expect(restoreTokens(":999999999999999999: ⟦7⟧", m)).toBe("");
    });

    it("line breaks survive a removal", () => {
        expect(restoreTokens(`line one ${P(9)}\n${P(2)} line two`, m)).toBe(`line one\n${E1} line two`);
    });

    it("right-to-left text around emoji comes back with the emoji in place", () => {
        const ar = maskTokens(`${E1} مبروك يا صديقي ${E2}`);
        expect(ar.text).toBe(`${P(1)} مبروك يا صديقي ${P(2)}`);
        expect(restoreTokens(`${P(1)} Congratulations my friend ${P(2)}`, ar)).toBe(`${E1} Congratulations my friend ${E2}`);
    });

    it("25 custom emoji: all masked, numbered to ⟦25⟧, all restored", () => {
        const many = Array.from({ length: 25 }, (_, i) => `<:e${i}:${String(100000000000000000 + i)}>`);
        const s = many.map((e, i) => `palabra${i} ${e}`).join(" ");
        const mm = maskTokens(s);
        expect(mm.tokens).toEqual(many);
        expect(mm.text).toContain(P(25));
        const translated = mm.text.replace(/palabra/g, "word");
        expect(restoreTokens(translated, mm)).toBe(s.replace(/palabra/g, "word"));
    });

    it("an emoji between every word", () => {
        const s = `hola${E1}amigo${E2}como${E3}estas`;
        const mm = maskTokens(s);
        expect(mm.text).toBe(`hola${P(1)}amigo${P(2)}como${P(3)}estas`);
        expect(restoreTokens(`hi${P(1)}friend${P(2)}how${P(3)}are you`, mm)).toBe(`hi${E1}friend${E2}how${E3}are you`);
    });

    it("never throws on odd input", () => {
        expect(repairTranslation("", "x")).toBe("");
        expect(repairTranslation(undefined as any, "x")).toBe("");
        expect(repairTranslation("hi", undefined as any)).toBe("hi");
    });
});

describe("long texts never cut a placeholder or a token", () => {
    it("Google's URL splitter keeps every ⟦n⟧ whole, however small the budget", () => {
        const s = Array.from({ length: 40 }, (_, i) => `palabra ${P(i + 1)}`).join(" ");
        for (const budget of [40, 60, 200]) {
            const pieces = splitForUrl(s, budget);
            expect(pieces.map(p => p.text + p.sep).join("")).toBe(s);
            for (const p of pieces) {
                expect(p.text).not.toMatch(/⟦\s*\d*$/);
                expect(p.text).not.toMatch(/^\s*\d*\s*⟧/);
            }
        }
    });

    it("Google's splitter keeps a placeholder whole even at the code-point fallback", () => {
        const s = `${P(12)}${P(13)}${P(14)}`;
        const pieces = splitForUrl(s, 30);
        expect(pieces.map(p => p.text + p.sep).join("")).toBe(s);
        for (const p of pieces) expect(p.text === "" || /^(⟦\d+⟧)+$/.test(p.text)).toBe(true);
    });

    it("the relay's request fitter never cuts a message, so its placeholders stay whole", () => {
        const text = Array.from({ length: 300 }, (_, i) => `palabra ${P(i + 1)}`).join(" ");
        const req = { messages: [{ id: "1", author: "a", text }, { id: "2", author: "b", text }], context: [], targetLang: "en" };
        const parts = fitLlmRequest(req, 6_000);
        expect(parts.flatMap(p => p.messages.map(m => m.text))).toEqual([text, text]);
    });

    it("a surface text cut to fit never ends inside a token", () => {
        const head = "x ".repeat(1_990);
        const code = "```\n" + "line of code with spaces ".repeat(20) + "\n```";
        const s = head + code + " tail";
        const fitted = fitLongText(s).text;
        expect(fitted.length).toBeLessThanOrEqual(4_000);
        expect((fitted.match(/```/g) ?? []).length % 2).toBe(0);
    });
});

describe("content-bearing tokens (✦ that drops placeholders)", () => {
    const U2 = "<@444444444444444444>";
    const R2 = "<@&555555555555555555>";
    const C2 = "<#666666666666666666>";
    const T2 = "<t:1790000000:t>";
    const L2 = "https://example.com/x";
    const K2 = "`npm i`";
    const B2 = "```js\nlet a = 1\n```";
    const EM = "<:SHAKE:222222222222222222>";
    const EA = "<a:wave:333333333333333333>";
    const SRC = `${U2} ${R2} ${C2} at ${T2} see ${L2} run ${K2} ${EM}${EA}\n${B2} @everyone`;

    it("lists every content-bearing kind once, in source order, and no custom emoji", () => {
        expect(contentTokens(`${SRC} ${U2}`)).toEqual([U2, R2, C2, T2, L2, K2, B2, "@everyone"]);
        expect(contentTokens(`${EM} hi ${EA}`)).toEqual([]);
        expect(contentTokens("plain text")).toEqual([]);
    });

    it("withContent appends only what was lost, in source order, and drops nothing that was kept", () => {
        expect(withContent(`hi ${C2} done`, SRC)).toBe(`hi ${C2} done ${U2} ${R2} ${T2} ${L2} ${K2} ${B2} @everyone`);
        expect(withContent(`all ${U2} ${R2} ${C2} ${T2} ${L2} ${K2} ${B2} @everyone`, SRC)).toBe(`all ${U2} ${R2} ${C2} ${T2} ${L2} ${K2} ${B2} @everyone`);
        expect(withContent("", SRC)).toBe("");
    });

    it("a mention kept in its readable form (a line stored before placeholders) counts as kept", () => {
        const readable = (t: string) => t === U2 ? "@viktor" : null;
        expect(withContent("@viktor happy birthday", `${U2} wszystkiego najlepszego`, readable)).toBe("@viktor happy birthday");
        expect(withContent("happy birthday", `${U2} wszystkiego najlepszego`, readable)).toBe(`happy birthday ${U2}`);
        // A readable form that throws is treated as absent, never as kept.
        expect(withContent("happy birthday", `${U2} hola`, () => { throw new Error("x"); })).toBe(`happy birthday ${U2}`);
    });

    it("fastKeepsWhatQualityLost: only when ✦ lost content that ≈ kept, all of it", () => {
        const src = `¿vienes a las ${T2}? mira ${L2} ${EM}`;
        const q = "Are you coming at the ? Look";
        const fAll = `EN ¿vienes a las ⟦1⟧? mira ⟦2⟧ ⟦3⟧`;
        const fHalf = `EN ¿vienes a las ⟦1⟧? mira`;
        expect(fastKeepsWhatQualityLost(q, fAll, src)).toBe(true);
        expect(fastKeepsWhatQualityLost(q, fHalf, src)).toBe(false);
        expect(fastKeepsWhatQualityLost(`Are you coming at ⟦1⟧? Look ⟦2⟧`, fAll, src)).toBe(false);   // ✦ lost only the emoji
        expect(fastKeepsWhatQualityLost(q, "", src)).toBe(false);
        expect(fastKeepsWhatQualityLost("thanks", "EN gracias", `${EM} gracias`)).toBe(false);          // no content at all
    });

    it("many placeholders: 40 links, half dropped by ✦, come back at the end in order", () => {
        const links = Array.from({ length: 40 }, (_, i) => `https://e.example/${i}`);
        const src = links.map((l, i) => `w${i} ${l}`).join(" ");
        const kept = links.filter((_, i) => i % 2 === 0);
        const lost = links.filter((_, i) => i % 2 === 1);
        const restored = kept.join(" ");
        expect(withContent(restored, src)).toBe(`${restored} ${lost.join(" ")}`);
    });
});
