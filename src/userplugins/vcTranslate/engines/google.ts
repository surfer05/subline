import { HttpError } from "../httpError";
import { retryAfterFromHeader } from "../rateHint";
import { isSameText, type BatchRequest, type Result } from "../types";

const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const CONCURRENCY = 4;

/**
 * How long to wait before re-sending a message the endpoint just throttled.
 *
 * MEASURED, 2026-08-29. Ten messages at CONCURRENCY 4 against the live
 * endpoint returned nine 200s and one 429 — and the two requests issued
 * immediately AFTER the refusal both succeeded. This endpoint throttles
 * individual requests under burst; it does not shut the caller out. So one
 * short retry converts the common case into no loss at all, and the delay only
 * has to outlast the burst that caused it rather than any stated quota (there
 * is none to read — the refusal is an HTML block page).
 */
const RETRY_DELAY_MS = 400;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Headers that make the request look like a browser rather than a bare fetch.
 *
 * WHY THIS MATTERS, evidenced 2026-09-02. The free translate_a endpoint
 * throttles by (IP, request shape) — not IP alone. On one Airtel connection,
 * with the block active, a browser hitting the endpoint got 200 while the
 * plugin got 429, at the same second, from the same house. The status beacon
 * caught it: updatedAt == lastError.at, status 429, while the browser answered
 * cleanly. The difference was the request: the plugin sent `fetchImpl(url)`
 * with no headers at all, which is MORE naked than curl (curl at least sends a
 * User-Agent). A bare request is the first thing a rate limiter sheds.
 *
 * So we stop looking like a script. A real Chrome User-Agent, an
 * Accept-Language, and the Referer/Origin a browser translate widget would
 * carry. None of it is a trick — it is what any browser sends, and it is the
 * difference between surviving a throttling window and being dropped in it.
 * It cannot make things worse: the previous request sent strictly less.
 */
const BROWSER_HEADERS: Record<string, string> = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        + "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://translate.google.com/",
    "Origin": "https://translate.google.com"
};

/**
 * A failure that concerns exactly ONE message — a garbled body, an empty
 * translation. It degrades that message to `{ failed: true }` and leaves the
 * rest of the batch intact.
 *
 * Transport-level failures (a non-OK HTTP status) are deliberately NOT of this
 * kind: they mean the endpoint is refusing us, so they propagate out of
 * translateWithGoogle and let native.ts retry or classify the whole request.
 */
class MessageError extends Error {}

async function translateOne(
    msg: { id: string; text: string; sourceLang?: string },
    targetLang: string,
    fetchImpl: typeof fetch,
    retryDelayMs: number = RETRY_DELAY_MS,
    isRetry: boolean = false
): Promise<Result> {
    // `auto` unless the caller resolved a language for us. Pinning is what
    // rescues short replies: "ne" under `sl=auto` comes back as Hausa "it is",
    // and under `sl=de` as "no" — opposite answers to the same question.
    const sourceLang = msg.sourceLang ?? "auto";
    const url =
        `${ENDPOINT}?client=gtx&sl=${encodeURIComponent(sourceLang)}` +
        `&tl=${encodeURIComponent(targetLang)}` +
        `&dt=t&q=${encodeURIComponent(msg.text)}`;

    const res = await fetchImpl(url, { headers: BROWSER_HEADERS });
    if (!res.ok) {
        // One retry for a throttle, because this endpoint refuses REQUESTS
        // rather than callers (see RETRY_DELAY_MS). Only 429, and only once:
        // a 4xx that is not a throttle repeats identically, and retrying into
        // a genuine block is how a burst sustains itself.
        if (res.status === 429 && !isRetry) {
            await sleep(retryDelayMs);
            return translateOne(msg, targetLang, fetchImpl, retryDelayMs, true);
        }
        throw new HttpError(`google: HTTP ${res.status}`, res.status, retryAfterFromHeader(res));
    }

    const body = await res.json();
    // Expected: [[["translated","original",...], ...], null, "<detected lang>"]
    if (!Array.isArray(body) || !Array.isArray(body[0]) || typeof body[2] !== "string") {
        throw new MessageError("google: unexpected response shape");
    }

    const detected = body[2] as string;

    // Index 6 carries the detection confidence — a number under `sl=auto`,
    // and absent/null when we pinned the language (nothing was detected).
    // Reading it costs nothing and is the only signal that separates a
    // trustworthy translation from a guess; the endpoint has been telling us
    // all along and we were discarding it.
    const conf = typeof body[6] === "number" ? body[6] : undefined;
    if (detected === targetLang) return { id: msg.id, skip: true };

    const text = (body[0] as unknown[])
        .map(seg => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
        .join("")
        .trim();

    if (text.length === 0) throw new MessageError("google: empty translation");

    // The engine handed back exactly what we sent, so there is nothing to
    // show. This is the usual outcome for English chat slang: Google
    // misdetects "hbu" as Frisian and "u2 <2" as Chinese, then passes the text
    // through untouched. The detected-language check above does not catch it,
    // because the bogus detection is not the target language — so without
    // this we render a subtitle identical to the message it sits under.
    if (isSameText(text, msg.text)) return { id: msg.id, skip: true };

    return { id: msg.id, lang: detected, text, skip: false, conf };
}

export interface GoogleOptions {
    /** Only the tests set this, to keep the retry from costing real time. */
    retryDelayMs?: number;
}

export async function translateWithGoogle(
    req: BatchRequest,
    fetchImpl: typeof fetch = fetch,
    options: GoogleOptions = {}
): Promise<Result[]> {
    const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    const results: Result[] = [];
    // Kept so a request that was refused OUTRIGHT — every message, no
    // exceptions — can still be rethrown. That is the shape of a real block,
    // and runTier needs to see it to park the engine.
    let transportError: unknown;

    for (let i = 0; i < req.messages.length; i += CONCURRENCY) {
        const slice = req.messages.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
            slice.map(m => translateOne(m, req.targetLang, fetchImpl, retryDelayMs))
        );
        for (let j = 0; j < settled.length; j++) {
            const outcome = settled[j];
            if (outcome.status === "fulfilled") {
                results.push(outcome.value);
            } else if (outcome.reason instanceof MessageError) {
                results.push({ id: slice[j]!.id, failed: true });
            } else {
                // A TRANSPORT failure for ONE message. It used to be rethrown
                // here, on the reasoning that a non-OK status "means the
                // endpoint is refusing us" — true of a batch endpoint, false of
                // this one. Google is per-message, and it throttles per message:
                // a single 429 among nine 200s was discarding nine finished
                // translations and reporting the whole batch as refused.
                //
                // So it is recorded as this message's own failure, and the rest
                // of the batch stands. The reader loses at most the one message
                // Google would not take — which the quality tier is already on
                // its way to translating anyway.
                transportError = outcome.reason;
                results.push({ id: slice[j]!.id, failed: true });
            }
        }
    }

    // Nothing came back at all: not a throttle, a refusal. Rethrow so runTier
    // classifies it, marks the batch deferred and cools the engine down.
    if (transportError !== undefined && !results.some(r => !("failed" in r))) {
        throw transportError;
    }
    return results;
}
