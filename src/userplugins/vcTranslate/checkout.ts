/**
 * BUYING WITHOUT HANDLING A KEY.
 *
 * The reader picks a plan in the Upgrade panel. The relay creates a Dodo
 * checkout session tagged with a hash of this install's free id and returns its
 * URL, which opens in the browser. While that checkout is open this module asks
 * the relay's /v1/status every 5 seconds, for up to 30 minutes, then every 5
 * minutes for up to 48 hours: a subscription can sit in Pending while the bank
 * sets up the mandate (minutes in practice; Dodo documents up to 48 hours for
 * Indian mandates), and the key must still land without a restart. Once the
 * purchase is linked to the install, status carries the license key
 * (`purchase.code`), and the caller saves it as the Subline code. Nobody types
 * or pastes anything.
 *
 * If the relay ANSWERS that it cannot sell this now (503 "checkout
 * unavailable": the product is not set up, or Dodo is down), nothing opens:
 * the reader is told buying isn't available yet. The static Dodo checkout link
 * is only for a relay that could not be reached at all, and never while the
 * product id is still the placeholder (it would open a 404). It carries the
 * same install hash as `metadata_install` and a `redirect_url` back to the
 * site, both documented for static links
 * (https://docs.dodopayments.com/developer-resources/integration-guide#static-payment-links),
 * so the webhook can still link the purchase and polling still works.
 *
 * Free of Discord and settings: every side effect is a dependency, so the flow
 * is tested on its own.
 */

export type Plan = "automatic" | "monthly" | "annual";

/**
 * The Dodo product for Automatic ($4.99 once). Set it here (and only here).
 * While it is still the placeholder the static link is never opened (see
 * isConfiguredProduct), and a test refuses the placeholder in a shipped build
 * (tests/placeholder.test.ts).
 */
export const AUTOMATIC_PRODUCT_ID = "pdt_AUTOMATIC_PENDING";

/** A real Dodo product id, not the placeholder a build ships with before the owner sets it. */
export function isConfiguredProduct(id: string): boolean {
    return /^pdt_[A-Za-z0-9]+$/.test(id) && !/PENDING/.test(id);
}

export const PLAN_PRODUCTS: Record<Plan, string> = {
    automatic: AUTOMATIC_PRODUCT_ID,
    monthly: "pdt_0No1xmbcAqHdYAvt1RNPR",
    annual: "pdt_0No1yAve1ozdxryVGZvf6"
};

/**
 * Relay refusals that mean "this purchase is not for you", not "the relay is
 * down": the static link must NOT open for them, or a static link would sell
 * what the relay just refused (AI without Automatic, Automatic twice).
 */
export const CHECKOUT_REFUSALS = new Set(["automatic_required", "already_owned"]);

/**
 * Where Dodo sends the buyer after paying: the site root, marked as a checkout
 * started from Discord, so the thanks view says "go back to Discord" rather
 * than showing a code to paste.
 */
export const CHECKOUT_RETURN_URL = "https://surfer05.github.io/subline/?from=discord";

export const POLL_EVERY_MS = 5_000;
export const POLL_FOR_MS = 30 * 60_000;
/** After the first 30 minutes, a slower check for a purchase still pending. */
export const SLOW_POLL_EVERY_MS = 5 * 60_000;
export const SLOW_POLL_FOR_MS = 48 * 60 * 60_000;

/**
 * The install hash the relay files a purchase under: the first 16 hex of
 * SHA-256 of the full bearer ("free_<32hex>"). Never the raw id.
 */
export async function installHash(bearer: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function staticCheckoutUrl(plan: Plan, hash: string | null): string {
    const params = [`quantity=1`];
    if (hash !== null) params.push(`metadata_install=${encodeURIComponent(hash)}`);
    params.push(`redirect_url=${encodeURIComponent(CHECKOUT_RETURN_URL)}`);
    return `https://checkout.dodopayments.com/buy/${PLAN_PRODUCTS[plan]}?${params.join("&")}`;
}

/**
 * Only a Dodo https URL is opened from a relay answer. openExternal hands the
 * URL to the operating system, so a relay answer must never be able to open
 * anything else (a file: URL, a custom protocol, another site).
 */
export function isDodoCheckoutUrl(url: unknown): url is string {
    if (typeof url !== "string") return false;
    try {
        const u = new URL(url);
        return u.protocol === "https:" && (u.hostname === "dodopayments.com" || u.hostname.endsWith(".dodopayments.com"));
    } catch {
        return false;
    }
}

export interface Purchase { code: string; plan: string; }

export interface CheckoutDeps {
    /** This install's free bearer ("free_<32hex>"). */
    bearer: () => Promise<string>;
    /** POST /v1/checkout through the main process. */
    /** `status` is the relay's HTTP status when it answered; absent when it could not be reached. */
    createCheckout: (bearer: string, plan: Plan) => Promise<{ ok: true; url: string } | { ok: false; error: string; errorCode?: string; status?: number }>;
    /** GET /v1/status through the main process; `purchase` once linked. */
    status: (bearer: string) => Promise<{ ok: boolean; purchase?: Purchase }>;
    openExternal: (url: string) => void;
    /** A linked purchase arrived: save it. Returns false when it was not saved (for example a
     *  code the reader cleared, which the relay still links), and the poll then
     *  keeps going so a later, different purchase still lands. */
    onPurchase: (purchase: Purchase) => boolean;
    log?: (message: string) => void;
    now?: () => number;
}

export interface CheckoutFlow {
    /**
     * Open checkout for a plan and start (or restart) polling. Resolves true
     * when a checkout page was opened, the relay's refusal word when it
     * refused the purchase (see CHECKOUT_REFUSALS), "unavailable" when buying
     * is not possible right now (nothing opened), or false if superseded.
     */
    start: (plan: Plan) => Promise<true | false | string>;
    stop: () => void;
    isPolling: () => boolean;
}

export function createCheckoutFlow(deps: CheckoutDeps): CheckoutFlow {
    const now = deps.now ?? (() => Date.now());
    const log = deps.log ?? (() => { });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let deadline = 0;
    let slowDeadline = 0;
    let generation = 0;

    const stop = () => {
        generation++;
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };

    const schedule = (gen: number, bearer: string) => {
        if (gen !== generation) return;
        if (now() >= slowDeadline) {
            log("checkout: stopped waiting after 48 hours");
            timer = null;
            return;
        }
        const every = now() < deadline ? POLL_EVERY_MS : SLOW_POLL_EVERY_MS;
        timer = setTimeout(async () => {
            timer = null;
            if (gen !== generation) return;
            let res: { ok: boolean; purchase?: Purchase } | null = null;
            try {
                res = await deps.status(bearer);
            } catch (e) {
                log(`checkout: status check failed: ${String((e as any)?.message ?? e)}`);
            }
            if (gen !== generation) return;
            const p = res?.ok ? res.purchase : undefined;
            if (p && typeof p.code === "string" && p.code.trim() !== ""
                && deps.onPurchase({ code: p.code.trim(), plan: p.plan })) {
                stop();
                return;
            }
            schedule(gen, bearer);
        }, every);
    };

    const start = async (plan: Plan) => {
        stop();
        const gen = generation;
        const bearer = await deps.bearer();
        let url: string | null = null;
        try {
            const res = await deps.createCheckout(bearer, plan);
            if (!res.ok && res.errorCode !== undefined && CHECKOUT_REFUSALS.has(res.errorCode)) {
                log(`checkout: the relay refused this plan (${res.errorCode})`);
                return res.errorCode;
            }
            if (res.ok && isDodoCheckoutUrl(res.url)) url = res.url;
            else if (res.ok || res.status !== undefined) {
                // The relay answered and cannot sell this now: nothing opens.
                log(`checkout: not available (${res.ok ? "not a Dodo URL" : res.error})`);
                return "unavailable";
            } else log(`checkout: relay unreachable (${res.error}), trying the static link`);
        } catch (e) {
            log(`checkout: relay call failed (${String((e as any)?.message ?? e)}), trying the static link`);
        }
        if (url === null) {
            if (!isConfiguredProduct(PLAN_PRODUCTS[plan])) {
                log("checkout: no product set up for this plan, not opening a static link");
                return "unavailable";
            }
            let hash: string | null = null;
            try { hash = await installHash(bearer); } catch { hash = null; }
            url = staticCheckoutUrl(plan, hash);
        }
        if (gen !== generation) return false;
        deps.openExternal(url);
        deadline = now() + POLL_FOR_MS;
        slowDeadline = now() + SLOW_POLL_FOR_MS;
        schedule(gen, bearer);
        return true;
    };

    return { start, stop, isPolling: () => timer !== null };
}
