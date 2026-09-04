/**
 * The translation core, server-side.
 *
 * MIRROR of the plugin's engines/llmShared.ts (buildPrompt, enc) and
 * engines/groq.ts (the Groq call + tolerant parse). Kept self-contained so the
 * relay deploys as one Cloudflare Worker with no cross-tree bundling. If the
 * plugin's prompt or parse changes materially, update this too — the
 * "prompt carries the load-bearing rules" test in test/translate.test.ts is a
 * tripwire, not a full golden match.
 *
 * The relay OWNS the model and the prompt. A client only ever sends the
 * structured batch (messages + context + target); it cannot dictate the model,
 * the system rules, or the key. That is what makes a keyless relay safe.
 */

export interface Message { id: string; author?: string; text: string }
export interface BatchRequest {
    messages: Message[];
    context: { author: string; text: string }[];
    targetLang: string;
}
export type Result =
    | { id: string; lang: string; text: string; skip: false }
    | { id: string; skip: true }
    | { id: string; failed: true };

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/** JSON-encode an untrusted field for safe interpolation, neutralising the two
 *  line separators that are legal inside JSON strings yet forge a line. */
const LINE_SEPS = new RegExp("[" + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + "]", "gu");
const enc = (s: string): string => JSON.stringify((s ?? "").replace(LINE_SEPS, " "));

export function buildPrompt(req: BatchRequest): string {
    // The target language is untrusted input like everything else: enc() it so
    // a crafted "targetLang" cannot inject instructions into the system prompt.
    // Length/charset are ALSO capped upstream in validBatch (index.ts).
    const tgt = enc(req.targetLang);
    const parts: string[] = [];
    parts.push(
        `You are translating a live group chat between friends into ${tgt}.`,
        "",
        "Rules:",
        `- Translate each message into ${tgt}.`,
        `- If a message is already in ${tgt}, set skip to true and text to "".`,
        "- Write what a native speaker would actually say in " + tgt + ", not a word-by-word rendering.",
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
    parts.push(
        "Messages to translate:",
        ...req.messages.map(m => `[id=${enc(m.id)}] ${enc(m.author ?? "")}: ${enc(m.text)}`),
        "",
        'Reply with JSON only: {"translations":[{"id":"<id>","lang":"<bcp47>","text":"<translation>","skip":false}]}'
    );
    return parts.join("\n");
}

/** Unwrap a whole-string ```json fence, if present. */
const CODE_FENCE_RE = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/;
function stripCodeFence(text: string): string {
    const m = CODE_FENCE_RE.exec(text.trim());
    return m ? m[1]! : text;
}

/** Tolerant in packaging, strict in content: accept {translations:[]} or a bare
 *  array, coerce ids to string, drop invented ids, and give every requested id
 *  an explicit verdict (missing → failed). */
function parseRows(content: string, req: BatchRequest): Result[] {
    let rows: unknown[] = [];
    try {
        const parsed = JSON.parse(stripCodeFence(content));
        rows = Array.isArray(parsed) ? parsed
            : Array.isArray((parsed as any)?.translations) ? (parsed as any).translations
            : [];
    } catch { rows = []; }

    const byId = new Map<string, any>();
    for (const r of rows) {
        if (r && typeof r === "object" && "id" in r) byId.set(String((r as any).id), r);
    }
    return req.messages.map(({ id }): Result => {
        const r = byId.get(id);
        if (!r) return { id, failed: true };
        if (r.skip === true) return { id, skip: true };
        const text = typeof r.text === "string" ? r.text : "";
        const lang = typeof r.lang === "string" ? r.lang : "";
        if (text.trim() === "" || lang === "") return { id, failed: true };
        return { id, lang, text, skip: false };
    });
}

const REASONING_CONTROLS = { reasoning_effort: "low", reasoning_format: "hidden" } as const;
const REASONING_HINT = /gpt-oss|qwen|reasoning|o1|o3|deepseek-r/i;

export interface TranslateError { status: number; retryAfterMs?: number }

/** Call Groq with the relay's key and return one verdict per message. Throws a
 *  TranslateError on a non-OK status so the Worker can map it to the client's
 *  { ok:false } shape. Never logs or returns the request text. */
export async function translate(req: BatchRequest, apiKey: string, model: string, signal?: AbortSignal): Promise<Result[]> {
    const prompt = buildPrompt(req);
    const send = (withReasoning: boolean) => fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        signal,
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
            ...(withReasoning ? REASONING_CONTROLS : {})
        })
    });

    let res = await send(REASONING_HINT.test(model));
    if (res.status === 400) {
        const t = await res.clone().text().catch(() => "");
        if (/reasoning_(effort|format)/i.test(t)) res = await send(false);
    }
    if (!res.ok) {
        const ra = res.headers.get("retry-after");
        const err: TranslateError = { status: res.status };
        if (ra) { const s = Number(ra); if (Number.isFinite(s)) err.retryAfterMs = s * 1000; }
        throw err;
    }
    const body = await res.json() as any;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
        // Empty 200: a reasoning model that answered in the hidden field, or a
        // malformed success. Not the user's fault, not their quota — treat it
        // like an upstream failure so index.ts refunds and the client retries.
        throw { status: 502 } as TranslateError;
    }
    return parseRows(content, req);
}
