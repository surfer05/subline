import { PLUGIN_VERSION } from "../buildStamp";
import { HttpError } from "../httpError";
import type { BatchRequest, Result } from "../types";

/**
 * Sent on every relay request so the relay can tell a client that knows about
 * the free trial and ✦ previews (v0.1.6 and later) from an older one. Its
 * PRESENCE is the signal, not the number: no earlier build ever sent it, so the
 * relay keeps treating a request without it exactly as it always has. It
 * identifies the build, never the user.
 */
export const CLIENT_HEADER = "x-subline-client";
export const CLIENT_ID = `vcTranslate/${PLUGIN_VERSION}`;

/**
 * The paid-only model (v2). Every request says so with `x-subline-api: 2`, and
 * names the install it comes from with `x-subline-install: free_<hex>`, so the
 * relay can apply the 3-computer limit and join the install to its account.
 * Without the api header the relay answers exactly as it did for v0.1.9 and
 * earlier, which is what keeps older installs working until they update.
 */
export const API_HEADER = "x-subline-api";
export const API_VERSION = "2";
export const INSTALL_HEADER = "x-subline-install";
/**
 * "This install was used before 0.2.0" (a local trial start, or an install id
 * older than the installer-seeded one). Only a hint: the relay grants the
 * early-user Automatic only if it already has a record of this id from before
 * its launch moment. Sent until the relay has answered once.
 */
export const PRIOR_HEADER = "x-subline-prior";
/**
 * "Check this code, do not link it": a typed code is checked first, so a
 * mistyped or someone else's code never takes one of an account's 3
 * computers. The reader confirms, then a normal status call links it.
 */
export const CHECK_HEADER = "x-subline-check";

/** Optional extras on a v2 status request. */
export interface StatusOptions {
    prior?: boolean;
    check?: boolean;
}

/** The headers every v2 relay request carries. `install` is the install bearer ("free_<hex>"). */
export function relayHeaders(credential: string, install?: string, json = false, options: StatusOptions = {}): Record<string, string> {
    const h: Record<string, string> = {
        authorization: `Bearer ${credential}`,
        [CLIENT_HEADER]: CLIENT_ID,
        [API_HEADER]: API_VERSION
    };
    if (install) h[INSTALL_HEADER] = install;
    if (options.prior) h[PRIOR_HEADER] = "1";
    if (options.check) h[CHECK_HEADER] = "1";
    if (json) h["content-type"] = "application/json";
    return h;
}

/**
 * The relay's own error word ("device_limit", "claimed"...), when its body had
 * one. The checkout's "checkout unavailable" (it has a space) is filed as
 * "checkout_unavailable", so the renderer can tell it apart from a network
 * failure.
 */
function withErrorCode<E extends Error>(err: E, body: any): E {
    if (!body || typeof body.error !== "string") return err;
    // A promo claimed too often from one network: the relay keeps the older
    // word ("rate_limited") and says why in `reason`.
    if (body.error === "rate_limited" && body.reason === "net_limited") (err as any).errorCode = "net_limited";
    else if (/^[a-z_]{1,40}$/.test(body.error)) (err as any).errorCode = body.error;
    else if (body.error === "checkout unavailable") (err as any).errorCode = "checkout_unavailable";
    return err;
}

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
 * making; an Automatic owner has five previews a day and has to know how many are
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
 * `used`/`cap` are the preview allowance's daily count (previews used today, out of
 * five). The relay states them on every success; they used to be parsed and
 * dropped here, which meant the only way for a free install to learn its own
 * count was to spend one. Absent for a paid code, and then nothing downstream
 * shows a count at all.
 */
export interface RelayOutcome {
    results: Result[];
    rpmLimit?: number;
    used?: number;
    cap?: number;
    /** The relay's own clock (epoch ms), stated to v0.1.6 clients. */
    serverNow?: number;
}

/** What /v1/status says about this credential. See RELAY_STATUS_URL. */
export interface RelayStatus {
    /** "taste" for a free install id; whatever the relay calls a paid code. */
    plan: string;
    /** Messages spent today. */
    used: number;
    /** The day's allowance (3 on the taste tier). */
    cap: number;
    /**
     * When this free install's trial ends (or ended), epoch ms, as the relay
     * recorded it. Only a relay that knows about trials states it, and only
     * for a free install id; absent otherwise.
     */
    trialEndsAt?: number;
    /** The relay's own clock (epoch ms), for the skew correction in freePlan.ts. */
    serverNow?: number;
    /** The relay has not started a trial for this id yet: `trialEndsAt` is only "now + 7 days". */
    trialProvisional?: boolean;
    /**
     * A purchase made from this install (a checkout the plugin opened), once the
     * relay has linked it: the license key to save as the Subline code. Only
     * ever sent to the holder of the free id the checkout was opened with.
     */
    purchase?: { code: string; plan: string };
    /* ---- v2 (paid-only) fields. Present together, or not at all. ---- */
    /** Whether the account behind this install owns Automatic. */
    automatic?: boolean;
    /** Whether it has AI (✦ on everything) right now. */
    ai?: boolean;
    /** When the AI period ends (epoch ms), if stated. */
    aiUntil?: number;
    /** A code this install should save (a purchase, a promo or an early-user grant). */
    code?: string;
    /** Today's ✦ previews for an Automatic owner. */
    previews?: { used: number; cap: number };
    /** The relay's signed entitlement token, and when it (and so Automatic offline) runs out. */
    token?: string;
    tokenExpiresAt?: number;
    /** The code presented is dead (lapsed, refunded, revoked, unknown). */
    deadCode?: string;
    /** "early": this answer first granted the early-user Automatic. */
    grant?: "early";
    /** The answer to a check-only request (x-subline-check): nothing was linked. */
    check?: { valid: boolean; automatic: boolean; ai: boolean };
}

/** POST /v1/redeem: a promo code for this install. A compiled constant, like RELAY_URL. */
export const RELAY_REDEEM_URL = "https://subline-relay.rahul05alok.workers.dev/v1/redeem";

/**
 * Redeem a promo code for this install. Returns the Subline code the relay
 * minted. Throws an HttpError carrying the relay's error word (`errorCode`:
 * "not_found", "claimed", "already", "rate_limited", "unavailable").
 */
export async function fetchRelayRedeem(
    install: string,
    promo: string,
    fetchImpl: typeof fetch = fetch,
    timeoutMs: number = CHECKOUT_TIMEOUT_MS
): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(RELAY_REDEEM_URL, {
            method: "POST",
            headers: relayHeaders(install, install, true),
            body: JSON.stringify({ code: promo }),
            signal: controller.signal
        });
        let body: any = null;
        try { body = await res.json(); } catch { /* fall through */ }
        if (!res.ok || !body || body.ok !== true || typeof body.code !== "string" || body.code.trim() === "" || body.code.length > 200) {
            const detail = body && typeof body.error === "string" ? ` ${body.error}` : "";
            throw withErrorCode(new HttpError(`relay redeem: HTTP ${res.status}${detail}`, res.status), body);
        }
        return body.code.trim();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Create a Dodo checkout session through the relay, tagged with this install
 * (see checkout.ts). A compiled constant for the same reason RELAY_URL is.
 */
export const RELAY_CHECKOUT_URL = "https://subline-relay.rahul05alok.workers.dev/v1/checkout";

/** How long a checkout request may take before the static link is used instead. */
export const CHECKOUT_TIMEOUT_MS = 10_000;

/**
 * POST /v1/checkout. Returns the checkout URL, or throws an HttpError that
 * the caller treats as "use the static link".
 */
export async function fetchRelayCheckout(
    code: string,
    plan: string,
    fetchImpl: typeof fetch = fetch,
    timeoutMs: number = CHECKOUT_TIMEOUT_MS,
    install?: string
): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(RELAY_CHECKOUT_URL, {
            method: "POST",
            headers: relayHeaders(code, install, true),
            body: JSON.stringify({ plan }),
            signal: controller.signal
        });
        let body: any = null;
        try { body = await res.json(); } catch { /* fall through */ }
        if (!res.ok || !body || body.ok !== true || typeof body.url !== "string") {
            const detail = body && typeof body.error === "string" ? ` ${body.error}` : "";
            throw withErrorCode(new HttpError(`relay checkout: HTTP ${res.status}${detail}`, res.status), body);
        }
        return body.url;
    } finally {
        clearTimeout(timer);
    }
}

/** A well-formed `purchase` from a status body, or undefined. */
function purchaseFrom(value: unknown): { code: string; plan: string } | undefined {
    if (!value || typeof value !== "object") return undefined;
    const { code, plan } = value as { code?: unknown; plan?: unknown };
    if (typeof code !== "string" || code.trim() === "" || code.length > 200) return undefined;
    return { code: code.trim(), plan: typeof plan === "string" ? plan : "" };
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
 * is briefly unreachable must not take a paid install's plan away.
 */
export async function fetchRelayStatus(
    code: string,
    fetchImpl: typeof fetch = fetch,
    install?: string,
    options: StatusOptions = {}
): Promise<RelayStatus> {
    const res = await fetchImpl(RELAY_STATUS_URL, {
        method: "GET",
        headers: relayHeaders(code, install, false, options)
    });

    let body: any = null;
    try { body = await res.json(); } catch { /* fall through to the status check */ }

    if (!res.ok || !body || body.ok !== true) {
        const detail = body && typeof body.error === "string" ? ` ${body.error}` : "";
        throw withErrorCode(new HttpError(
            `relay: HTTP ${res.status}${detail}`,
            res.status,
            body && typeof body.retryAfterMs === "number" ? body.retryAfterMs : undefined
        ), body);
    }

    // A v2 answer (the paid-only model): the entitlement, and no daily count
    // unless the install is an Automatic owner with previews.
    if (typeof body.automatic === "boolean") return v2StatusFrom(body);

    // Validated rather than blind-cast, on the same principle as the results
    // array below: a malformed count reaching the renderer would be shown to
    // the user as the number of tastes they have left.
    const used = countFrom(body.used);
    const cap = countFrom(body.cap);
    if (used === undefined || cap === undefined || cap === 0) {
        throw new HttpError("relay: malformed status", 502);
    }
    const trialEndsAt = typeof body.trialEndsAt === "number" && Number.isFinite(body.trialEndsAt) && body.trialEndsAt > 0
        ? body.trialEndsAt
        : undefined;
    const serverNow = typeof body.now === "number" && Number.isFinite(body.now) && body.now > 0 ? body.now : undefined;
    return {
        plan: typeof body.plan === "string" ? body.plan : "", used, cap, trialEndsAt, serverNow,
        trialProvisional: body.trialProvisional === true ? true : undefined,
        purchase: purchaseFrom(body.purchase)
    };
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** A v2 status body, field by field. Anything malformed is dropped, never trusted. */
function v2StatusFrom(body: any): RelayStatus {
    const used = countFrom(body.previews?.used);
    const cap = countFrom(body.previews?.cap);
    const previews = used !== undefined && cap !== undefined ? { used, cap } : undefined;
    const code = typeof body.code === "string" && body.code.trim() !== "" && body.code.length <= 200 ? body.code.trim() : undefined;
    return {
        plan: typeof body.plan === "string" ? body.plan : "",
        used: previews?.used ?? 0,
        cap: previews?.cap ?? 0,
        serverNow: positive(body.now) ? body.now : undefined,
        automatic: body.automatic === true,
        ai: body.ai === true,
        aiUntil: positive(body.aiUntil) ? body.aiUntil : undefined,
        code,
        previews,
        token: typeof body.token === "string" && body.token.length <= 4096 ? body.token : undefined,
        tokenExpiresAt: positive(body.tokenExpiresAt) ? body.tokenExpiresAt : undefined,
        purchase: purchaseFrom(body.purchase),
        deadCode: typeof body.deadCode === "string" && body.deadCode.trim() !== "" && body.deadCode.length <= 200
            ? body.deadCode.trim() : undefined,
        grant: body.grant === "early" ? "early" : undefined,
        check: body.check && typeof body.check === "object" && typeof body.check.valid === "boolean"
            ? { valid: body.check.valid, automatic: body.check.automatic === true, ai: body.check.ai === true }
            : undefined
    };
}

/** How long one ✦ batch may take. An LLM answer can take seconds; a stall is not that. */
export const TRANSLATE_TIMEOUT_MS = 30_000;

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
    fetchImpl: typeof fetch = fetch,
    install?: string,
    // A stalled socket (wake from sleep, a Wi-Fi switch) otherwise waits out
    // Node's 300s headers timeout while the batch sits in flight. An abort is
    // a transport failure, so the usual cooldown and retry paths take it.
    timeoutMs: number = TRANSLATE_TIMEOUT_MS
): Promise<RelayOutcome> {
    const res = await fetchImpl(RELAY_URL, {
        method: "POST",
        headers: relayHeaders(code, install, true),
        body: JSON.stringify(req),
        ...(typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
            ? { signal: AbortSignal.timeout(timeoutMs) }
            : {})
    });

    // The relay speaks NativeResponse: { ok:true, results } | { ok:false, error, retryAfterMs }.
    // Throw an HttpError on any failure so native.ts's translateBatch maps it to
    // { ok:false, error, retryAfterMs } exactly as it does for the keyed engines
    // — including the 429 → pause-the-queue path (httpStatus reads "HTTP 429").
    let body: any = null;
    try { body = await res.json(); } catch { /* fall through to the status check */ }

    if (!res.ok || !body || body.ok !== true) {
        const detail = body && typeof body.error === "string" ? ` ${body.error}` : "";
        const err = new HttpError(
            `relay: HTTP ${res.status}${detail}`,
            res.status,
            body && typeof body.retryAfterMs === "number" ? body.retryAfterMs : undefined,
            // A rate-limit 429 states the ceiling it enforced; native.ts hands
            // it to the renderer, which retunes its gate to it (enterCooldown).
            body && typeof body.quotaLimitPerMinute === "number" && body.quotaLimitPerMinute > 0
                ? body.quotaLimitPerMinute
                : undefined
        );
        // The relay's own error word ("ai_required", "device_limit"...), so
        // the renderer can tell an entitlement refusal from a network fault.
        withErrorCode(err, body);
        if (body && typeof body.now === "number") (err as any).serverNow = body.now;
        throw err;
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
    }).map(r => {
        // A preview flag that is anything but `true` is dropped, so nothing
        // downstream can mistake a malformed flag for a full translation or
        // the other way round.
        if ("truncated" in r && (r as { truncated?: unknown }).truncated !== true) {
            const { truncated: _drop, ...rest } = r as Result & { truncated?: unknown };
            return rest as Result;
        }
        return r;
    });
    const rpmLimit = typeof body.rpmLimit === "number" && body.rpmLimit > 0 ? body.rpmLimit : undefined;
    // Same validation as fetchRelayStatus, for the same reason: these two
    // numbers are shown to a free user as "how many tastes are left today".
    const cap = countFrom(body.cap);
    return {
        results,
        rpmLimit,
        used: countFrom(body.used),
        cap: cap === 0 ? undefined : cap,
        serverNow: typeof body.now === "number" && Number.isFinite(body.now) && body.now > 0 ? body.now : undefined
    };
}
