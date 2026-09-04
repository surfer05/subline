/**
 * Stand-in for Vencord's `@api/Notices`, aliased in vitest.config.ts.
 *
 * The plugin uses `showNotice` for the "Subline updated, restart Discord"
 * banner (updateNotice.ts, wired in index.tsx). This stub records each shown
 * notice so a test can assert one was raised and invoke its restart action,
 * without a real Discord notice bar.
 */

export interface ShownNotice {
    message: unknown;
    buttonText: string;
    onOkClick: () => void;
}

export const shownNotices: ShownNotice[] = [];

export function showNotice(message: unknown, buttonText: string, onOkClick: () => void): void {
    shownNotices.push({ message, buttonText, onOkClick });
}

export function popNotice(): void {
    shownNotices.pop();
}

export function __resetNotices(): void {
    shownNotices.length = 0;
}
