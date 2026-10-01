/**
 * Every user-facing string for activating and upgrading Subline from inside
 * Discord: the activation notice, the Activate and Add AI panels, the code
 * entry, their toasts, and the ⚡ popover labels. One place, so the copy can be
 * rewritten without reading any code. Short plain sentences, no em dashes.
 */
/** AI prices in cents, as on the Dodo products. The yearly saving below is derived from them. */
export const AI_MONTHLY_CENTS = 199;
export const AI_ANNUAL_CENTS = 1999;

/**
 * What a year saves against 12 months, in whole percent, rounded DOWN so the
 * claim is never bigger than the real saving ($23.88 vs $19.99 is 16.3%).
 */
export function annualSavingPercent(monthlyCents: number, annualCents: number): number {
    return Math.floor((12 * monthlyCents - annualCents) * 100 / (12 * monthlyCents));
}

const ANNUAL_NOTE = `Save ${annualSavingPercent(AI_MONTHLY_CENTS, AI_ANNUAL_CENTS)}%`;

export const UPGRADE_COPY = {
    /* ---- not activated ---- */
    /** A notice that stays until dismissed, shown once per session while not activated. */
    activateNotice: "Subline isn't activated on this computer yet.",
    activateButton: "Activate",
    activateTitle: "Activate Subline",
    activateSubtitle: "Pay once and every message gets translated.",
    automaticName: "Automatic",
    automaticPrice: "$4.99 once",
    automaticNote: "≈ under every message, profile and embed. Yours for good.",
    automaticButton: "Buy for $4.99",
    enterCodeButton: "Enter a code",

    /* ---- entering a code (promo codes and license keys) ---- */
    codeTitle: "Enter a code",
    codeSubtitle: "A server code, or the code from your purchase email.",
    codePlaceholder: "Your code",
    codeSubmit: "Activate",
    codeEmpty: "Type or paste a code first.",
    codeClaimed: "This code has been fully claimed.",
    codeNotFound: "That code doesn't exist.",
    codeAlready: "Already yours.",
    codeUnreachable: "Can't reach Subline right now. Try again in a minute.",
    codeRateLimited: "Too many codes tried from this network today. Try again after midnight UTC.",
    /** A promo code allows only a few claims from one network. */
    codeNetLimited: "This code has reached its limit on your network.",
    deviceLimit: "This code is on 3 computers already. It frees up after 30 days unused, or ask for a reset on GitHub.",
    /** The button next to the device-limit sentence: opens RESET_HELP_URL. */
    deviceLimitButton: "GitHub",
    /** A typed license key or Subline code checked OK, before it is linked to this computer. */
    codeConfirmTitle: "Use this code?",
    codeConfirm: "It works on up to 3 computers.",
    codeConfirmButton: "Use it",

    /* ---- a saved code the relay could not check yet ---- */
    /** A notice while a saved code is unconfirmed because the relay can't be reached. No Activate button. */
    checkingNotice: "Can't reach Subline to check your code. Retrying.",
    checkingNoticeButton: "OK",

    /* ---- an early user's first 0.2.0 start, before the relay has answered ---- */
    /** Instead of the activation notice while the early-user check is still out (at most a day). */
    earlyCheckingNotice: "Checking your early-user access. This can take a minute.",
    earlyCheckingNoticeButton: "OK",

    /* ---- Automatic owners: add AI ---- */
    panelTitle: "Add AI",
    panelSubtitle: "✦ reads the whole conversation, so slang and replies come out right.",
    monthlyName: "Monthly",
    monthlyPrice: "$1.99 a month",
    annualName: "Annual",
    annualPrice: "$19.99 a year",
    annualNote: ANNUAL_NOTE,
    /**
     * Under the AI plans in the Add AI panel: a Dodo coupon goes on the checkout
     * page, not in Subline. Coupons are made for the Monthly plan only (relay
     * createCoupon: restricted_to [monthly]), so Yearly's page refuses them.
     */
    couponHint: "Have a coupon? Pick Monthly and enter it on the payment page.",
    monthlyButton: "Monthly $1.99",
    annualButton: `Yearly $19.99 · ${ANNUAL_NOTE}`,
    aiNeedsAutomatic: "AI needs Automatic first.",
    alreadyAutomatic: "You already have Automatic.",
    /** Buy or Add AI while a payment from this install is still being confirmed. */
    purchasePending: "Your payment is still being confirmed. It switches on by itself.",
    /** The relay answered that it cannot sell this right now (no product set up, or the shop is down). */
    checkoutUnavailable: "Buying isn't available yet. Use a code, or try again later.",

    /* ---- shared ---- */
    panelFootnote: "Pay in your browser. Subline switches on here by itself.",
    checkoutOpenedToast: "Finish checkout in your browser.",
    /** A notice that stays until dismissed: the buyer is often still in the browser when it lands. */
    purchasedNotice: "You're on. Every message translates by itself now.",
    purchasedNoticeButton: "OK",
    /** Instead of "You're on." when the relay grants Automatic to an early user. */
    earlyNotice: "Thanks for being early. Automatic is yours, free.",

    /* ---- ✦ previews (Automatic) ---- */
    /** The link on a rough ≈ line that asks for a ✦ preview. */
    previewAsk: "Preview ✦",
    /** The ⚡ popover for an Automatic owner. {n} is how many are left today. */
    popoverPreview: "Preview ✦ ({n} left today)",
    /** The ⚡ popover once today's previews are used. */
    popoverUpgrade: "Add AI ✦",
    /** The link after a ✦ preview. */
    previewLink: "Add AI",
    /** Hover text on a ≈ line waiting for Google. */
    googleBusy: "Google is busy. Subline retries by itself."
} as const;

/** Where the device-limit sentence sends the reader to ask for a reset. */
export const RESET_HELP_URL = "https://github.com/surfer05/subline/issues";
