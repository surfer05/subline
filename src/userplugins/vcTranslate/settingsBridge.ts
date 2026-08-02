/**
 * Lets settings.ts notify index.tsx that a setting changed, without a
 * circular import. index.tsx registers on start() and clears on stop().
 */
let handler: (() => void) | null = null;

export function onSettingsChanged(fn: (() => void) | null): void {
    handler = fn;
}

export function notifySettingsChanged(): void {
    handler?.();
}
