/**
 * Every title and description on Subline's settings page, in one place, so the
 * copy can be rewritten without reading any code. Titles are sentence case and
 * go to Vencord's `displayName` (without one, Vencord builds a title from the
 * setting's key, e.g. "Target Lang"). Keys stay as they are: the installer
 * writes some of them into Vencord's settings.json, and renaming them would
 * strand stored values. Short plain sentences, no em dashes.
 */
export const SETTINGS_COPY = {
    /** The line at the top of the Subline settings tab (installer/packaging/branding/sublineTab.tsx mirrors it). */
    top: "Subline translates messages in other languages and shows the translation underneath.",
    sublineCode: {
        title: "Subline code",
        description: "From your purchase email. Keeps everything automatic."
    },
    /** The plan card at the top of the page: what this install has, and its code. */
    plan: {
        none: "Not activated.",
        automatic: "Plan: Automatic.",
        ai: "Plan: Automatic + AI.",
        codeLabel: "Your code:",
        copy: "Copy",
        copied: "Code copied.",
        activate: "Activate",
        addAi: "Add AI",
        /** In place of Activate / Add AI while a payment is on its way (same words as UPGRADE_COPY.paymentPending). */
        paymentPending: "Payment being confirmed",
        enterCode: "Enter a code"
    },
    targetLang: {
        title: "Reading language",
        description: "Messages are translated into this language."
    },
    catchUpCount: {
        title: "Earlier messages",
        description: "How many recent messages to translate when you open a channel."
    },
    globalAuto: {
        title: "All servers",
        description: "Off: only channels you turn on with the globe button. DMs stay off unless you turn one on."
    },
    translateSurfaces: {
        title: "Profiles, embeds and more",
        description: "Also translate statuses, bios, embeds, polls, topics and titles."
    },
    debugLogging: {
        title: "Debug log",
        description: "Writes details to Discord's console for troubleshooting. Stays on your computer."
    }
} as const;
