/**
 * EVERY CALL TO THE DODO API GOES THROUGH dodoFetch: each one is bounded in
 * time, so a slow Dodo can never hold a webhook past Dodo's own 30 s timeout
 * (docs: developer-resources/webhooks) or a checkout request open for good.
 *
 *   • one GET: at most DODO_GET_TIMEOUT_MS;
 *   • one POST (create a checkout session, a coupon): at most DODO_POST_TIMEOUT_MS;
 *   • a `deadline` (epoch ms) caps the call further: a webhook shares one
 *     budget (WEBHOOK_DODO_BUDGET_MS) across all its Dodo calls, a checkout
 *     its session-status checks (CHECKOUT_STATUS_BUDGET_MS).
 *
 * A call past its deadline, or one that times out, THROWS. Every caller
 * already catches a failed fetch and answers "unavailable"/"unknown", then
 * keeps its own safe fallback; a timeout is just another failed fetch.
 */
export const DODO_GET_TIMEOUT_MS = 5_000;
export const DODO_POST_TIMEOUT_MS = 15_000;
/** All Dodo calls of one webhook together. Leaves ~10 s of Dodo's 30 s for KV. */
export const WEBHOOK_DODO_BUDGET_MS = 20_000;
/** The GET /checkouts/{id} status checks of one checkout request together. */
export const CHECKOUT_STATUS_BUDGET_MS = 10_000;

/** A deadline `ms` from now (epoch ms). */
export function deadlineIn(ms: number): number {
    return Date.now() + ms;
}

/** fetch() with a timeout: the method's own cap, lowered to what is left of `deadline`. */
export async function dodoFetch(url: string, init: RequestInit, deadline?: number): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const cap = method === "GET" ? DODO_GET_TIMEOUT_MS : DODO_POST_TIMEOUT_MS;
    const left = deadline === undefined ? cap : deadline - Date.now();
    if (left <= 0) throw new Error("dodo time budget spent");
    return fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(cap, left)) });
}
