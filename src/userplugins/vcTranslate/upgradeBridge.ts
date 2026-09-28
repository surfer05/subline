/**
 * Lets settings.ts (and anything else that must not import index.tsx) open
 * the Activate / Add AI panel and the code entry. index.tsx registers the
 * openers on start() and clears them on stop(). With no opener (plugin
 * stopped) the pricing page opens instead, so a link is never a dead click.
 */
import { PRICING_URL } from "./freePlan";

let opener: (() => void) | null = null;
let codeOpener: (() => void) | null = null;

export function registerUpgradeOpener(fn: (() => void) | null, codeFn: (() => void) | null = null): void {
    opener = fn;
    codeOpener = codeFn;
}

function pricing(): void {
    (globalThis as any).VencordNative?.native?.openExternal?.(PRICING_URL);
}

/** The Activate panel (not activated) or the Add AI panel (Automatic). */
export function openUpgrade(): void {
    if (opener !== null) opener();
    else pricing();
}

/** The code entry, from the settings page's "Enter a code". */
export function openCodeEntryFromSettings(): void {
    if (codeOpener !== null) codeOpener();
    else pricing();
}
