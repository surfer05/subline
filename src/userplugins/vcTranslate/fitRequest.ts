import type { BatchRequest } from "./types";

/**
 * Fitting a ✦ request inside what the relay (and the keyed providers) accept.
 *
 * WHY, measured 2026-10-01. The relay refuses a body over 32,768 bytes (413)
 * and any text over 4,000 characters (400). The batcher's 8-slot context ring
 * keeps earlier long messages, so seven 2,000-character Japanese posts in a
 * row grew the request to 6, 12, 18 ... 42 KB, and from the sixth on every ✦
 * batch in that channel was refused, including the short messages after them.
 */

/** A context text is only there to disambiguate. Its first part does that. */
export const CONTEXT_TEXT_MAX = 600;

/**
 * A reply's parent copy (R3) is cut to this many code points, "…" when cut.
 * Same as the relay's REPLY_PARENT_CHARS, which clips again on its side.
 */
export const REPLY_PARENT_MAX = 200;

export function clipParentText(text: string): string {
    const points = Array.from(text);
    return points.length <= REPLY_PARENT_MAX ? text : points.slice(0, REPLY_PARENT_MAX).join("") + "…";
}

/**
 * After a split: a reply whose parent went to ANOTHER part would lose its
 * link (the batcher dropped the parent's copy because the parent was in the
 * batch). Give it a clipped copy of the parent instead.
 */
function withParentCopies(part: BatchRequest["messages"], all: BatchRequest["messages"]): BatchRequest["messages"] {
    return part.map(m => {
        if (m.replyToId === undefined || m.replyTo !== undefined) return m;
        if (part.some(x => x.id === m.replyToId)) return m;
        const parent = all.find(x => x.id === m.replyToId);
        return parent === undefined ? m : { ...m, replyTo: { author: parent.author, text: clipParentText(parent.text) } };
    });
}

/** Under the relay's 32,768-byte limit, with room for headers and the wrapper. */
export const MAX_REQUEST_BYTES = 30_000;

/** The relay's per-text limit (relay/src/index.ts MAX_TEXT_CHARS). Older relays stay at this. */
export const LLM_TEXT_MAX = 4_000;

/** Spans a cut may not land inside: half of one would reach the translator as text. */
const UNCUTTABLE = /```[\s\S]*?```|`[^`\n]+`|<a?:\w+:\d+>|<#\d+>|<@&\d+>|<@!?\d+>|<t:-?\d+(?::[a-zA-Z])?>|https?:\/\/\S+/g;

/**
 * `text` cut to at most `max` UTF-16 units (what the relay counts), at the
 * last paragraph break, else the last sentence end, else the last space in
 * the second half, never inside a Discord token (a code block, inline code,
 * a link, a mention, an emoji, a timestamp) and never on half a surrogate
 * pair. No ellipsis is added: what is sent is real text the translator
 * reads as written. `partial` says it is only the first part.
 */
export function fitTextToLimit(text: string, max: number): { text: string; partial: boolean; } {
    if (text.length <= max) return { text, partial: false };
    const head = text.slice(0, max);
    const breaks = [head.lastIndexOf("\n\n"), head.lastIndexOf("\n")];
    const sentence = Math.max(...[". ", "! ", "? ", "。", "！", "？"].map(m => {
        const at = head.lastIndexOf(m);
        return at < 0 ? -1 : at + m.trimEnd().length;
    }));
    const floor = max / 2;
    let cut = breaks.find(at => at >= floor) ?? -1;
    if (cut < 0 && sentence >= floor) cut = sentence;
    if (cut < 0) cut = head.lastIndexOf(" ");
    if (cut < floor) cut = max;
    for (const m of text.matchAll(UNCUTTABLE)) {
        const start = m.index!, end = start + m[0].length;
        if (cut > start && cut < end) { cut = start; break; }
        if (start >= cut) break;
    }
    if (cut <= 0) cut = max;
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    return { text: text.slice(0, cut).trimEnd(), partial: true };
}

/**
 * A message text that fits the relay's per-text limit (G2). Over the limit
 * the relay answers that message with a failed row, so it could never get ✦
 * or a preview. The first part is sent instead, cut where fitTextToLimit
 * cuts. The ✦ line then translates that part, shown as it came back.
 */
export function fitMessageText(text: string): string {
    return fitTextToLimit(text, LLM_TEXT_MAX).text;
}

const encoder = new TextEncoder();

export function requestBytes(req: BatchRequest): number {
    return encoder.encode(JSON.stringify(req)).length;
}

/** The first `max` code points of `text`, with an ellipsis when it was cut. */
function capContextText(text: string): string {
    const points = Array.from(text);
    return points.length <= CONTEXT_TEXT_MAX ? text : points.slice(0, CONTEXT_TEXT_MAX).join("") + "…";
}

/** Drop context oldest-first until the request fits, or no context is left. */
function dropContextToFit(req: BatchRequest, budget: number): BatchRequest {
    const context = req.context.slice();
    while (context.length > 0 && requestBytes({ ...req, context }) > budget) context.shift();
    return { ...req, context };
}

/**
 * Split `req` into requests that each fit `budget` bytes. Context texts are
 * capped first, then context is dropped oldest-first, then the messages are
 * split across several requests. A message being translated is never cut: a
 * single message that does not fit on its own is sent alone.
 */
export function fitLlmRequest(req: BatchRequest, budget: number = MAX_REQUEST_BYTES): BatchRequest[] {
    const capped: BatchRequest = { ...req, context: req.context.map(c => ({ ...c, text: capContextText(c.text) })) };
    if (requestBytes(capped) <= budget) return [capped];

    const trimmed = dropContextToFit(capped, budget);
    if (requestBytes(trimmed) <= budget || capped.messages.length <= 1) return [trimmed];

    const parts: BatchRequest["messages"][] = [];
    let current: BatchRequest["messages"] = [];
    for (const m of capped.messages) {
        const next = [...current, m];
        if (current.length > 0 && requestBytes({ ...capped, context: [], messages: next }) > budget) {
            parts.push(current);
            current = [m];
        } else {
            current = next;
        }
    }
    if (current.length > 0) parts.push(current);
    return parts.map(messages => dropContextToFit({ ...capped, messages: withParentCopies(messages, capped.messages) }, budget));
}

/**
 * After a size refusal that slipped past fitLlmRequest (a relay with a lower
 * limit, a provider's own cap): the same request smaller. Two halves when
 * there are several messages, the lone message without context when there is
 * one, and nothing when that was already tried.
 */
export function shrinkAfterRefusal(req: BatchRequest): BatchRequest[] {
    if (req.messages.length > 1) {
        const mid = Math.ceil(req.messages.length / 2);
        return [
            { ...req, messages: withParentCopies(req.messages.slice(0, mid), req.messages) },
            { ...req, messages: withParentCopies(req.messages.slice(mid), req.messages) }
        ];
    }
    if (req.context.length > 0) return [{ ...req, context: [] }];
    return [];
}
