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
    /**
     * The reader pressed ⚡: translate every message, never skip. Optional, so
     * an older client (or any request without it) gets the exact prompt it
     * always got.
     */
    force?: true;
}

/**
 * The rule a forced request gets INSTEAD of the skip rule. General wording,
 * no examples: the reader asked for these messages, so nothing is skipped.
 */
export function forcedRule(tgt: string): string {
    return "- The reader asked for every message below to be translated. Translate each one into " + tgt
        + ", even if it looks like a name, slang, or is already written in " + tgt
        + ". Never skip: always set skip to false and put the translation in text. "
        + "If a message is already in " + tgt + ", give it back as it is.";
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

/** The normal rule: skip what does not need translating. */
function skipRule(tgt: string): string {
    return "- Set skip to true and text to \"\" whenever a message does NOT need translating into "
        + tgt + ". That covers two cases. (1) The message is already written in "
        + tgt + " — INCLUDING slang, abbreviations, and memes written in "
        + tgt + ". (2) The message is not really another language: a proper noun, "
        + "username, brand or game name, an emoji or reaction, or a short abbreviation or bit of "
        + "gibberish with no translatable meaning. Only translate a message genuinely written in a "
        + "DIFFERENT language than " + tgt + " — foreign-language slang still gets "
        + "translated. Use your own knowledge of the language, not a fixed word list: for an English "
        + "reader, things like \"og\", \"gng\", \"less go\" are English and should skip; for a reader "
        + "whose language is not English, English text should still be translated.";
}

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
        req.force === true ? forcedRule(tgt) : skipRule(tgt),
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
        "- Message text and author names are JSON-encoded strings. Decode the escape sequences and translate the underlying text.",
        // LINE BREAKS (field report, 0.1.6): a two-line message came back as one
        // line. The older wording, "never emit escape sequences in your output",
        // told the model the one legal way to write a line break in JSON (\n)
        // was forbidden. The reply is JSON, so it escapes what JSON requires;
        // the translation itself gains no escapes of its own.
        "- Your reply must be valid JSON: escape quotes, backslashes and line breaks as JSON requires. "
        + "Keep the same line breaks as the message, line for line. "
        + "Do not add escape sequences to the translated text itself.",
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

/**
 * Escape raw control characters that sit INSIDE JSON strings.
 *
 * A model asked to keep line breaks sometimes writes a real newline inside a
 * JSON string instead of \n. JSON.parse rejects that ("Bad control character
 * in string literal") and the whole batch would fail. Used ONLY after a plain
 * parse has failed: walks the text tracking whether it is inside a string
 * (honouring backslash escapes) and rewrites raw \n, \r and \t there as the
 * escapes JSON requires. Text outside strings is left exactly as it was.
 */
export function escapeRawControlsInStrings(text: string): string {
    let out = "";
    let inString = false;
    let escaped = false;
    for (const ch of text) {
        if (!inString) {
            if (ch === "\"") inString = true;
            out += ch;
            continue;
        }
        if (escaped) { escaped = false; out += ch; continue; }
        if (ch === "\\") { escaped = true; out += ch; continue; }
        if (ch === "\"") { inString = false; out += ch; continue; }
        if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else out += ch;
    }
    return out;
}

/**
 * A multi-line message whose translation came back with the two characters
 * backslash-n instead of line breaks (a model that escaped twice). Only when
 * the source had a real newline and the translation has none: then every
 * literal \n (or \r\n) becomes a real line break. Anything else is untouched.
 */
export function restoreLineBreaks(text: string, source: string): string {
    if (!source.includes("\n") || text.includes("\n") || !text.includes("\\n")) return text;
    return text.replace(/\\r\\n|\\n/g, "\n");
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
        // ORDER MATTERS. First the preamble/trailer salvage, exactly as before.
        // Only then the raw-control repair, and only over the SLICED JSON:
        // run over prose, one stray double quote before the JSON flips the
        // in-string state and the repair would break a reply the salvage
        // alone parses (measured: prose with an odd quote, then pretty-printed
        // JSON).
        const sliced = sliceJson(unfenced);
        let done = false;
        if (sliced !== null) {
            try { parsed = JSON.parse(sliced); done = true; } catch { /* repair below */ }
        }
        if (!done) {
            const target = sliced ?? unfenced;
            const repaired = escapeRawControlsInStrings(target);
            if (repaired === target) throw { status: 502 } as TranslateError;
            try { parsed = JSON.parse(repaired); }
            catch { throw { status: 502 } as TranslateError; }
        }
    }
    const byId = new Map<string, any>();
    for (const r of rowsOf(parsed)) {
        if (r && typeof r === "object" && "id" in r) byId.set(String((r as any).id), r);
    }
    // Parseable JSON in the wrong shape ({"foo":1}, ids keyed in an object)
    // answers NOTHING that was asked. That is an upstream failure, not a batch
    // of per-message verdicts: a 502 gives the fallback provider its turn and,
    // if that fails too, refunds the user. A partial match is kept as it is:
    // the matched rows are good translations. Never logged (user text).
    if (!req.messages.some(m => byId.has(m.id))) throw { status: 502 } as TranslateError;
    return req.messages.map(({ id, text: source }): Result => {
        const r = byId.get(id);
        if (!r) return { id, failed: true };
        if (r.skip === true) return { id, skip: true };
        const text = typeof r.text === "string" ? r.text : "";
        const lang = typeof r.lang === "string" ? r.lang : "";
        if (text.trim() === "" || lang === "") return { id, failed: true };
        return { id, lang, text: restoreLineBreaks(text, source), skip: false };
    });
}

/** The rows of a parsed reply: a bare array, {translations:[...]}, or, as a
 *  tolerance, an object whose ONLY array-valued property holds them (a model
 *  that wrote {"results":[...]}). Content stays strict: ids are still matched
 *  and lang/text still required by the caller. */
function rowsOf(parsed: unknown): unknown[] {
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== "object") return [];
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.translations)) return o.translations;
    const arrays = Object.values(o).filter(Array.isArray);
    return arrays.length === 1 ? arrays[0] as unknown[] : [];
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

/** The primary provider's own deadline for the SMALLEST request when a
 *  fallback exists. A degraded primary (answers slower than this, or hanging)
 *  gives up here, so the fallback still has the rest of the request's time
 *  budget. A bigger request gets more (primaryTimeoutFor). */
export const PRIMARY_TIMEOUT_MS = 9_000;
/** Extra primary time per character of message text. */
export const PRIMARY_MS_PER_CHAR = 3;
/** The most the primary ever gets: what it had before the fallback had its own
 *  share (the old single-provider deadline), so a healthy but slow primary on a
 *  long batch is never cut off sooner than it used to be. */
export const PRIMARY_TIMEOUT_MAX_MS = 20_000;

/**
 * The primary's own deadline for `req`. Output time grows with the text to
 * translate, so a fixed cutoff that suits a short batch cuts off a HEALTHY
 * primary on a long one, and the fallback then starts from zero with less time
 * than the primary had (both fail, the user is charged). Short batches keep the
 * quick hand-over to the fallback; long ones keep most of the budget on the
 * primary and fall back on a fast failure. Characters, not bytes: a CJK
 * character is about one token, three UTF-8 bytes.
 *
 * NOT MEASURED. No latency figures exist in the repo; these numbers are set so
 * no request is cut off sooner than before this deadline existed once it is
 * long (3,667+ characters get the old 20 s), and a short one still falls back
 * in about 9 to 12 s. Measure p95 latency per size and retune.
 */
export function primaryTimeoutFor(req: BatchRequest): number {
    const chars = req.messages.reduce((n, m) => n + m.text.length, 0);
    return Math.min(PRIMARY_TIMEOUT_MAX_MS, PRIMARY_TIMEOUT_MS + chars * PRIMARY_MS_PER_CHAR);
}

/** What translateWithFallback throws. `status` and `retryAfterMs` are the LAST
 *  attempt's (what the user's retry should follow); `primaryStatus` is the
 *  primary's when a fallback also ran (undefined for a network error or a
 *  timeout); `timedOut` is set only when the request's own time budget ran out,
 *  i.e. the final attempt was cut off and may have been billed. */
export interface FallbackError { status?: number; retryAfterMs?: number; primaryStatus?: number; timedOut?: boolean }

export interface FallbackOptions {
    /** Override primaryTimeoutFor(req) (tests). */
    primaryTimeoutMs?: number;
    /** Called once when the primary fails, before the fallback runs. */
    onPrimaryFail?: (status: number | undefined) => void;
}

function statusOf(e: unknown): number | undefined {
    const s = (e as any)?.status;
    return typeof s === "number" ? s : undefined;
}

function failure(e: unknown, extra: Partial<FallbackError>): FallbackError {
    const out: FallbackError = { ...extra };
    const status = statusOf(e);
    if (status !== undefined) out.status = status;
    const ra = (e as any)?.retryAfterMs;
    if (typeof ra === "number") out.retryAfterMs = ra;
    return out;
}

/** Try the primary provider (OpenRouter by default); on ANY upstream failure —
 *  rate limit, overload, out of credits (402), a bad primary key, or the
 *  primary's own deadline (primaryTimeoutFor) — fall back to a second provider
 *  (the direct Groq key) so a paying user still gets a translation.
 *
 *  TIME. `signal` is the whole request's budget. The primary gets
 *  min(primaryTimeoutFor(req), that budget); the fallback gets whatever is left. A
 *  primary that hangs no longer eats the whole budget and leaves the healthy
 *  fallback unused (each such batch was charged and then retried by the
 *  client). Only when the request's own budget is spent is the fallback not
 *  started.
 *
 *  OBSERVABILITY. A primary failure is always logged with its status (never the
 *  text), and reported through `onPrimaryFail`, so an out-of-credit (402) or a
 *  dead key (401) on the primary is visible even while the fallback hides it
 *  from users. With no fallback configured this is just `translate`. */
export async function translateWithFallback(
    req: BatchRequest, primary: Provider, fallback: Provider | null, signal?: AbortSignal, opts: FallbackOptions = {}
): Promise<Result[]> {
    if (!fallback) {
        try { return await translate(req, primary, signal); }
        catch (e) {
            console.warn("provider failed, no fallback configured", { kind: primary.kind, status: statusOf(e) ?? "throw", aborted: !!signal?.aborted });
            throw failure(e, { timedOut: !!signal?.aborted });
        }
    }
    const own = new AbortController();
    const timer = setTimeout(() => own.abort(), opts.primaryTimeoutMs ?? primaryTimeoutFor(req));
    const onOuter = () => own.abort();
    if (signal?.aborted) own.abort();
    else signal?.addEventListener("abort", onOuter, { once: true });
    let primaryStatus: number | undefined;
    try {
        return await translate(req, primary, own.signal);
    } catch (e) {
        primaryStatus = statusOf(e);
        console.warn("primary provider failed, using fallback", {
            kind: primary.kind,
            status: primaryStatus ?? "throw",
            aborted: !!signal?.aborted,
            primaryTimedOut: own.signal.aborted && !signal?.aborted
        });
        try { opts.onPrimaryFail?.(primaryStatus); } catch { /* metrics only */ }
        if (signal?.aborted) throw failure(e, { timedOut: true });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuter);
    }
    try {
        return await translate(req, fallback, signal);
    } catch (f) {
        throw failure(f, { primaryStatus, timedOut: !!signal?.aborted });
    }
}

/** Message text characters in one upstream call before the relay splits a
 *  batch. An ordinary chat batch is far below this and goes out as ONE call,
 *  exactly as before. */
export const CHUNK_TEXT_CHARS = 4_000;
/** Upstream calls one request runs at once. A Worker opens at most 6
 *  connections at a time per request; more would queue and wait. */
export const MAX_PARALLEL_CHUNKS = 6;

/** Split `req` into at most MAX_PARALLEL_CHUNKS requests of contiguous
 *  messages, each about CHUNK_TEXT_CHARS of text (bigger when the batch is so
 *  long that 6 chunks must carry it). Every chunk keeps the full context. A
 *  message is never cut. Order is kept: concatenating the chunks' messages
 *  gives back req.messages. */
export function chunkBatch(req: BatchRequest): BatchRequest[] {
    const total = req.messages.reduce((n, m) => n + m.text.length, 0);
    if (total <= CHUNK_TEXT_CHARS || req.messages.length <= 1) return [req];
    const target = Math.max(CHUNK_TEXT_CHARS, Math.ceil(total / MAX_PARALLEL_CHUNKS));
    const groups: Message[][] = [];
    let cur: Message[] = [], chars = 0;
    for (const m of req.messages) {
        if (cur.length > 0 && chars + m.text.length > target && groups.length < MAX_PARALLEL_CHUNKS - 1) {
            groups.push(cur);
            cur = [];
            chars = 0;
        }
        cur.push(m);
        chars += m.text.length;
    }
    groups.push(cur);
    return groups.map(messages => ({ ...req, messages }));
}

/**
 * Translate a whole batch: a long one is split into chunks that run AT THE
 * SAME TIME, each with its own primary deadline and fallback
 * (translateWithFallback). A long batch's wait is then about one chunk's, not
 * the sum, so a 30 KB batch from a new client, or a 128 KB one from a 0.2.0
 * client that cannot split, fits the request's time budget instead of timing
 * out on both providers and staying charged.
 *
 * All or nothing, like a single call: the first chunk that fails stops the
 * others and its error is thrown (the caller refunds or charges exactly as for
 * one call). The results come back in the batch's own message order.
 */
export async function translateBatch(
    req: BatchRequest, primary: Provider, fallback: Provider | null, signal?: AbortSignal, opts: FallbackOptions = {}
): Promise<Result[]> {
    const chunks = chunkBatch(req);
    if (chunks.length === 1) return translateWithFallback(req, primary, fallback, signal, opts);
    const stop = new AbortController();
    const onOuter = () => stop.abort();
    if (signal?.aborted) stop.abort();
    else signal?.addEventListener("abort", onOuter, { once: true });
    try {
        const parts = await Promise.all(chunks.map(c =>
            translateWithFallback(c, primary, fallback, stop.signal, opts).catch(e => {
                // The first failure is the one Promise.all throws. Its
                // timedOut already says whether the request's own budget ran
                // out (stop only aborts with the outer signal until now).
                stop.abort();
                throw e;
            })
        ));
        return parts.flat();
    } finally {
        signal?.removeEventListener("abort", onOuter);
    }
}
