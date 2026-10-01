/**
 * Stand-in for Vencord's `@api/Notices`, aliased in vitest.config.ts.
 *
 * Models Vencord's real behaviour (src/api/Notices.tsx): one FIFO queue of
 * ["GENERIC", message, buttonText, onOkClick] entries, one `currentNotice`
 * on screen, `popNotice()` dismissing whatever is on screen and the next one
 * taking its place. `userDismiss()` is the notice's X: it calls nothing.
 *
 * `shownNotices` is a live view of what is present (on screen first, then the
 * queue), so a test can count and press notices.
 */

export interface ShownNotice {
    message: unknown;
    buttonText: string;
    onOkClick: () => void;
}

export const noticesQueue: unknown[][] = [];
export let currentNotice: unknown[] | null = null;

export function nextNotice(): void {
    currentNotice = noticesQueue.shift() ?? null;
}

const view = (): ShownNotice[] =>
    [currentNotice, ...noticesQueue]
        .filter((e): e is unknown[] => Array.isArray(e))
        .map(e => ({ message: e[1], buttonText: e[2] as string, onOkClick: e[3] as () => void }));

export const shownNotices: ShownNotice[] = new Proxy([] as ShownNotice[], {
    get(_target, key) {
        const v = view();
        const value = (v as any)[key];
        return typeof value === "function" ? value.bind(v) : value;
    }
});

export function showNotice(message: unknown, buttonText: string, onOkClick: () => void): void {
    noticesQueue.push(["GENERIC", message, buttonText, onOkClick]);
    if (!currentNotice) nextNotice();
}

/** Discord's dismiss of the notice on screen; Vencord then shows the next. */
export function popNotice(): void {
    nextNotice();
}

/** The reader closes the notice on screen with its X: no callback runs. */
export function userDismiss(): void {
    nextNotice();
}

export function __resetNotices(): void {
    noticesQueue.length = 0;
    currentNotice = null;
}
