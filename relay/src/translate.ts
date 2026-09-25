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
    // `truncated` is set only by preview mode (see previewText), never by a
    // provider, so a normal response is unchanged.
    | { id: string; lang: string; text: string; skip: false; truncated?: boolean }
    | { id: string; skip: true }
    | { id: string; failed: true };

/** Preview mode: the first 5 words, capped at 32 code points. */
export const PREVIEW_WORDS = 5;
export const PREVIEW_MAX_CODE_POINTS = 32;

/**
 * The preview a free install sees once its trial is over: enough of the
 * translation to show it is real, not enough to read the conversation. The
 * relay truncates ON THE SERVER, so a preview request never gets the full text
 * back (a client-side cut would be one devtools edit away). That is all it
 * promises: preview is a mode the v0.1.6 client asks for. A header-less legacy
 * (v0.1.5) free_ request sends no mode and still gets full text, within its
 * 3-a-day taste allowance.
 *
 * Words are whitespace-split; a language without spaces (CJK) arrives as one
 * long "word", which is why the code-point cap exists. Array.from counts code
 * points, so a surrogate pair (emoji, rare CJK) is never split in half.
 * `truncated` is true only when the preview differs from the full
 * whitespace-normalised text, so a short line is not flagged.
 */
export function previewText(text: string): { text: string; truncated: boolean } {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const full = words.join(" ");
    let out = words.slice(0, PREVIEW_WORDS).join(" ");
    const cps = Array.from(out);
    if (cps.length > PREVIEW_MAX_CODE_POINTS) out = cps.slice(0, PREVIEW_MAX_CODE_POINTS).join("").trimEnd();
    return { text: out, truncated: out !== full };
}

/** Apply previewText to every translated row; skipped/failed rows pass through. */
export function toPreview(results: Result[]): Result[] {
    return results.map(r => {
        if (!("skip" in r) || r.skip !== false) return r;
        const p = previewText(r.text);
        return p.truncated ? { ...r, text: p.text, truncated: true } : { ...r, text: p.text };
    });
}

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
// OpenRouter resells the SAME openai/gpt-oss-120b on Groq's hardware, pay as you
// go, on an OpenAI-shaped endpoint. It is the primary path because the direct
// Groq key is stuck on the free tier's daily token ceiling; the direct key stays
// on as the automatic fallback.
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

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
        "- Set skip to true and text to \"\" whenever a message does NOT need translating into "
        + tgt + ". That covers two cases. (1) The message is already written in "
        + tgt + " — INCLUDING slang, abbreviations, and memes written in "
        + tgt + ". (2) The message is not really another language: a proper noun, "
        + "username, brand or game name, an emoji or reaction, or a short abbreviation or bit of "
        + "gibberish with no translatable meaning. Only translate a message genuinely written in a "
        + "DIFFERENT language than " + tgt + " — foreign-language slang still gets "
        + "translated. Use your own knowledge of the language, not a fixed word list: for an English "
        + "reader, things like \"og\", \"gng\", \"less go\" are English and should skip; for a reader "
        + "whose language is not English, English text should still be translated.",
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

/** Salvage a JSON document that arrived wrapped in prose: keep everything from
 *  the first "{" or "[" through the last "}" or "]". A model that prefixes
 *  "Here is the JSON:" or appends a closing sentence would otherwise lose the
 *  whole batch. Returns null when there is nothing to salvage, or when nothing
 *  was actually trimmed (so the caller never re-parses the identical string). */
function sliceJson(text: string): string | null {
    const starts = [text.indexOf("{"), text.indexOf("[")].filter(i => i >= 0);
    if (starts.length === 0) return null;
    const start = Math.min(...starts);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (end <= start) return null;
    const sliced = text.slice(start, end + 1);
    return sliced === text ? null : sliced;
}

/** Tolerant in packaging, strict in content: accept {translations:[]} or a bare
 *  array, coerce ids to string, drop invented ids, and give every requested id
 *  an explicit verdict (missing → failed).
 *
 *  Content that is not JSON at all, even after the preamble/trailer salvage, is
 *  an UPSTREAM failure rather than a batch of silent "failed" verdicts: it
 *  throws a 502 so index.ts refunds and the fallback provider gets its turn. The
 *  failure is never logged with the content, which is user message text. */
function parseRows(content: string, req: BatchRequest): Result[] {
    const unfenced = stripCodeFence(content);
    let parsed: unknown;
    try {
        parsed = JSON.parse(unfenced);
    } catch {
        const salvaged = sliceJson(unfenced);
        if (salvaged === null) throw { status: 502 } as TranslateError;
        try { parsed = JSON.parse(salvaged); }
        catch { throw { status: 502 } as TranslateError; }
    }
    const rows: unknown[] = Array.isArray(parsed) ? parsed
        : Array.isArray((parsed as any)?.translations) ? (parsed as any).translations
        : [];

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

/** A `retry-after` header (seconds) → an err carrying the status + ms hint. */
function errFor(res: Response): TranslateError {
    const ra = res.headers.get("retry-after");
    const err: TranslateError = { status: res.status };
    if (ra) { const s = Number(ra); if (Number.isFinite(s)) err.retryAfterMs = s * 1000; }
    return err;
}

/** OpenRouter's provider-routing block. `order` pins the request to Groq's own
 *  hosting of this model first (then Cerebras, then DeepInfra) so latency and
 *  behaviour match the direct-Groq path the prompt was tuned on;
 *  `require_parameters` makes OpenRouter skip any host that would silently DROP
 *  our reasoning controls instead of serving a quietly degraded answer; `ignore`
 *  removes the hosts we do not want this traffic on at all. */
const OPENROUTER_ROUTING = {
    order: ["groq", "cerebras", "deepinfra"],
    allow_fallbacks: true,
    require_parameters: true,
    ignore: ["novita", "digitalocean", "sambanova", "amazon-bedrock"]
} as const;

/** Attribution headers OpenRouter shows on the account's activity page. Public
 *  values only — the download page and the product name, never a user, a code,
 *  or a key. */
const OPENROUTER_HEADERS: Record<string, string> = {
    "HTTP-Referer": "https://surfer05.github.io/subline/",
    "X-Title": "Subline"
};

interface OpenAiCall {
    endpoint: string;
    /** Extra request headers (OpenRouter's attribution pair). */
    headers?: Record<string, string>;
    /** Extra top-level body fields (OpenRouter's provider-routing block). */
    body?: Record<string, unknown>;
    /** A 400 whose body text matches this is retried ONCE without the reasoning
     *  controls. */
    retryOn: RegExp;
}

/** Call an OpenAI-shaped chat-completions endpoint — Groq directly, or
 *  OpenRouter reselling the same model — and return the raw model content
 *  string. Throws a TranslateError on a non-OK status or an empty 200. */
async function callOpenAi(
    call: OpenAiCall, prompt: string, apiKey: string, model: string, signal?: AbortSignal
): Promise<string> {
    const send = (withReasoning: boolean) => fetch(call.endpoint, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...call.headers
        },
        signal,
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
            ...call.body,
            ...(withReasoning ? REASONING_CONTROLS : {})
        })
    });

    let res = await send(REASONING_HINT.test(model));
    if (res.status === 400) {
        const t = await res.clone().text().catch(() => "");
        // Groq names the parameter; OpenRouter, under require_parameters, can
        // instead complain about the PROVIDER block (no listed host offers
        // those params). Either way retry once WITHOUT the reasoning controls
        // and KEEP the routing block, so the request stays pinned.
        if (call.retryOn.test(t)) res = await send(false);
    }
    if (!res.ok) throw errFor(res);
    const body = await res.json() as any;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
        // Empty 200: a reasoning model that answered in the hidden field, or a
        // malformed success. Not the user's fault, not their quota — treat it
        // like an upstream failure so index.ts refunds and the client retries.
        throw { status: 502 } as TranslateError;
    }
    return content;
}

const GROQ_CALL: OpenAiCall = { endpoint: GROQ_ENDPOINT, retryOn: /reasoning_(effort|format)/i };
const OPENROUTER_CALL: OpenAiCall = {
    endpoint: OPENROUTER_ENDPOINT,
    headers: OPENROUTER_HEADERS,
    body: { provider: OPENROUTER_ROUTING },
    retryOn: /provider|reasoning/i
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
/** Force machine-readable JSON out of Gemini: a strict schema beats the prompt's
 *  free-form "reply with JSON" and removes the fence/prose failure modes. Only
 *  id + skip are required so a skipped row need not carry lang/text; parseRows
 *  still demands a real lang+text for anything not skipped. */
const GEMINI_SCHEMA = {
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
                required: ["id", "skip"]
            }
        }
    },
    required: ["translations"]
} as const;

/** Call Gemini (generateContent) and return the raw model content string. The
 *  key travels in the x-goog-api-key header, never the URL, so it can't leak
 *  into a proxy/access log. thinkingBudget:0 keeps a Flash "thinking" model from
 *  burning output tokens (billed) on latency we don't want for chat lines; if a
 *  model rejects that control we retry once without it, mirroring the Groq path.
 *  Throws a TranslateError on a non-OK status, a safety block, or an empty 200. */
async function callGemini(prompt: string, apiKey: string, model: string, signal?: AbortSignal): Promise<string> {
    const send = (withThinking: boolean) => fetch(`${GEMINI_BASE}${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        signal,
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json",
                responseSchema: GEMINI_SCHEMA,
                ...(withThinking ? {} : { thinkingConfig: { thinkingBudget: 0 } })
            }
        })
    });

    let res = await send(false);
    if (res.status === 400) {
        const t = await res.clone().text().catch(() => "");
        if (/thinking/i.test(t)) res = await send(true);
    }
    if (!res.ok) throw errFor(res);
    const body = await res.json() as any;
    // A prompt-level safety block returns 200 with no candidate — treat as an
    // upstream failure (refund + fall back), not a silent empty translation.
    const content = body?.candidates?.[0]?.content?.parts
        ?.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("") ?? "";
    if (content.trim() === "") throw { status: 502 } as TranslateError;
    return content;
}

/** Which upstream answers. An EXPLICIT kind, never a regex on the model id:
 *  openrouter and groq serve the SAME id ("openai/gpt-oss-120b") through
 *  different endpoints with different keys, so the id cannot decide the route. */
export type ProviderKind = "groq" | "openrouter" | "gemini";

export interface Provider { kind: ProviderKind; apiKey: string; model: string }

/** Call ONE provider (chosen by provider.kind) with the relay's key and return
 *  one verdict per message. Throws a TranslateError on a non-OK status so the
 *  Worker can map it to the client's { ok:false } shape. Never logs or returns
 *  the request text. */
export async function translate(req: BatchRequest, provider: Provider, signal?: AbortSignal): Promise<Result[]> {
    const prompt = buildPrompt(req);
    const { kind, apiKey, model } = provider;
    const content =
        kind === "gemini" ? await callGemini(prompt, apiKey, model, signal)
        : kind === "openrouter" ? await callOpenAi(OPENROUTER_CALL, prompt, apiKey, model, signal)
        : await callOpenAi(GROQ_CALL, prompt, apiKey, model, signal);
    return parseRows(content, req);
}

/** Try the primary provider (OpenRouter by default); on ANY upstream failure —
 *  rate limit, overload, out of credits (402), or even a bad primary key — fall
 *  back to a second provider (the direct Groq key) so a paying user still gets a
 *  translation. The fallback
 *  shares the caller's abort signal, so once the request's time budget is spent
 *  (signal already aborted) we surface the primary error instead of starting a
 *  second call that can only abort. With no fallback configured this is just
 *  `translate`. */
export async function translateWithFallback(
    req: BatchRequest, primary: Provider, fallback: Provider | null, signal?: AbortSignal
): Promise<Result[]> {
    try {
        return await translate(req, primary, signal);
    } catch (e) {
        if (!fallback || signal?.aborted) throw e;
        return await translate(req, fallback, signal);
    }
}
