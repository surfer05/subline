/**
 * NORMALISATION: fancy Unicode text back to plain letters, before anything
 * judges or translates it.
 *
 * "𝓱𝓸𝓵𝓪 𝓪𝓶𝓲𝓰𝓸", "ｈｏｌａ", "ⓗⓞⓛⓐ", "ʜᴏʟᴀ", "ɐloɥ" and Zalgo "h̸̢o̵͝l̴a̷" are all
 * the word "hola". Language detection and both translators read those code
 * points as symbols, so without this the message is either skipped as
 * "nothing translatable" or sent to Google and echoed back unchanged. This is
 * not a separate subtitle: the normalised text simply goes through the
 * normal pipeline, so it translates like any other message.
 *
 * WHAT IS NEVER TOUCHED: code (``` blocks and `inline`), links, and Discord
 * markup (<@id>, <#id>, <:emote:id>, <t:123>). Those spans are cut out first
 * and put back unchanged. Usernames are never passed in at all: callers hand
 * over message content only.
 *
 * NOT a blanket NFKC. NFKC would also rewrite ordinary text people rely on:
 * Korean "ㅋㅋㅋ" becomes conjoining jamo, "½" becomes "1⁄2", "™" becomes
 * "TM". Each family below is mapped on its own, only inside its own block.
 *
 * Pure, synchronous, no network: safe for every plan and every render.
 */

/** Spans that must come through byte for byte. Order matters: code first. */
const PROTECTED = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|<[^<>\s]+>/g;

/** Apply `fn` to every stretch of text OUTSIDE code, links and Discord markup. */
function mapUnprotected(text: string, fn: (s: string) => string): string {
    let out = "";
    let last = 0;
    for (const m of text.matchAll(PROTECTED)) {
        const start = m.index ?? 0;
        out += fn(text.slice(last, start)) + m[0];
        last = start + m[0].length;
    }
    return out + fn(text.slice(last));
}

/* ------------------------------------------------ styled letter blocks -- */

/**
 * One code point from a "font" block, to plain ASCII, or null when it is not
 * one. NFKC is used per character and ONLY for blocks whose whole purpose is
 * styled Latin: Mathematical Alphanumeric Symbols (𝐀 𝓐 𝔄 𝕬 𝖠 𝙰 …), fullwidth
 * ASCII (Ａ ａ ！), enclosed alphanumerics (Ⓐ ⓐ ①), squared Latin (🄰).
 */
function styledToAscii(cp: number, ch: string): string | null {
    const inBlock =
        (cp >= 0x1D400 && cp <= 0x1D7FF) ||   // mathematical alphanumerics
        (cp >= 0xFF01 && cp <= 0xFF5E) ||     // fullwidth ASCII
        (cp >= 0x2460 && cp <= 0x24FF) ||     // enclosed alphanumerics (circled)
        (cp >= 0x1F130 && cp <= 0x1F149);     // squared Latin capitals
    if (inBlock) {
        const n = ch.normalize("NFKC");
        return /^[\x20-\x7E]+$/.test(n) ? n : null;
    }
    // Negative circled (🅐) and negative squared (🅰) capitals have no
    // compatibility mapping, so they are offset by hand. 🅰 and 🅱 double as
    // emoji (the "🅱️" meme): see NEGATIVE_RUN below for when these apply.
    if (cp >= 0x1F150 && cp <= 0x1F169) return String.fromCharCode(0x41 + cp - 0x1F150);
    if (cp >= 0x1F170 && cp <= 0x1F189) return String.fromCharCode(0x41 + cp - 0x1F170);
    return null;
}

const isNegativeLetter = (cp: number) =>
    (cp >= 0x1F150 && cp <= 0x1F169) || (cp >= 0x1F170 && cp <= 0x1F189);

function mapStyled(s: string): string {
    // Negative letters count as a font only when at least three appear, so a
    // lone "🅱️" or "🅰️" emoji stays an emoji.
    let negatives = 0;
    for (const ch of s) if (isNegativeLetter(ch.codePointAt(0)!)) negatives++;
    let out = "";
    for (const ch of s) {
        const cp = ch.codePointAt(0)!;
        if (isNegativeLetter(cp) && negatives < 3) { out += ch; continue; }
        const plain = styledToAscii(cp, ch);
        out += plain ?? ch;
    }
    // A negative letter is often followed by VS16 to force emoji rendering.
    return negatives >= 3 ? out.replace(/(?<=[A-Z])️/g, "") : out;
}

/* ---------------------------------------------------------- small caps -- */

const SMALL_CAPS: Record<string, string> = {
    "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ꜰ": "f", "ɢ": "g", "ʜ": "h", "ɪ": "i",
    "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ǫ": "q", "ʀ": "r",
    "ꜱ": "s", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z"
};
const SMALL_CAP_RE = /[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡʏᴢ]/gu;

/**
 * Small caps only when it is clearly a font: at least two small capitals in
 * the text. Several of these letters are also IPA (ʀ ɢ ɪ ʏ), so a single one
 * in otherwise normal text is left alone.
 */
function mapSmallCaps(s: string): string {
    const hits = s.match(SMALL_CAP_RE);
    if (!hits || hits.length < 2) return s;
    return s.replace(SMALL_CAP_RE, c => SMALL_CAPS[c] ?? c);
}

/* -------------------------------------------------------- upside down -- */

/** Flipped glyph -> the letter it came from. Plain letters that flip into
 *  other plain letters (b/q, d/p, n/u) are included; they apply only once
 *  the text is known to be flipped. */
const FLIPPED: Record<string, string> = {
    "ɐ": "a", "q": "b", "ɔ": "c", "p": "d", "ǝ": "e", "ɟ": "f", "ƃ": "g", "ɥ": "h", "ᴉ": "i",
    "ı": "i", "ɾ": "j", "ʞ": "k", "ן": "l", "ɯ": "m", "u": "n", "d": "p", "b": "q", "ɹ": "r",
    "ʇ": "t", "n": "u", "ʌ": "v", "ʍ": "w", "ʎ": "y",
    "∀": "A", "ꓭ": "B", "Ɔ": "C", "ᗡ": "D", "Ǝ": "E", "Ⅎ": "F", "⅁": "G", "ſ": "J", "ꓘ": "K",
    "˥": "L", "Ԁ": "P", "ꓤ": "R", "⊥": "T", "∩": "U", "Λ": "V", "⅄": "Y",
    "¡": "!", "¿": "?", "˙": ".", "'": ",", ",": "'", "(": ")", ")": "(", "[": "]", "]": "[",
    "{": "}", "}": "{", "<": ">", ">": "<", "‾": "_", "؛": ";"
};

/** Glyphs that appear in flipped text and in no real orthography. */
const FLIP_MARKERS = /[ɐǝɹʇɯʎɥʍʞɟƃᴉ∀Ǝ⅄⊥∩˥Ԁꓤᗡ]/gu;

/**
 * Upside-down text is reversed AND flipped. Recognised only with two or more
 * distinct marker glyphs, then read back to front with every glyph unflipped.
 */
function mapUpsideDown(s: string): string {
    const markers = new Set(s.match(FLIP_MARKERS) ?? []);
    if (markers.size < 2) return s;
    return [...s].reverse().map(c => FLIPPED[c] ?? c).join("");
}

/* --------------------------------------------------------------- Zalgo -- */

const COMBINING = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/gu;
const STACK = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]{3,}/u;

/**
 * Zalgo is a letter buried under a stack of combining marks. Real writing
 * never stacks three: Vietnamese, the heaviest user of these marks, uses at
 * most two on one letter. So a stack of three or more anywhere means the
 * whole text is Zalgo, and every mark in these blocks is removed. Accents
 * that were typed precomposed (é, ñ, ệ) are separate code points and stay.
 */
function stripZalgo(s: string): string {
    if (!STACK.test(s)) return s;
    return s.replace(COMBINING, "").normalize("NFC");
}

/**
 * The text as a translator should read it. Returns the input unchanged (same
 * string) when there is nothing to normalise, so callers can compare cheaply.
 */
export function normalizeText(text: string): string {
    if (typeof text !== "string" || text === "") return text;
    // Fast exit: plain ASCII has nothing to map.
    if (/^[\x00-\x7F]*$/.test(text)) return text;
    const out = mapUnprotected(text, s => mapUpsideDown(mapSmallCaps(mapStyled(stripZalgo(s)))));
    return out === text ? text : out;
}
