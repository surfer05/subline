export type EngineId = "google" | "claude";

export interface PendingMessage {
    id: string;
    author: string;
    text: string;
    channelId: string;
}

export interface BatchRequest {
    messages: { id: string; author: string; text: string }[];
    context: { author: string; text: string }[];
    targetLang: string;
}

// `failed` is the per-message failure variant: it lets a batch return a real
// answer for the messages that worked and an explicit marker for the ones that
// did not, instead of the whole batch being all-or-nothing (or, worse, a
// message silently vanishing from the results with no marker at all — the
// renderer would then show nothing forever and re-request it on every open).
// It mirrors `StoredTranslation`'s `{ failed: true }` shape in store.ts.
export type Result =
    | { id: string; lang: string; text: string; skip: false }
    | { id: string; skip: true }
    | { id: string; failed: true };

export const ENGINE_CAPS: Record<EngineId, { supportsContext: boolean }> = {
    google: { supportsContext: false },
    claude: { supportsContext: true }
};

/**
 * True when a translation is indistinguishable from its source, so there is
 * nothing worth rendering. Engines pass text through unchanged when they
 * misdetect the language — Google reads "hbu" as Frisian and "u2 <2" as
 * Chinese — and the detected-language check cannot catch that, because the
 * bogus detection is not the target language either.
 *
 * Compares case-insensitively with whitespace collapsed, so a translation
 * differing only in spacing or capitalisation still counts as no translation.
 */
export function isSameText(a: string, b: string): boolean {
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    return norm(a) === norm(b);
}
