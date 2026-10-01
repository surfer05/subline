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

/** Under the relay's 32,768-byte limit, with room for headers and the wrapper. */
export const MAX_REQUEST_BYTES = 30_000;

/** The relay's per-text limit (relay/src/index.ts MAX_TEXT_CHARS). Older relays stay at this. */
export const LLM_TEXT_MAX = 4_000;

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
    return parts.map(messages => dropContextToFit({ ...capped, messages }, budget));
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
            { ...req, messages: req.messages.slice(0, mid) },
            { ...req, messages: req.messages.slice(mid) }
        ];
    }
    if (req.context.length > 0) return [{ ...req, context: [] }];
    return [];
}
