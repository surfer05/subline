/**
 * Counters only. The ONE module that touches METRICS, so "we never log message
 * text" is enforceable by reading exactly this file: it emits an outcome label,
 * a code fingerprint, a plan label, and a message count — never a request or
 * response body, never the code itself, never an IP or country.
 */
import type { Env } from "./codes";

export type Outcome =
    | "ok" | "cap_exceeded" | "rate_limited" | "capacity"
    | "no_code" | "unknown_code" | "revoked" | "expired"
    | "too_large" | "bad_payload" | "upstream_error" | "relay_key_fail" | "not_found";

/** A non-reversible short fingerprint of the code, so per-code volume can be
 *  seen in analytics without storing the credential. */
async function fingerprint(code: string | null): Promise<string> {
    if (!code) return "-";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    return [...new Uint8Array(digest).slice(0, 4)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** The plan behind the request, as a metrics label. "taste" is the one that
 *  earns its keep: `outcome=ok, plan=taste` counts free installs that tasted the
 *  AI tier and `outcome=cap_exceeded, plan=taste` counts the ones that hit the
 *  wall, which together are the conversion funnel. A request that never
 *  authenticated has no plan and records "-". Not identity — a tier name. */
export type PlanLabel = string | null | undefined;

export async function record(env: Env, outcome: Outcome, code: string | null, messages: number, plan?: PlanLabel): Promise<void> {
    if (!env.METRICS) return;
    try {
        env.METRICS.writeDataPoint({
            blobs: [outcome, await fingerprint(code), plan || "-"],
            doubles: [messages],
            indexes: [outcome]
        });
    } catch { /* metrics must never break a translation */ }
}
