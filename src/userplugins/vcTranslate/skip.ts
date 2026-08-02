const CUSTOM_EMOTE = /<a?:\w+:\d+>/g;
const MENTION = /<[@#][!&]?\d+>/g;
const URL = /https?:\/\/\S+/g;
// Emoji, variation selectors, ZWJ, skin-tone modifiers, regional indicators.
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * Laughter and keyboard mash, across the languages this is aimed at:
 * hahaha / ahaha (en), jajaja / jeje (es), kkkk (pt), wwww (ja), 555 (th),
 * xd / xddd, lol / lolol, rsrs (pt), ㅋㅋ / ㅎㅎ (ko).
 *
 * Length floors matter: `[jha]{4,}` deliberately does not fire on short real
 * words, and the alternatives are anchored so this only ever matches a whole
 * message, never a laughing fragment inside a real sentence.
 */
const LAUGHTER = /^(?:[jha]{4,}|k{3,}|w{3,}|(?:x+d+)+|(?:lo)+l|(?:rs){2,}|5{3,}|[ㄱㅎ]{2,})$/i;

/**
 * A message whose every whitespace-separated token is the same word carries no
 * more meaning than the single word, and translation engines handle it badly:
 * Google detected "GOJ GOJ GOJ GOJ" as Esperanto and rendered it as a slur
 * attributed to the sender. Requires 2+ tokens so a single real word is
 * untouched.
 */
function isRepeatedToken(s: string): boolean {
    const tokens = s.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return false;
    const first = tokens[0].toLowerCase();
    return tokens.every(t => t.toLowerCase() === first);
}

export function shouldSkip(text: string, isOwnMessage: boolean): boolean {
    if (isOwnMessage) return true;

    const stripped = text
        .replace(CUSTOM_EMOTE, "")
        .replace(MENTION, "")
        .replace(URL, "")
        .replace(EMOJI, "")
        // Anything left that is only digits, punctuation, whitespace, or combining marks
        // carries no translatable meaning.
        .replace(/[\p{Nd}\p{P}\p{S}\p{M}\s]/gu, "");

    if (stripped.length === 0) return true;

    // Noise checks run on the ORIGINAL text with punctuation removed but
    // whitespace kept, so token structure survives ("GOJ GOJ GOJ" must stay
    // three tokens) while "jaja!!!" and "jaja" collapse to the same thing.
    const words = text
        .replace(CUSTOM_EMOTE, " ")
        .replace(MENTION, " ")
        .replace(URL, " ")
        .replace(EMOJI, " ")
        .replace(/[\p{P}\p{S}\p{M}]/gu, "")
        .trim();

    if (isRepeatedToken(words)) return true;
    if (LAUGHTER.test(words.replace(/\s+/g, ""))) return true;

    return false;
}
