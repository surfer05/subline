/**
 * Every user-facing string for activating and upgrading Subline from inside
 * Discord: the activation notice, the Activate and Add AI panels, the code
 * entry, their toasts, and the ⚡ popover labels. One place, so the copy can be
 * rewritten without reading any code. Short plain sentences, no em dashes.
 */
export const UPGRADE_COPY = {
    /* ---- not activated ---- */
    /** A notice that stays until dismissed, shown once per session while not activated. */
    activateNotice: "Subline is not activated on this computer. Nothing is translated until it is.",
    activateButton: "Activate",
    activateTitle: "Activate Subline",
    activateSubtitle: "Every message translated the moment it arrives.",
    automaticName: "Automatic",
    automaticPrice: "$4.99 once",
    automaticNote: "Every message, profile and embed, with ≈. Codes decoded.",
    automaticButton: "Buy Automatic, $4.99",
    enterCodeButton: "Enter a code",

    /* ---- entering a code (promo codes and license keys) ---- */
    codeTitle: "Enter a code",
    codeSubtitle: "A code from your server, or from your purchase email.",
    codePlaceholder: "Your code",
    codeSubmit: "Activate",
    codeEmpty: "Type your code first.",
    codeClaimed: "This code has been fully claimed.",
    codeNotFound: "That code doesn't exist.",
    codeAlready: "Already yours.",
    codeUnreachable: "Can't reach Subline right now. Try again in a minute.",
    codeRateLimited: "Too many codes from this network today. Try again tomorrow.",
    deviceLimit: "This code is already used on 3 computers.",

    /* ---- Automatic owners: add AI ---- */
    panelTitle: "Add AI",
    panelSubtitle: "✦ AI on every message, profile and embed.",
    monthlyName: "Monthly",
    monthlyPrice: "$2.49 a month",
    annualName: "Annual",
    annualPrice: "$19.99 a year",
    annualNote: "4 months free",
    monthlyButton: "Monthly $2.49",
    annualButton: "Annual $19.99",
    aiNeedsAutomatic: "AI needs Automatic first.",
    alreadyAutomatic: "You already have Automatic.",

    /* ---- shared ---- */
    panelFootnote: "Pay in your browser. Subline switches on here by itself.",
    checkoutOpenedToast: "Finish checkout in your browser.",
    /** A notice that stays until dismissed: the buyer is often still in the browser when it lands. */
    purchasedNotice: "You're on. Every message translates by itself now.",
    purchasedNoticeButton: "OK",

    /* ---- ✦ previews (Automatic) ---- */
    /** The link on a rough ≈ line that asks for a ✦ preview. */
    previewAsk: "Preview ✦",
    /** The ⚡ popover for an Automatic owner. Followed by today's count, e.g. "(2 of 3 left today)". */
    popoverPreview: "Preview ✦",
    /** The ⚡ popover once today's previews are used. Followed by today's count. */
    popoverUpgrade: "Add AI ✦",
    /** The link after a ✦ preview. */
    previewLink: "Add AI"
} as const;
