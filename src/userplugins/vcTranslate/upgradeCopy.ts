/**
 * Every user-facing string for buying Subline from inside Discord: the
 * Upgrade panel, its toasts, the trial-ended notice button and the ⚡ popover
 * label once the day's previews are used. One place, so the copy can be
 * rewritten without reading any code. Short plain sentences, no em dashes.
 */
export const UPGRADE_COPY = {
    panelTitle: "Upgrade Subline",
    panelSubtitle: "Every message translated the moment it arrives, with ✦.",
    monthlyName: "Monthly",
    monthlyPrice: "$2.49 a month",
    annualName: "Annual",
    annualPrice: "$19.99 a year",
    annualNote: "4 months free",
    monthlyButton: "Monthly $2.49",
    annualButton: "Annual $19.99",
    panelFootnote: "Pay in your browser. Subline switches on here by itself.",
    checkoutOpenedToast: "Finish checkout in your browser.",
    /** A notice that stays until dismissed: the buyer is often still in the browser when it lands. */
    purchasedNotice: "You're on. Every message translates by itself now.",
    purchasedNoticeButton: "OK",
    noticeButton: "Upgrade",
    /** Followed by today's count, e.g. "(0 of 3 left today)". */
    popoverUpgrade: "Go automatic ✦",
    settingsLink: "Upgrade",
    previewLink: "Upgrade"
} as const;
