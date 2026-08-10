import { Logger } from "@utils/Logger";

import { isSameText, type BatchRequest, type Result } from "../types";

/**
 * A SECOND `Logger` instance, not the one index.tsx builds — and unavoidably
 * so. mapRows() runs wherever the engine that calls it runs, which is the
 * Electron MAIN process (native.ts is the plugin's native/IPC side), a
 * separate realm from index.tsx's renderer. The two cannot share a JS object
 * across that boundary. Same construction (`new Logger("VcTranslate")`) as
 * index.tsx's, so both print under the identical "VcTranslate" tag and filter
 * identically in DevTools — see the `debugLogging` setting in settings.ts for
 * what turns this on. `debug` is threaded down as a plain argument (from
 * native.ts's `translateBatch`) rather than read from a setting: settings
 * live in the renderer, and this code cannot see them any more than
 * `apiKey`/`model` can — see native.ts's own comment on that.
 */
const logger = new Logger("VcTranslate");

/**
 * Shared between engines/claude.ts and engines/gemini.ts: the prompt builder
 * (injection-hardened — see enc() below), the translations JSON schema, and
 * the row-validation/hallucinated-id-filtering pass that turns a parsed
 * `{ translations: [...] }` payload into Result[]. Duplicating any of this
 * per engine means a future fix (e.g. another injection vector) only reaches
 * whichever engine got patched — exactly the bug class this project keeps
 * hitting. Keep BOTH engines routed through here.
 */

/**
 * The output contract we ASK for. Claude honours it. Gemini's `interactions`
 * endpoint, measured against a live call with this exact schema, ignores it
 * completely — see the note above parseJsonText. It is still sent: it costs
 * nothing, it is what makes Claude's output well-formed, and a future Gemini
 * endpoint honouring it would be a silent improvement rather than a change.
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
        `You are translating a live group chat between friends into ${req.targetLang}.`,
        "",
        "Rules:",
        `- Translate each message into ${req.targetLang}.`,
        `- If a message is already in ${req.targetLang}, set skip to true and text to "".`,
        // The register rules earned their length. "Preserve the casual register"
        // alone produced "hello kids" for a Persian greeting whose colloquial
        // sense is "hey guys" — a literally defensible reading that no speaker
        // would ever use. Naming the failure beats naming the goal.
        "- Write what a native speaker would actually say in " + req.targetLang + ", not a word-by-word rendering.",
        "- Everyday address terms are the most common mistake. A word that literally means "
        + "'children', 'sacrifice', 'my eyes', 'my soul' is usually just 'guys', 'mate', 'dude' "
        + "or an affectionate filler. Translate the intent.",
        "- Keep slang as slang and profanity as profanity. Do not soften, formalise or explain it.",
        "- Match number and formality: a term addressed to one person stays singular.",
        "- Regional and dialect forms (Maghrebi, Levantine, Gulf, Egyptian; Persian; "
        + "romanised Arabic written in Latin letters with digits for letters, e.g. 3 for ع, 7 for ح) "
        + "are ordinary chat, not errors. Translate them as confidently as the standard form.",
        "- Leave usernames, game terms, and custom emote names untranslated.",
        "- Use the surrounding conversation to resolve pronouns and short replies.",
        "- Translate a repeated phrase the same way every time it appears.",
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
 * BE TOLERANT IN WHAT YOU ACCEPT, STRICT IN WHAT YOU TRUST.
 *
 * The three functions below were written against the contract we ASKED for —
 * a bare `{ "translations": [ { "id": "<string>", ... } ] }` object, requested
 * via SCHEMA above. Measured against the live Gemini `interactions` endpoint,
 * that schema is simply IGNORED: the same prompt and the same schema came back
 * as a ```json-fenced BARE ARRAY with NUMERIC ids. Every one of those three
 * deviations used to be fatal — the fence alone made JSON.parse throw, which
 * native.ts's isRetryable treats as retryable, so a whole batch was sent twice
 * and then failed.
 *
 * So the SHAPE is now negotiable in all three ways. What is NOT negotiable, and
 * is deliberately unchanged below, is what we then trust: an id the model
 * invented is still dropped, a row missing a usable lang/text is still
 * rejected, and every requested id still comes back with an explicit verdict.
 * Tolerance about packaging must not become tolerance about content.
 */

/**
 * A whole-string markdown code fence: ```` ```json ```` … ```` ``` ````.
 *
 * Anchored at both ends and applied to the TRIMMED text, so it only ever
 * unwraps a response that IS a fenced block — a fence appearing inside a
 * translation is not touched. The language tag is optional (```` ``` ````,
 * ```` ```json ```` and ```` ```JSON ```` have all been seen from LLMs) and the
 * closing fence's newline is optional so a single-line block still unwraps.
 */
const CODE_FENCE_RE = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/;

/** The contents of a whole-string code fence, or the text unchanged. */
export function stripCodeFence(text: string): string {
    const m = CODE_FENCE_RE.exec(text.trim());
    return m === null ? text : m[1];
}

/**
 * Parse the model's text output as JSON. `engineName` prefixes the thrown
 * message ("claude: ..." / "gemini: ...") so a failure is attributable at a
 * glance without inspecting the call stack.
 *
 * The raw text is tried FIRST and the fence is stripped only after that fails.
 * A response that is already valid JSON therefore takes exactly the path it
 * always did — the unwrapping cannot alter a well-formed payload, only rescue a
 * malformed one.
 */
export function parseJsonText(text: string, engineName: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        // Fall through: a ```json fence is the observed reason a real response
        // fails the parse above.
    }

    const unfenced = stripCodeFence(text);
    if (unfenced !== text) {
        try {
            return JSON.parse(unfenced);
        } catch {
            // Still not JSON — report the same error as any other garbage.
        }
    }

    throw new Error(`${engineName}: response was not valid JSON`);
}

/**
 * Pull the translation rows out of the parsed JSON body.
 *
 * Accepts EITHER the `{ translations: [...] }` object the schema asks for
 * (what Claude returns) OR a bare top-level array (what Gemini actually
 * returns). Anything else is still an error rather than an empty result: a
 * response we cannot read must not be indistinguishable from one that
 * translated nothing.
 */
export function extractRows(parsed: unknown, engineName: string): unknown[] {
    if (Array.isArray(parsed)) return parsed;
    if (parsed !== null && typeof parsed === "object") {
        const rows = (parsed as { translations?: unknown }).translations;
        if (Array.isArray(rows)) return rows;
    }
    throw new Error(`${engineName}: missing translations array`);
}

/**
 * The row's id as a string, or undefined if it is not an id at all.
 *
 * A NUMBER is accepted and coerced: the live Gemini response numbers its rows
 * (`"id": 1`) even though the schema declares a string, and Discord message ids
 * are decimal snowflakes, so the request's own ids are the exact strings
 * `String(n)` produces for the small indices a model echoes back. Nothing else
 * is coerced — `String(true)`/`String(null)` would invent an id out of a
 * malformed row, and the membership check below is only a real check while the
 * only way to pass it is to have been asked for.
 *
 * Non-integer and non-finite numbers are rejected rather than coerced: no
 * requested id is ever `"1.5"` or `"NaN"`, so accepting them could only ever
 * turn a malformed row into a miss — and doing it here keeps that reasoning in
 * one place instead of relying on the Set lookup to clean up afterwards.
 */
function rowId(raw: unknown): string | undefined {
    if (typeof raw === "string") return raw;
    if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
    return undefined;
}

/**
 * Turn raw translation rows into Result[]: drop hallucinated ids (an id the
 * model invented that was never in the request), drop unusable rows (a
 * non-string lang/text, or skip:false with empty text), drop pass-through
 * "translations" identical to their source (isSameText), and mark every
 * requested id that never got a usable row as an explicit `{ failed: true }`
 * rather than letting it vanish.
 *
 * `debug`, when true, logs every id dropped here for being present in the
 * response but absent from the request — the "model answered a different
 * message than the one asked" failure mode, which otherwise leaves no trace:
 * the id is silently gone by the time this function returns, and the caller
 * only ever sees the requested id come back `{ failed: true }`. Off by
 * default and checked before any string is built, same discipline as every
 * other debugLogging call site (see settings.ts).
 */
export function mapRows(rows: unknown[], req: BatchRequest, debug = false): Result[] {
    const validIds = new Set(req.messages.map(m => m.id));
    const results: Result[] = [];

    for (const row of rows) {
        if (row === null || typeof row !== "object") continue;
        const r = row as { id?: unknown; lang?: unknown; text?: unknown; skip?: unknown };
        // Coerced (see rowId) but never invented: an id the model made up is
        // still dropped here, numeric or not.
        const id = rowId(r.id);
        if (id === undefined || !validIds.has(id)) {
            if (debug && id !== undefined) {
                logger.debug(
                    `[response] id ${id} present in the response but not in the `
                    + "request — dropped as hallucinated"
                );
            }
            continue;
        }
        if (r.skip === true) {
            results.push({ id, skip: true });
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
        const source = req.messages.find(m => m.id === id)?.text ?? "";
        if (isSameText(r.text, source)) {
            results.push({ id, skip: true });
            continue;
        }

        results.push({ id, lang: r.lang, text: r.text, skip: false });
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
