import { describe, expect, it } from "vitest";

import { decodeMessage, DECODER_LABELS, translatableText } from "../decode";
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
    it("rejects fewer than three letters", () => {
        expect(decodeMessage(".... ..")).toBeNull();
    });
    it("rejects any unknown code", () => {
        expect(decodeMessage(".... ...... .-..")).toBeNull();
    });
    it("rejects an ellipsis written with spaces", () => {
        expect(decodeMessage("... ... ...")).toBeNull();
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
        expect(normalizeText("n\u0300\u0338\u0322a\u0335\u0327\u035Do\u0334\u031B\u0308")).toBe("nao");
        expect(normalizeText("café niño việt")).toBe("café niño việt");
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
