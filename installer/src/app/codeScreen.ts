/**
 * The code screen: a choice, not a form.
 *
 * In the normal path nobody types or pastes a key. Buying from inside Discord
 * saves the code there by itself, so this screen leads with the free trial
 * ("Start free trial" continues without a code) and keeps the paste field
 * behind "I have a code" for the people who do hold one (a friend's code, or a
 * purchase made on the website).
 *
 * Pure and free of `document`, so the suite can test what the renderer draws:
 * the renderer is the one module vitest never executes.
 *
 * EVERY STRING ON THIS SCREEN LIVES IN `CODE_SCREEN_COPY`. The owner rewrites
 * copy; one object is the one place to do it. `**` is bold (see emphasis.ts).
 */

export const CODE_SCREEN_COPY = {
    /** The line under the heading, before and after "I have a code". */
    detail: "Try everything free for 7 days. No code needed.",
    /** The filled button. Same action as the old "Continue without a code". */
    startTrial: "Start free trial",
    /** The secondary button that reveals the paste field. Not a flow action. */
    haveCode: "I have a code",
    /** The button under the revealed field. */
    save: "Save code",
    fieldLabel: "Subline code",
    placeholder: "Paste your code here",
    /** Under the field, once revealed. Names the sender, because the email lands in spam. */
    whereFrom: "Bought Subline? Your code is in the email from **Dodo Payments**, "
        + "subject \"Your License Key is Ready\". **Check spam.** "
        + "If a friend set you up, they sent it to you.",
    /** The link to Dodo's customer portal, shown only when the portal URL is known. */
    findCode: "Find my code"
} as const;

/**
 * The Dodo Payments business id, which the customer portal login URL needs.
 *
 * UNKNOWN AT THE TIME OF WRITING, so empty, and while it is empty the "Find my
 * code" link is not drawn at all (a portal link without it is a dead page).
 * The owner finds it in the Dodo dashboard: Customer Portal, Share Invite,
 * Static Link, the last path segment. Set it here and nowhere else.
 */
export const DODO_BUSINESS_ID = "";

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
    | { kind: "skip-code"; label: string; primary: boolean }
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
                { kind: "skip-code", label: CODE_SCREEN_COPY.startTrial, primary: true },
                { kind: "reveal", label: CODE_SCREEN_COPY.haveCode, primary: false }
            ]
        };
    }
    return {
        showField,
        findCodeUrl,
        buttons: [
            { kind: "set-code", label: CODE_SCREEN_COPY.save, primary: true },
            { kind: "skip-code", label: CODE_SCREEN_COPY.startTrial, primary: false }
        ]
    };
}
