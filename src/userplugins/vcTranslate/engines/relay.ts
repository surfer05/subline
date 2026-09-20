import { HttpError } from "../httpError";
import type { BatchRequest, Result } from "../types";

/**
 * The Subline relay: keyless AI translation. The user's "key" is an opaque
 * CODE, not a provider key, and the request goes to Subline's own Worker, which
 * holds the paid Groq key and returns the SAME shape a direct provider call
 * would (see relay/). So this engine is a thin poster — the relay owns the
 * model and the prompt.
 *
 * REPLACE this URL with your deployed Worker's URL (see relay/README.md). It is
 * a compiled constant, not a setting, for the same reason RELEASE_FEED_URL is:
 * a translation endpoint that a config file could repoint is a way to exfiltrate
 * message text, and there must be nothing to repoint.
 */
export const RELAY_URL = "https://subline-relay.rahul05alok.workers.dev/v1/translate";

/**
 * "How much of today's allowance has this credential spent?", asked without
 * spending any of it.
 *
 * A compiled constant for exactly the reason RELAY_URL is (see above): it
 * carries the same bearer, so a config file that could repoint it would be a
 * way to harvest install ids.
 *
 * Only the TASTE tier reads this. A paid code has no daily count worth showing,
 * and learns its per-minute ceiling from the translate responses it is already
 * making; a free install has three presses a day and has to know how many are
 * left after a Discord restart, without buying one to find out.
 */
export const RELAY_STATUS_URL = "https://subline-relay.rahul05alok.workers.dev/v1/status";

/**
 * One relay round trip: the translations, plus the ceiling the relay states
 * for this code (`rpmLimit`, requests per minute). The ceiling is what lets
 * the renderer's rate gate run at the relay's real rate instead of its
 * untaught guess — see rateGate.ts. Absent on an older relay, and then the
 * gate simply keeps whatever it has.
 *
 * `used`/`cap` are the TASTE tier's daily count (messages used today, out of
 * three). The relay states them on every success; they used to be parsed and
 * dropped here, which meant the only way for a free install to learn its own
 * count was to spend one. Absent for a paid code, and then nothing downstream
 * shows a count at all.
 */
export interface RelayOutcome {
    results: Result[];
    rpmLimit?: number;
    used?: number;
    cap?: number;
}

/** What /v1/status says about this credential. See RELAY_STATUS_URL. */
export interface RelayStatus {
    /** "taste" for a free install id; whatever the relay calls a paid code. */
    plan: string;
    /** Messages spent today. */
    used: number;
    /** The day's allowance (3 on the taste tier). */
    cap: number;
}

/** A non-negative, finite integer the relay stated, or undefined. */
function countFrom(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    return Math.floor(value);
}

/**
 * Read today's count for a credential without spending one.
 *
 * Throws an HttpError on any failure, exactly as translateWithRelayDetailed
 * does, so native.ts can map it the same way. The caller treats a failure as
 * "count unknown" — never as "nothing left" — because a status endpoint that
 * is briefly unreachable must not take a free user's three tastes away.
 */
export async function fetchRelayStatus(
    code: string,
    fetchImpl: typeof fetch = fetch
): Promise<RelayStatus> {
    const res = await fetchImpl(RELAY_STATUS_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${code}` }
    });

    let body: any = null;
    try { body = await res.json(); } catch { /* fall through to the status check */ }

    if (!res.ok || !body || body.ok !== true) {
        const detail = body && typeof body.error === "string" ? ` ${body.error}` : "";
        throw new HttpError(
            `relay: HTTP ${res.status}${detail}`,
            res.status,
            body && typeof body.retryAfterMs === "number" ? body.retryAfterMs : undefined
        );
    }

    // Validated rather than blind-cast, on the same principle as the results
    // array below: a malformed count reaching the renderer would be shown to
    // the user as the number of tastes they have left.
    const used = countFrom(body.used);
    const cap = countFrom(body.cap);
    if (used === undefined || cap === undefined || cap === 0) {
        throw new HttpError("relay: malformed status", 502);
    }
    return { plan: typeof body.plan === "string" ? body.plan : "", used, cap };
}

export async function translateWithRelay(
    req: BatchRequest,
    code: string,
    fetchImpl: typeof fetch = fetch
): Promise<Result[]> {
    return (await translateWithRelayDetailed(req, code, fetchImpl)).results;
}

export async function translateWithRelayDetailed(
    req: BatchRequest,
    code: string,
    fetchImpl: typeof fetch = fetch
): Promise<RelayOutcome> {
    const res = await fetchImpl(RELAY_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${code}` },
        body: JSON.stringify(req)
    });

    // The relay speaks NativeResponse: { ok:true, results } | { ok:false, error, retryAfterMs }.
    // Throw an HttpError on any failure so native.ts's translateBatch maps it to
    // { ok:false, error, retryAfterMs } exactly as it does for the keyed engines
    // — including the 429 → pause-the-queue path (httpStatus reads "HTTP 429").
    let body: any = null;
    try { body = await res.json(); } catch { /* fall through to the status check */ }

    if (!res.ok || !body || body.ok !== true) {
        const detail = body && typeof body.error === "string" ? ` ${body.error}` : "";
        throw new HttpError(
            `relay: HTTP ${res.status}${detail}`,
            res.status,
            body && typeof body.retryAfterMs === "number" ? body.retryAfterMs : undefined,
            // A rate-limit 429 states the ceiling it enforced; native.ts hands
            // it to the renderer, which retunes its gate to it (enterCooldown).
            body && typeof body.quotaLimitPerMinute === "number" && body.quotaLimitPerMinute > 0
                ? body.quotaLimitPerMinute
                : undefined
        );
    }
    // Validate rather than blind-cast: the relay is our own server, but a
    // corrupted or hostile response must not inject malformed entries into the
    // store. Keep only rows that match the Result union; anything else is
    // dropped, and native.ts treats a short/empty array as it treats any
    // partial engine result.
    if (!Array.isArray(body.results)) throw new HttpError("relay: malformed response", 502);
    const results = (body.results as unknown[]).filter((r): r is Result => {
        if (!r || typeof r !== "object" || typeof (r as any).id !== "string") return false;
        const o = r as any;
        if (o.failed === true) return true;
        if (o.skip === true) return true;
        return o.skip === false && typeof o.lang === "string" && typeof o.text === "string";
    });
    const rpmLimit = typeof body.rpmLimit === "number" && body.rpmLimit > 0 ? body.rpmLimit : undefined;
    // Same validation as fetchRelayStatus, for the same reason: these two
    // numbers are shown to a free user as "how many tastes are left today".
    const cap = countFrom(body.cap);
    return {
        results,
        rpmLimit,
        used: countFrom(body.used),
        cap: cap === 0 ? undefined : cap
    };
}
