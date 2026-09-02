export type EngineId = "google" | "claude" | "gemini" | "groq";

/**
 * The Gemini model the quality tier asks for unless the user overrides it in
 * settings (see `geminiModel` in settings.ts).
 *
 * MEASURED, not chosen from a docs page. Probed side by side against one real
 * free-tier key, same endpoint, same instant:
 *
 *   gemini-2.5-flash       200 — works
 *   gemini-3.6-flash       429 quota exceeded, at ANY rate
 *   gemini-2.5-pro         429 quota exceeded, at ANY rate
 *   gemini-2.5-flash-lite  404 no longer available
 *   gemini-3-flash         404 not found
 *   gemini-2.0-flash       500
 *
 * The previous default was `gemini-3.6-flash`, which has no free-tier
 * allowance on that key at all: it returned 429 on the FIRST request of a
 * session, so every rate-limiting mechanism in this plugin was throttling
 * against a wall that was never a rate limit, and no LLM translation ever
 * reached the screen.
 *
 * Lives here, in the module both the renderer (settings.ts) and the native
 * side (engines/gemini.ts) already import, so the setting's default and the
 * request's fallback are the same string by construction.
 *
 * WHICH MODEL IS FREE MOVES UNDER US — that table is a snapshot, not a
 * contract. That is precisely why the model is a SETTING: a user whose ✦
 * upgrades stop can change it without waiting for a rebuild.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/**
 * The Groq model the quality tier asks for unless the user overrides it in
 * settings (see `groqModel` in settings.ts).
 *
 * A SETTING FROM DAY ONE, and the reason is the paragraph above this one. The
 * plugin shipped for a week pinned to a Gemini model the key had zero quota
 * for; the symptom was a 429 on every request, which reads as throttling, and
 * the only cure was a rebuild. That is not a mistake worth making twice on a
 * new provider, so Groq's model is user-changeable before its first request
 * has ever been sent.
 *
 * `llama-3.3-70b-versatile` is Groq's general-purpose free-tier chat model at
 * the time of writing. NOT MEASURED against a live key — there is no Groq key
 * on this machine yet — which is precisely why this is a default rather than a
 * constant: WHICH MODEL IS FREE MOVES UNDER US, on this provider exactly as it
 * did on the last one, and the user must be able to move with it from the
 * settings page.
 *
 * Lives here, in the module both the renderer (settings.ts) and the native
 * side (engines/groq.ts) already import, so the setting's default and the
 * request's fallback are the same string by construction.
 */
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

/**
 * Models this provider has retired, and which no request can any longer reach.
 *
 * WHY A LIST AND NOT JUST A NEW DEFAULT. The model is a persisted SETTING, so a
 * new default reaches nobody who has already installed: their settings.json
 * still names the dead model, every request 404s or 400s, and the plugin falls
 * back to Google with no explanation the user could act on. Changing the
 * default alone would have fixed this for new installs only — which is the
 * smaller half of the problem.
 *
 * Groq announced Llama 3.3 70B Versatile's decommission for 2026-08-16.
 *
 * Read by `effectiveGroqModel`: a stored value on this list is treated as
 * absent, so the current default is used instead and the user's own choice of
 * any LIVE model is still respected.
 */
export const RETIRED_GROQ_MODELS: readonly string[] = [
    "llama-3.3-70b-versatile"
];

/**
 * The model a request should actually use.
 *
 * Blank falls back for the reason the old comment gave — sending `"model": ""`
 * is a 400 on every request. A RETIRED model falls back for a newer reason:
 * it is a value the user never chose so much as inherited from a default that
 * has since died, and leaving them on it means a plugin that silently stopped
 * doing the one thing they installed it for.
 */
export function effectiveGroqModel(stored?: string): string {
    const trimmed = typeof stored === "string" ? stored.trim() : "";
    if (trimmed === "") return DEFAULT_GROQ_MODEL;
    if (RETIRED_GROQ_MODELS.includes(trimmed)) return DEFAULT_GROQ_MODEL;
    return trimmed;
}

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
    // `transport` marks a failure that never REACHED a verdict: a 429 that
    // survived the retry, a 5xx, a network drop, for THIS message while its
    // batch-mates went through. It is a fact about the moment, not the
    // message, and runTier renders it as "waiting" rather than "failed" —
    // the same transport-vs-verdict split the batch level already has.
    | { id: string; failed: true; transport?: true };

/**
 * What each engine can do, and — via `hasOwnProperty` in store.ts's
 * isKnownEngine — the single runtime list of which engine ids exist at all.
 *
 * `supportsContext` is READ, by rebuildBatcher() in index.tsx, for both tiers.
 * That matters: a capability table nothing consults is a comment pretending to
 * be code, and the two tiers hardcoding their own values is exactly how this
 * table would come to disagree with the batchers it describes.
 */
export const ENGINE_CAPS: Record<EngineId, { supportsContext: boolean }> = {
    google: { supportsContext: false },
    claude: { supportsContext: true },
    gemini: { supportsContext: true },
    groq: { supportsContext: true }
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
 * The fast tier: Google, with NO debounce window. This is what the reader
 * actually sees first, so every millisecond here is stare time.
 *
 * WHY ZERO. The old 700ms window existed "to make fewer tiny HTTP calls" —
 * a premise that was never true: engines/google.ts sends ONE request PER
 * MESSAGE whatever the batch size (its own concurrency cap does the rate
 * shaping), so holding messages back reduced what Google receives by exactly
 * nothing. The window bought no requests and cost 700ms on every ≈ line —
 * more than half the observed end-to-end latency.
 *
 * What the window WAS doing usefully — coalescing catch-up's backlog into one
 * flush — a zero timer still does: catch-up enqueues synchronously in a loop
 * and setTimeout(0) fires after it, so the whole backlog lands in one batch
 * (pinned by "coalesces a synchronous burst" in index.test.ts). Messages
 * arriving over the network seconds apart flush separately, which is the same
 * number of Google requests either way.
 *
 * Also the quality tier's window while Google is cooling down (see
 * rebuildBatcher): in that state the LLM is the reader's only translator and
 * the same argument applies — the rate gate, not a window, is what protects
 * the quota.
 */
export const FAST_DEBOUNCE_MS = 0;
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
