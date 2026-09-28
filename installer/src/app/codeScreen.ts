/**
 * The activation screen (the old code screen).
 *
 * Subline is paid: there is no free tier and no trial, and the installer does
 * not change Discord until this install has Automatic. So the screen offers
 * exactly two ways forward: buy Automatic ($4.99, once) in the browser, or
 * enter a code (a promo code, or the license key from a purchase). There is no
 * way past it without one of them.
 *
 * Pure and free of `document`, so the suite can test what the renderer draws:
 * the renderer is the one module vitest never executes.
 *
 * EVERY STRING ON THIS SCREEN LIVES IN `CODE_SCREEN_COPY`. The owner rewrites
 * copy; one object is the one place to do it. `**` is bold (see emphasis.ts).
 */

export const CODE_SCREEN_COPY = {
    /** The heading of the screen. */
    title: "Activate Subline",
    /** The line under the heading. */
    detail: "Subline is $4.99, once. Buy it here, or enter a code you have.",
    /** The filled button: opens the checkout in the browser. */
    buy: "Buy Automatic, $4.99",
    /** The secondary button that reveals the code field. Not a flow action. */
    haveCode: "I have a code",
    /** The button under the revealed field. */
    save: "Save code",
    fieldLabel: "Subline code",
    placeholder: "Paste or type your code",
    /** Under the field, once revealed. Names the sender, because the email lands in spam. */
    whereFrom: "A server code, or the code in your email from **Dodo Payments**. **Check spam.**",
    /** The link to Dodo's customer portal, shown only when the portal URL is known. */
    findCode: "Find my code",
    /** The waiting screen while the purchase happens in the browser. */
    waitingTitle: "Finish in your browser",
    waiting: "Finish the payment in your browser. Subline carries on by itself when it is done.",
    /** Leaves the waiting screen. */
    back: "Back",
    /** The screen shown when a saved code could not be checked. */
    checkTitle: "Can't reach Subline",
    /* Errors, shown on the screen they happened on. */
    errNotFound: "That code doesn't exist.",
    errClaimed: "This code has been fully claimed.",
    errAlready: "Already yours.",
    errUnreachable: "Can't reach Subline right now. Try again in a minute.",
    errDeviceLimit: "This code is already used on 3 computers.",
    errNotActive: "That code is not active.",
    errRateLimited: "Too many codes tried from this network today. Try again tomorrow.",
    errEmpty: "Type or paste a code first."
} as const;

/**
 * The Dodo Payments business id, which the customer portal login URL needs.
 *
 * Set to the owner's business. If it is ever emptied, the "Find my code" link
 * is not drawn at all (a portal link without it is a dead page). It is found
 * in the Dodo dashboard: Customer Portal, Share Invite, Static Link, the last
 * path segment. Set it here and nowhere else.
 */
export const DODO_BUSINESS_ID = "bus_0Nn5xovcpJlT15uPLKQ8M";

/**
 * The customer portal login page for a business, or null without an id.
 * Documented form: https://customer.dodopayments.com/login/{business_id}
 * (https://docs.dodopayments.com/features/customer-portal).
 */
export function portalUrl(businessId: string = DODO_BUSINESS_ID): string | null {
    const id = businessId.trim();
    if (!/^[A-Za-z0-9_]+$/.test(id)) return null;
    return `https://customer.dodopayments.com/login/${id}`;
}

export type CodeScreenButton =
    | { kind: "buy-automatic"; label: string; primary: boolean }
    | { kind: "set-code"; label: string; primary: boolean }
    | { kind: "reveal"; label: string; primary: boolean };

export interface CodeScreenView {
    /** Whether the paste field is on screen. */
    showField: boolean;
    /** The footer buttons, in on-screen order. Exactly one is primary. */
    buttons: CodeScreenButton[];
    /** The "Find my code" link target, or null to draw no link. */
    findCodeUrl: string | null;
}

/**
 * What the code screen shows.
 *
 * `revealed` is true once "I have a code" was pressed, and ALSO whenever the
 * flow came back with an error: a refused save must land back on the field,
 * not on the choice, or the user loses what they pasted and the reason.
 */
export function codeScreenView(opts: { revealed: boolean; hasError?: boolean; businessId?: string }): CodeScreenView {
    const showField = opts.revealed || opts.hasError === true;
    const findCodeUrl = showField ? portalUrl(opts.businessId ?? DODO_BUSINESS_ID) : null;
    if (!showField) {
        return {
            showField,
            findCodeUrl,
            buttons: [
                { kind: "buy-automatic", label: CODE_SCREEN_COPY.buy, primary: true },
                { kind: "reveal", label: CODE_SCREEN_COPY.haveCode, primary: false }
            ]
        };
    }
    return {
        showField,
        findCodeUrl,
        buttons: [
            { kind: "set-code", label: CODE_SCREEN_COPY.save, primary: true },
            { kind: "buy-automatic", label: CODE_SCREEN_COPY.buy, primary: false }
        ]
    };
}
