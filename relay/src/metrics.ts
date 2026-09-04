/**
 * Counters only. The ONE module that touches METRICS, so "we never log message
 * text" is enforceable by reading exactly this file: it emits an outcome label,
 * a code fingerprint, and a message count — never a request or response body,
 * never the code itself, never an IP or country.
 */
import type { Env } from "./codes";

export type Outcome =
    | "ok" | "cap_exceeded" | "rate_limited" | "capacity"
    | "no_code" | "unknown_code" | "revoked"
    | "too_large" | "bad_payload" | "upstream_error" | "relay_key_fail" | "not_found";

/** A non-reversible short fingerprint of the code, so per-code volume can be
 *  seen in analytics without storing the credential. */
async function fingerprint(code: string | null): Promise<string> {
    if (!code) return "-";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    return [...new Uint8Array(digest).slice(0, 4)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function record(env: Env, outcome: Outcome, code: string | null, messages: number): Promise<void> {
    if (!env.METRICS) return;
    try {
        env.METRICS.writeDataPoint({
            blobs: [outcome, await fingerprint(code)],
            doubles: [messages],
            indexes: [outcome]
        });
    } catch { /* metrics must never break a translation */ }
}
