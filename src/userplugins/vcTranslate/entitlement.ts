import * as DataStore from "@api/DataStore";

/**
 * WHAT THIS INSTALL HAS PAID FOR, as the relay last said it (v2 /v1/status).
 *
 * There is no free tier. An install is one of three things:
 *  - "none": nothing is translated; the activation notice is shown;
 *  - "automatic": ≈ Google on every message and surface, decoders, and three
 *    ✦ previews a day on rough ≈ lines;
 *  - "ai": the above plus ✦ on everything (relay, under the saved code).
 *
 * The relay is the authority and states `tokenExpiresAt` (7 days out) on every
 * good answer. The answer is kept on disk, so Automatic keeps working offline
 * until that moment and no longer; after it, the install counts as "none"
 * until the relay answers again. The plugin asks at start and every 24 hours,
 * so an online install never gets near the edge.
 *
 * Free of Discord and settings, so the rules can be read and tested alone.
 */

export type Level = "none" | "automatic" | "ai";

export interface Entitlement {
    automatic: boolean;
    ai: boolean;
    /** When the AI subscription's current period ends (epoch ms), if the relay said. */
    aiUntil?: number;
    /** The relay's signed entitlement token. Kept, never shown, never logged. */
    token?: string;
    /** Automatic (and AI) count only until this moment (epoch ms). */
    tokenExpiresAt: number;
    /** When the relay last answered (epoch ms). */
    checkedAt: number;
}

export const ENTITLEMENT_KEY = "VcTranslate_entitlement";
/** How often a running install asks the relay again. */
export const ENTITLEMENT_REFRESH_MS = 24 * 60 * 60_000;

let current: Entitlement | null = null;
const listeners = new Set<() => void>();

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A stored or received value, checked field by field. Anything malformed is null. */
export function parseEntitlement(raw: unknown): Entitlement | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.automatic !== "boolean" || typeof o.ai !== "boolean") return null;
    if (!finite(o.tokenExpiresAt) || o.tokenExpiresAt <= 0) return null;
    const out: Entitlement = {
        automatic: o.automatic,
        ai: o.ai,
        tokenExpiresAt: o.tokenExpiresAt,
        checkedAt: finite(o.checkedAt) ? o.checkedAt : 0
    };
    if (finite(o.aiUntil) && o.aiUntil > 0) out.aiUntil = o.aiUntil;
    if (typeof o.token === "string" && o.token.length <= 4096) out.token = o.token;
    return out;
}

/** Read what the last session stored. A bad or missing value is "none". */
export async function loadEntitlement(): Promise<void> {
    try {
        current = parseEntitlement(await DataStore.get<unknown>(ENTITLEMENT_KEY));
    } catch {
        current = null;
    }
    notify();
}

/** Record the relay's answer (in memory and on disk). */
export function setEntitlement(next: Entitlement | null): void {
    current = next;
    void DataStore.set(ENTITLEMENT_KEY, next ?? undefined).catch(() => { });
    notify();
}

export function getEntitlement(): Entitlement | null {
    return current;
}

/**
 * What this install may do right now. Automatic and AI both lapse at
 * `tokenExpiresAt`; AI also lapses at `aiUntil` when the relay stated one.
 * An account the relay marks AI counts as Automatic too (AI is sold only on
 * top of Automatic, and older AI codes are grandfathered).
 */
export function entitlementLevel(now: number = Date.now()): Level {
    const e = current;
    if (e === null || now >= e.tokenExpiresAt) return "none";
    const aiLive = e.ai && (e.aiUntil === undefined || now < e.aiUntil);
    if (aiLive) return "ai";
    return e.automatic ? "automatic" : "none";
}

export function subscribeEntitlement(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

function notify(): void {
    for (const fn of [...listeners]) {
        try { fn(); } catch { /* a listener's failure is its own */ }
    }
}

/** Test-only: forget the in-memory state (disk is the DataStore stub's business). */
export function __resetEntitlement(): void {
    current = null;
    listeners.clear();
}
