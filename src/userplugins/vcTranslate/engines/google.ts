import { isSameText, type BatchRequest, type Result } from "../types";

const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const CONCURRENCY = 4;

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
    msg: { id: string; text: string },
    targetLang: string,
    fetchImpl: typeof fetch
): Promise<Result> {
    const url =
        `${ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}` +
        `&dt=t&q=${encodeURIComponent(msg.text)}`;

    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`google: HTTP ${res.status}`);

    const body = await res.json();
    // Expected: [[["translated","original",...], ...], null, "<detected lang>"]
    if (!Array.isArray(body) || !Array.isArray(body[0]) || typeof body[2] !== "string") {
        throw new MessageError("google: unexpected response shape");
    }

    const detected = body[2] as string;
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

    return { id: msg.id, lang: detected, text, skip: false };
}

export async function translateWithGoogle(
    req: BatchRequest,
    fetchImpl: typeof fetch = fetch
): Promise<Result[]> {
    const results: Result[] = [];
    for (let i = 0; i < req.messages.length; i += CONCURRENCY) {
        const slice = req.messages.slice(i, i + CONCURRENCY);
        // allSettled, not all: one bad message must not discard the nine good
        // translations alongside it (and make native.ts retry all ten).
        const settled = await Promise.allSettled(
            slice.map(m => translateOne(m, req.targetLang, fetchImpl))
        );
        for (let j = 0; j < settled.length; j++) {
            const outcome = settled[j];
            if (outcome.status === "fulfilled") {
                results.push(outcome.value);
            } else if (outcome.reason instanceof MessageError) {
                results.push({ id: slice[j].id, failed: true });
            } else {
                // Whole-request failure (non-OK HTTP status): rethrow so
                // native.ts can retry or classify it.
                throw outcome.reason;
            }
        }
    }
    return results;
}
