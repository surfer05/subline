export type EngineId = "google" | "claude" | "gemini";

export interface PendingMessage {
    id: string;
    author: string;
    text: string;
    channelId: string;
    /**
     * The message this one replies to, when Discord says it is a reply.
     * Carried so the Google path can borrow the parent's already-detected
     * language for texts too short to detect on their own — see `sourceLang`.
     */
    replyToId?: string;
}

export interface BatchRequest {
    messages: {
        id: string;
        author: string;
        text: string;
        replyToId?: string;
        /**
         * Pins Google's `sl` instead of letting it auto-detect. Set only for
         * short texts whose reply-parent was itself detected confidently. The
         * LLM engines ignore it: conversation context already tells them more
         * than one language code could.
         */
        sourceLang?: string;
    }[];
    context: { author: string; text: string }[];
    targetLang: string;
}

/**
 * Below this, Google's own detection confidence is not worth acting on.
 *
 * Measured against the live endpoint, not guessed. Every misdetection observed
 * in real chat sat under it and every correct one sat well above:
 *
 *   "ne"   -> ha 0.217  "it is"       (German: "no"  — the OPPOSITE)
 *   "klar" -> da 0.378  "clear"
 *   "ja"   -> et 0.446  "and"         (German: "yes")
 *   "nö"   -> et 0.609  "so-called"   (German: "nope")
 *   "ok"                -> en 0.912   correct
 *   "ok dann brauch..." -> de 0.987   correct
 *   "sind die gruppen..." / "hola que tal" -> 1.0  correct
 *
 * Short conversational replies are both the hardest to detect and the ones
 * where being wrong inverts the meaning, so they matter more than their length
 * suggests.
 */
export const MIN_DETECT_CONFIDENCE = 0.85;

/**
 * Texts at or below this length are the ones auto-detection gets wrong (see
 * the table above — every failure was 4 characters or fewer). Only these
 * borrow a reply-parent's language, which bounds the blast radius of the
 * borrow being wrong: a long message in a genuinely different language still
 * gets detected on its own merits.
 */
export const SHORT_TEXT_MAX = 12;

// `failed` is the per-message failure variant: it lets a batch return a real
// answer for the messages that worked and an explicit marker for the ones that
// did not, instead of the whole batch being all-or-nothing (or, worse, a
// message silently vanishing from the results with no marker at all — the
// renderer would then show nothing forever and re-request it on every open).
// It mirrors `StoredTranslation`'s `{ failed: true }` shape in store.ts.
export type Result =
    // `conf` is Google's own detection confidence, passed through so the
    // renderer can mark a translation it should not be trusted. Absent for the
    // LLM engines (they report no such number) and absent when `sourceLang`
    // pinned the language, because then nothing was detected to be unsure of.
    | { id: string; lang: string; text: string; skip: false; conf?: number }
    | { id: string; skip: true }
    | { id: string; failed: true };

export const ENGINE_CAPS: Record<EngineId, { supportsContext: boolean }> = {
    google: { supportsContext: false },
    claude: { supportsContext: true },
    gemini: { supportsContext: true }
};

/**
 * True when a translation is indistinguishable from its source, so there is
 * nothing worth rendering. Engines pass text through unchanged when they
 * misdetect the language — Google reads "hbu" as Frisian and "u2 <2" as
 * Chinese — and the detected-language check cannot catch that, because the
 * bogus detection is not the target language either.
 *
 * Compares case-insensitively with whitespace collapsed, so a translation
 * differing only in spacing or capitalisation still counts as no translation.
 */
export function isSameText(a: string, b: string): boolean {
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    return norm(a) === norm(b);
}

/**
 * The fast tier: Google, on a short window. Free and unmetered, so the only
 * thing being traded off is how many tiny HTTP calls we make — hence a small
 * batch and a short wait. This is what the reader actually sees first.
 */
export const FAST_DEBOUNCE_MS = 700;
export const FAST_MAX_BATCH = 10;

/**
 * The quality tier: the configured LLM, on a long window.
 *
 * 20s is chosen against a MEASURED limit of 20 requests per rolling minute.
 * The batcher flushes on a fixed window from the first queued message, so the
 * window alone caps a single channel at 3 requests/minute; in a busy channel
 * the 25-message batch cap flushes sooner, at roughly 2-3 requests/minute for
 * 60 messages/minute of chat. Either way it sits an order of magnitude under
 * the ceiling, which is the entire point — the previous 3s window produced up
 * to 20 requests/minute and sat exactly ON the ceiling.
 *
 * The reader does not wait on this: the fast tier has already put a subtitle
 * on screen. This window only decides how long the line stays Google's.
 */
export const QUALITY_DEBOUNCE_MS = 20_000;
export const QUALITY_MAX_BATCH = 25;
