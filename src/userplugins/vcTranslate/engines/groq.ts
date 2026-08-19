import { HttpError } from "../httpError";
import { rateLimitFromHeaders, retryAfterFromHeader, type ProviderRateLimit } from "../rateHint";
import { effectiveGroqModel, type BatchRequest, type Result } from "../types";
import { buildPrompt, extractRows, mapRows, parseJsonText, SCHEMA } from "./llmShared";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// buildPrompt, enc, the injection guard, the translations schema and the
// row-validation/hallucinated-id-filtering pass all live in ./llmShared,
// shared with engines/claude.ts and engines/gemini.ts. This engine is a THIRD
// SIBLING of those two, not a parallel implementation: everything about what
// we ask for and what we then trust is the same code, and only the transport
// (an OpenAI-compatible chat-completions call) differs.
export { buildPrompt };

/** The top-level keys of a value, or "" if it isn't a plain object/array. */
function topLevelKeys(value: unknown): string {
    if (value === null || typeof value !== "object") return "";
    return Object.keys(value as object).join(", ");
}

/**
 * What a successful Groq call reports about our remaining allowance, alongside
 * the translations themselves.
 *
 * WHY THE RETURN TYPE DIFFERS FROM ITS TWO SIBLINGS. Claude and Gemini return
 * a bare `Result[]` because a bare `Result[]` is everything they know. Groq's
 * 200 also carries `x-ratelimit-remaining-requests` — the provider's own count
 * of what is left — and the engine is the ONLY code that ever sees a Response
 * object, so a value not returned here is a value parsed and thrown away. It
 * rides back as a second field rather than as a callback or module state
 * because a return value is the one channel that cannot be missed, reordered,
 * or left over from a previous request.
 */
export interface GroqOutcome {
    results: Result[];
    /** Undefined when the response carried no rate-limit headers at all. */
    rateLimit?: ProviderRateLimit;
}

/**
 * The OpenAI chat-completions response shape: `choices[0].message.content`.
 *
 * DIFFERENT FROM GEMINI'S `steps` WALK, IDENTICAL IN DISCIPLINE. Parsed as
 * defensively as parseGeminiResponse parses its own endpoint: every access is
 * an explicit typeof/Array.isArray check (never `?.`, which would silently
 * collapse a shape mismatch into `undefined` and produce a confusing
 * downstream error instead of a diagnosable one), and the "no content found"
 * error carries the response's own top-level keys so a shape change is
 * diagnosable from the Discord console rather than a silent failure.
 *
 * This has NOT been measured against a live Groq key — there is none on this
 * machine yet — which is exactly why it is written this way. The one thing a
 * shape we have not seen must not do is fail quietly.
 *
 * Choices are walked in order and the first with string content wins, rather
 * than indexing `choices[0]` blindly: `n` defaults to 1 so there is normally
 * only one, but a response whose first choice carried a tool call and no text
 * would otherwise read as "no content" while the answer sat one element along.
 *
 * The INNER text is handed to ./llmShared, unchanged, which is what makes this
 * tolerate a ```json fence, a bare top-level array instead of
 * `{translations:[...]}`, and numeric ids — all three of which the live Gemini
 * endpoint actually sends despite being asked for none of them. Assuming a new
 * provider will be better behaved than the last one is not a bet worth taking,
 * and a second, stricter parser here is how the two engines would come to
 * disagree about what a valid response is.
 */
/**
 * Keep a reasoning model's thinking out of the reply.
 *
 * Groq's recommended replacements for the decommissioned Llama 3.3 are both
 * reasoning models. Left alone they emit their working — gpt-oss into a
 * separate `reasoning` field that consumes the budget before any answer
 * appears, qwen as a `<think>` block inside the content, which is not the JSON
 * this engine parses. "low" rather than "off" because the reasoning is what
 * makes these models better at the colloquial readings we want; it just has no
 * business in the output.
 */
const REASONING_CONTROLS = { reasoning_effort: "low", reasoning_format: "hidden" } as const;

/**
 * Whether to send the controls above at all.
 *
 * A prefix test, not a list of model ids: the list would be stale the moment a
 * provider ships a new one, and this is only ever the FIRST guess — a wrong
 * answer costs one retry, never a failed translation. See the 400 handling in
 * `translateWithGroq`.
 */
export function looksLikeReasoningModel(model: string): boolean {
    return /^(openai\/gpt-oss|qwen\/)/i.test(model.trim());
}

export function parseGroqResponse(body: unknown, req: BatchRequest, debug = false): Result[] {
    if (body === null || typeof body !== "object") {
        throw new Error(`groq: response is not an object (got ${typeof body})`);
    }

    const choices = (body as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) {
        throw new Error(`groq: missing choices array (response keys: ${topLevelKeys(body)})`);
    }

    let text: string | undefined;
    for (const choice of choices) {
        if (choice === null || typeof choice !== "object") continue;
        const message = (choice as { message?: unknown }).message;
        if (message === null || typeof message !== "object") continue;
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") {
            text = content;
            break;
        }
    }

    if (text === undefined) {
        throw new Error(
            `groq: no message content found in any choice (response keys: ${topLevelKeys(body)})`
        );
    }

    const parsed = parseJsonText(text, "groq");
    const rows = extractRows(parsed, "groq");
    return mapRows(rows, req, debug);
}

/**
 * The output contract, asked for in the PROMPT rather than in a
 * `response_format` field — and that is a deliberate, load-bearing choice.
 *
 * OpenAI-compatible JSON modes are per-model. Sending `response_format` for a
 * model that does not support it is a 400 on EVERY request, and this plugin
 * has already lost a week to a configuration that failed identically on every
 * request while looking like throttling. Since the model is a user-editable
 * setting, that failure would be one paste away for any user who tries a model
 * off Groq's list. The prompt costs a few tokens, cannot 400, and degrades to
 * exactly what ./llmShared already tolerates if it is ignored — which is what
 * the measured Gemini behaviour proves a schema field does anyway.
 */
function groqPrompt(req: BatchRequest): string {
    return `${buildPrompt(req)}\n\n`
        + "Return ONLY a JSON object matching this schema — no prose, no code fence:\n"
        + JSON.stringify(SCHEMA);
}

/**
 * `model` is a PARAMETER, not a constant, and it comes from a user setting
 * (see `groqModel` in settings.ts, defaulted from DEFAULT_GROQ_MODEL in
 * types.ts). This is the single most expensive lesson in this project's
 * history, applied before the first request has ever been sent rather than
 * after a week of misdiagnosis: a hardcoded model that loses its free-tier
 * allowance returns 429 forever, which is indistinguishable from rate limiting
 * from the outside, and a compiled-in constant makes recovering from that a
 * REBUILD rather than a settings edit. A blank/absent value falls back to the
 * default rather than sending `"model": ""`, which would be a 400 on every
 * request — strictly worse than the 429 it was trying to escape.
 *
 * KNOWN GAP, flagged rather than guessed at: no output-token cap is sent and
 * no `finish_reason` is checked, so this has no equivalent of claude.ts's
 * TRUNCATED_ERROR. Sending `max_tokens` would mean picking a number valid for
 * every model a user might paste into the setting, and a value above a model's
 * ceiling is a 400 on every request — the failure mode this file is most
 * concerned with. Omitting it means the server's own default for the chosen
 * model applies, which is the largest budget available. If a 25-message batch
 * ever did exhaust it, the cut-off JSON surfaces as "response was not valid
 * JSON", which native.ts's isRetryable treats as retryable, so the batch would
 * be sent twice before failing — a bounded, visible cost, unlike a 400 storm.
 */
export async function translateWithGroq(
    req: BatchRequest,
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
    model?: string,
    debug = false
): Promise<GroqOutcome> {
    // Handles blank AND retired values — see effectiveGroqModel. A user still
    // on the decommissioned default would otherwise get a 400 on every request.
    const chosenModel = effectiveGroqModel(model);

    const headers = {
        "content-type": "application/json",
        // A Bearer token, unlike Gemini's `x-goog-api-key` and Claude's
        // `x-api-key` — the one thing about this transport that is neither
        // sibling's.
        authorization: `Bearer ${apiKey}`
    };

    const send = (withReasoningControls: boolean): Promise<Response> => fetchImpl(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model: chosenModel,
            messages: [{ role: "user", content: groqPrompt(req) }],
            ...(withReasoningControls ? REASONING_CONTROLS : {})
        })
    });

    let res = await send(looksLikeReasoningModel(chosenModel));

    // A reasoning model that is not told to keep quiet answers with an empty
    // `content` and its whole budget spent in a `reasoning` field — measured,
    // not guessed: gpt-oss-120b returned "" with finish_reason "length". And a
    // NON-reasoning model 400s outright on those same parameters. Since the
    // model is a user-editable setting, neither can be assumed, so a refusal
    // that names one of them is retried once without them. That keeps an
    // unrecognised model a user pastes working, instead of failing on every
    // request in a way that reads like throttling.
    if (res.status === 400) {
        const text = await res.clone().text().catch(() => "");
        if (/reasoning_(effort|format)/i.test(text)) {
            res = await send(false);
        }
    }

    if (!res.ok) {
        // Deliberately does not include the request body or key.
        //
        // ONLY the `Retry-After` header is consulted. OpenAI-compatible
        // services send one, and rateHint.ts's retryAfterFromHeader already
        // parses it. Gemini's message-text parsing (retryAfterFromGeminiBody,
        // quotaLimitFromGeminiBody, modelFromGeminiBody) is deliberately NOT
        // applied here: it reads Google's own error PROSE, and pointing it at
        // another vendor's error body could only ever produce a coincidental
        // match — a fabricated cooldown or, far worse, a fabricated
        // "limit: N" that would retune the rate gate from a number nobody
        // stated.
        //
        // No `quotaLimitPerMinute` is reported for the same reason the header
        // is not used for it: `x-ratelimit-limit-requests` is a per-DAY figure
        // on this provider (see ProviderRateLimit in rateHint.ts), and the
        // rate gate takes a per-MINUTE ceiling. Reporting the daily number
        // there would open the gate to thousands of requests a minute.
        throw new HttpError(`groq: HTTP ${res.status}`, res.status, retryAfterFromHeader(res));
    }

    // Read BEFORE the body: `res.json()` is what can throw here (a malformed
    // 200), and losing the provider's remaining count to a parse failure would
    // mean the indicator goes stale exactly when something is going wrong.
    const rateLimit = rateLimitFromHeaders(res);
    return { results: parseGroqResponse(await res.json(), req, debug), rateLimit };
}
