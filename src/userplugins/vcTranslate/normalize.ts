/**
 * NORMALISATION: fancy Unicode text back to plain letters, before anything
 * judges or translates it.
 *
 * "𝓱𝓸𝓵𝓪 𝓪𝓶𝓲𝓰𝓸", "ｈｏｌａ", "ⓗⓞⓛⓐ", "ʜᴏʟᴀ", "ɐloɥ" and Zalgo "h̸̢̛o̵̧͝l̴̨̛a̷̢͠" are all
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
/**
 * Letterlike Symbols (U+2100 to U+214F) hold the capitals and a few small
 * letters that the math alphanumerics block leaves out as "holes": Fraktur
 * ℌ ℑ ℜ ℭ ℨ, script ℬ ℰ ℱ ℋ ℐ ℒ ℳ ℛ ℯ ℊ ℴ ℓ, double-struck ℂ ℍ ℕ ℙ ℚ ℝ ℤ, and
 * the italic ℎ. A "𝔣𝔞𝔫𝔠𝔶" generator writes "ℌ𝔢𝔩𝔩𝔬" for "Hello".
 */
const LETTERLIKE = "ℌℑℜℭℨℬℰℱℋℐℒℳℛℯℊℴℓℂℍℕℙℚℝℤℎ";
const LETTERLIKE_RE = new RegExp(`[${LETTERLIKE}]`, "gu");
const MATH_LETTER_RE = /[\u{1D400}-\u{1D6A5}]/u;

/**
 * Letterlike letters map only when the text is clearly styled: it also has
 * math alphanumeric letters, or two or more letterlike letters. A lone ℝ or
 * ℕ in "x ∈ ℝ" is maths, not a font, and stays.
 */
function mapLetterlike(s: string): string {
    const hits = s.match(LETTERLIKE_RE);
    if (!hits) return s;
    if (hits.length < 2 && !MATH_LETTER_RE.test(s)) return s;
    return s.replace(LETTERLIKE_RE, c => c.normalize("NFKC"));
}

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

/**
 * A run of three or more marks from the generic combining blocks on one base
 * character: Combining Diacritical Marks (U+0300 to U+036F) and their
 * extensions and supplement, marks for symbols, and half marks.
 *
 * Deliberately NOT \p{M}: Devanagari, Arabic, Thai, Hebrew and every other
 * script keep their own vowel signs in their own blocks, and those stack
 * legitimately. They are never touched.
 */
const ZALGO_STACK = /(\P{M})([̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯])[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]{2,}/gu;

/**
 * Zalgo is a letter buried under a stack of combining marks. Real writing
 * never stacks three: Vietnamese, the heaviest user of these marks, uses at
 * most two on one letter. So on each base character that carries three or
 * more, every mark after the first is removed. The first is kept only when it
 * is a real accent on that letter, meaning the pair composes to one letter
 * (e + ́ is é). A Zalgo stroke or ring never composes (h + ̸), so it goes
 * too, and the word reads as plain letters. A base with one or two marks is
 * left exactly as written, so é, ñ and ệ (precomposed or typed as letter plus
 * accent) never change, even in a message that is Zalgo elsewhere.
 */
function stripZalgo(s: string): string {
    const out = s.replace(ZALGO_STACK, (_all, base: string, first: string) => {
        const composed = (base + first).normalize("NFC");
        return [...composed].length === 1 ? composed : base;
    });
    return out === s ? s : out.normalize("NFC");
}

/**
 * The text as a translator should read it. Returns the input unchanged (same
 * string) when there is nothing to normalise, so callers can compare cheaply.
 */
export function normalizeText(text: string): string {
    if (typeof text !== "string" || text === "") return text;
    // Fast exit: plain ASCII has nothing to map.
    if (/^[\x00-\x7F]*$/.test(text)) return text;
    const out = mapUnprotected(text, s => mapUpsideDown(mapSmallCaps(mapStyled(mapLetterlike(stripZalgo(s))))));
    return out === text ? text : out;
}
