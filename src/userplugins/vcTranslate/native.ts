import type { IpcMainInvokeEvent } from "electron";

import { translateWithClaude, TRUNCATED_ERROR } from "./engines/claude";
import { translateWithGemini } from "./engines/gemini";
import { translateWithGoogle } from "./engines/google";
import { withRetry } from "./retry";
import type { BatchRequest, EngineId, Result } from "./types";

export type NativeResponse =
    | { ok: true; results: Result[] }
    | { ok: false; error: string; retryAfterMs?: number; quotaLimitPerMinute?: number };

/**
 * Both engines report transport failures as `<engine>: HTTP <status>`.
 * One shared, strict extractor so the retry decision and the rate-limit
 * signal can never disagree about what a message means.
 */
function httpStatus(msg: string): number | undefined {
    const m = /\bHTTP (\d{3})\b/.exec(msg);
    return m ? Number(m[1]) : undefined;
}

/**
 * The `error` string below crosses the IPC boundary into the renderer, where it
 * may be logged or displayed. It is whatever an engine threw, so nothing
 * structurally stops a key ending up in it — today's engines are clean, but a
 * future one, or a dependency's error, need not be. Redact defensively.
 *
 * split/join rather than a regex: the key is arbitrary user input and must not
 * be interpreted as a pattern.
 *
 * No-op for an unset key. The blank check is `trim()`, not `length`: the google
 * path passes "", and a whitespace-only key is not a secret but WOULD otherwise
 * be a live separator — scrubbing on "   " would replace every three-space run
 * in an unrelated message with [redacted]. Guarding on length alone leaves that
 * hole open; splitting on "" would shred the message into single characters.
 * A trimmed-blank key redacts nothing. Any other key, however short, is
 * redacted in full — mangling a diagnostic beats leaking a credential, and the
 * raw (untrimmed) value is what the header carries, so that is what we match.
 */
function scrubKey(message: string, apiKey: string): string {
    if (apiKey.trim().length === 0) return message;
    return message.split(apiKey).join("[redacted]");
}

/** 4xx failures repeat identically on retry; 429 and everything else may not. */
function isRetryable(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    // A truncated response carries no HTTP status, so the "no status → retry"
    // default below would retry it — and the retry sends the same prompt with
    // the same output budget, truncating at exactly the same place. Pure
    // double spend for a guaranteed second failure.
    if (msg === TRUNCATED_ERROR) return false;
    const status = httpStatus(msg);
    if (status === undefined) return true; // network/parse error — one retry is worthwhile
    // A 429 is NOT retried here, for the same reason as TRUNCATED_ERROR above:
    // it is a guaranteed second failure at double the cost. The API states how
    // long to wait and it is far longer than any delay worth blocking an IPC
    // call for — 33s in one captured response, against this retry's 1s — so the
    // second attempt is rejected too, having consumed another request from the
    // very quota that is exhausted. Rate limiting is handled where it can be
    // handled properly: the renderer parks the engine for the interval the API
    // asked for and serves the batch from Google meanwhile.
    if (status === 429) return false;
    return status < 400 || status >= 500;  // retry 5xx, never other 4xx
}

export async function translateBatch(
    _: IpcMainInvokeEvent,
    engine: EngineId,
    apiKey: string,
    reqJson: string
): Promise<NativeResponse> {
    let req: BatchRequest;
    try {
        req = JSON.parse(reqJson) as BatchRequest;
    } catch {
        return { ok: false, error: "bad request payload" };
    }

    try {
        const results = await withRetry(
            () => {
                if (engine === "claude") return translateWithClaude(req, apiKey);
                if (engine === "gemini") return translateWithGemini(req, apiKey);
                return translateWithGoogle(req);
            },
            { retries: 1, delayMs: 1000, shouldRetry: isRetryable }
        );
        return { ok: true, results };
    } catch (err) {
        const raw = err instanceof Error ? err.message : "unknown error";
        // Surface rate limiting so the renderer can pause the queue. Extracted
        // from the RAW message, exactly as isRetryable saw it. Reading it off
        // the scrubbed string instead would let a degenerate key (one that
        // happens to contain "HTTP 429", or a substring of it) rewrite the
        // status out from under this check and desync the two decisions.
        // Scrubbing happens afterwards, and only for the value that leaves.
        //
        // The engine may have parsed the API's own retry hint (a `Retry-After`
        // header, or Gemini's RetryInfo body — see rateHint.ts) onto the error
        // as `retryAfterMs` (see httpError.ts). Prefer that real number over
        // the guessed 30s constant; fall back to the constant only when the
        // engine had no hint to offer.
        const rateLimited = httpStatus(raw) === 429;
        const hinted = (err as { retryAfterMs?: unknown })?.retryAfterMs;
        const retryAfterMs = rateLimited
            ? (typeof hinted === "number" ? hinted : 30_000)
            : undefined;

        // The quota the API says it just enforced, when it said so (see
        // rateHint.ts). Unlike retryAfterMs there is NO default: the renderer
        // retunes its rate gate from this, and inventing a ceiling would be
        // worse than keeping the one it already has.
        const limit = (err as { quotaLimitPerMinute?: unknown })?.quotaLimitPerMinute;
        const quotaLimitPerMinute = rateLimited && typeof limit === "number" && limit > 0
            ? limit
            : undefined;

        return { ok: false, error: scrubKey(raw, apiKey), retryAfterMs, quotaLimitPerMinute };
    }
}
