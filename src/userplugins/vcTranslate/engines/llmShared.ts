import { isSameText, type BatchRequest, type Result } from "../types";

/**
 * Shared between engines/claude.ts and engines/gemini.ts: the prompt builder
 * (injection-hardened — see enc() below), the translations JSON schema, and
 * the row-validation/hallucinated-id-filtering pass that turns a parsed
 * `{ translations: [...] }` payload into Result[]. Duplicating any of this
 * per engine means a future fix (e.g. another injection vector) only reaches
 * whichever engine got patched — exactly the bug class this project keeps
 * hitting. Keep BOTH engines routed through here.
 */

export const SCHEMA = {
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
export const enc = (s: string): string =>
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
 * Parse the model's text output as JSON. `engineName` prefixes the thrown
 * message ("claude: ..." / "gemini: ...") so a failure is attributable at a
 * glance without inspecting the call stack.
 */
export function parseJsonText(text: string, engineName: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${engineName}: response was not valid JSON`);
    }
}

/** Pull the `translations` array out of the parsed JSON body. */
export function extractRows(parsed: unknown, engineName: string): unknown[] {
    const rows = (parsed as { translations?: unknown }).translations;
    if (!Array.isArray(rows)) throw new Error(`${engineName}: missing translations array`);
    return rows;
}

/**
 * Turn raw translation rows into Result[]: drop hallucinated ids (an id the
 * model invented that was never in the request), drop unusable rows (a
 * non-string lang/text, or skip:false with empty text), drop pass-through
 * "translations" identical to their source (isSameText), and mark every
 * requested id that never got a usable row as an explicit `{ failed: true }`
 * rather than letting it vanish.
 */
export function mapRows(rows: unknown[], req: BatchRequest): Result[] {
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
        // A "translation" identical to its source is nothing to render.
        // Cheaper to catch here than to show the user a subtitle that
        // repeats the message verbatim.
        const source = req.messages.find(m => m.id === r.id)?.text ?? "";
        if (isSameText(r.text, source)) {
            results.push({ id: r.id, skip: true });
            continue;
        }

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
