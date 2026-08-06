import { collapseElongation, stripMarkup } from "./skip";

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
 * Lowercased word tokens, with markup, punctuation and bare numbers removed,
 * and elongated letters collapsed — "sooooo good" tokenizes as ["so", "good"]
 * rather than ["sooooo", "good"], so an elongated word inside a longer
 * sentence still counts as ENGLISH_WORDS evidence. Applied AFTER lowercasing
 * (collapseElongation's backreference is exact-character, so a mixed-case run
 * would not collapse) and on the whole string rather than per-token: runs
 * never cross a token boundary anyway, since whatever separates two tokens is
 * itself not a letter. See collapseElongation's own doc comment for why 3+
 * is the safe threshold and why this cannot manufacture a false match on its
 * own — only ENGLISH_WORDS itself can do that, which is why nothing is added
 * there for this change (see the module doc comment's asymmetry).
 */
function tokenize(text: string): string[] {
    return collapseElongation(stripMarkup(text, " ").toLowerCase())
        // Apostrophes are dropped rather than split on, so "don't" matches the
        // "dont" entry instead of becoming the junk tokens "don" and "t".
        .replace(/['’]/g, "")
        .split(/[^\p{L}\p{Nd}]+/u)
        // Bare numbers are neither evidence nor counter-evidence, and counting
        // them would drag the English ratio down on messages full of scores.
        .filter(t => t !== "" && !/^\d+$/.test(t));
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
    if (tokens.length < MIN_TOKENS) return false;

    if (tokens.some(t => FOREIGN_WORDS.has(t))) return false;

    let hits = 0;
    for (const t of tokens) if (ENGLISH_WORDS.has(t)) hits++;

    if (hits < MIN_ENGLISH_HITS) return false;
    return hits / tokens.length >= MIN_ENGLISH_RATIO;
}
