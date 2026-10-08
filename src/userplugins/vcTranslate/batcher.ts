import { CONTEXT_TEXT_MAX } from "./fitRequest";
import type { BatchRequest, PendingMessage } from "./types";

/**
 * How many conversation lines a channel's ring keeps (P6). Bigger than one
 * request's context on purpose: the batch's own messages sit in it too, and a
 * channel open records its whole recent backlog (catch-up), so the lines just
 * before an older catch-up message are still there when its batch flushes.
 * Texts are kept clipped (CONTEXT_TEXT_MAX), so this stays small per channel.
 */
export const CONTEXT_RING_SIZE = 64;

export interface BatcherOptions {
    /**
     * How long the window from a burst's first message is. A function is
     * consulted each time a timer is ARMED — not per message, and never for a
     * window already running — so a caller can pick the window from live state
     * (the quality tier shortens its 20s to the fast 700ms while Google is
     * cooling down, because its long window is justified by "the reader is
     * already looking at a Google line", which is false exactly then).
     */
    debounceMs: number | (() => number);
    maxBatch: number;
    /** Lines of context one request carries (the newest before the batch). */
    contextSize: number;
    /** Lines the ring keeps; default max(CONTEXT_RING_SIZE, contextSize + maxBatch). */
    ringSize?: number;
    supportsContext: boolean;
    targetLang: string;
    onFlush: (req: BatchRequest, channelId: string) => void;
}

export interface Batcher {
    add(msg: PendingMessage): void;
    recordContext(msg: PendingMessage): void;
    /**
     * Take a message out of its queue before it is sent, e.g. because it was
     * edited inside the debounce window. True when it was queued.
     */
    remove(id: string): boolean;
    flushNow(): void;
    /** Remove and return every queued message across all channels, without flushing. */
    drainPending(): PendingMessage[];
    dispose(): void;
}

/**
 * One line of the conversation ring. `id` (de-duplication and order) and
 * `seq` (arrival order, the tie-break for ids that are not snowflakes) are
 * internal: both are stripped before the context reaches a BatchRequest.
 */
interface RingEntry { id: string; author: string; text: string; seq: number }

interface ChannelState {
    queue: PendingMessage[];
    /** The conversation, oldest first by message id, never by arrival. */
    context: RingEntry[];
    timer: ReturnType<typeof setTimeout> | null;
}

const SNOWFLAKE = /^\d{1,25}$/;

/**
 * Discord ids are snowflakes: a later message has a larger number. Compared
 * as digit strings (length, then text), so no BigInt and no precision loss.
 * Anything that is not a snowflake (tests, a future id shape) falls back to
 * arrival order, which is what the ring always used.
 */
export function compareMessageOrder(a: { id: string; seq: number }, b: { id: string; seq: number }): number {
    if (SNOWFLAKE.test(a.id) && SNOWFLAKE.test(b.id)) {
        const x = a.id.replace(/^0+(?=\d)/, ""), y = b.id.replace(/^0+(?=\d)/, "");
        if (x.length !== y.length) return x.length - y.length;
        if (x !== y) return x < y ? -1 : 1;
    }
    return a.seq - b.seq;
}

export function createBatcher(opts: BatcherOptions): Batcher {
    const channels = new Map<string, ChannelState>();
    // Arrival counter: the order tie-break for ids that are not snowflakes.
    let nextSeq = 0;
    // The ring holds more than one request's context: the batch's own
    // messages sit in it too (they are recorded when the reader sees them,
    // before the flush), and a full batch must not push out the lines that
    // came before it.
    const ringSize = opts.ringSize ?? Math.max(CONTEXT_RING_SIZE, opts.contextSize + opts.maxBatch);
    const clipText = (text: string) => {
        if (text.length <= CONTEXT_TEXT_MAX) return text;
        const points = Array.from(text);
        return points.length <= CONTEXT_TEXT_MAX ? text : points.slice(0, CONTEXT_TEXT_MAX).join("") + "…";
    };
    const trim = (s: ChannelState) => {
        // The OLDEST lines go first, so history the reader scrolled back to can
        // never push out the conversation happening now.
        if (s.context.length > ringSize) s.context.splice(0, s.context.length - ringSize);
    };

    const stateFor = (channelId: string): ChannelState => {
        let s = channels.get(channelId);
        if (!s) {
            s = { queue: [], context: [], timer: null };
            channels.set(channelId, s);
        }
        return s;
    };

    const pushContext = (s: ChannelState, msg: PendingMessage, trimAfter = true) => {
        // The same message can legitimately be offered as context more than
        // once: catch-up runs for BOTH CHANNEL_SELECT and LOAD_MESSAGES_SUCCESS
        // on a single channel open, and every message the reader sees is
        // recorded (P6), queued or not. Without this check the ring fills with
        // copies, halving the real context the model sees. A second offer of
        // the same id only refreshes its text (an edit). Linear scan is fine:
        // the ring is ringSize (64) long.
        const known = s.context.find(c => c.id === msg.id);
        if (known !== undefined) {
            known.author = msg.author;
            known.text = clipText(msg.text);
            return;
        }
        // P6: in conversation order, not arrival order. Catch-up, cache hits
        // and live messages reach this from different paths and at different
        // times; the model must still read the chat the way it was written.
        const entry: RingEntry = { id: msg.id, author: msg.author, text: clipText(msg.text), seq: nextSeq++ };
        let i = s.context.length;
        while (i > 0 && compareMessageOrder(entry, s.context[i - 1]!) < 0) i--;
        s.context.splice(i, 0, entry);
        if (trimAfter) trim(s);
    };

    const flushChannel = (channelId: string) => {
        const s = channels.get(channelId);
        if (!s) return;
        if (s.timer !== null) {
            clearTimeout(s.timer);
            s.timer = null;
        }
        if (s.queue.length === 0) return;

        const batch = s.queue.splice(0, s.queue.length);
        // The batch's own messages join the ring (already there when the
        // reader saw them first), then the context is the contextSize lines
        // that come BEFORE the batch's newest message and are not themselves
        // being translated. Lines written after the whole batch are left out:
        // they are not what the batch answers. The internal id and seq are
        // dropped here.
        // Trimmed only AFTER the snapshot: an old (scroll-back) batch must
        // still find the lines before it that the ring holds.
        for (const m of batch) pushContext(s, m, false);
        let context: { author: string; text: string }[] = [];
        if (opts.supportsContext) {
            const ids = new Set(batch.map(m => m.id));
            const own = s.context.filter(c => ids.has(c.id));
            // Never empty: the batch was just pushed, untrimmed.
            const newest = own.length > 0 ? own.reduce((a, b) => compareMessageOrder(a, b) >= 0 ? a : b) : undefined;
            if (newest !== undefined) {
                context = s.context
                    .filter(c => !ids.has(c.id) && compareMessageOrder(c, newest) < 0)
                    .slice(-opts.contextSize)
                    .map(c => ({ author: c.author, text: c.text }));
            }
        }
        trim(s);

        opts.onFlush(
            {
                // replyToId is passed straight through, not resolved here: the
                // batcher has no access to the translation store, and holding
                // the resolution until flush time gives the parent the longest
                // possible chance to have been translated already.
                //
                // R3: the parent's clipped copy travels only when the parent is
                // not in this same batch; inside the batch the relay names it
                // by id, and a second copy would only cost tokens.
                messages: batch.map(m => {
                    const parentInBatch = m.replyToId !== undefined && batch.some(x => x.id === m.replyToId);
                    return {
                        id: m.id, author: m.author, text: m.text, replyToId: m.replyToId,
                        ...(m.replyTo !== undefined && !parentInBatch ? { replyTo: m.replyTo } : {})
                    };
                }),
                context,
                targetLang: opts.targetLang
            },
            channelId
        );
    };

    return {
        add(msg) {
            const s = stateFor(msg.channelId);
            s.queue.push(msg);

            if (s.queue.length >= opts.maxBatch) {
                flushChannel(msg.channelId);
                return;
            }
            // DELIBERATE: a FIXED window from the first message of a burst, not
            // a sliding per-message reset. Only arm the timer when none is
            // running; a later message in the same burst must not push the
            // deadline back. A sliding debounce would never fire while a channel
            // stays active, so translations would appear only once everyone
            // stopped talking — the opposite of what this plugin is for. The
            // fixed window guarantees a flush within debounceMs of the first
            // queued message. Do not "fix" this into a sliding debounce.
            if (s.timer === null) {
                const wait = typeof opts.debounceMs === "function" ? opts.debounceMs() : opts.debounceMs;
                s.timer = setTimeout(() => flushChannel(msg.channelId), wait);
            }
        },

        recordContext(msg) {
            pushContext(stateFor(msg.channelId), msg);
        },

        remove(id) {
            let removed = false;
            for (const s of channels.values()) {
                const i = s.queue.findIndex(m => m.id === id);
                if (i >= 0) {
                    s.queue.splice(i, 1);
                    removed = true;
                }
            }
            return removed;
        },

        flushNow() {
            for (const channelId of [...channels.keys()]) flushChannel(channelId);
        },

        drainPending() {
            const drained: PendingMessage[] = [];
            for (const s of channels.values()) {
                if (s.timer !== null) {
                    clearTimeout(s.timer);
                    s.timer = null;
                }
                if (s.queue.length > 0) {
                    // Splice, not slice: the messages leave the queue entirely
                    // (caller is responsible for re-queueing them elsewhere).
                    // Context is deliberately untouched.
                    drained.push(...s.queue.splice(0, s.queue.length));
                }
            }
            return drained;
        },

        dispose() {
            for (const s of channels.values()) {
                if (s.timer !== null) clearTimeout(s.timer);
            }
            channels.clear();
        }
    };
}
