const CUSTOM_EMOTE = /<a?:\w+:\d+>/g;
const MENTION = /<[@#][!&]?\d+>/g;
const URL = /https?:\/\/\S+/g;
// Emoji, variation selectors, ZWJ, skin-tone modifiers, regional indicators.
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * Remove the non-linguistic markup from a message: custom emotes, mentions,
 * links and emoji.
 *
 * Exported because detectLang.ts has to strip exactly the same things before it
 * can judge what language a message is in — `🌞🌿` and `<@123>` are not
 * evidence for or against English. A second private copy of these four patterns
 * is precisely the bug shape this project keeps hitting: a future fix (a new
 * mention form, a new emoji range) reaches whichever copy got patched.
 *
 * `replacement` is the caller's, because the two questions differ: "" when
 * asking whether anything translatable is left at all, " " when token structure
 * has to survive the strip.
 */
export function stripMarkup(text: string, replacement: string): string {
    return text
        .replace(CUSTOM_EMOTE, replacement)
        .replace(MENTION, replacement)
        .replace(URL, replacement)
        .replace(EMOJI, replacement);
}

/**
 * Collapse a run of 3-OR-MORE identical letters down to exactly one:
 * "yesssss" -> "yes", "waiiiiiit" -> "wait", "helloooooo" -> "hello".
 *
 * A run of exactly two is left alone on purpose — "hello"'s "ll" and
 * "morning"'s none survive untouched — because English (and most of the other
 * languages this plugin sees) doubles letters constantly in ordinary spelling
 * (hello, better, all, will) but essentially never triples one, so 3+ is the
 * threshold that catches chat elongation ("yesssss", "shhhh") without ever
 * mangling a real word. Checked against a foreign word too: "ceeeee"
 * (Romanian) collapses to "ce", which is not an English word either — the
 * collapse on its own cannot manufacture a false match, only being ALSO added
 * to an evidence list can (see CHAT_SHORTHAND and detectLang.ts's
 * ENGLISH_WORDS), which is why entries are added there individually and
 * deliberately rather than as a side effect of this function existing.
 *
 * ONE FORM IS NOT ENOUGH, and this function's own name says so: it only
 * reconstructs a base word correctly when the elongated letter appears
 * SINGLY in that word ("yes" -> one "s", "wait" -> one "i"). A base word with
 * a genuine DOUBLED letter at the elongated spot ("good", "cool", "all")
 * collapses to the wrong thing here — "goooooood" -> "god", not "good" — because
 * collapsing to one cannot tell "a single letter mashed" from "an already-doubled
 * letter mashed further"; both look identical once collapsed. See
 * `collapseElongationToPair` for the other half of the fix: every caller of
 * this function is expected to ALSO try that one and accept a match on
 * either, never this one alone.
 *
 * Exported (rather than kept private, like every other pattern here except
 * stripMarkup) because detectLang.ts has to apply the exact same collapse
 * before comparing a token against ENGLISH_WORDS/FOREIGN_WORDS — a second
 * private copy is precisely the "two copies of the same rule drift apart"
 * bug this project keeps hitting, the same reason stripMarkup is shared.
 *
 * `\p{L}` rather than `[a-z]`: the same reasoning extends to any script this
 * plugin ever sees text in, not just the Latin one the examples happen to use.
 * The backreference is exact-character, not case-folded, so a run has to be
 * the SAME case throughout to collapse — "SSS" and "sss" each collapse on
 * their own, "SsS" (not a real elongation pattern) does not.
 */
export function collapseElongation(s: string): string {
    return s.replace(/(\p{L})\1{2,}/gu, "$1");
}

/**
 * The other half of the fix `collapseElongation` alone cannot provide:
 * collapse a run of 3-OR-MORE identical letters down to exactly TWO, so a
 * base word with a genuine doubled letter at the elongated spot survives
 * intact — "goooooood" -> "good", "coooool" -> "cool" — the case
 * `collapseElongation` alone gets wrong ("goooooood" -> "god").
 *
 * NEITHER FORM IS RIGHT ON ITS OWN. A base word whose elongated letter is
 * SINGLE ("yes", "wait", "hello", "lmao") is only reconstructed correctly by
 * `collapseElongation`; a base word whose elongated letter is DOUBLED
 * ("good", "cool") is only reconstructed correctly by this one — and nothing
 * about a bare run of repeated letters in the MESSAGE says which case a
 * given word is, since both look like the exact same run once elongated.
 * The two-letter, three-letter, ... possibilities beyond that are not
 * covered (there is no English word this plugin's evidence lists need with
 * three genuine copies of a letter), so two forms is where this stops.
 *
 * EVERY caller that uses `collapseElongation` for word-list matching must
 * also try this one and accept a match on EITHER — see its own doc comment.
 * A token with no elongation at all (no run of 3+) is untouched by both, so
 * checking both forms is always safe for ordinary text: it can only ever add
 * a second candidate spelling, never remove the first.
 */
export function collapseElongationToPair(s: string): string {
    return s.replace(/(\p{L})\1{2,}/gu, "$1$1");
}

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
    "nah", "nope", "yeet", "bruh", "bro", "sus", "af", "ffs", "istg", "tldr",
    // Added alongside collapseElongation: these are the words a real
    // elongated interjection ("yesssss", "waiiiiiit", "helloooooo", ...)
    // collapses down to, matched below via `every` over the collapsed tokens.
    // Every entry here is a plain English (or, for "sh"/"hmm"/"ah"/"oh",
    // near-universal onomatopoeic) interjection, and only fires when the
    // WHOLE short message is nothing but these — the same discipline as
    // every other entry in this set.
    //
    // "no" is deliberately NOT here despite being an obvious-looking
    // candidate: detectLang.ts excludes it from ENGLISH_WORDS/FOREIGN_WORDS
    // for the same reason (Portuguese/Spanish also spell a real word "no"),
    // and a standalone "no" is exactly the short, ambiguous case where that
    // collision could silently drop a foreign message.
    "yes", "wait", "hello", "hmm", "ah", "oh", "yay", "wow", "lmao", "sh",
    // "good"/"morning" so a plain or elongated "good morning" resolves
    // entirely through this set: two tokens, both members, no non-shorthand
    // word to keep it out. No "god" entry needed alongside "good": trying
    // BOTH collapsed forms below (see collapseElongationToPair) already
    // reconstructs "good" correctly from "goooooood" — a collapse-artefact
    // entry that only existed to paper over trying one form was removed once
    // the real fix landed.
    "good", "morning"
]);

function isChatShorthand(s: string): boolean {
    // Bare numbers survive punctuation stripping ("u2 <2" becomes "u2 2") and
    // carry no meaning of their own, so they neither qualify nor disqualify.
    const tokens = s.toLowerCase().split(/\s+/).filter(t => t && !/^\d+$/.test(t));
    if (tokens.length === 0 || tokens.length > 4) return false;
    // BOTH collapsed forms are tried, and a token counts if EITHER is a known
    // word — see collapseElongation/collapseElongationToPair's own comments
    // for why one form alone gets a base word with a doubled letter
    // ("good", "cool") wrong. A token with no elongation is untouched by
    // both, so this is exactly as strict as a plain lookup for ordinary text.
    return tokens.every(t =>
        CHAT_SHORTHAND.has(collapseElongation(t)) || CHAT_SHORTHAND.has(collapseElongationToPair(t))
    );
}

export function shouldSkip(text: string, isOwnMessage: boolean): boolean {
    if (isOwnMessage) return true;

    // Anything left that is only digits, punctuation, whitespace, or combining
    // marks carries no translatable meaning.
    const stripped = stripMarkup(text, "")
        .replace(/[\p{Nd}\p{P}\p{S}\p{M}\s]/gu, "");

    if (stripped.length === 0) return true;

    // Noise checks run on the ORIGINAL text with punctuation removed but
    // whitespace kept, so token structure survives ("GOJ GOJ GOJ" must stay
    // three tokens) while "jaja!!!" and "jaja" collapse to the same thing.
    const words = stripMarkup(text, " ")
        .replace(/[\p{P}\p{S}\p{M}]/gu, "")
        .trim();

    if (isChatShorthand(words)) return true;
    if (isRepeatedToken(words)) return true;
    if (LAUGHTER.test(words.replace(/\s+/g, ""))) return true;

    return false;
}
