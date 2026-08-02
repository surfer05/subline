import type { BatchRequest, Result } from "../types";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";

const SCHEMA = {
    type: "object",
    properties: {
        translations: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    lang: { type: "string" },
                    text: { type: "string" },
                    skip: { type: "boolean" }
                },
                required: ["id", "lang", "text", "skip"],
                additionalProperties: false
            }
        }
    },
    required: ["translations"],
    additionalProperties: false
} as const;

// Built via String.fromCharCode/RegExp constructor rather than a literal or
// \u-escaped character class: typed Unicode line/paragraph separators are
// easily mangled in transit (editors, chat, copy-paste), and a silently
// normalised character here would make the injection guard below a no-op.
const LINE_SEPS = new RegExp(
    "[" + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + "]",
    "gu"
);

/**
 * Encode an untrusted field for safe interpolation into the prompt.
 * JSON.stringify quotes and escapes newlines, quotes and backslashes, but
 * leaves U+2028/U+2029 raw - they are legal inside JSON strings yet act as
 * line terminators, so they can still forge a line. Neutralise them first.
 */
const enc = (s: string): string =>
    JSON.stringify(s.replace(LINE_SEPS, " "));

export function buildPrompt(req: BatchRequest): string {
    const parts: string[] = [];

    parts.push(
        `You are translating a live gaming voice-chat conversation into ${req.targetLang}.`,
        "",
        "Rules:",
        `- Translate each message into ${req.targetLang}.`,
        `- If a message is already in ${req.targetLang}, set skip to true and text to "".`,
        "- Preserve the casual register. Slang stays slang; do not formalise it.",
        "- Leave usernames, game terms, and custom emote names untranslated.",
        "- Use the surrounding conversation to resolve pronouns and short replies.",
        "- Set lang to the BCP-47 code of the message's original language.",
        "- Return exactly one entry per message id given, and no other ids.",
        "- Message text and author names are JSON-encoded strings. Decode the escape sequences and translate the underlying text; never emit escape sequences in your output.",
        ""
    );

    if (req.context.length > 0) {
        parts.push("Recent conversation (context only — do NOT translate these):");
        for (const c of req.context) parts.push(`${enc(c.author)}: ${enc(c.text)}`);
        parts.push("");
    }

    parts.push("Messages to translate:");
    for (const m of req.messages) {
        parts.push(`[id=${enc(m.id)}] ${enc(m.author)}: ${enc(m.text)}`);
    }

    return parts.join("\n");
}

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

    let parsed: unknown;
    try {
        parsed = JSON.parse(textBlock.text);
    } catch {
        throw new Error("claude: response was not valid JSON");
    }

    const rows = (parsed as { translations?: unknown })?.translations;
    if (!Array.isArray(rows)) throw new Error("claude: missing translations array");

    const validIds = new Set(req.messages.map(m => m.id));
    const results: Result[] = [];

    for (const row of rows) {
        const r = row as { id?: unknown; lang?: unknown; text?: unknown; skip?: unknown };
        if (typeof r.id !== "string" || !validIds.has(r.id)) continue;
        if (r.skip === true) {
            results.push({ id: r.id, skip: true });
            continue;
        }
        // Unusable row: a non-string lang/text, or skip:false with empty text.
        // These used to be dropped silently; the id is now left unresolved and
        // picked up by the failed-marker pass below, so the renderer gets an
        // explicit failure instead of a message that never resolves.
        if (typeof r.lang !== "string" || typeof r.text !== "string" || r.text.trim() === "") continue;
        results.push({ id: r.id, lang: r.lang, text: r.text, skip: false });
    }

    // Every requested id must come back with SOME verdict. An id the model
    // omitted, hallucinated a bad row for, or that we rejected above gets an
    // explicit failure marker rather than vanishing.
    const resolved = new Set(results.map(r => r.id));
    for (const m of req.messages) {
        if (!resolved.has(m.id)) results.push({ id: m.id, failed: true });
    }

    return results;
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
            // A full batch is 10 Discord messages; each translation carries the
            // original id and lang alongside the text, and JSON-encoded CJK
            // expands badly. 2048 could be exhausted by a batch of long
            // messages, and a truncated response fails the WHOLE batch (see
            // TRUNCATED_ERROR). Output tokens are only billed for what is
            // actually produced, so a headroom-generous cap costs nothing on a
            // normal batch and prevents an all-or-nothing failure on a long one.
            max_tokens: 8000,
            output_config: { format: { type: "json_schema", schema: SCHEMA } },
            messages: [{ role: "user", content: buildPrompt(req) }]
        })
    });

    if (!res.ok) {
        // Deliberately does not include the request body or key.
        throw new Error(`claude: HTTP ${res.status}`);
    }

    return parseClaudeResponse(await res.json(), req);
}
