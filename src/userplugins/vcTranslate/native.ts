import type { IpcMainInvokeEvent } from "electron";

import { translateWithClaude } from "./engines/claude";
import { translateWithGoogle } from "./engines/google";
import { withRetry } from "./retry";
import type { BatchRequest, EngineId, Result } from "./types";

export type NativeResponse =
    | { ok: true; results: Result[] }
    | { ok: false; error: string; retryAfterMs?: number };

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
 * be interpreted as a pattern. Applied for any non-empty key, with no minimum
 * length, so there is no short-key hole.
 */
function scrubKey(message: string, apiKey: string): string {
    if (apiKey.length === 0) return message;
    return message.split(apiKey).join("[redacted]");
}

/** 4xx failures repeat identically on retry; 429 and everything else may not. */
function isRetryable(err: unknown): boolean {
    const status = httpStatus(err instanceof Error ? err.message : String(err));
    if (status === undefined) return true; // network/parse error — one retry is worthwhile
    if (status === 429) return true;       // rate limited — backoff then retry
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
            () =>
                engine === "claude"
                    ? translateWithClaude(req, apiKey)
                    : translateWithGoogle(req),
            { retries: 1, delayMs: 1000, shouldRetry: isRetryable }
        );
        return { ok: true, results };
    } catch (err) {
        const raw = err instanceof Error ? err.message : "unknown error";
        const message = scrubKey(raw, apiKey);
        // Surface rate limiting so the renderer can pause the queue. Same
        // extractor as isRetryable, so the two can never disagree.
        const retryAfterMs = httpStatus(message) === 429 ? 30_000 : undefined;
        return { ok: false, error: message, retryAfterMs };
    }
}
