/**
 * Activation: the installer's side of "Subline is paid, and nothing is
 * installed until it is".
 *
 * There is no free tier. The code screen is the activation screen: buy
 * Automatic ($4.99, once) or enter a code (a promo code or a license key). The
 * flow does not patch Discord until the relay says this install has Automatic.
 *
 * This module is the relay client and the small pure helpers around it. It
 * never touches `document` or Electron, so the suite runs it directly; the main
 * process injects `fetch`.
 *
 * The contract is the v2 relay API: every request carries
 * `x-subline-api: 2`, `x-subline-install: free_<id>` and a client header, and
 * `Authorization: Bearer <credential>`, where the credential is a code when one
 * is being checked and the install id otherwise.
 *
 * NOTHING HERE LOGS OR RETURNS A CODE IN AN ERROR. Causes carry the HTTP status
 * or the network error's message, never the bearer.
 */

import { createHash, randomBytes } from "node:crypto";

export const RELAY_URL = "https://subline-relay.rahul05alok.workers.dev";

/**
 * The Dodo product for Automatic ($4.99, one-time, issues a license key).
 * PENDING: the owner has not given the live product id yet. Set it here and
 * nowhere else; the static fallback link below is dead until then (the relay
 * checkout, the normal path, uses the relay's own product map).
 */
export const AUTOMATIC_PRODUCT_ID = "pdt_0NofMhZ4QRA71V9lJw6K7";

/**
 * The placeholder the product id holds until the owner supplies the real one.
 * A static link to it is a Dodo 404, so it is never opened (see
 * `staticCheckoutAllowed`), and the release script refuses to build while it
 * is anywhere in a shipped file (scripts/placeholder.mjs). Written in two
 * pieces so this guard is not itself a match.
 */
export const PLACEHOLDER_PRODUCT_ID = "pdt_AUTOMATIC_" + "PENDING";

/** Whether the static checkout link can be opened at all: never for the placeholder. */
export function staticCheckoutAllowed(productId: string = AUTOMATIC_PRODUCT_ID): boolean {
    return productId !== PLACEHOLDER_PRODUCT_ID && /^pdt_[A-Za-z0-9]+$/.test(productId);
}

/**
 * Where Dodo sends the buyer back to: the site's "go back to the Subline
 * installer" view. The relay's own checkout is asked for the same page with
 * `return: "installer"`; this constant is the static link's version of it.
 */
export const CHECKOUT_RETURN_URL = "https://surfer05.github.io/subline/?from=installer";

/** After this long on the finish-paying screen, a hint says a late purchase still lands. */
export const WAITING_HINT_AFTER_MS = 10 * 60_000;

/** How often the installer asks whether the purchase has landed. */
export const ACTIVATION_POLL_MS = 5_000;

/** A request that takes longer than this is treated as "can't reach Subline". */
export const RELAY_TIMEOUT_MS = 10_000;

/** 32 lowercase hex: the install id without its `free_` prefix. */
export const INSTALL_ID_RE = /^[0-9a-f]{32}$/;

/** A promo code, after trimming and uppercasing. Never a license key or an slp_ code. */
export const PROMO_CODE_RE = /^[A-Z0-9]{4,16}$/;

export function newInstallId(): string {
    return randomBytes(16).toString("hex");
}

export function isInstallId(value: unknown): value is string {
    return typeof value === "string" && INSTALL_ID_RE.test(value);
}

export function installBearer(installId: string): string {
    return `free_${installId}`;
}

/** First 16 hex of SHA-256 of the full bearer, the same hash the relay and the plugin use. */
export function installHash(installId: string): string {
    return createHash("sha256").update(installBearer(installId)).digest("hex").slice(0, 16);
}

/** The promo code the user typed, normalised, or null when it is not promo-shaped. */
export function promoCode(raw: string): string | null {
    const code = raw.trim().toUpperCase();
    return PROMO_CODE_RE.test(code) ? code : null;
}

/**
 * Whether a code the relay does not know as a promo code looks like one of
 * the owner's Dodo coupons (relay/scripts/coupon.mjs: a name of 3 or more
 * letters and digits plus a 5-character suffix from an alphabet with no 0, O,
 * 1 or I). A coupon is typed on Dodo's payment page, not here; the screen says
 * so as well as "doesn't exist", because a mistyped server code can look the
 * same.
 */
export function looksLikeCoupon(code: string): boolean {
    return /^[A-Z0-9]{8,16}$/.test(code) && /[A-HJ-NP-Z2-9]{5}$/.test(code);
}

/** Only an https URL on a dodopayments.com host is opened from a relay answer. */
export function isDodoCheckoutUrl(value: unknown): value is string {
    if (typeof value !== "string") return false;
    let url: URL;
    try { url = new URL(value); } catch { return false; }
    return url.protocol === "https:" && (url.hostname === "dodopayments.com" || url.hostname.endsWith(".dodopayments.com"));
}

/**
 * The static checkout link, for when the relay could not make a session. The
 * install hash rides as metadata so the purchase still links to this install.
 */
export function staticAutomaticCheckoutUrl(installId: string, productId: string = AUTOMATIC_PRODUCT_ID): string {
    const url = new URL(`https://checkout.dodopayments.com/buy/${productId}`);
    url.searchParams.set("quantity", "1");
    url.searchParams.set("metadata_install", installHash(installId));
    url.searchParams.set("redirect_url", CHECKOUT_RETURN_URL);
    return url.toString();
}

/* ------------------------------------------------------------------------ *
 * Answers
 * ------------------------------------------------------------------------ */

/** What a check-only status said about the code the user typed (`x-subline-check: 1`). */
export interface CodeCheck {
    valid: boolean;
    automatic: boolean;
    ai: boolean;
}

export type StatusAnswer =
    | { kind: "ok"; automatic: boolean; ai: boolean; code: string | null; check?: CodeCheck | null }
    | { kind: "device_limit" }
    | { kind: "invalid" }
    | { kind: "unreachable"; cause: string };

export type RedeemAnswer =
    | { kind: "ok"; code: string }
    | { kind: "not_found" }
    | { kind: "claimed" }
    | { kind: "already" }
    | { kind: "rate_limited" }
    | { kind: "unreachable"; cause: string };

/**
 * What the relay said to "make me a checkout".
 *  - `unavailable`: the relay answered and buying is not possible (503
 *    "checkout unavailable": the product is not set up, or Dodo is down). The
 *    static link would be a dead end, so it is never opened after this.
 *  - `already_owned`: 409, this install already has Automatic. Re-check status.
 *  - `network`: the relay could not be reached at all. Only this may fall back
 *    to the static link, and only when the product id is real.
 *  - `failed`: any other answer.
 */
export type CheckoutAnswer =
    | { kind: "ok"; url: string }
    | { kind: "unavailable"; cause: string }
    | { kind: "already_owned" }
    | { kind: "network"; cause: string }
    | { kind: "failed"; cause: string };

export interface ActivationRelay {
    /** POST /v1/checkout {plan:"automatic", return:"installer"} for this install. */
    checkout(installId: string): Promise<CheckoutAnswer>;
    /**
     * GET /v1/status with `credential` as the bearer (a code, or the install
     * bearer). `check: true` sends `x-subline-check: 1`: the relay judges the
     * code WITHOUT linking this computer to it, so typing a code never uses up
     * one of its 3 computers before the user says "Use it".
     */
    status(credential: string, installId: string, options?: { check?: boolean }): Promise<StatusAnswer>;
    /** POST /v1/redeem {code} for this install. */
    redeem(installId: string, code: string): Promise<RedeemAnswer>;
}

type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * The relay client. `fetch` is injected: Electron's main process passes the
 * global one, the suite passes a script.
 */
export function createActivationRelay(options: {
    fetch: FetchLike;
    version: string;
    baseUrl?: string;
    timeoutMs?: number;
}): ActivationRelay {
    const base = options.baseUrl ?? RELAY_URL;
    const timeoutMs = options.timeoutMs ?? RELAY_TIMEOUT_MS;

    const headers = (credential: string, installId: string, json: boolean, check = false): Record<string, string> => ({
        authorization: `Bearer ${credential}`,
        "x-subline-install": installBearer(installId),
        "x-subline-client": `subline-installer/${options.version}`,
        "x-subline-api": "2",
        ...(check ? { "x-subline-check": "1" } : {}),
        ...(json ? { "content-type": "application/json" } : {})
    });

    /** One request; a network error or timeout comes back as `null` plus a cause. */
    const call = async (
        path: string,
        init: { method: string; headers: Record<string, string>; body?: string }
    ): Promise<{ status: number; body: Record<string, unknown> } | { status: null; cause: string }> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await options.fetch(`${base}${path}`, { ...init, signal: controller.signal });
            let body: Record<string, unknown> = {};
            try {
                const parsed = await res.json();
                if (parsed !== null && typeof parsed === "object") body = parsed as Record<string, unknown>;
            } catch {
                // A body that is not JSON is judged by its status alone.
            }
            return { status: res.status, body };
        } catch (cause) {
            const message = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : String((cause as Error)?.message ?? cause);
            return { status: null, cause: message.slice(0, 200) };
        } finally {
            clearTimeout(timer);
        }
    };

    return {
        async checkout(installId) {
            const res = await call("/v1/checkout", {
                method: "POST",
                headers: headers(installBearer(installId), installId, true),
                // Back to the site's "go back to the Subline installer" view.
                body: JSON.stringify({ plan: "automatic", return: "installer" })
            });
            if (res.status === null) return { kind: "network", cause: res.cause };
            if (res.status === 200 && isDodoCheckoutUrl(res.body.url)) return { kind: "ok", url: res.body.url };
            const cause = `HTTP ${res.status}${typeof res.body.error === "string" ? ` ${res.body.error}` : ""}`;
            if (res.status === 409 && res.body.error === "already_owned") return { kind: "already_owned" };
            if (res.status === 503) return { kind: "unavailable", cause };
            return { kind: "failed", cause };
        },

        async status(credential, installId, statusOptions) {
            const check = statusOptions?.check === true;
            const res = await call("/v1/status", { method: "GET", headers: headers(credential, installId, false, check) });
            if (res.status === null) return { kind: "unreachable", cause: res.cause };
            if (res.status === 200 && res.body.ok === true) {
                const code = typeof res.body.code === "string" && res.body.code.trim() !== "" ? res.body.code.trim() : null;
                const raw = res.body.check;
                const parsedCheck: CodeCheck | null = check && raw !== null && typeof raw === "object"
                    ? {
                        valid: (raw as Record<string, unknown>).valid === true,
                        automatic: (raw as Record<string, unknown>).automatic === true,
                        ai: (raw as Record<string, unknown>).ai === true
                    }
                    : null;
                return {
                    kind: "ok", automatic: res.body.automatic === true, ai: res.body.ai === true, code,
                    ...(check ? { check: parsedCheck } : {})
                };
            }
            if (res.status === 403 && res.body.error === "device_limit") return { kind: "device_limit" };
            if (res.status === 401 || res.status === 403) return { kind: "invalid" };
            return { kind: "unreachable", cause: `HTTP ${res.status}` };
        },

        async redeem(installId, code) {
            const res = await call("/v1/redeem", {
                method: "POST",
                headers: headers(installBearer(installId), installId, true),
                body: JSON.stringify({ code })
            });
            if (res.status === null) return { kind: "unreachable", cause: res.cause };
            if (res.status === 200 && res.body.ok === true && typeof res.body.code === "string" && res.body.code !== "") {
                return { kind: "ok", code: res.body.code };
            }
            switch (res.body.error) {
                case "not_found": return { kind: "not_found" };
                case "claimed": return { kind: "claimed" };
                case "already": return { kind: "already" };
                case "rate_limited": return { kind: "rate_limited" };
                default: return { kind: "unreachable", cause: `HTTP ${res.status}` };
            }
        }
    };
}
