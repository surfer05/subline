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
