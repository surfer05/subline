import type { BatchRequest, PendingMessage } from "./types";

export interface BatcherOptions {
    debounceMs: number;
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
    dispose(): void;
}

interface ChannelState {
    queue: PendingMessage[];
    context: { author: string; text: string }[];
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
        s.context.push({ author: msg.author, text: msg.text });
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
        // Snapshot context BEFORE the batch's own messages join it.
        const context = opts.supportsContext ? [...s.context] : [];
        for (const m of batch) pushContext(s, m);

        opts.onFlush(
            {
                messages: batch.map(m => ({ id: m.id, author: m.author, text: m.text })),
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
                s.timer = setTimeout(() => flushChannel(msg.channelId), opts.debounceMs);
            }
        },

        recordContext(msg) {
            pushContext(stateFor(msg.channelId), msg);
        },

        flushNow() {
            for (const channelId of [...channels.keys()]) flushChannel(channelId);
        },

        dispose() {
            for (const s of channels.values()) {
                if (s.timer !== null) clearTimeout(s.timer);
            }
            channels.clear();
        }
    };
}
