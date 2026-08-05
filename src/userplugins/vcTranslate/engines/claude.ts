import { HttpError } from "../httpError";
import { retryAfterFromHeader } from "../rateHint";
import type { BatchRequest, Result } from "../types";
import { buildPrompt, extractRows, mapRows, parseJsonText, SCHEMA } from "./llmShared";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";

// buildPrompt, enc, the injection guard, the translations schema and the
// row-validation/hallucinated-id-filtering pass all live in ./llmShared,
// shared with engines/gemini.ts. Re-exported here so existing imports of
// buildPrompt from "./claude" (this module's own tests included) keep working
// unchanged.
export { buildPrompt };

/**
 * Thrown when the model hit the output budget mid-answer. Kept as a distinct,
 * exact string because native.ts's isRetryable matches on it: a truncated
 * response reproduces IDENTICALLY on retry (same prompt, same budget), so
 * retrying only doubles the token bill before failing the batch anyway.
 * Without this it looks like a generic parse error, which IS retried.
 */
export const TRUNCATED_ERROR = "claude: response truncated (max_tokens)";

export function parseClaudeResponse(body: unknown, req: BatchRequest): Result[] {
    // Checked before anything else: a max_tokens stop means the JSON below is
    // cut off mid-object, so every downstream diagnostic ("not valid JSON",
    // "missing translations array") would be a misleading description of a
    // budget problem — and, worse, a retryable-looking one.
    if ((body as { stop_reason?: unknown })?.stop_reason === "max_tokens") {
        throw new Error(TRUNCATED_ERROR);
    }

    const content = (body as { content?: unknown[] })?.content;
    if (!Array.isArray(content)) throw new Error("claude: missing content");

    const textBlock = content.find(
        b => (b as { type?: string })?.type === "text"
    ) as { text?: string } | undefined;

    if (typeof textBlock?.text !== "string") throw new Error("claude: no text block in response");

    const parsed = parseJsonText(textBlock.text, "claude");
    const rows = extractRows(parsed, "claude");
    return mapRows(rows, req);
}

export async function translateWithClaude(
    req: BatchRequest,
    apiKey: string,
    fetchImpl: typeof fetch = fetch
): Promise<Result[]> {
    const res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
            model: MODEL,
            // A full batch is 25 Discord messages (raised from 10 to fit a
            // day's chat into a few dozen requests — see QUALITY_MAX_BATCH in
            // types.ts). Each translation carries the original id and lang
            // alongside the text, and JSON-encoded CJK expands badly: a single
            // escaped CJK character is `\uXXXX`, several tokens for one glyph.
            // 8000 was sized for 10 messages and a 2.5x larger batch could
            // exhaust it, which fails the WHOLE batch (see TRUNCATED_ERROR) and
            // is explicitly NOT retried — so under-sizing this converts a
            // latency win into 25 lost translations.
            //
            // 24000 is the 8000-for-10 ratio with headroom, and well under
            // claude-haiku-4-5's 64K output ceiling. Output tokens are billed
            // only for what is actually produced, so the unused headroom costs
            // nothing on a normal batch.
            max_tokens: 24000,
            output_config: { format: { type: "json_schema", schema: SCHEMA } },
            messages: [{ role: "user", content: buildPrompt(req) }]
        })
    });

    if (!res.ok) {
        // Deliberately does not include the request body or key.
        throw new HttpError(`claude: HTTP ${res.status}`, res.status, retryAfterFromHeader(res));
    }

    return parseClaudeResponse(await res.json(), req);
}
