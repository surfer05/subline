import { currentNotice, noticesQueue, popNotice, showNotice } from "@api/Notices";

/**
 * Subline's own notices (the activation notice and the "checking" notice),
 * tracked by whether THEY are still there, not by a flag.
 *
 * WHY. Vencord's notices are one FIFO queue, and `popNotice()` dismisses
 * whatever notice is on screen. The old code assumed its own notice was that
 * one: when the reader had closed it with its X, a later "take it down"
 * dismissed someone else's (the once-a-session "restart for the update"
 * banner), and every Activate click queued another identical device-limit
 * notice the reader had to dismiss one by one.
 *
 * Each notice is found by its button callback, a function made fresh for
 * every show, so an identity check finds exactly ours. A notice is "present"
 * while it is on screen or still queued; the X removes it from both without
 * calling anything, which is how a close by hand is seen.
 */
export type NoticeSlot = "activation" | "checking";

type Entry = unknown[];

const mine: Record<NoticeSlot, { cb: () => void; text: string; } | null> = { activation: null, checking: null };

const callbackOf = (entry: unknown): unknown => Array.isArray(entry) ? (entry as Entry)[3] : undefined;

function queue(): Entry[] {
    return Array.isArray(noticesQueue) ? noticesQueue as Entry[] : [];
}

/** Is this slot's notice on screen or waiting in the queue? */
export function noticePresent(slot: NoticeSlot): boolean {
    const m = mine[slot];
    if (m === null) return false;
    return callbackOf(currentNotice) === m.cb || queue().some(e => callbackOf(e) === m.cb);
}

/** The text this slot's notice is showing, "" for none. */
export function noticeShowing(slot: NoticeSlot): string {
    return noticePresent(slot) ? mine[slot]!.text : "";
}

/** Take this slot's notice down. Never dismisses a notice that is not ours. */
export function takeNotice(slot: NoticeSlot): void {
    const m = mine[slot];
    mine[slot] = null;
    if (m === null) return;
    if (callbackOf(currentNotice) === m.cb) {
        popNotice();
        return;
    }
    const q = queue();
    const at = q.findIndex(e => callbackOf(e) === m.cb);
    if (at >= 0) q.splice(at, 1);
}

/**
 * Show `text` in this slot. Nothing when the same text is already there. Once
 * the reader has closed it, the same text is not shown again this session
 * unless `force` (they pressed something that asks for it).
 */
export function putNotice(
    slot: NoticeSlot, text: string, button: string, onClick: () => void, force = false
): void {
    const m = mine[slot];
    if (m !== null && m.text === text && (noticePresent(slot) || !force)) return;
    takeNotice(slot);
    const cb = () => onClick();
    mine[slot] = { cb, text };
    showNotice(text, button, cb);
}

/** Forget both slots without touching the screen (stop()). */
export function forgetNotices(): void {
    mine.activation = null;
    mine.checking = null;
}
