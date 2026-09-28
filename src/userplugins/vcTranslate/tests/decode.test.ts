import { describe, expect, it } from "vitest";

import { decodeMessage, DECODER_LABELS, translatableText } from "../decode";
import { commonEnglishWordCount, isCommonEnglishWord } from "../wordList";
import { normalizeText } from "../normalize";

const kindOf = (s: string) => decodeMessage(s)?.kind ?? null;
const textOf = (s: string) => decodeMessage(s)?.text ?? null;

describe("Morse", () => {
    it("decodes letters and words", () => {
        expect(textOf(".... .- .--. .--. -.-- / -... .. .-. - .... -.. .- -.--")).toBe("HAPPY BIRTHDAY");
        expect(kindOf(".... .- .--. .--. -.-- / -... .. .-. - .... -.. .- -.--")).toBe("morse");
    });
    it("accepts the dot and dash look-alikes generators emit", () => {
        expect(textOf("··· −−− ···")).toBe("SOS");
    });
    it("lowercases what it hands the translator", () => {
        expect(decodeMessage("... --- ...")!.translatable).toBe("sos");
    });
    it("rejects short codes that spell no known word", () => {
        expect(decodeMessage("-. ..-.")).toBeNull();      // NF
        expect(decodeMessage(".. ...")).toBeNull();       // IS: common, but not a Morse word
    });
    it("decodes a known short word on its own", () => {
        expect(textOf("... --- ...")).toBe("SOS");
        expect(textOf(".... ..")).toBe("HI");
        expect(textOf(".... . .-.. .-.. ---")).toBe("HELLO");
        expect(textOf("-.-- . ...")).toBe("YES");
    });
    it("rejects short dot and dash runs that happen to spell letters", () => {
        for (const s of ["- . -", ". - .", "-- - -- - --", "... .. ...", "--- -.- .-.. --- .-.."]) {
            expect(decodeMessage(s), s).toBeNull();
        }
    });
    it("decodes five or more letters only when they read as words", () => {
        expect(textOf("-- . . - / -- . / - --- -.. .- -.--")).toBe("MEET ME TODAY");
        expect(textOf("-... --- -. .--- --- ..- .-. / .- -- ..")).toBe("BONJOUR AMI");
        expect(textOf("--. .-. .- -.-. .. .- ...")).toBe("GRACIAS");
        expect(decodeMessage("-... -.-. -.. ..-. --.")).toBeNull(); // BCDFG
        expect(decodeMessage("-- - ... - .-. -. -..")).toBeNull(); // MTSTRND: no vowels
    });
    it("rejects any unknown code", () => {
        expect(decodeMessage(".... ...... .-..")).toBeNull();
    });
    it("rejects an ellipsis written with spaces", () => {
        expect(decodeMessage("... ... ...")).toBeNull();
    });
});

describe("Morse judged against the common-word list", () => {
    it("decodes short words that are common English words, and chat shorthand", () => {
        expect(textOf("--- ..- -.-. ....")).toBe("OUCH");
        expect(textOf(".-.. -- .- ---")).toBe("LMAO");
        expect(textOf("-. --- / -.-- --- ..-")).toBe("NO YOU");
    });
    it("still rejects letters that spell no word", () => {
        for (const s of ["- . -", ". - .", "-- - -- - --", "--- -.- .-.. --- .-..", "... .. ..."]) {
            expect(decodeMessage(s), s).toBeNull(); // TET, ETE, MTMTM, OKLOL, SIS
        }
    });
    it("accepts a name only through the multi-letter rules, never the list", () => {
        expect(decodeMessage(".- -. -.. ..")).toBeNull(); // ANDI: four letters, not a common word
        expect(isCommonEnglishWord("andi")).toBe(false);
    });
    it("bundles a real list, parsed on first use", () => {
        expect(commonEnglishWordCount()).toBeGreaterThan(10_000);
        for (const w of ["ouch", "you", "no", "birthday", "happy"]) expect(isCommonEnglishWord(w), w).toBe(true);
        for (const w of ["tet", "ete", "sis", "oklol", "mtmtm", "m", "cs"]) expect(isCommonEnglishWord(w), w).toBe(false);
    });
});

describe("codes inside a message", () => {
    it("decodes Morse that follows ordinary words, and shows only the decoded run", () => {
        const d = decodeMessage("or ..-. ..- -.-. -.- / -.-- --- ..- / .... .- -.- .- ..")!;
        expect(d.kind).toBe("morse");
        expect(d.text).toBe("FUCK YOU HAKAI");
        expect(d.partial).toBe(true);
        expect(d.inPlace).toBe("or FUCK YOU HAKAI");
    });
    it("looks past a mention or emoji after the code", () => {
        const d = decodeMessage(".... .- .--. .--. -.-- / -... .. .-. - .... -.. .- -.-- / @Gojer")!;
        expect(d.text).toBe("HAPPY BIRTHDAY");
        expect(d.partial).toBeUndefined();
        expect(d.inPlace).toBe("HAPPY BIRTHDAY @Gojer");
        expect(d.translatable).toBe("happy birthday");
        expect(textOf("<:cake:123456> .... .- .--. .--. -.-- 🎉 <@42>")).toBe("HAPPY");
    });
    it("judges a run inside text by the same rules as a whole message", () => {
        // ANDI is four letters and not a common word, so this run is not claimed.
        expect(decodeMessage("You can tell him this .- -. -.. ..")).toBeNull();
        expect(textOf("You can tell him this -- . . - / -- . / - --- -.. .- -.--")).toBe("MEET ME TODAY");
    });
    it("joins several runs", () => {
        expect(textOf("first ... --- ... then .... . .-.. .-.. --- ok")).toBe("SOS / HELLO");
    });
    it("hands the translator the message with the code decoded in it", () => {
        expect(translatableText("dile esto: --. .-. .- -.-. .. .- ...")).toBe("dile esto: gracias");
    });
    it("finds binary inside a message too", () => {
        const d = decodeMessage("hey 01101000 01101001 00100000 01111001 01101111 01110101 ok")!;
        expect(d.kind).toBe("binary");
        expect(d.text).toBe("hi you");
        expect(d.inPlace).toBe("hey hi you ok");
    });
    it("never reads dashes and ellipses in prose as a code", () => {
        for (const s of ["wait... - what - no", "so ... - ... yeah", "a - b - c - d", "me: --- -.-",
            "the score was 10101010 to 01010101", "I think - - maybe"]) {
            expect(decodeMessage(s), s).toBeNull();
        }
    });
});

describe("binary", () => {
    it("decodes spaced 8-bit groups", () => {
        expect(textOf("01101000 01101001 00100000 01111001 01101111 01110101")).toBe("hi you");
    });
    it("decodes an unspaced run of bytes", () => {
        expect(textOf("011010000110010101111001")).toBe("hey");
    });
    it("decodes UTF-8", () => {
        expect(textOf("01101111 01101100 11000011 10100001")).toBe("olá");
    });
    it("rejects control bytes and non-writing", () => {
        expect(decodeMessage("00000001 00000010 00000011")).toBeNull();
        expect(decodeMessage("00110001 00110010 00110011")).toBeNull(); // "123"
    });
    it("rejects fewer than three groups", () => {
        expect(decodeMessage("01101000 01101001")).toBeNull();
    });
    it("rejects one character repeated", () => {
        expect(decodeMessage("01100001 01100001 01100001 01100001")).toBeNull(); // "aaaa"
        expect(decodeMessage("01000001 00100000 01000001 00100000 01000001")).toBeNull(); // "A A A"
    });
});

describe("Braille", () => {
    it("decodes grade 1 letters", () => {
        expect(textOf("⠓⠑⠇⠇⠕")).toBe("hello");
        expect(kindOf("⠓⠑⠇⠇⠕")).toBe("braille");
    });
    it("handles capitals, spaces and numbers", () => {
        expect(textOf("⠠⠓⠊ ⠞⠓⠑⠗⠑ ⠼⠁⠃")).toBe("Hi there 12");
    });
    it("rejects braille art and blank filler", () => {
        expect(decodeMessage("⣿⣿⣿⣿⡿⠿⠛")).toBeNull();
        expect(decodeMessage("⠀⠀⠀⠀⠀")).toBeNull();
    });
});

describe("Base64", () => {
    it("decodes whole-message Base64 that reads as writing", () => {
        expect(textOf("aGVsbG8gd29ybGQ=")).toBe("hello world");
        expect(kindOf("aGVsbG8gd29ybGQ=")).toBe("base64");
        expect(textOf("aG9sYSBhbWlnbw==")).toBe("hola amigo");
    });
    it("rejects short, unpadded or non-alphabet input", () => {
        expect(decodeMessage("aGVsbG8=")).toBeNull();          // under 12
        expect(decodeMessage("aGVsbG8gd29ybGQ")).toBeNull();   // not a multiple of 4
        expect(decodeMessage("aGVsbG8gd29y-GQ=")).toBeNull();  // url-safe alphabet
    });
    it("rejects hex hashes and random tokens", () => {
        expect(decodeMessage("d41d8cd98f00b204e9800998ecf8427e")).toBeNull();              // md5
        expect(decodeMessage("901d7d0c4b2f9a1e8d3c5b7a6f4e2d1c0b9a8f7e")).toBeNull();      // git sha
        expect(decodeMessage("Zx81PqL0mN3vT7yR")).toBeNull();
    });
    it("rejects a single word whose length happens to fit", () => {
        expect(decodeMessage("Internationalization".slice(0, 16).toLowerCase())).toBeNull();
        expect(decodeMessage("ABCDEFGHIJKLMNOP")).toBeNull();
    });
});

describe("ROT13", () => {
    it("decodes when the rotated text is plainly English", () => {
        expect(textOf("Uryyb, V ybir lbh")).toBe("Hello, I love you");
        expect(kindOf("Jr ner arire tbaan tvir lbh hc")).toBe("rot13");
    });
    it("leaves ordinary English alone", () => {
        expect(decodeMessage("hello how are you doing today")).toBeNull();
        expect(decodeMessage("I think we should go now")).toBeNull();
        // Rotates into one common word ("or"), which is not enough.
        expect(decodeMessage("be nice to him")).toBeNull();
    });
    it("leaves foreign text alone", () => {
        expect(decodeMessage("hola que tal amigo")).toBeNull();
        expect(decodeMessage("ich bin nicht sicher")).toBeNull();
    });
});

describe("letter emoji", () => {
    it("decodes spaced regional indicators", () => {
        expect(textOf("🇭 🇪 🇾")).toBe("HEY");
        expect(kindOf("🇭 🇪 🇾")).toBe("emoji");
    });
    it("splits words on wider gaps", () => {
        expect(textOf("🇭 🇮   🇾 🇴 🇺")).toBe("HI YOU");
    });
    it("accepts invisible separators", () => {
        expect(textOf("🇭​🇪​🇾")).toBe("HEY");
    });
    it("never decodes flags", () => {
        expect(decodeMessage("🇯🇵")).toBeNull();
        expect(decodeMessage("🇯🇵🇺🇸")).toBeNull();
        expect(decodeMessage("🇯🇵 🇺🇸")).toBeNull();
    });
    it("needs three letters", () => {
        expect(decodeMessage("🇭 🇮")).toBeNull();
    });
});

describe("false positives", () => {
    const never = [
        "...", "-", "ok.", "--", "- - -", ".", "?!",
        "hello there, how are you?",
        "https://example.com/aGVsbG8gd29ybGQ=",
        "```\n.... . .-.. .-.. ---\n```",
        "`aGVsbG8gd29ybGQ=`",
        "d41d8cd98f00b204e9800998ecf8427e",
        "q9ZtR2vX7kLm4NpW8sYb3cHd6fJg1uEo",
        "0x1f2e3d4c",
        "lol",
        "Hello"
    ];
    for (const s of never) {
        it(`does not decode ${JSON.stringify(s)}`, () => {
            expect(decodeMessage(s)).toBeNull();
        });
    }
});

describe("labels", () => {
    it("has a label for every decoder kind", () => {
        expect(Object.keys(DECODER_LABELS).sort()).toEqual(["base64", "binary", "braille", "emoji", "morse", "rot13"]);
    });
});

describe("normalisation", () => {
    it("maps mathematical alphanumerics", () => {
        expect(normalizeText("𝓱𝓸𝓵𝓪 𝓪𝓶𝓲𝓰𝓸")).toBe("hola amigo");
        expect(normalizeText("𝐁𝐎𝐋𝐃 𝕕𝕠𝕦𝕓𝕝𝕖")).toBe("BOLD double");
    });
    it("maps fullwidth", () => {
        expect(normalizeText("ｈｏｌａ！")).toBe("hola!");
    });
    it("maps circled and squared letters", () => {
        expect(normalizeText("ⓗⓞⓛⓐ")).toBe("hola");
        expect(normalizeText("🅷🅾🅻🅰")).toBe("HOLA");
    });
    it("keeps a lone 🅱️ emoji", () => {
        expect(normalizeText("🅱️ruh")).toBe("🅱️ruh");
    });
    it("maps small caps", () => {
        expect(normalizeText("ʜᴏʟᴀ ᴀᴍɪɢᴏ")).toBe("hola amigo");
    });
    it("reads upside-down text back", () => {
        expect(normalizeText("oƃᴉɯɐ ɐloɥ")).toBe("hola amigo");
    });
    it("strips Zalgo marks but keeps real accents", () => {
        expect(normalizeText("h̸̢̛o̵̧͝l̴̨̛a̷̢͠")).toBe("hola");
        // n's first mark is a real grave accent (it composes to ǹ), so it stays.
        expect(normalizeText("n\u0300\u0338\u0322a\u0335\u0327\u035Do\u0334\u031B\u0308")).toBe("\u01F9ao");
        expect(normalizeText("café niño việt")).toBe("café niño việt");
    });
    it("strips Zalgo per letter, so a real accent elsewhere in the message stays", () => {
        // The stacked letters are cleaned; the typed accents (é, ñ as letter plus mark) are not.
        expect(normalizeText("h\u0338\u0322\u031Bola cafe\u0301 nin\u0303o")).toBe("hola café niño");
        // A real accent under a Zalgo stack is kept: e + acute + noise is é.
        expect(normalizeText("e\u0301\u0338\u0322\u035D")).toBe("é");
        // Two marks on one letter is Vietnamese, not Zalgo.
        expect(normalizeText("vie\u0323\u0302t")).toBe("vie\u0323\u0302t");
    });
    it("never touches other scripts' vowel signs", () => {
        for (const s of [
            "नमस्ते, आप कैसे हैं? मैं ठीक हूँ।",
            "مَرْحَبًا بِكُمْ فِي الْمَدْرَسَةِ",
            "สวัสดีครับ ยินดีที่ได้รู้จัก",
            "שָׁלוֹם עֲלֵיכֶם"
        ]) {
            expect(normalizeText(s)).toBe(s);
        }
        // Styled Latin next to Hindi: only the Latin changes.
        expect(normalizeText("𝔥𝔦 नमस्ते")).toBe("hi नमस्ते");
    });
    it("maps Fraktur, script and double-struck letterlike capitals", () => {
        expect(normalizeText("ℌ𝔢𝔩𝔩𝔬 𝔣𝔯𝔦𝔢𝔫𝔡")).toBe("Hello friend");
        expect(normalizeText("ℭ𝔞𝔣𝔢 ℜ𝔬𝔪𝔞")).toBe("Cafe Roma");
        expect(normalizeText("ℍ𝕠𝕝𝕒 ℂ𝕒𝕣𝕝𝕠𝕤")).toBe("Hola Carlos");
        expect(normalizeText("ℋℯ𝓁𝓁ℴ")).toBe("Hello");
        expect(normalizeText("ℑℨℤ")).toBe("IZZ");
    });
    it("keeps a lone letterlike symbol in maths", () => {
        expect(normalizeText("for every x in ℝ")).toBe("for every x in ℝ");
        expect(normalizeText("n ∈ ℕ")).toBe("n ∈ ℕ");
    });
    it("never touches code, links or Discord markup", () => {
        const s = "𝓱𝓲 `𝓬𝓸𝓭𝓮` https://x.com/𝓪 <:𝓮:123> <@456>";
        expect(normalizeText(s)).toBe("hi `𝓬𝓸𝓭𝓮` https://x.com/𝓪 <:𝓮:123> <@456>");
    });
    it("leaves ordinary text, including Korean jamo and symbols, unchanged", () => {
        for (const s of ["hello", "ㅋㅋㅋ 진짜", "½ price™", "привет", "Ağır işçi", "ʀ"]) {
            expect(normalizeText(s)).toBe(s);
        }
    });
});

describe("translatableText", () => {
    it("prefers the decoded text", () => {
        expect(translatableText("aG9sYSBhbWlnbw==")).toBe("hola amigo");
    });
    it("otherwise normalises", () => {
        expect(translatableText("ｈｏｌａ")).toBe("hola");
    });
    it("returns ordinary text unchanged", () => {
        expect(translatableText("hola amigo")).toBe("hola amigo");
    });
});

describe("the word list's licence notice", () => {
    it("is a legal comment, so minification keeps it in the build", async () => {
        const { readFileSync } = await import("node:fs");
        const src = readFileSync(new URL("../wordList.ts", import.meta.url), "utf8");
        expect(src.startsWith("/*!")).toBe(true);
        const header = src.slice(0, src.indexOf("*/"));
        expect(header).toContain("@license");
        expect(header).toContain("Copyright 2000-2018 by Kevin Atkinson");
        expect(header).toContain("Permission to use, copy, modify, distribute and sell these word");
    });
});
