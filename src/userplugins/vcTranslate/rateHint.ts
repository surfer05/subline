/**
 * Best-effort extraction of a server-provided retry hint, in milliseconds, so
 * native.ts's 429 backoff can use the API's own number instead of always
 * falling back to a guessed constant.
 *
 * Two known shapes, both optional — either can be absent, in which case the
 * caller falls back to its own default:
 *  - A `Retry-After` HTTP header (RFC 7231 section 7.1.3), as a delay in
 *    seconds. Only the delay-seconds form is parsed; the alternative
 *    HTTP-date form is not something any engine here has been observed to
 *    send, and parsing a date correctly (clock skew, timezone) is more
 *    machinery than a "best effort, else fall back" hint justifies.
 *  - Gemini's error body: `error.details[]` may contain an entry shaped like
 *    google.rpc.RetryInfo, carrying a `retryDelay` string such as "13s" or
 *    "1.5s". HTTP responses in general do not carry this; it is
 *    Gemini-specific, hence the separate function.
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

export function retryAfterFromGeminiBody(body: unknown): number | undefined {
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
