import type { IpcMainInvokeEvent } from "electron";

import { translateWithClaude } from "./engines/claude";
import { translateWithGoogle } from "./engines/google";
import { withRetry } from "./retry";
import type { BatchRequest, EngineId, Result } from "./types";

export type NativeResponse =
    | { ok: true; results: Result[] }
    | { ok: false; error: string; retryAfterMs?: number };

export async function translateBatch(
    _: IpcMainInvokeEvent,
    engine: EngineId,
    apiKey: string,
    reqJson: string
): Promise<NativeResponse> {
    let req: BatchRequest;
    try {
        req = JSON.parse(reqJson) as BatchRequest;
    } catch {
        return { ok: false, error: "bad request payload" };
    }

    try {
        const results = await withRetry(
            () =>
                engine === "claude"
                    ? translateWithClaude(req, apiKey)
                    : translateWithGoogle(req),
            { retries: 1, delayMs: 1000 }
        );
        return { ok: true, results };
    } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        // Surface rate limiting so the renderer can pause the queue.
        const retryAfterMs = /\b429\b/.test(message) ? 30_000 : undefined;
        return { ok: false, error: message, retryAfterMs };
    }
}
