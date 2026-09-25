/**
 * The action vocabulary's presentation: what each action is called, and which
 * one gets the filled button.
 *
 * NOT in the renderer, though only the renderer draws them. The renderer is the
 * one module the suite never executes — vitest runs `tests/**` in a `node`
 * environment and the renderer touches `document` at module load — so anything
 * that lives there is untestable by construction. These two tables encode a
 * rule ("one primary per screen, never two") that was written as a comment
 * because there was nowhere to assert it from.
 *
 * Here, a test can import them and walk every state the flow can reach.
 */

import type { FlowActionType } from "./flow.js";

export const ACTION_LABELS: Record<FlowActionType, string> = {
    next: "Continue",
    cancel: "Cancel",
    "pick-path": "Choose Discord…",
    "choose-install": "Choose",
    "proceed-over-mod": "Replace it and continue",
    "quit-discord": "Quit Discord for me",
    // Says what it does. "Try again" here would hide that this one does not ask
    // Discord first — the user is consenting to the close, which is the whole
    // reason a forced quit is allowed to exist at all.
    "force-quit-discord": "Close Discord anyway",
    recheck: "Check again",
    "set-language": "Continue",
    "set-code": "Save code",
    // Says what is being declined: a code, not ✦. A free install still gets
    // ≈ and ✦ automatically for 7 days, so "Use free Google only" was false.
    "skip-code": "Continue without a code",
    // Secondary: Subline already opened the pane itself. This is for someone
    // who closed it or lost it behind another window.
    "open-permission-settings": "Open it again",
    retry: "Try again",
    // Named for what it costs, not for what it skips. "Continue" here would let
    // someone give up the thing that keeps their install alive without ever
    // learning they had.
    "skip-helper": "Continue without background updates",
    "skip-launch": "I'll open Discord myself",
    finish: "Done"
};

export /**
 * Which actions get the filled button.
 *
 * A full Record rather than an array of the primary ones: as an array, a new
 * action silently defaulted to secondary, and nothing here had to be touched at
 * all. Now the compiler asks the question for every action that exists.
 *
 * "One per screen, never two" is a property of each SCREEN's action list, not
 * of this table — see the test that walks every state asserting it.
 */
const IS_PRIMARY: Record<FlowActionType, boolean> = {
    next: true,
    cancel: false,
    "pick-path": false,
    "choose-install": false,
    "proceed-over-mod": true,
    "quit-discord": true,
    "force-quit-discord": true,
    recheck: false,
    "set-language": true,
    "set-code": true,
    "skip-code": false,
    "open-permission-settings": false,
    retry: true,
    "skip-helper": false,
    "skip-launch": false,
    finish: true
};
