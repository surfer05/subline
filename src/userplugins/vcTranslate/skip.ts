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

/**
 * English chat shorthand. These are already in the target language for an
 * English-speaking user, but they are too short and too unlike dictionary
 * words for statistical detection to place them: Google reads "hbu" as
 * Frisian and "u2" as Chinese, then returns them unchanged. Catching them
 * here avoids the request entirely rather than paying for a no-op.
 *
 * Only fires when the WHOLE message is shorthand, so "hbu, tienes hambre?"
 * still translates.
 */
const CHAT_SHORTHAND = new Set([
    "hbu", "wbu", "u2", "you2", "same", "ty", "tysm", "np", "yw", "nvm", "idk",
    "idc", "imo", "imho", "tbh", "ngl", "fr", "brb", "afk", "gtg", "ttyl",
    "wtf", "omg", "omfg", "ikr", "smh", "irl", "rn", "atm", "asap", "btw",
    "gg", "ggwp", "wp", "gl", "hf", "glhf", "ez", "op", "nt", "n1", "sry",
    "pls", "plz", "thx", "ok", "okay", "k", "kk", "yh", "ye", "yep", "yup",
    "nah", "nope", "yeet", "bruh", "bro", "sus", "af", "ffs", "istg", "tldr"
]);

function isChatShorthand(s: string): boolean {
    // Bare numbers survive punctuation stripping ("u2 <2" becomes "u2 2") and
    // carry no meaning of their own, so they neither qualify nor disqualify.
    const tokens = s.toLowerCase().split(/\s+/).filter(t => t && !/^\d+$/.test(t));
    if (tokens.length === 0 || tokens.length > 4) return false;
    return tokens.every(t => CHAT_SHORTHAND.has(t));
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

    if (isChatShorthand(words)) return true;
    if (isRepeatedToken(words)) return true;
    if (LAUGHTER.test(words.replace(/\s+/g, ""))) return true;

    return false;
}
