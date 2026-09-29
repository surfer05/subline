/**
 * LOCAL DECODERS: Morse, binary, Braille, Base64, ROT13 and letter emoji.
 *
 * A message written entirely in one of these is shown decoded, on its own
 * line, under the message: "decoded · morse · HAPPY BIRTHDAY". Decoding runs on this
 * computer with no network, so it costs nothing and works offline. Like every
 * other line it needs an activated install (Automatic or AI): an install with
 * nothing shows no lines at all.
 *
 * If the decoded text is itself foreign, it is that decoded text (not the
 * dots and dashes) that goes through the normal translation pipeline; the
 * translated line then appears under the decoded one, exactly like any other
 * translation. See `translatableText`.
 *
 * STRICTNESS IS THE WHOLE DESIGN. A wrong decode is a line of nonsense under a
 * perfectly normal message, which is worse than no decode at all. Every rule
 * below errs toward "not a code": Braille, Base64, ROT13 and letter emoji must
 * be the whole message; Morse and binary may be part of one, but each run is
 * judged as strictly as a whole message, and the decoded result has to look
 * like writing. "...", "-", "ok.", links, code
 * blocks, hashes, tokens and ordinary sentences never decode.
 *
 * Only message content is ever passed in, never a username.
 */

import { normalizeText } from "./normalize";
import { isCommonEnglishWord } from "./wordList";

/** The label shown before the decoded text. One place, so the wording is easy to change. */
export const DECODER_LABELS = {
    morse: "morse",
    binary: "binary",
    braille: "braille",
    base64: "base64",
    rot13: "rot13",
    emoji: "emoji letters"
} as const;

/** The first word of the decoded line: "decoded · morse · HAPPY BIRTHDAY". */
export const DECODED_WORD = "decoded";

/** Everything before the decoded text, trailing space included. */
export function decodedPrefix(kind: DecoderKind): string {
    return `${DECODED_WORD} · ${DECODER_LABELS[kind]} · `;
}

/** Hover text on the decoded line. */
export const DECODED_TITLE = "Decoded on your computer. Nothing was sent anywhere.";

export type DecoderKind = keyof typeof DECODER_LABELS;

export interface Decoded {
    kind: DecoderKind;
    /** What the reader sees after the label. */
    text: string;
    /** What the translator is given, when it is not `text` (caseless codes are lowercased). */
    translatable: string;
    /**
     * The whole message with each code replaced by its decoded text, for
     * places that show a message in place (the reply bar). The decoded text
     * alone when the message is nothing but the code.
     */
    inPlace?: string;
    /** True when the code is only part of the message (see findCodeRuns). */
    partial?: boolean;
}

/* ----------------------------------------------------------------- Morse -- */

const MORSE: Record<string, string> = {
    ".-": "A", "-...": "B", "-.-.": "C", "-..": "D", ".": "E", "..-.": "F", "--.": "G",
    "....": "H", "..": "I", ".---": "J", "-.-": "K", ".-..": "L", "--": "M", "-.": "N",
    "---": "O", ".--.": "P", "--.-": "Q", ".-.": "R", "...": "S", "-": "T", "..-": "U",
    "...-": "V", ".--": "W", "-..-": "X", "-.--": "Y", "--..": "Z",
    "-----": "0", ".----": "1", "..---": "2", "...--": "3", "....-": "4", ".....": "5",
    "-....": "6", "--...": "7", "---..": "8", "----.": "9",
    ".-.-.-": ".", "--..--": ",", "..--..": "?", "-.-.--": "!", ".----.": "'",
    "-..-.": "/", "-.--.": "(", "-.--.-": ")", "---...": ":", "-...-": "=", ".-.-.": "+",
    "-....-": "-", ".-..-.": "\"", ".--.-.": "@"
};

function decodeMorse(input: string): Decoded | null {
    // Dot and dash look-alikes that Morse generators emit. Anything else is
    // not Morse, so a single stray letter rejects the whole message.
    const s = input.replace(/[·•∙]/g, ".").replace(/[−–—_]/g, "-");
    if (!/^[.\-\/| \n\t]+$/.test(s) || !/[.-]/.test(s)) return null;
    const words = s.trim().split(/\s*[\/|]\s*|\s{3,}|\n+/).filter(w => w.trim() !== "");
    const out: string[] = [];
    const codes = new Set<string>();
    let letters = 0;
    for (const w of words) {
        let word = "";
        for (const code of w.trim().split(/\s+/)) {
            const ch = MORSE[code];
            if (ch === undefined) return null; // one unknown code and it is not Morse
            codes.add(code);
            if (/[A-Z]/.test(ch)) letters++;
            word += ch;
        }
        out.push(word);
    }
    // "..." is S and "-" is T; "... ... ..." is an ellipsis, not "SSS".
    if (codes.size < 2) return null;
    const text = out.join(" ");
    if (!morseReads(text, letters)) return null;
    return { kind: "morse", text, translatable: text.toLowerCase() };
}

/**
 * Chat shorthand people send on their own, in Morse as much as anywhere, that
 * no dictionary lists. Deliberately tiny and generic (no phrases): the
 * dictionary in wordList.ts does the real work.
 */
const CHAT_WORDS = new Set([
    "hi", "ok", "sos", "lol", "lmao", "lmfao", "rofl", "omg", "brb", "idk", "wtf", "thx",
    "pls", "plz", "ty", "gg", "ily", "tbh", "imo", "irl", "ikr", "smh", "nvm", "btw", "np"
]);

/** A word a person writes: a common English word (wordList.ts) or chat shorthand. */
function isKnownWord(w: string): boolean {
    return CHAT_WORDS.has(w) || isCommonEnglishWord(w);
}

/**
 * Short runs of dots and dashes are everywhere ("- . -", "-- - -- - --"), and
 * almost any of them spells SOME letters. So Morse is claimed only when:
 *  - every decoded word is a known word (a common English word from
 *    wordList.ts, or chat shorthand): "... --- ..." is SOS, "-. --- / -.-- --- ..-"
 *    is NO YOU. A lone word needs 3+ letters unless it is chat shorthand
 *    ("HI", "OK"), because the two-letter words ("IS", "TO", "ME") are exactly
 *    what stray dots and dashes spell; or
 *  - it has at least 5 letters, reads as writing, and reads as words: at
 *    least one known word, or two or more words that each have a vowel, or
 *    one word of 6+ letters that is pronounceable (a third vowels, no run of
 *    4 consonants), so a foreign word like GRACIAS still decodes.
 * These rules are what turn away "--- -.- .-.. --- .-.." (OKLOL): five
 * letters of real writing, but one run-together word nobody wrote. A name
 * ("ANDI") is accepted only by the second rule, never by the dictionary.
 */
function morseReads(text: string, letters: number): boolean {
    const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
    if (words.length === 0) return false;
    if (words.every(isKnownWord) && (letters >= 3 || words.length >= 2 || CHAT_WORDS.has(words[0]!))) return true;
    if (letters < 5 || !looksLikeWriting(text, 0.6)) return false;
    if (words.some(isKnownWord)) return true;
    if (words.length >= 2) return words.every(w => /[aeiouy]/.test(w));
    const w = words[0]!;
    const vowels = (w.match(/[aeiouy]/g) ?? []).length;
    return w.length >= 6 && vowels / w.length >= 0.3 && !/[^aeiouy0-9']{4}/.test(w);
}

/* ---------------------------------------------------------------- binary -- */

/** Decoded text reads as writing: printable, and mostly letters, digits and spaces. */
function looksLikeWriting(text: string, minRatio: number): boolean {
    if (text.trim() === "") return false;
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F�]/.test(text)) return false;
    const chars = [...text];
    const wordy = chars.filter(c => /[\p{L}\p{N}\s]/u.test(c)).length;
    const letters = chars.filter(c => /\p{L}/u.test(c)).length;
    // One character over and over ("aaaa", "AAAAAA") is not writing.
    const distinct = new Set(chars.filter(c => !/\s/u.test(c)).map(c => c.toLowerCase()));
    return letters >= 2 && distinct.size >= 2 && wordy / chars.length >= minRatio;
}

function utf8(bytes: Uint8Array): string | null {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

function decodeBinary(input: string): Decoded | null {
    const s = input.trim();
    let groups: string[];
    if (/^[01]{8}(\s+[01]{8})+$/.test(s)) groups = s.split(/\s+/);
    else if (/^[01]+$/.test(s) && s.length % 8 === 0) groups = s.match(/.{8}/g)!;
    else return null;
    if (groups.length < 3) return null;
    const text = utf8(new Uint8Array(groups.map(g => parseInt(g, 2))));
    if (text === null || !looksLikeWriting(text, 0.6)) return null;
    return { kind: "binary", text, translatable: text };
}

/* --------------------------------------------------------------- Braille -- */

/** Grade 1 (uncontracted) letters, by Unicode dot pattern. */
const BRAILLE_LETTERS: Record<string, string> = {
    "⠁": "a", "⠃": "b", "⠉": "c", "⠙": "d", "⠑": "e", "⠋": "f", "⠛": "g", "⠓": "h", "⠊": "i",
    "⠚": "j", "⠅": "k", "⠇": "l", "⠍": "m", "⠝": "n", "⠕": "o", "⠏": "p", "⠟": "q", "⠗": "r",
    "⠎": "s", "⠞": "t", "⠥": "u", "⠧": "v", "⠺": "w", "⠭": "x", "⠽": "y", "⠵": "z"
};
const BRAILLE_PUNCT: Record<string, string> = {
    "⠂": ",", "⠆": ";", "⠒": ":", "⠲": ".", "⠖": "!", "⠦": "?", "⠄": "'", "⠤": "-"
};
const DIGIT_OF = "jabcdefghi"; // number sign + a..j = 1..9, 0
const CAPITAL = "⠠";
const NUMBER = "⠼";

function decodeBraille(input: string): Decoded | null {
    const s = input.trim();
    if (!/^[⠀-⣿ \n!?.,]+$/u.test(s)) return null;
    let out = "";
    let capital = false;
    let number = false;
    let letters = 0;
    for (const c of s) {
        if (c === " " || c === "⠀" || c === "\n") { out += c === "\n" ? "\n" : " "; number = false; continue; }
        if (c === CAPITAL) { capital = true; continue; }
        if (c === NUMBER) { number = true; continue; }
        if ("!?.,".includes(c)) { out += c; continue; }
        const letter = BRAILLE_LETTERS[c];
        if (letter !== undefined) {
            if (number && DIGIT_OF.includes(letter)) { out += String(DIGIT_OF.indexOf(letter)); continue; }
            number = false;
            out += capital ? letter.toUpperCase() : letter;
            capital = false;
            letters++;
            continue;
        }
        const p = BRAILLE_PUNCT[c];
        if (p === undefined) return null; // braille art, 8-dot cells, contractions
        out += p;
        number = false;
    }
    if (letters < 3) return null;
    const text = out.replace(/ {2,}/g, " ").trim();
    return { kind: "braille", text, translatable: text };
}

/* ---------------------------------------------------------------- Base64 -- */

function decodeBase64(input: string): Decoded | null {
    const s = input.trim();
    // Strict: standard alphabet, whole message, padded to a multiple of four.
    if (s.length < 12 || s.length % 4 !== 0) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
    let bin: string;
    try { bin = atob(s); } catch { return null; }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = utf8(bytes);
    if (text === null) return null;
    // Mostly letters and spaces: 80% of the characters, and 2+ letters.
    const chars = [...text];
    const letterSpace = chars.filter(c => /[\p{L}\s]/u.test(c)).length;
    if (!looksLikeWriting(text, 0.8) || letterSpace / chars.length < 0.8) return null;
    return { kind: "base64", text, translatable: text };
}

/* ----------------------------------------------------------------- ROT13 -- */

/** Very common English words. Small on purpose: ROT13 is only claimed when the
 *  rotated text is plainly English and the original plainly is not. */
const COMMON_WORDS = new Set([
    "the", "be", "to", "of", "and", "in", "that", "have", "it", "for", "not", "on", "with",
    "he", "as", "you", "do", "at", "this", "but", "his", "by", "from", "they", "we", "say",
    "her", "she", "or", "an", "will", "my", "one", "all", "would", "there", "their", "what",
    "so", "up", "out", "if", "about", "who", "get", "which", "go", "me", "when", "make",
    "can", "like", "time", "no", "just", "him", "know", "take", "people", "into", "year",
    "your", "good", "some", "could", "them", "see", "other", "than", "then", "now", "look",
    "only", "come", "its", "over", "think", "also", "back", "after", "use", "two", "how",
    "our", "work", "first", "well", "way", "even", "new", "want", "because", "any", "these",
    "give", "day", "most", "us", "is", "are", "was", "were", "am", "hello", "hi", "secret",
    "message", "love", "happy", "birthday", "here", "where", "why", "yes", "thanks", "thank",
    "please", "friend", "friends", "never", "gonna", "you", "up", "down", "let", "said"
]);

function rot13(s: string): string {
    return s.replace(/[a-z]/gi, c => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
    });
}

/** Share of words (2+ letters) that are common English words, and how many are. */
function englishScore(s: string): { ratio: number; hits: number } {
    const words = (s.toLowerCase().match(/[a-z]+/g) ?? []).filter(w => w.length >= 2);
    if (words.length === 0) return { ratio: 0, hits: 0 };
    const hits = words.filter(w => COMMON_WORDS.has(w)).length;
    return { ratio: hits / words.length, hits };
}

function decodeRot13(input: string): Decoded | null {
    const s = input.trim();
    // Latin letters, spaces and light punctuation only. Anything else (links,
    // markup, other scripts, digits-heavy text) is not a ROT13 message.
    if (!/^[A-Za-z\s.,!?'"-]+$/.test(s)) return null;
    const words = s.match(/[A-Za-z]+/g) ?? [];
    if (words.length < 2) return null;
    const before = englishScore(s);
    const rotated = rot13(s);
    const after = englishScore(rotated);
    // Clearly English after, clearly not before.
    if (after.hits < 2 || after.ratio < 0.5 || before.ratio > 0.15) return null;
    if (after.ratio - before.ratio < 0.4) return null;
    return { kind: "rot13", text: rotated, translatable: rotated };
}

/* --------------------------------------------------- letter emoji (🇭 🇮) -- */

const RI_START = 0x1F1E6;
const isRegional = (cp: number) => cp >= RI_START && cp <= 0x1F1FF;
/** Between letters: a space or an invisible joiner/separator. */
const SEPARATOR = /[ ​‌‍⁠️]/;

/**
 * Regional indicator letters, spelled one by one. Two indicators written
 * directly next to each other are a country flag (🇯🇵), never letters, so any
 * adjacent pair rejects the message. People who spell with these put a space
 * or an invisible separator between letters so they do not turn into flags.
 */
function decodeRegional(input: string): Decoded | null {
    const s = input.trim();
    const chars = [...s];
    if (!chars.some(c => isRegional(c.codePointAt(0)!))) return null;
    let text = "";
    let letters = 0;
    let prevRegional = false;
    let gap = "";
    for (const c of chars) {
        const cp = c.codePointAt(0)!;
        if (isRegional(cp)) {
            if (prevRegional) return null; // a flag
            // Two or more spaces, a slash or a line break between letters is a word break.
            if (letters > 0 && (/ {2,}|\/|\n/.test(gap) || / .* /.test(gap))) text += " ";
            text += String.fromCharCode(65 + cp - RI_START);
            letters++;
            prevRegional = true;
            gap = "";
            continue;
        }
        prevRegional = false;
        if (SEPARATOR.test(c) || c === "\n" || c === "/") { gap += c; continue; }
        if ("!?.,".includes(c)) { text += c; gap = ""; continue; }
        return null;
    }
    if (letters < 3) return null;
    return { kind: "emoji", text, translatable: text.toLowerCase() };
}

/* ------------------------------------------- codes inside a message -- */

/**
 * Morse and binary are often only PART of a message: "you can tell him this
 * .- -. -.. ..", or a code followed by a mention. A message is read as a row
 * of whitespace-separated tokens:
 *  - code tokens: dots and dashes (and "/" or "|" word breaks), or 8-bit
 *    binary groups;
 *  - ignorable tokens: @mentions, channel and role mentions, custom emoji
 *    markup and emoji. They sit next to a code without breaking it, and are
 *    never part of it;
 *  - everything else, which ends a code.
 * Each unbroken row of code tokens is a run, judged by the same rules as a
 * whole message. A run inside other text must also have at least three codes,
 * so a dash or an ellipsis in a sentence is never a run.
 */
const MORSE_TOKEN = /^[.\-·•∙−–—_]+$/;
const MORSE_BREAK = /^[\/|]$/;
const BINARY_TOKEN = /^(?:[01]{8})+$/;
const IGNORABLE_TOKEN = /^(?:<a?:\w+:\d+>|<@[!&]?\d+>|<#\d+>|@[^\s@]+|[\p{Extended_Pictographic}\u200d\ufe0f\u{1F3FB}-\u{1F3FF}]+)$/u;
/** The fewest codes a run inside other text may have. */
const MIN_CODES_IN_TEXT = 3;

interface Token { text: string; start: number; end: number; }
interface Run { kind: "morse" | "binary"; start: number; end: number; decoded: Decoded; }

function tokensOf(s: string): Token[] {
    return [...s.matchAll(/\S+/g)].map(m => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
}

type TokenClass = "morse" | "break" | "binary" | "ignorable" | "other";
function classify(t: string): TokenClass {
    if (MORSE_BREAK.test(t)) return "break";
    if (MORSE_TOKEN.test(t)) return "morse";
    if (BINARY_TOKEN.test(t)) return "binary";
    if (IGNORABLE_TOKEN.test(t)) return "ignorable";
    return "other";
}

/**
 * The run's text as its decoder expects it: the original from its first code
 * to its last, with any ignorable token inside blanked out. A blanked token
 * becomes spaces, which a Morse decoder reads as a word break when it leaves
 * three or more in a row.
 */
function runText(s: string, tokens: Token[], classes: TokenClass[], from: number, to: number): string {
    let out = s.slice(tokens[from].start, tokens[to].end);
    for (let i = to; i >= from; i--) {
        if (classes[i] !== "ignorable") continue;
        const a = tokens[i].start - tokens[from].start;
        const b = tokens[i].end - tokens[from].start;
        out = out.slice(0, a) + " ".repeat(Math.max(3, b - a)) + out.slice(b);
    }
    return out;
}

function findCodeRuns(s: string): { runs: Run[]; otherText: boolean } {
    const tokens = tokensOf(s);
    const classes = tokens.map(t => classify(t.text));
    const otherText = classes.some(c => c === "other");
    const minCodes = otherText ? MIN_CODES_IN_TEXT : 1;
    const runs: Run[] = [];
    let i = 0;
    while (i < tokens.length) {
        const c = classes[i];
        if (c !== "morse" && c !== "binary") { i++; continue; }
        const kind = c;
        // Extend over tokens of the same code (and, for Morse, word breaks),
        // stepping over ignorable tokens without ending the run.
        let last = i;
        // The last code or word break: a trailing "/" belongs to the code, so
        // it goes when the code is replaced by its decoded text.
        let spanEnd = i;
        let j = i + 1;
        while (j < tokens.length) {
            const cj = classes[j];
            if (cj === kind) { last = j; spanEnd = j; j++; continue; }
            // Only a break right after the code; never across a mention or emoji.
            if (kind === "morse" && cj === "break") { if (spanEnd === j - 1) spanEnd = j; j++; continue; }
            if (cj === "ignorable") { j++; continue; }
            break;
        }
        // Codes in the run: Morse letters, or bytes of binary.
        let codes = 0;
        for (let k = i; k <= last; k++) {
            if (classes[k] === kind) codes += kind === "binary" ? tokens[k].text.length / 8 : 1;
        }
        if (codes >= minCodes) {
            const text = runText(s, tokens, classes, i, last);
            const decoded = kind === "morse" ? decodeMorse(text) : decodeBinary(text.replace(/\s+/g, " "));
            if (decoded !== null) runs.push({ kind, start: tokens[i].start, end: tokens[spanEnd].end, decoded });
        }
        i = j;
    }
    return { runs, otherText };
}

/** Morse and binary found as runs in the message (the whole message, or parts of it). */
function decodeRuns(s: string): Decoded | null {
    const { runs: all, otherText } = findCodeRuns(s);
    if (all.length === 0) return null;
    // One kind per line: Morse if the message has any, else binary.
    const kind = all.some(r => r.kind === "morse") ? "morse" : "binary";
    const runs = all.filter(r => r.kind === kind);
    let inPlace = s;
    for (let k = runs.length - 1; k >= 0; k--) {
        inPlace = inPlace.slice(0, runs[k].start) + runs[k].decoded.text + inPlace.slice(runs[k].end);
    }
    const text = runs.map(r => r.decoded.text).join(" / ");
    if (!otherText) {
        // Nothing but the code (and mentions or emoji around it).
        return { kind, text, translatable: runs.map(r => r.decoded.translatable).join(" "), inPlace: inPlace.trim() };
    }
    // Part of a message: the translator gets the message with each code
    // replaced by its decoded text, so the language is judged on all of it.
    let translatable = s;
    for (let k = runs.length - 1; k >= 0; k--) {
        translatable = translatable.slice(0, runs[k].start) + runs[k].decoded.translatable + translatable.slice(runs[k].end);
    }
    return { kind, text, translatable: normalizeText(translatable), inPlace, partial: true };
}

/* ------------------------------------------------------------------ entry -- */

const DECODERS = [decodeRegional, decodeBraille, decodeMorse, decodeBinary, decodeBase64, decodeRot13];

/**
 * The message decoded, or null when it holds no code. A message written
 * entirely in one code is decoded whole; Morse and binary are also found
 * inside other text (see findCodeRuns). Code blocks, inline code and links
 * never decode.
 */
export function decodeMessage(content: string | null | undefined): Decoded | null {
    if (typeof content !== "string") return null;
    const s = content.trim();
    if (s.length < 3 || s.length > 4000) return null;
    // Belt and braces: every decoder's own alphabet already rejects these.
    if (s.includes("`") || /https?:\/\//i.test(s)) return null;
    for (const d of DECODERS) {
        const r = d(s);
        if (r !== null) return { ...r, inPlace: r.text };
    }
    return decodeRuns(s);
}

/**
 * The text the rest of the pipeline should judge and translate for a message:
 * the decoded text for a message written in a code, otherwise the message with
 * fancy fonts, upside-down letters and Zalgo normalised (see normalize.ts).
 * Returns the input unchanged when neither applies.
 */
export function translatableText(content: string): string {
    if (typeof content !== "string" || content === "") return content;
    const decoded = decodeMessage(content);
    if (decoded !== null) return decoded.translatable;
    return normalizeText(content);
}
