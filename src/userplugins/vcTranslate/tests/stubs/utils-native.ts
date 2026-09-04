/**
 * Stand-in for Vencord's `@utils/native`, aliased in vitest.config.ts.
 *
 * The plugin calls `relaunch` as the restart action on the update banner
 * (updateNotice.ts / index.tsx). The real one calls
 * `window.DiscordNative.app.relaunch()` (or Vesktop's); here it just records
 * that it was invoked, so a test can prove the banner's button restarts Discord
 * without actually tearing down the process.
 */

export const relaunchCalls: { count: number; } = { count: 0 };

export function relaunch(): void {
    relaunchCalls.count += 1;
}

export function __resetRelaunch(): void {
    relaunchCalls.count = 0;
}
