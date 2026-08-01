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
        ""
    );

    if (req.context.length > 0) {
        parts.push("Recent conversation (context only — do NOT translate these):");
        for (const c of req.context) parts.push(`${c.author}: ${c.text}`);
        parts.push("");
    }

    parts.push("Messages to translate:");
    for (const m of req.messages) {
        parts.push(`[id=${m.id}] ${m.author}: ${m.text}`);
    }

    return parts.join("\n");
}

export function parseClaudeResponse(body: unknown, req: BatchRequest): Result[] {
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
        if (typeof r.lang !== "string" || typeof r.text !== "string" || r.text.trim() === "") continue;
        results.push({ id: r.id, lang: r.lang, text: r.text, skip: false });
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
            max_tokens: 2048,
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
