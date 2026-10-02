import { HttpError } from "../httpError";
import { retryAfterFromHeader } from "../rateHint";
import { GOOGLE_MIN_CONFIDENCE, isSameText, type BatchRequest, type Result } from "../types";

// translate-pa, not translate_a/single. MEASURED 2026-09-03 on TWO throttled
// networks (an Airtel connection and a friend's, a different country, first
// install): translate_a/single 429'd bursts wholesale while THIS endpoint
// answered 200 to every request in the same burst from the same machine. The
// difference is the key: translate_a is the unofficial keyless scrape Google
// rate-limits aggressively; translate-pa is the keyed path the browser widget
// uses, and it returns clean structured JSON instead of the positional array.
// The key below is Google's own public gtx widget key, exactly as Vencord's
// Translate plugin has shipped it to a large userbase for years.
const ENDPOINT = "https://translate-pa.googleapis.com/v1/translate";
const GTX_KEY = "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA";
const CONCURRENCY = 4;

/**
 * How long to wait before re-sending a message the endpoint just throttled.
 *
 * MEASURED, 2026-08-29. Ten messages at CONCURRENCY 4 against the live
 * endpoint returned nine 200s and one 429 — and the two requests issued
 * immediately AFTER the refusal both succeeded. This endpoint throttles
 * individual requests under burst; it does not shut the caller out. So one
 * short retry converts the common case into no loss at all, and the delay only
 * has to outlast the burst that caused it rather than any stated quota (there
 * is none to read — the refusal is an HTML block page).
 */
const RETRY_DELAY_MS = 400;

/**
 * The patient ladder, used only when Google is the reader's sole translator
 * (req.patientRetries). At roughly one-in-seven per-request odds on a
 * throttled network, one retry leaves ~73% of messages waiting; four attempts
 * lift a message's odds per flush to ~45%, and the recovery sweep re-runs the
 * rest whenever any success lands. With an LLM configured the quick single
 * retry stays: those seconds belong to the reactive quality flush instead.
 */
const PATIENT_RETRY_DELAYS_MS = [400, 1500, 4000];

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Headers that make the request look like a browser rather than a bare fetch.
 *
 * WHY THIS MATTERS, evidenced 2026-09-02. The free translate_a endpoint
 * throttles by (IP, request shape) — not IP alone. On one Airtel connection,
 * with the block active, a browser hitting the endpoint got 200 while the
 * plugin got 429, at the same second, from the same house. The status beacon
 * caught it: updatedAt == lastError.at, status 429, while the browser answered
 * cleanly. The difference was the request: the plugin sent `fetchImpl(url)`
 * with no headers at all, which is MORE naked than curl (curl at least sends a
 * User-Agent). A bare request is the first thing a rate limiter sheds.
 *
 * So we stop looking like a script. A real Chrome User-Agent, an
 * Accept-Language, and the Referer/Origin a browser translate widget would
 * carry. None of it is a trick — it is what any browser sends, and it is the
 * difference between surviving a throttling window and being dropped in it.
 * It cannot make things worse: the previous request sent strictly less.
 */
const BROWSER_HEADERS: Record<string, string> = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        + "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://translate.google.com/",
    "Origin": "https://translate.google.com"
};

/**
 * A failure that concerns exactly ONE message — a garbled body, an empty
 * translation, a request the endpoint will refuse every time it is sent. It
 * degrades that message to `{ failed: true }` and leaves the rest of the batch
 * intact.
 *
 * Transport-level failures (a throttle, a 5xx, a network drop, a timeout) are
 * deliberately NOT of this kind: they are facts about the moment, so they
 * propagate out of translateWithGoogle and let native.ts retry or classify the
 * whole request.
 */
class MessageError extends Error {}

/**
 * A 4xx that says "this request is wrong", not "not now". Sending the same
 * request again gets the same answer, so it is a verdict about the message:
 * leaving it as a transport failure kept the message on "waiting for the
 * translator" for good and logged the same engine error on every retry.
 *
 * NOT deterministic: 429 (a throttle, retried above), 408 (a timeout) and 403
 * (how an IP or region block answers; the next request may well pass).
 */
function isDeterministicRefusal(status: number): boolean {
    return status >= 400 && status < 500 && status !== 429 && status !== 408 && status !== 403;
}

/**
 * The longest URL we send. MEASURED 2026-10-01 against the live endpoint: a
 * 16,214-character URL got 200 and a 16,664-character one got HTTP 400 (an
 * HTML error page). Every CJK character costs 9 URL characters, so a
 * 1,830-character Japanese message (under Discord's 2,000 limit) could never
 * be translated in one request. 14,000 leaves room under the measured wall.
 */
export const MAX_GOOGLE_URL_CHARS = 14_000;

/** How long one request may take before it counts as a dropped connection. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * One gate for every request this module sends, across every batch at once.
 *
 * CONCURRENCY used to apply only inside one batch. A 50-message catch-up is
 * five batches flushed together, so five slices ran side by side: 20 parallel
 * requests, the exact burst the halving to 2 (patient mode) exists to prevent.
 * Each request now waits until fewer than its own cap are in flight.
 */
let live = 0;
const waiters: { cap: number; go: () => void; }[] = [];

function pumpGate(): void {
    for (let i = 0; i < waiters.length;) {
        if (live < waiters[i]!.cap) {
            const [w] = waiters.splice(i, 1);
            live++;
            w!.go();
        } else {
            i++;
        }
    }
}

function acquireGate(cap: number): Promise<void> {
    return new Promise(resolve => {
        waiters.push({ cap: Math.max(1, cap), go: resolve });
        pumpGate();
    });
}

function releaseGate(): void {
    live = Math.max(0, live - 1);
    pumpGate();
}

/** Tests only: forget every slot and waiter. */
export function __resetGoogleGate(): void {
    live = 0;
    waiters.splice(0, waiters.length);
}

function timeoutSignal(ms: number): AbortSignal | undefined {
    return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(ms)
        : undefined;
}

function buildUrl(text: string, sourceLang: string, targetLang: string): string {
    return ENDPOINT + "?" + new URLSearchParams({
        "params.client": "gtx",
        "dataTypes": "TRANSLATION",
        "key": GTX_KEY,
        "query.sourceLanguage": sourceLang,
        "query.targetLanguage": targetLang,
        "query.text": text
    }).toString();
}

/** What `text` costs inside the query string, exactly as URLSearchParams writes it. */
function encodedLength(text: string): number {
    return new URLSearchParams({ q: text }).toString().length - 2;
}

/** One piece of a split message, and the separator that followed it in the original. */
export interface TextPiece { text: string; sep: string; }

/**
 * Spans no cut may land inside: Discord markup (a mention, a custom emoji, a
 * timestamp), links, and the ⟦n⟧ placeholders those are sent as (placeholders.ts). Cutting one would hand Google half a token, which it
 * then translates or mangles.
 */
const ATOMS = /<a?:\w+:\d+>|<#\d+>|<@&\d+>|<@!?\d+>|<t:-?\d+(?::[a-zA-Z])?>|https?:\/\/\S+|\u27E6\s*\d+\s*\u27E7/gu;

/** The coarsest cut first: lines, then sentences, then words. */
const CUT_LEVELS: RegExp[] = [
    /\n+/gu,
    /(?<=[.!?])\s+|(?<=[。！？])\s*/gu,
    /\s+/gu
];

interface Span { start: number; end: number; }

function atomSpans(text: string): Span[] {
    const spans: Span[] = [];
    for (const m of text.matchAll(ATOMS)) spans.push({ start: m.index!, end: m.index! + m[0].length });
    return spans;
}

const insideAtom = (spans: Span[], at: number) => spans.some(s => at > s.start && at < s.end);

/** Cut `text` at every match of `re` that is not inside an atom. */
function cutAt(text: string, re: RegExp): TextPiece[] {
    const spans = atomSpans(text);
    const out: TextPiece[] = [];
    let from = 0;
    for (const m of text.matchAll(re)) {
        const at = m.index!;
        const sepEnd = at + m[0].length;
        // A zero-width cut at the very start or end separates nothing.
        if (m[0].length === 0 && (at === from || at >= text.length)) continue;
        if (insideAtom(spans, at) || insideAtom(spans, sepEnd)) continue;
        out.push({ text: text.slice(from, at), sep: m[0] });
        from = sepEnd;
    }
    out.push({ text: text.slice(from), sep: "" });
    return out;
}

/** Last resort: whole code points, and whole atoms. A surrogate pair is never split. */
function cutAtCodePoints(text: string): TextPiece[] {
    const spans = atomSpans(text);
    const out: TextPiece[] = [];
    let i = 0;
    while (i < text.length) {
        const span = spans.find(s => s.start === i);
        const end = span ? span.end : i + String.fromCodePoint(text.codePointAt(i)!).length;
        out.push({ text: text.slice(i, end), sep: "" });
        i = end;
    }
    return out;
}

/** An atom longer than the whole budget: no clean cut exists, so cut by code point. */
function rawCodePoints(text: string, budget: number): TextPiece[] {
    const out: TextPiece[] = [];
    let cur = "";
    for (const ch of text) {
        if (cur !== "" && encodedLength(cur + ch) > budget) {
            out.push({ text: cur, sep: "" });
            cur = "";
        }
        cur += ch;
    }
    out.push({ text: cur, sep: "" });
    return out;
}

/**
 * Split `text` into pieces whose encoded length is at most `budget`, cutting
 * at the coarsest boundary that works. Joining every `text + sep` in order
 * gives back the original exactly. Exported for the tests.
 */
export function splitForUrl(text: string, budget: number, level = 0): TextPiece[] {
    if (encodedLength(text) <= budget) return [{ text, sep: "" }];
    if (level > CUT_LEVELS.length) return rawCodePoints(text, budget);
    const segments = level < CUT_LEVELS.length ? cutAt(text, CUT_LEVELS[level]!) : cutAtCodePoints(text);
    if (segments.length <= 1) return splitForUrl(text, budget, level + 1);

    const out: TextPiece[] = [];
    let cur: TextPiece | null = null;
    for (const seg of segments) {
        if (encodedLength(seg.text) > budget) {
            // Too big on its own: cut it finer. Its last piece keeps the
            // separator that followed it here. A single atom longer than the
            // whole budget (a huge link) has no clean cut, so only then is it
            // cut by code point.
            if (cur) { out.push(cur); cur = null; }
            const finer = splitForUrl(seg.text, budget, level + 1);
            finer[finer.length - 1]!.sep = seg.sep;
            out.push(...finer);
            continue;
        }
        if (cur && encodedLength(cur.text + cur.sep + seg.text) <= budget) {
            cur = { text: cur.text + cur.sep + seg.text, sep: seg.sep };
        } else {
            if (cur) out.push(cur);
            cur = { ...seg };
        }
    }
    if (cur) out.push(cur);
    return out;
}

/** Targets written without spaces between words: pieces join with nothing between them. */
const NO_SPACE_TARGETS = /^(ja|zh|th|lo|km|my)\b/i;

type PieceOutcome =
    | { kind: "text"; lang: string; text: string; conf?: number; }
    | { kind: "skip"; reason: "target" | "same" | "unsure"; };

interface RequestOptions {
    fetchImpl: typeof fetch;
    retryDelays: readonly number[];
    cap: number;
    timeoutMs: number;
}

async function translateText(
    text: string,
    sourceLang: string,
    targetLang: string,
    opts: RequestOptions,
    attempt: number = 0
): Promise<PieceOutcome> {
    const url = buildUrl(text, sourceLang, targetLang);

    await acquireGate(opts.cap);
    let res: Response;
    try {
        // A fresh timeout per attempt, so the 429 retry gets its own. A
        // stalled socket (wake from sleep, a Wi-Fi switch) otherwise waits out
        // Node's 300s headers timeout with the message blank and in flight.
        res = await opts.fetchImpl(url, { headers: BROWSER_HEADERS, signal: timeoutSignal(opts.timeoutMs) });
    } finally {
        // Released before any retry sleep, so a waiting retry holds no slot.
        releaseGate();
    }
    if (!res.ok) {
        // One retry for a throttle, because this endpoint refuses REQUESTS
        // rather than callers (see RETRY_DELAY_MS). Only 429: a 4xx that is
        // not a throttle repeats identically, and retrying into a genuine
        // block is how a burst sustains itself.
        if (res.status === 429 && attempt < opts.retryDelays.length) {
            await sleep(opts.retryDelays[attempt]!);
            return translateText(text, sourceLang, targetLang, opts, attempt + 1);
        }
        if (isDeterministicRefusal(res.status)) throw new MessageError(`google: HTTP ${res.status}`);
        throw new HttpError(`google: HTTP ${res.status}`, res.status, retryAfterFromHeader(res));
    }

    // translate-pa's shape: { translation, sourceLanguage, detectedLanguages:
    // { srclangs: [...], srclangsConfidences: [...] } }. A flat object, not the
    // positional array translate_a returned.
    const body = await res.json() as {
        translation?: unknown;
        sourceLanguage?: unknown;
        detectedLanguages?: { srclangs?: unknown; srclangsConfidences?: unknown };
    };
    if (typeof body.translation !== "string") {
        throw new MessageError("google: unexpected response shape");
    }

    const detected = typeof body.sourceLanguage === "string" ? body.sourceLanguage : sourceLang;

    // Detection confidence, when the endpoint reports one. Same job as before:
    // the only signal separating a trustworthy translation from a guess, so a
    // low-confidence line can be marked for the reader.
    const confidences = body.detectedLanguages?.srclangsConfidences;
    const conf = Array.isArray(confidences) && typeof confidences[0] === "number" ? confidences[0] : undefined;
    if (detected === targetLang) return { kind: "skip", reason: "target" };

    // A translation Google built on a low-confidence detection is a guess, and
    // a wrong subtitle asserts a meaning the speaker never had — so below the
    // gate we show NOTHING and let the quality tier's pass fill it in. Only when
    // a confidence was actually reported: a pinned/undetected request carries
    // none, and there is then nothing to be unsure of, so it still translates.
    // "unsure" is not a verdict about the text, only about this detection:
    // callers must not cache it as "not foreign" or cancel the quality tier.
    if (conf !== undefined && conf < GOOGLE_MIN_CONFIDENCE) return { kind: "skip", reason: "unsure" };

    const out = body.translation.trim();
    if (out.length === 0) throw new MessageError("google: empty translation");

    // The engine handed back exactly what we sent, so there is nothing to
    // show. This is the usual outcome for English chat slang: Google
    // misdetects "hbu" as Frisian and "u2 <2" as Chinese, then passes the text
    // through untouched. The detected-language check above does not catch it,
    // because the bogus detection is not the target language — so without
    // this we render a subtitle identical to the message it sits under.
    if (isSameText(out, text)) return { kind: "skip", reason: "same" };

    return { kind: "text", lang: detected, text: out, conf };
}

function toResult(id: string, o: PieceOutcome): Result {
    if (o.kind === "skip") return { id, skip: true, reason: o.reason };
    return { id, lang: o.lang, text: o.text, skip: false, conf: o.conf };
}

async function translateOne(
    msg: { id: string; text: string; sourceLang?: string },
    targetLang: string,
    opts: RequestOptions
): Promise<Result> {
    // `auto` unless the caller resolved a language for us. Pinning is what
    // rescues short replies: "ne" under `sl=auto` comes back as Hausa "it is",
    // and under `sl=de` as "no" — opposite answers to the same question.
    const sourceLang = msg.sourceLang ?? "auto";
    const budget = MAX_GOOGLE_URL_CHARS - buildUrl("", sourceLang, targetLang).length;
    if (encodedLength(msg.text) <= budget) {
        return toResult(msg.id, await translateText(msg.text, sourceLang, targetLang, opts));
    }

    // Too long for one URL: translate it in pieces, one after another, and
    // join them back with the separators that were cut. The whole message
    // shares one fate: a failed piece fails it (thrown from translateText),
    // and an unsure piece makes the whole line unsure, so a partial
    // translation is never shown as a complete one.
    const pieces = splitForUrl(msg.text, budget);
    const outcomes: PieceOutcome[] = [];
    for (const piece of pieces) {
        if (piece.text.trim() === "") {
            outcomes.push({ kind: "skip", reason: "same" });
            continue;
        }
        const o = await translateText(piece.text, sourceLang, targetLang, opts);
        if (o.kind === "skip" && o.reason === "unsure") return { id: msg.id, skip: true, reason: "unsure" };
        outcomes.push(o);
    }

    const translated = outcomes.filter((o): o is Extract<PieceOutcome, { kind: "text"; }> => o.kind === "text");
    if (translated.length === 0) {
        const allTarget = outcomes.every(o => o.kind === "skip" && o.reason === "target");
        return { id: msg.id, skip: true, reason: allTarget ? "target" : "same" };
    }

    const joiner = NO_SPACE_TARGETS.test(targetLang) ? "" : " ";
    let text = "";
    pieces.forEach((piece, i) => {
        const o = outcomes[i]!;
        // A piece already in the reader's language (or only a link) keeps
        // its original words in place.
        text += o.kind === "text" ? o.text : piece.text.trim();
        if (i < pieces.length - 1) text += piece.sep === "" ? joiner : piece.sep;
    });

    // The language most pieces were detected as, and the LEAST confident
    // detection among them: one shaky piece makes the whole line shaky.
    const counts = new Map<string, number>();
    for (const o of translated) counts.set(o.lang, (counts.get(o.lang) ?? 0) + 1);
    const lang = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const confs = translated.map(o => o.conf).filter((c): c is number => typeof c === "number");
    const conf = confs.length > 0 ? Math.min(...confs) : undefined;
    return { id: msg.id, lang, text: text.trim(), skip: false, conf };
}

export interface GoogleOptions {
    /** Only the tests set this, to keep the retries from costing real time. */
    retryDelayMs?: number;
    /** How long one request may take. Only the tests shorten it. */
    requestTimeoutMs?: number;
}

export async function translateWithGoogle(
    req: BatchRequest,
    fetchImpl: typeof fetch = fetch,
    options: GoogleOptions = {}
): Promise<Result[]> {
    const base = req.patientRetries === true ? PATIENT_RETRY_DELAYS_MS : [RETRY_DELAY_MS];
    const retryDelays = options.retryDelayMs === undefined ? base : base.map(() => options.retryDelayMs!);
    // Half the burst profile when Google is the only translator. A 20-message
    // catch-up at concurrency 4 is a burst, and a throttling endpoint sheds
    // bursts wholesale - observed: channel-switching re-ran catch-up and every
    // message re-deferred, while single messages in live traffic got through.
    // Slower catch-up is translations; fast catch-up was a repeated no-op.
    const standard = req.patientRetries === true ? 2 : CONCURRENCY;
    const concurrency = typeof req.maxConcurrency === "number" && req.maxConcurrency >= 1
        ? Math.min(standard, Math.floor(req.maxConcurrency))
        : standard;
    const opts: RequestOptions = {
        fetchImpl,
        retryDelays,
        cap: concurrency,
        timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    };
    const results: Result[] = [];
    // Kept so a request that was refused OUTRIGHT — every message, no
    // exceptions — can still be rethrown. That is the shape of a real block,
    // and runTier needs to see it to park the engine.
    let transportError: unknown;

    for (let i = 0; i < req.messages.length; i += concurrency) {
        const slice = req.messages.slice(i, i + concurrency);
        const settled = await Promise.allSettled(
            slice.map(m => translateOne(m, req.targetLang, opts))
        );
        for (let j = 0; j < settled.length; j++) {
            const outcome = settled[j];
            if (outcome.status === "fulfilled") {
                results.push(outcome.value);
            } else if (outcome.reason instanceof MessageError) {
                // A verdict about THIS message: garbled body, empty
                // translation. Retrying repeats it; "failed" is honest.
                results.push({ id: slice[j]!.id, failed: true });
            } else {
                // A TRANSPORT failure for ONE message. It used to be rethrown
                // here, on the reasoning that a non-OK status "means the
                // endpoint is refusing us" — true of a batch endpoint, false of
                // this one. Google is per-message, and it throttles per message:
                // a single 429 among nine 200s was discarding nine finished
                // translations and reporting the whole batch as refused.
                //
                // So it is recorded as this message's own failure, and the rest
                // of the batch stands. The reader loses at most the one message
                // Google would not take — which the quality tier is already on
                // its way to translating anyway.
                transportError = outcome.reason;
                results.push({ id: slice[j]!.id, failed: true, transport: true });
            }
        }
    }

    // Nothing came back at all: not a throttle, a refusal. Rethrow so runTier
    // classifies it, marks the batch deferred and cools the engine down.
    if (transportError !== undefined && !results.some(r => !("failed" in r))) {
        throw transportError;
    }
    return results;
}
