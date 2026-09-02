import { collapseElongation, collapseElongationToPair, stripMarkup } from "./skip";

/**
 * A local, free "this message is already in the target language" check, run
 * before anything is handed to an engine.
 *
 * WHY THIS EXISTS: the Gemini free tier gives on the order of tens of usable
 * requests per day (observed: ~40 successes against ~50 429s in a single day).
 * In an English-majority server most traffic is already English, so without a
 * local check every "yess", "gl hf", and English paragraph costs a request to
 * learn nothing.
 *
 * THE ASYMMETRY IS THE WHOLE DESIGN, and every threshold below is set by it:
 *
 *   - A FALSE NEGATIVE (returning false for a message that really was English)
 *     costs exactly one wasted request. The user never notices.
 *   - A FALSE POSITIVE (returning true for a message that was NOT English)
 *     means a foreign message is silently never translated — no subtitle, no
 *     error, no marker. The user cannot even know there was something to ask
 *     about, so they cannot ask.
 *
 * Those two are not remotely equal, so this function is biased hard toward
 * returning false. "No signal either way" always means false. When adding to
 * the veto lists below, no justification is needed — a broader veto can only
 * ever cost a request. When adding to the ENGLISH_WORDS evidence list, be
 * certain: that is the list that can silently lose a translation.
 */

/**
 * Latin-script characters that are strong evidence of a Romance/Germanic
 * language other than English, plus Spanish's inverted punctuation.
 *
 * Deliberately includes characters that DO turn up in English loanwords
 * ("café", "naïve", "über") — that costs one request and is the safe
 * direction. Extend freely.
 */
const FOREIGN_CHARS = /[ñáéíóúüçãõàèìòùâêîôûäöß¿¡]/i;

/**
 * Whole tokens that are common function words in a language that is not
 * English. Any one of them vetoes the whole message.
 *
 * The core Spanish set is the one the user actually sees in their server;
 * Portuguese, French, German and Italian entries are here because the veto is
 * free in the direction that matters. Anything ALSO an English word is
 * deliberately excluded (no "no", "todo", "sin", "ya", "come", "son", "so") —
 * not because a veto there would be dangerous, but because it would waste
 * requests on ordinary English chat for no gain.
 */
const FOREIGN_WORDS = new Set([
    // Spanish
    "que", "de", "la", "el", "y", "en", "es", "por", "para", "con", "una",
    "los", "las", "pero", "como", "esta", "muy", "del", "al", "se", "lo",
    "tambien", "porque", "cuando", "donde", "quien", "nada", "bien", "mas",
    "sobre", "entre", "hasta", "desde", "eso", "esto", "este", "ese", "ser",
    "estar", "tiene", "tengo", "hacer", "puede", "vamos", "gracias", "hola",
    "adios", "si", "tu", "su",
    // Portuguese
    "nao", "voce", "obrigado", "eu", "meu", "isso", "sim",
    // German
    "ich", "nicht", "und", "ist", "das", "der", "dass", "ein", "eine", "mit",
    "auch", "aber", "oder", "wir", "ihr", "sehr",
    // French
    "je", "ne", "pas", "oui", "bonjour", "merci", "mais", "avec", "pour",
    "tout", "vous", "nous",
    // Italian
    "che", "non", "sono", "anche", "perche", "questo", "molto", "grazie",
    "ciao"
]);

/**
 * Positive evidence that a message is English. Absence of foreign markers is
 * NOT evidence — "yess" and "THIS" have no foreign markers and are not
 * classifiable, so they must come back false.
 *
 * The core is the common English function words; the rest are the everyday
 * chat words that make real messages like "hello everyone good luck"
 * classifiable at all. Every entry was checked against the veto languages
 * above: nothing here is also a common word in Spanish, Portuguese, French,
 * German or Italian ("come", "no", "so", "son", "man", "die", "war" are all
 * deliberately absent for that reason).
 */
const ENGLISH_WORDS = new Set([
    // The core function words.
    "the", "and", "is", "are", "was", "to", "of", "in", "for", "that", "you",
    "it", "we", "he", "she", "they", "this", "with", "have", "has", "not",
    "but", "on", "at", "my", "your",
    // Contractions, apostrophes stripped before lookup.
    "i", "im", "dont", "cant", "didnt", "doesnt", "isnt", "its", "thats",
    "youre", "theyre", "were", "ive", "wont",
    // Everyday verbs and modals.
    "be", "been", "am", "do", "does", "did", "can", "will", "would", "should",
    "could", "get", "got", "go", "going", "gonna", "wanna", "know", "think",
    "want", "need", "make", "see", "say", "said", "take", "let", "lets",
    "work", "play", "help",
    // Question words and connectives.
    "what", "when", "where", "why", "how", "who", "from", "out", "up",
    "about", "there", "here", "now", "then", "than", "because", "if", "or",
    "after", "before", "into", "over", "under", "still", "never", "always",
    "just", "only", "also", "even", "much", "many", "some", "any", "other",
    "every", "all", "more", "most",
    // Pronouns and possessives not already covered.
    "me", "us", "him", "her", "his", "our", "their", "them",
    // Common chat content words — these are what make short real messages
    // like "hello everyone good luck" classifiable at all.
    "hello", "everyone", "everything", "something", "nothing", "good",
    "luck", "love", "thanks", "thank", "please", "sorry", "really", "people",
    "time", "back", "guys", "game", "server", "right", "wrong", "well",
    "first", "last", "next", "new", "old", "best", "better", "one"
]);

/**
 * Thresholds. All three exist to keep "no signal" from becoming a false
 * positive.
 *
 * MIN_TOKENS: a one- or two-word message cannot be confidently placed. This is
 * what makes "THIS" return false even though "this" is an English function
 * word, and it is why `yess` / `gl` / `ok` / `lol` are safe.
 *
 * MIN_ENGLISH_HITS: a single hit can be coincidence — plenty of languages
 * borrow an English word. Two independent hits are much harder to hit by
 * accident.
 *
 * MIN_ENGLISH_RATIO: guards the code-mixed case that hit-count alone misses.
 * "sorry po, hindi ko alam kung ano ang gagawin, thanks" has two English hits
 * and is not English; at 2/12 = 0.17 the ratio rejects it.
 */
const MIN_TOKENS = 3;

/**
 * Words safe to classify a SHORT message (fewer than MIN_TOKENS) on.
 *
 * A separate list from ENGLISH_WORDS, with a strictly harder admission rule,
 * because the two rules lean on their evidence differently. ENGLISH_WORDS
 * feeds a ratio over three-plus tokens, where one ambiguous entry is diluted
 * by the rest of the message; here EVERY token must match and there may be
 * only one, so a single entry that is also a word in a veto language
 * misclassifies whole messages by itself. "was" (German what), "die" (German
 * the), "is"/"in" (Dutch), "si" (Spanish yes) all sit safely in the ratio
 * rule's world and would each be a bug in this one. Nothing on this list may
 * be a word — function OR content — in any language the veto lists cover.
 *
 * WHY THE RULE EXISTS AT ALL: MIN_TOKENS made the gate abstain on one- and
 * two-word messages, and short messages are where chat lives. Measured on
 * 2026-09-02, a channel of "good luck!", "break", "helloo hellooo" wore
 * "⚠ translation failed" because every one of them cost a request the
 * throttled endpoints refused — for messages that never needed translating.
 */
const SHORT_MESSAGE_WORDS = new Set([
    "hello", "hi", "hey", "heya", "yo", "sup", "welcome", "bye", "goodbye",
    "good", "luck", "morning", "night", "evening", "afternoon",
    "thanks", "thank", "please", "sorry", "congrats", "congratulations",
    "guys", "yall", "everyone", "folks", "friends",
    "break", "nice", "cool", "great", "awesome", "amazing", "perfect",
    "love", "happy", "birthday", "wow", "damn", "same", "true", "right",
    "ready", "done", "wait", "stop", "help", "letsgo"
]);
const MIN_ENGLISH_HITS = 2;
const MIN_ENGLISH_RATIO = 0.25;

const LETTER = /\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * True if the text contains ANY letter outside the Latin script — Arabic, CJK,
 * Cyrillic, Greek, Hebrew, Devanagari, Thai and every other script, by
 * construction rather than by an enumerated list that would silently miss one.
 *
 * Deliberately zero-tolerance rather than "a meaningful proportion": one
 * Arabic word in an otherwise-English sentence means the message must be sent.
 * The cost of the strictness is a wasted request on an English message that
 * happens to contain a Greek "μ" or a Cyrillic homoglyph. That is the cheap
 * direction.
 */
function hasNonLatinLetter(text: string): boolean {
    for (const ch of text) {
        if (LETTER.test(ch) && !LATIN_LETTER.test(ch)) return true;
    }
    return false;
}

/**
 * Lowercased word tokens, with markup, punctuation and bare numbers removed.
 *
 * Deliberately NOT elongation-collapsed here: the collapse has TWO valid
 * outputs per token (see collapseElongation/collapseElongationToPair) and
 * only the two membership checks below know which set they're asking about,
 * so collapsing once at tokenize() time would have to commit to one form and
 * silently lose the other. Tokens stay raw; `matchesWord` below tries both
 * forms at each lookup instead. Token COUNT is unaffected either way — a run
 * of repeated letters never crosses a token boundary, since whatever
 * separates two tokens is itself not a letter — so `tokens.length`
 * (MIN_TOKENS, the English ratio) means the same thing regardless.
 */
function tokenize(text: string): string[] {
    return stripMarkup(text, " ")
        .toLowerCase()
        // Apostrophes are dropped rather than split on, so "don't" matches the
        // "dont" entry instead of becoming the junk tokens "don" and "t".
        .replace(/['’]/g, "")
        .split(/[^\p{L}\p{Nd}]+/u)
        // Bare numbers are neither evidence nor counter-evidence, and counting
        // them would drag the English ratio down on messages full of scores.
        .filter(t => t !== "" && !/^\d+$/.test(t));
}

/**
 * Does `token` match a word in `set`, once elongation is accounted for?
 *
 * Tries the token AS-IS first (the common case — most tokens have no
 * elongation at all, and both collapsed forms equal the raw token then
 * anyway, so this is not strictly required for correctness but is the
 * cheapest check and makes that common case explicit), then both collapsed
 * forms — see collapseElongation/collapseElongationToPair for why a base
 * word needs both tried: "yesssss" only matches via the collapse-to-one form
 * ("yes"), "goooooood" only matches via the collapse-to-two form ("good").
 *
 * THE ASYMMETRY STILL APPLIES, and trying two forms instead of one widens
 * the surface a foreign word could — in principle — collide with an English
 * one on. Nothing is added to ENGLISH_WORDS/FOREIGN_WORDS for this change:
 * the two forms only let a token find an entry that ALREADY exists, so a
 * false positive here still requires an entry that was independently vetted
 * against the veto languages when it was added.
 */
/** "helloo" -> "hello", "luckk" -> "luck": the final letter-run cut to one. */
function trimFinalRun(token: string): string {
    return token.replace(/(\p{L})\1+$/u, "$1");
}

/** "goodd" -> "good": the final letter-run cut to two, for genuine doubles. */
function trimFinalRunToPair(token: string): string {
    return token.replace(/(\p{L})\1+$/u, "$1$1");
}

function matchesWord(token: string, set: Set<string>): boolean {
    return set.has(token) || set.has(collapseElongation(token)) || set.has(collapseElongationToPair(token));
}

/**
 * True only when the text can be confidently placed in `targetLang` locally,
 * so no request needs to be spent on it.
 *
 * ONLY IMPLEMENTED FOR ENGLISH. Every other target returns false —
 * unconditionally, no partial credit. A heuristic tuned for English applied to
 * a language nobody reasoned about would produce exactly the failure this
 * whole file is written to avoid: silently dropped translations, invisible to
 * the user. No heuristic is strictly better than a wrong one here. Adding a
 * language means writing (and testing) its own evidence and veto sets.
 */
export function isConfidentlyTargetLanguage(text: string, targetLang: string): boolean {
    if (targetLang !== "en") return false;

    const stripped = stripMarkup(text, " ");

    // Script check first: it is the single most reliable signal, and it is
    // absolute. Any non-Latin letter at all and this is not English.
    if (hasNonLatinLetter(stripped)) return false;

    // Latin-script foreign markers.
    if (FOREIGN_CHARS.test(stripped)) return false;

    const tokens = tokenize(text);
    if (tokens.length === 0) return false;

    if (tokens.some(t => matchesWord(t, FOREIGN_WORDS))) return false;

    // Short messages: every token must be unambiguously English — a list with
    // a harder admission rule than the ratio evidence below, because there is
    // no surrounding message to dilute a wrong entry. All the vetoes above
    // have already run.
    //
    // The extra two forms handle elongation-by-ONE ("luckk", "helloo"), which
    // both shared collapses are blind to — they fire only on runs of 3+,
    // because collapsing every 2-run would corrupt genuine doubles ("good" →
    // "god"). Chat elongation is overwhelmingly final-letter, so trimming just
    // the FINAL run is safe where a global collapse is not: "helloo" → "hello"
    // leaves the genuine "ll" alone.
    if (tokens.length < MIN_TOKENS) {
        return tokens.every(t =>
            matchesWord(t, SHORT_MESSAGE_WORDS)
            || SHORT_MESSAGE_WORDS.has(trimFinalRun(t))
            || SHORT_MESSAGE_WORDS.has(trimFinalRunToPair(t))
        );
    }

    let hits = 0;
    for (const t of tokens) if (matchesWord(t, ENGLISH_WORDS)) hits++;

    if (hits < MIN_ENGLISH_HITS) return false;
    return hits / tokens.length >= MIN_ENGLISH_RATIO;
}
