import { HttpError } from "../httpError";
import type { BatchRequest, Result } from "../types";

/**
 * The Subline relay: keyless AI translation. The user's "key" is an opaque
 * CODE, not a provider key, and the request goes to Subline's own Worker, which
 * holds the paid Groq key and returns the SAME shape a direct provider call
 * would (see relay/). So this engine is a thin poster — the relay owns the
 * model and the prompt.
 *
 * REPLACE this URL with your deployed Worker's URL (see relay/README.md). It is
 * a compiled constant, not a setting, for the same reason RELEASE_FEED_URL is:
 * a translation endpoint that a config file could repoint is a way to exfiltrate
 * message text, and there must be nothing to repoint.
 */
export const RELAY_URL = "https://subline-relay.REPLACE.workers.dev/v1/translate";

export async function translateWithRelay(
    req: BatchRequest,
    code: string,
    fetchImpl: typeof fetch = fetch
): Promise<Result[]> {
    const res = await fetchImpl(RELAY_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${code}` },
        body: JSON.stringify(req)
    });

    // The relay speaks NativeResponse: { ok:true, results } | { ok:false, error, retryAfterMs }.
    // Throw an HttpError on any failure so native.ts's translateBatch maps it to
    // { ok:false, error, retryAfterMs } exactly as it does for the keyed engines
    // — including the 429 → pause-the-queue path (httpStatus reads "HTTP 429").
    let body: any = null;
    try { body = await res.json(); } catch { /* fall through to the status check */ }

    if (!res.ok || !body || body.ok !== true) {
        const detail = body && typeof body.error === "string" ? ` ${body.error}` : "";
        throw new HttpError(
            `relay: HTTP ${res.status}${detail}`,
            res.status,
            body && typeof body.retryAfterMs === "number" ? body.retryAfterMs : undefined
        );
    }
    return body.results as Result[];
}
