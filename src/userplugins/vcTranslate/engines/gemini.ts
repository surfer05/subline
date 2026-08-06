import { HttpError } from "../httpError";
import {
    modelFromGeminiBody, quotaLimitFromGeminiBody, retryAfterFromGeminiBody, retryAfterFromHeader
} from "../rateHint";
import { DEFAULT_GEMINI_MODEL, type BatchRequest, type Result } from "../types";
import { buildPrompt, extractRows, mapRows, parseJsonText, SCHEMA } from "./llmShared";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

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
 * The `interactions` endpoint's OUTER shape (`steps[].content[].text`) is now
 * confirmed against a live call — a real 200 with a real key parses through
 * this function unchanged. What that same call disproved is the INNER shape:
 * the `response_format` schema below is ignored, and the text block came back
 * as a ```json-fenced bare array with numeric ids. That is handled in
 * ./llmShared (parseJsonText/extractRows/mapRows), shared with claude.ts, so
 * neither engine can be hardened without the other.
 *
 * The defensive style stays exactly as it was written, because the outer shape
 * being right once is not the same as it being guaranteed. Parse it as
 * defensively as engines/google.ts parses its own unofficial endpoint:
 * every access is an explicit typeof/Array.isArray check (never `?.`, which
 * would silently collapse a shape mismatch into `undefined` and produce a
 * confusing downstream error instead of a diagnosable one), and the
 * "no text found" error carries the response's own top-level keys so a shape
 * change is diagnosable from the Discord console rather than a silent
 * failure or a generic "no text" message that gives no clue why.
 */
export function parseGeminiResponse(body: unknown, req: BatchRequest, debug = false): Result[] {
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
    return mapRows(rows, req, debug);
}

/**
 * `model` is a PARAMETER, not a constant, and it comes from a user setting
 * (see `geminiModel` in settings.ts, defaulted from DEFAULT_GEMINI_MODEL in
 * types.ts). Which Gemini models a free-tier key may call changes underneath
 * us — the previous hardcoded `gemini-3.6-flash` returned 429 on every single
 * request because the key had no allowance for THAT MODEL at all — and a
 * compiled-in constant makes recovering from that a rebuild rather than a
 * settings edit. A blank/absent value falls back to the default rather than
 * sending `"model": ""`, which would be a 400 on every request.
 *
 * KNOWN GAP, flagged rather than fixed: this engine sends no output-token cap
 * and checks no finish/stop reason, so it has no equivalent of claude.ts's
 * TRUNCATED_ERROR. If a 25-message batch ever did exhaust the server-side
 * default output budget, the cut-off JSON would surface as "response was not
 * valid JSON" — which native.ts's isRetryable treats as retryable, so the same
 * over-long batch would be sent twice before failing. A Flash model's default
 * output ceiling is far above what 25 short chat translations produce, so this
 * is not expected to fire; it is not fixed here because the field name for an
 * output cap on the `interactions` request has still not been verified against
 * a live call (the live call confirmed only that the request shape BELOW is
 * accepted), and guessing one risks a 400 on every request — a much worse
 * failure than the one it would prevent.
 */
export async function translateWithGemini(
    req: BatchRequest,
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
    model?: string,
    debug = false
): Promise<Result[]> {
    const chosenModel = typeof model === "string" && model.trim() !== ""
        ? model.trim()
        : DEFAULT_GEMINI_MODEL;

    const res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            // NOT a query param, NOT a Bearer token — the API key header this
            // endpoint expects.
            "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
            model: chosenModel,
            input: buildPrompt(req),
            response_format: {
                type: "text",
                mime_type: "application/json",
                schema: SCHEMA
            }
        })
    });

    if (!res.ok) {
        // Deliberately does not include the request body or key. Two numbers
        // are worth salvaging from a rate-limit response, and both are read
        // from a SINGLE body parse — res.json() consumes the stream, so
        // reading it twice would throw on the second call.
        //
        // The retry hint may live in either place: a `Retry-After` header
        // (checked first — cheap, and Gemini's real 429s carry no such header,
        // so this usually misses) or the JSON error body. The quota ceiling
        // only ever appears in the body. Both reads are best-effort: a 4xx
        // response is not guaranteed to be JSON at all, and a parse failure
        // here must not shadow the real `HTTP <status>` error.
        //
        // The third salvaged value is the MODEL the quota was enforced
        // against ("... limit: 20, model: gemini-3.6-flash"). It is what makes
        // "this key has no allowance for this model at all" — a permanent
        // condition a settings change fixes — distinguishable from ordinary
        // throttling, which looks identical from the renderer otherwise. It is
        // parsed here for the same reason as the other two: the engine is the
        // only code that ever sees the response body.
        const headerHint = retryAfterFromHeader(res);
        let retryAfterMs = headerHint;
        let quotaLimitPerMinute: number | undefined;
        let quotaModel: string | undefined;
        try {
            const body = await res.json();
            if (retryAfterMs === undefined) retryAfterMs = retryAfterFromGeminiBody(body);
            quotaLimitPerMinute = quotaLimitFromGeminiBody(body);
            quotaModel = modelFromGeminiBody(body);
        } catch {
            // Not JSON, or no body to read — nothing to salvage, fall through
            // with whatever the header gave us.
        }
        throw new HttpError(
            `gemini: HTTP ${res.status}`,
            res.status,
            retryAfterMs,
            quotaLimitPerMinute,
            quotaModel
        );
    }

    return parseGeminiResponse(await res.json(), req, debug);
}
