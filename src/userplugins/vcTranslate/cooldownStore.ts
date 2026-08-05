import * as DataStore from "@api/DataStore";

import type { EngineId } from "./types";

/**
 * The "this engine is rate limited until <timestamp>" mark, persisted.
 *
 * WHY IT HAS TO SURVIVE A RESTART: without this the mark lives only in module
 * state, so every Discord launch starts by assuming the engine is healthy,
 * spends a request to discover it is not, and shows the user a rate-limit
 * toast. That is the worst possible request to spend when the quota is already
 * gone, and it is spent again on every single launch — quitting and reopening
 * Discord several times in a rate-limited window costs one wasted request each
 * time and teaches us nothing we did not already know.
 *
 * A timestamp, not a flag: it needs no expiry timer and no cleanup. A stale
 * entry from a previous session is simply in the past, so it reads as "not
 * cooling down" without any special handling.
 */
export const COOLDOWN_KEY = "VcTranslate_llmCooldown";

/** In-memory mirror; the plugin cannot await IndexedDB on every flush. */
let cooldowns: Partial<Record<EngineId, number>> = {};

/**
 * Load the persisted marks. Anything malformed is discarded rather than
 * thrown: a corrupt entry must not stop the plugin starting, and the safe
 * direction is "assume healthy" — that costs at most one request to rediscover
 * a live cooldown, whereas refusing to start costs the user everything.
 */
export async function loadCooldowns(): Promise<void> {
    cooldowns = {};
    let stored: unknown;
    try {
        stored = await DataStore.get<unknown>(COOLDOWN_KEY);
    } catch {
        return;
    }
    if (stored === null || typeof stored !== "object") return;

    for (const [engine, until] of Object.entries(stored as Record<string, unknown>)) {
        // Only finite future-or-past numbers; a NaN would make every
        // comparison false and silently disable cooldowns altogether.
        if (typeof until === "number" && Number.isFinite(until)) {
            cooldowns[engine as EngineId] = until;
        }
    }
}

export function cooldownUntil(engine: EngineId): number {
    return cooldowns[engine] ?? 0;
}

/**
 * Mark `engine` as unusable until `until`, in memory immediately and on disk
 * when IndexedDB gets round to it.
 *
 * The write is deliberately not awaited by callers: a flush must not block on
 * persistence, and losing the write costs exactly one probe request next
 * launch — the same cost as not having persisted at all, so there is nothing
 * to roll back and no failure mode worse than today's behaviour.
 */
export function setCooldown(engine: EngineId, until: number): void {
    cooldowns[engine] = until;
    void DataStore.set(COOLDOWN_KEY, { ...cooldowns }).catch(() => {
        // Best effort. See above: a failed write degrades to the old
        // behaviour rather than breaking anything.
    });
}

/** Test-only, and the plugin's own stop(): drop the in-memory mirror. */
export function __resetCooldowns(): void {
    cooldowns = {};
}
