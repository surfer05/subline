/**
 * Best-effort extraction of the numbers a rate-limit response carries about
 * itself — how long to wait, and what the quota ceiling actually is — so the
 * cooldown and the rate gate can use the API's own figures instead of a
 * guessed constant.
 *
 * Three shapes, all optional; each caller falls back to its own default when
 * nothing is found:
 *  - A `Retry-After` HTTP header (RFC 7231 section 7.1.3), as a delay in
 *    seconds. Only the delay-seconds form is parsed; the alternative
 *    HTTP-date form is not something any engine here has been observed to
 *    send, and parsing a date correctly (clock skew, timezone) is more
 *    machinery than a "best effort, else fall back" hint justifies.
 *  - Gemini's error body, PRIMARY path: the delay is embedded in the prose of
 *    `error.message`, as "Please retry in 551.874307ms." A real captured 429
 *    from the live API looks like this and carries no structured field at all:
 *
 *      {"error":{"code":"too_many_requests","message":"You exceeded your
 *       current quota, ... * Quota exceeded for metric:
 *       generativelanguage.googleapis.com/generate_content_free_tier_requests,
 *       limit: 20, model: gemini-3.6-flash Please retry in 551.874307ms."}}
 *
 *    Note `error.code` is the STRING "too_many_requests", not a number, and
 *    there is no `details` array — the previously-only path found nothing on
 *    every real response.
 *  - Gemini's error body, SECONDARY path: `error.details[]` may contain an
 *    entry shaped like google.rpc.RetryInfo carrying a `retryDelay` string
 *    such as "13s" or "1.5s". Other Google APIs do send this, and retaining it
 *    costs nothing, so it stays as a fallback behind the message-text parse.
 *
 * The same `error.message` prose also states the quota itself ("limit: 20").
 * quotaLimitFromGeminiBody() reads it so the rate gate can retune to the real
 * ceiling rather than a hardcoded guess.
 *
 * A FOURTH shape lives at the bottom of this file, kept deliberately apart
 * from the three above: the `x-ratelimit-*` headers an OpenAI-compatible
 * service (Groq) sends on EVERY response, successes included. The three above
 * are salvage from a rejection; those are a running readout. Nothing generic
 * is shared between them — the prose parsing above is Google's format and must
 * never be pointed at another provider's response.
 */

/** Minimal structural type: real fetch() Headers, or any test double with `.get`. */
interface HeaderSource {
    headers?: { get?(name: string): string | null; } | null;
}

export function retryAfterFromHeader(res: HeaderSource): number | undefined {
    const value = res.headers?.get?.("retry-after");
    if (typeof value !== "string" || value.trim() === "") return undefined;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.round(seconds * 1000);
}

/**
 * "Please retry in 551.874307ms." / "please retry in 13s".
 *
 * The trailing `\b` is what keeps "13sec" from being read as 13 seconds, while
 * still matching a delay that ends the sentence ("...551.874307ms."). Both
 * units are accepted because the message text is prose, not a contract: the
 * captured real response used `ms`, the RetryInfo field uses `s`, and nothing
 * promises which one a future response picks.
 */
const RETRY_IN_RE = /retry\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i;

/**
 * "limit: 20" — the quota the API says applies to us. A sub-second retry hint
 * alongside it means the window is a MINUTE, not a day: a daily cap could not
 * roll over in half a second.
 */
const QUOTA_LIMIT_RE = /\blimit:\s*(\d+)\b/i;

/**
 * "model: gemini-3.6-flash" — the model the quota was enforced AGAINST.
 *
 * Worth extracting because a 429 naming a model is not necessarily a rate
 * limit at all: a free-tier key with no allowance for that particular model
 * returns one on the FIRST request of a session, at any rate, forever. That is
 * a settings problem, and it is indistinguishable from throttling unless the
 * model name survives as far as the user (see index.tsx's cooldown toast).
 *
 * The character class stops at the space before "Please retry in ...", and
 * bounds what can reach a toast to model-name characters — the value is lifted
 * out of a remote response, so it is quoted into UI text and must not be able
 * to carry arbitrary prose along with it.
 */
const QUOTA_MODEL_RE = /\bmodel:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})/i;

/** `error.message` as a string, or undefined if the body isn't that shape. */
function errorMessageText(body: unknown): string | undefined {
    if (body === null || typeof body !== "object") return undefined;
    const error = (body as { error?: unknown }).error;
    if (error === null || typeof error !== "object") return undefined;
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
}

/** PRIMARY: the delay stated in the prose of `error.message`. */
function retryAfterFromErrorMessage(body: unknown): number | undefined {
    const message = errorMessageText(body);
    if (message === undefined) return undefined;

    const m = RETRY_IN_RE.exec(message);
    if (!m) return undefined;

    const value = Number(m[1]);
    if (!Number.isFinite(value) || value < 0) return undefined;
    // Fractional milliseconds are real ("551.874307ms") and meaningless to a
    // setTimeout, so round to whole milliseconds either way.
    return Math.round(m[2].toLowerCase() === "ms" ? value : value * 1000);
}

/** SECONDARY: google.rpc.RetryInfo in `error.details[]`. */
function retryAfterFromRetryInfo(body: unknown): number | undefined {
    if (body === null || typeof body !== "object") return undefined;
    const error = (body as { error?: unknown }).error;
    if (error === null || typeof error !== "object") return undefined;
    const details = (error as { details?: unknown }).details;
    if (!Array.isArray(details)) return undefined;

    for (const d of details) {
        if (d === null || typeof d !== "object") continue;
        const delay = (d as { retryDelay?: unknown }).retryDelay;
        if (typeof delay !== "string") continue;
        const m = /^(\d+(?:\.\d+)?)s$/.exec(delay.trim());
        if (m) return Math.round(Number(m[1]) * 1000);
    }
    return undefined;
}

export function retryAfterFromGeminiBody(body: unknown): number | undefined {
    // Message text first: that is the shape every real 429 has been observed
    // to use. RetryInfo is kept behind it for the other Google APIs that do
    // send it.
    return retryAfterFromErrorMessage(body) ?? retryAfterFromRetryInfo(body);
}

/**
 * The requests-per-minute ceiling the API reports for us, when it says so.
 *
 * Used to retune the rate gate (see rateGate.ts). Deliberately not defaulted
 * here: "no number stated" and "the number is 0" must stay distinguishable, so
 * the caller keeps its own default.
 */
export function quotaLimitFromGeminiBody(body: unknown): number | undefined {
    const message = errorMessageText(body);
    if (message === undefined) return undefined;

    const m = QUOTA_LIMIT_RE.exec(message);
    if (!m) return undefined;

    const limit = Number(m[1]);
    if (!Number.isFinite(limit) || limit <= 0) return undefined;
    return limit;
}

/**
 * The model a quota message names, when it names one. See QUOTA_MODEL_RE:
 * this is what lets the renderer say "THIS MODEL is out of quota, try another"
 * instead of "you are being rate limited", which is the same sentence a user
 * sees on every launch when the real problem is that their key cannot call the
 * configured model at all.
 */
export function modelFromGeminiBody(body: unknown): string | undefined {
    const message = errorMessageText(body);
    if (message === undefined) return undefined;

    const m = QUOTA_MODEL_RE.exec(message);
    return m ? m[1] : undefined;
}

/* ------------------------- OpenAI-compatible rate-limit response headers -- */

/**
 * What an OpenAI-compatible service says about our remaining allowance, on
 * EVERY response — including successful ones.
 *
 * THIS IS INFORMATION THE GEMINI PATH NEVER HAD. Everything above this line is
 * salvaged from a FAILURE: the numbers only exist once we have already been
 * rejected. An OpenAI-compatible provider (Groq) states the remaining request
 * count on every 200, which is what makes it possible for the chat-bar quota
 * indicator to report the PROVIDER's own remaining quota rather than this
 * plugin's internal token bucket — a real defect, because the bucket can read
 * "3 available" while the provider refuses the very next request instantly.
 *
 * Deliberately NOT folded into the Gemini helpers above and deliberately NOT
 * applied to Gemini/Claude responses: those parse Google's error PROSE, which
 * is specific to that provider and means nothing here. These read named
 * headers, which is a different contract entirely, and an engine opts in by
 * calling this.
 */
export interface ProviderRateLimit {
    /** `x-ratelimit-remaining-requests` — requests left in the current window. */
    remainingRequests?: number;
    /**
     * `x-ratelimit-limit-requests` — the window's ceiling.
     *
     * CAPTURED BUT NEVER FED TO THE RATE GATE AS A PER-MINUTE QUOTA. On Groq
     * this header is the requests-per-DAY figure (1,000-14,400 on the free
     * tier), not the per-minute one, so handing it to
     * `tuneRateGateToObservedLimit()` — which takes a per-MINUTE ceiling —
     * would open the gate to thousands of requests a minute and disable the
     * only protection this plugin has. It is kept because it is what makes the
     * remaining count interpretable to a human reading a tooltip ("12 of
     * 14,400"), and for no other purpose.
     */
    limitRequests?: number;
    /** `x-ratelimit-reset-requests`, in milliseconds — when the window rolls over. */
    resetRequestsMs?: number;
}

/**
 * One `<number><unit>` term of a Go-style duration ("2m59.56s", "7.66s",
 * "35ms"). Sticky, so `parseResetDuration` can require that the WHOLE string
 * is terms and nothing else — a value we only half-understood would be worse
 * than one we rejected, because it would be silently wrong rather than absent.
 *
 * `ms` precedes `m` in the alternation on purpose: alternation is ordered, so
 * putting `m` first would read "35ms" as 35 MINUTES and leave a stray "s",
 * which is a 60,000x error in the direction of "do not send anything for an
 * hour".
 */
const DURATION_TERM_RE = /(\d+(?:\.\d+)?)(ms|h|m|s)/y;

const DURATION_UNIT_MS: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000
};

/**
 * "2m59.56s" / "7.66s" / "35ms" / "60" → milliseconds.
 *
 * A bare number is accepted as SECONDS, matching `Retry-After`'s own
 * delay-seconds form — some OpenAI-compatible services send one. Anything
 * this cannot read in full returns undefined rather than a partial reading.
 */
export function parseResetDuration(value: string): number | undefined {
    const text = value.trim();
    if (text === "") return undefined;

    // Bare seconds, e.g. "60" or "0.5".
    if (/^\d+(?:\.\d+)?$/.test(text)) {
        const seconds = Number(text);
        return Number.isFinite(seconds) ? Math.round(seconds * 1_000) : undefined;
    }

    DURATION_TERM_RE.lastIndex = 0;
    let total = 0;
    let terms = 0;
    // Tracked here rather than read off `lastIndex` afterwards: a sticky regex
    // RESETS lastIndex to 0 on the failed match that ends the loop, so reading
    // it after the loop reports zero characters consumed for every input,
    // valid or not.
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = DURATION_TERM_RE.exec(text)) !== null) {
        total += Number(match[1]) * DURATION_UNIT_MS[match[2]];
        consumed = match.index + match[0].length;
        terms++;
    }
    // Sticky matching starts at the previous end, so requiring the whole
    // string to be consumed rejects both trailing garbage ("5s later") and a
    // unit we do not know ("5d").
    if (terms === 0 || consumed !== text.length) return undefined;
    if (!Number.isFinite(total) || total < 0) return undefined;
    return Math.round(total);
}

/** A header as a non-negative count, or undefined if it is not one. */
function countHeader(res: HeaderSource, name: string): number | undefined {
    const value = res.headers?.get?.(name);
    if (typeof value !== "string" || value.trim() === "") return undefined;
    const n = Number(value);
    // Fractional and negative counts are not counts. `0` IS meaningful and must
    // survive — "no requests left" is the single most important thing these
    // headers can say.
    if (!Number.isSafeInteger(n) || n < 0) return undefined;
    return n;
}

/**
 * The rate-limit headers of an OpenAI-compatible response, or undefined when
 * the response carried none of them.
 *
 * Undefined rather than an empty object, so a caller can tell "this provider
 * reports nothing" (Gemini, Claude) apart from "this provider reports zero
 * remaining" without inspecting field-by-field.
 */
export function rateLimitFromHeaders(res: HeaderSource): ProviderRateLimit | undefined {
    const remainingRequests = countHeader(res, "x-ratelimit-remaining-requests");
    const limitRequests = countHeader(res, "x-ratelimit-limit-requests");

    const rawReset = res.headers?.get?.("x-ratelimit-reset-requests");
    const resetRequestsMs = typeof rawReset === "string"
        ? parseResetDuration(rawReset)
        : undefined;

    if (
        remainingRequests === undefined
        && limitRequests === undefined
        && resetRequestsMs === undefined
    ) {
        return undefined;
    }
    return { remainingRequests, limitRequests, resetRequestsMs };
}
