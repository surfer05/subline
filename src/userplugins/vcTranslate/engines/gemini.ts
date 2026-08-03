import { HttpError } from "../httpError";
import { retryAfterFromGeminiBody, retryAfterFromHeader } from "../rateHint";
import type { BatchRequest, Result } from "../types";
import { buildPrompt, extractRows, mapRows, parseJsonText, SCHEMA } from "./llmShared";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = "gemini-3.6-flash";

// buildPrompt, enc, the injection guard, the translations schema and the
// row-validation/hallucinated-id-filtering pass all live in ./llmShared,
// shared with engines/claude.ts.
export { buildPrompt };

/** The top-level keys of a value, or "" if it isn't a plain object/array. */
function topLevelKeys(value: unknown): string {
    if (value === null || typeof value !== "object") return "";
    return Object.keys(value as object).join(", ");
}

/**
 * The `interactions` endpoint's response shape could not be verified against
 * a live call (no key was available while building this). Parse it exactly
 * as defensively as engines/google.ts parses its own unofficial endpoint:
 * every access is an explicit typeof/Array.isArray check (never `?.`, which
 * would silently collapse a shape mismatch into `undefined` and produce a
 * confusing downstream error instead of a diagnosable one), and the
 * "no text found" error carries the response's own top-level keys so a shape
 * change is diagnosable from the Discord console rather than a silent
 * failure or a generic "no text" message that gives no clue why.
 */
export function parseGeminiResponse(body: unknown, req: BatchRequest): Result[] {
    if (body === null || typeof body !== "object") {
        throw new Error(`gemini: response is not an object (got ${typeof body})`);
    }

    const steps = (body as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) {
        throw new Error(`gemini: missing steps array (response keys: ${topLevelKeys(body)})`);
    }

    // Walk from the end: the generated text lives in the FINAL step, but a
    // step can carry non-text content (e.g. a tool/thinking step with no
    // text block), so keep walking backwards until a text-bearing content
    // block is actually found rather than assuming the last step has one.
    let text: string | undefined;
    for (let i = steps.length - 1; i >= 0 && text === undefined; i--) {
        const step = steps[i];
        if (step === null || typeof step !== "object") continue;
        const content = (step as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (block === null || typeof block !== "object") continue;
            const t = (block as { text?: unknown }).text;
            if (typeof t === "string") {
                text = t;
                break;
            }
        }
    }

    if (text === undefined) {
        throw new Error(
            `gemini: no text content found in any step (response keys: ${topLevelKeys(body)})`
        );
    }

    const parsed = parseJsonText(text, "gemini");
    const rows = extractRows(parsed, "gemini");
    return mapRows(rows, req);
}

/**
 * KNOWN GAP, flagged rather than fixed: this engine sends no output-token cap
 * and checks no finish/stop reason, so it has no equivalent of claude.ts's
 * TRUNCATED_ERROR. If a 25-message batch ever did exhaust the server-side
 * default output budget, the cut-off JSON would surface as "response was not
 * valid JSON" — which native.ts's isRetryable treats as retryable, so the same
 * over-long batch would be sent twice before failing. Gemini 3 Flash's default
 * output ceiling is far above what 25 short chat translations produce, so this
 * is not expected to fire; it is not fixed here because the `interactions`
 * endpoint's request shape could not be verified against a live call (see the
 * parser comment above) and guessing a field name risks a 400 on every
 * request, which is a much worse failure than the one it would prevent.
 */
export async function translateWithGemini(
    req: BatchRequest,
    apiKey: string,
    fetchImpl: typeof fetch = fetch
): Promise<Result[]> {
    const res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            // NOT a query param, NOT a Bearer token — the API key header this
            // endpoint expects.
            "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
            model: MODEL,
            input: buildPrompt(req),
            response_format: {
                type: "text",
                mime_type: "application/json",
                schema: SCHEMA
            }
        })
    });

    if (!res.ok) {
        // Deliberately does not include the request body or key. The retry
        // hint, when present, lives in either place: a `Retry-After` header
        // (checked first — cheap, no body read needed) or, Gemini-specifically,
        // a RetryInfo entry inside the JSON error body. The body read is
        // best-effort: a 4xx response is not guaranteed to be JSON at all, and
        // a parse failure here must not shadow the real `HTTP <status>` error.
        let retryAfterMs = retryAfterFromHeader(res);
        if (retryAfterMs === undefined) {
            try {
                retryAfterMs = retryAfterFromGeminiBody(await res.json());
            } catch {
                // Not JSON, or no body to read — no hint available, fall
                // through with retryAfterMs left undefined.
            }
        }
        throw new HttpError(`gemini: HTTP ${res.status}`, res.status, retryAfterMs);
    }

    return parseGeminiResponse(await res.json(), req);
}
