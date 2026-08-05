/**
 * Languages normally written in a non-Latin script. If one of these is
 * detected from text containing no non-Latin letters at all, the input was
 * romanized — and Google's answer for it cannot be trusted.
 *
 * Not exhaustive, and does not need to be: a language missing from this list
 * costs an unflagged line, exactly as today. Adding one is free.
 */
const NON_LATIN_SCRIPT = new Set([
    "ar", "fa", "ur", "ps", "sd", "ug", "he", "yi",
    "ru", "uk", "be", "bg", "sr", "mk", "kk", "ky", "mn", "tg",
    "el", "hy", "ka", "am", "ti",
    "hi", "bn", "pa", "gu", "or", "ta", "te", "kn", "ml", "si", "ne", "mr", "sa",
    "th", "lo", "km", "my", "bo", "dv",
    "zh", "ja", "ko", "yue"
]);

const LETTER = /\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * True when `detectedLang` is normally non-Latin but `originalText` is written
 * entirely in Latin letters.
 *
 * This is the signal detection confidence cannot give us. Measured: Google
 * reports 1.00 confidence on romanized Moroccan Darija while inverting a
 * negation, so a low-confidence check stays silent on precisely the output most
 * likely to mislead. Script mismatch is independent of confidence and catches
 * that class directly.
 *
 * A code that names its own script ("ber-Latn") is taken at its word.
 *
 * Requires at least one Latin LETTER before returning true. Without this,
 * text with no letters at all (empty, digits-only, emoji-only) never hits
 * the disqualifying `return false` below and falls through to `true` —
 * "romanized" text that has no Latin letters in it either. Nothing upstream
 * makes that unreachable in principle; `index.tsx` merely happens never to
 * call this with empty content today.
 */
export function isRomanizedGuess(detectedLang: string, originalText: string): boolean {
    const base = detectedLang.toLowerCase().split("-")[0];
    if (detectedLang.toLowerCase().includes("-latn")) return false;
    if (!NON_LATIN_SCRIPT.has(base)) return false;

    let sawLatinLetter = false;
    for (const ch of originalText) {
        if (!LETTER.test(ch)) continue;
        if (!LATIN_LETTER.test(ch)) return false;
        sawLatinLetter = true;
    }
    return sawLatinLetter;
}
