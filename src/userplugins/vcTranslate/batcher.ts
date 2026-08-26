import type { BatchRequest, PendingMessage } from "./types";

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
    contextSize: number;
    supportsContext: boolean;
    targetLang: string;
    onFlush: (req: BatchRequest, channelId: string) => void;
}

export interface Batcher {
    add(msg: PendingMessage): void;
    recordContext(msg: PendingMessage): void;
    flushNow(): void;
    /** Remove and return every queued message across all channels, without flushing. */
    drainPending(): PendingMessage[];
    dispose(): void;
}

interface ChannelState {
    queue: PendingMessage[];
    // `id` is carried internally for de-duplication only; it is stripped before
    // the context reaches a BatchRequest.
    context: { id: string; author: string; text: string }[];
    timer: ReturnType<typeof setTimeout> | null;
}

export function createBatcher(opts: BatcherOptions): Batcher {
    const channels = new Map<string, ChannelState>();

    const stateFor = (channelId: string): ChannelState => {
        let s = channels.get(channelId);
        if (!s) {
            s = { queue: [], context: [], timer: null };
            channels.set(channelId, s);
        }
        return s;
    };

    const pushContext = (s: ChannelState, msg: PendingMessage) => {
        // The same message can legitimately be offered as context more than
        // once: catch-up runs for BOTH CHANNEL_SELECT and LOAD_MESSAGES_SUCCESS
        // on a single channel open, so every skipped message in the backlog is
        // handed over twice. Without this check the 8-slot ring fills with two
        // copies of each, halving the real context the model sees. Linear scan
        // is fine — the ring is contextSize (8) long.
        if (s.context.some(c => c.id === msg.id)) return;
        s.context.push({ id: msg.id, author: msg.author, text: msg.text });
        if (s.context.length > opts.contextSize) {
            s.context.splice(0, s.context.length - opts.contextSize);
        }
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
        // Snapshot context BEFORE the batch's own messages join it. The
        // internal `id` is dropped here — it exists only for de-duplication.
        const context = opts.supportsContext
            ? s.context.map(c => ({ author: c.author, text: c.text }))
            : [];
        for (const m of batch) pushContext(s, m);

        opts.onFlush(
            {
                // replyToId is passed straight through, not resolved here: the
                // batcher has no access to the translation store, and holding
                // the resolution until flush time gives the parent the longest
                // possible chance to have been translated already.
                messages: batch.map(m => ({
                    id: m.id, author: m.author, text: m.text, replyToId: m.replyToId
                })),
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
