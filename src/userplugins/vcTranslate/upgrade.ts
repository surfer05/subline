import type { StoredTranslation } from "./store";
import type { EngineId } from "./types";

/**
 * How authoritative an engine's output is.
 *
 * Two writers now race for the same key — the fast tier (Google, ~1s) and the
 * quality tier (an LLM, up to ~20s later) — and ordering is not guaranteed in
 * either direction. A rank makes the outcome depend on WHICH engine produced
 * a line rather than on which reply happened to arrive last.
 *
 * Claude and Gemini share a rank: both see the conversation, neither is
 * meaningfully more authoritative than the other, and only one is ever
 * configured at a time.
 */
export const ENGINE_RANK: Record<EngineId, number> = {
    google: 0,
    claude: 1,
    gemini: 1
};

/** A stored entry that actually carries text to show, as opposed to a marker. */
export function isRealTranslation(
    e: StoredTranslation | undefined
): e is { lang: string; text: string; via: EngineId; conf?: number } {
    return e !== undefined && "lang" in e;
}

/**
 * May `next` be written over `existing`?
 *
 * Two rules, both about never taking something away from the reader:
 *  - a lower-ranked engine never replaces a higher-ranked one, so a slow
 *    Google reply cannot degrade a line the LLM already improved;
 *  - a marker (failed/deferred/skipped) never replaces a real translation, so
 *    a rate-limited quality tier leaves the readable Google line in place
 *    instead of turning it into an error.
 */
export function mayReplace(
    existing: StoredTranslation | undefined,
    next: StoredTranslation
): boolean {
    if (existing === undefined) return true;
    if (!isRealTranslation(existing)) return true;
    if (!isRealTranslation(next)) return false;
    return ENGINE_RANK[next.via] >= ENGINE_RANK[existing.via];
}
