/**
 * Lets settings.ts (and anything else that must not import index.tsx) open
 * the Upgrade panel. index.tsx registers the opener on start() and clears it
 * on stop(). With no opener (plugin stopped) the pricing page opens instead,
 * so an Upgrade link is never a dead click.
 */
import { PRICING_URL } from "./freePlan";

let opener: (() => void) | null = null;

export function registerUpgradeOpener(fn: (() => void) | null): void {
    opener = fn;
}

export function openUpgrade(): void {
    if (opener !== null) {
        opener();
        return;
    }
    (globalThis as any).VencordNative?.native?.openExternal?.(PRICING_URL);
}
