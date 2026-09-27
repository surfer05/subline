/**
 * Every user-facing string for buying Subline from inside Discord: the
 * Upgrade panel, its toasts, the trial-ended notice button and the ⚡ popover
 * label once the day's previews are used. One place, so the copy can be
 * rewritten without reading any code. Short plain sentences, no em dashes.
 */
export const UPGRADE_COPY = {
    panelTitle: "Upgrade Subline",
    panelSubtitle: "Keep every message translated automatically, with ✦ AI.",
    monthlyName: "Monthly",
    monthlyPrice: "$2.49 a month",
    annualName: "Annual",
    annualPrice: "$19.99 a year",
    annualNote: "4 months free",
    monthlyButton: "Monthly $2.49",
    annualButton: "Annual $19.99",
    panelFootnote: "Checkout opens in your browser. Subline turns on here by itself when you finish.",
    checkoutOpenedToast: "Checkout opened in your browser.",
    purchasedToast: "Thanks for buying Subline. Automatic translation is on.",
    noticeButton: "Upgrade",
    /** Followed by today's count, e.g. "(0 of 3 left today)". */
    popoverUpgrade: "Upgrade Subline ✦",
    settingsLink: "Upgrade",
    previewLink: "Upgrade"
} as const;
