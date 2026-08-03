/**
 * A REAL Gemini 429, captured verbatim against the live API.
 *
 * Not a hand-written approximation, and not covered by the config's
 * `tests/**\/*.test.ts` include — it is a fixture shared by rateHint.test.ts
 * and gemini.test.ts so both assert against the identical bytes and cannot
 * drift apart.
 *
 * The three things this response proves, all of which the previous parser got
 * wrong:
 *  - There is NO `Retry-After` header and NO `error.details[]` array. The only
 *    machine-readable delay is the "Please retry in 551.874307ms." at the end
 *    of the prose message.
 *  - The delay is sub-second and fractional, in MILLISECONDS.
 *  - `error.code` is the STRING "too_many_requests", not the number 429, so
 *    nothing should be keying off a numeric code here.
 *
 * String.raw is load-bearing: the message contains a literal backslash-n
 * escape INSIDE the JSON string. In an ordinary template literal JS would turn
 * it into a real newline before JSON.parse ever saw it, and a raw newline
 * inside a JSON string is invalid JSON.
 */
export const REAL_GEMINI_429_JSON = String.raw`{"error":{"code":"too_many_requests","message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash Please retry in 551.874307ms."}}`;

export const REAL_GEMINI_429_BODY: unknown = JSON.parse(REAL_GEMINI_429_JSON);

/** 551.874307ms, rounded to whole milliseconds. */
export const REAL_GEMINI_429_RETRY_MS = 552;

/** "limit: 20" — requests per minute, per the sub-second retry window. */
export const REAL_GEMINI_429_LIMIT = 20;
