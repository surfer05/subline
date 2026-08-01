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

export type Result =
    | { id: string; lang: string; text: string; skip: false }
    | { id: string; skip: true };

export const ENGINE_CAPS: Record<EngineId, { supportsContext: boolean }> = {
    google: { supportsContext: false },
    claude: { supportsContext: true }
};
