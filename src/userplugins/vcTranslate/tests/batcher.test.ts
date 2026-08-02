import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBatcher } from "../batcher";
import type { BatchRequest, PendingMessage } from "../types";

const msg = (id: string, text: string, channelId = "c1"): PendingMessage =>
    ({ id, author: `user${id}`, text, channelId });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(overrides: Partial<Parameters<typeof createBatcher>[0]> = {}) {
    const flushed: { req: BatchRequest; channelId: string }[] = [];
    const batcher = createBatcher({
        debounceMs: 700,
        maxBatch: 10,
        contextSize: 8,
        supportsContext: true,
        targetLang: "en",
        onFlush: (req, channelId) => flushed.push({ req, channelId }),
        ...overrides
    });
    return { batcher, flushed };
}

describe("createBatcher", () => {
    it("does not flush before the debounce window elapses", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "hola"));
        vi.advanceTimersByTime(699);
        expect(flushed).toHaveLength(0);
    });

    it("flushes once after the debounce window", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "hola"));
        vi.advanceTimersByTime(700);
        expect(flushed).toHaveLength(1);
        expect(flushed[0].req.messages).toHaveLength(1);
        expect(flushed[0].channelId).toBe("c1");
    });

    it("coalesces a burst into one batch", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "hola"));
        vi.advanceTimersByTime(300);
        batcher.add(msg("2", "que tal"));
        vi.advanceTimersByTime(300);
        batcher.add(msg("3", "bien"));
        vi.advanceTimersByTime(700);

        expect(flushed).toHaveLength(1);
        expect(flushed[0].req.messages.map(m => m.id)).toEqual(["1", "2", "3"]);
    });

    it("flushes immediately when the batch cap is reached", () => {
        const { batcher, flushed } = setup({ maxBatch: 3 });
        batcher.add(msg("1", "a"));
        batcher.add(msg("2", "b"));
        batcher.add(msg("3", "c"));
        expect(flushed).toHaveLength(1);
        expect(flushed[0].req.messages).toHaveLength(3);
    });

    it("keeps separate queues per channel", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "hola", "c1"));
        batcher.add(msg("2", "salut", "c2"));
        vi.advanceTimersByTime(700);

        expect(flushed).toHaveLength(2);
        const byChannel = Object.fromEntries(flushed.map(f => [f.channelId, f.req.messages.length]));
        expect(byChannel).toEqual({ c1: 1, c2: 1 });
    });

    it("includes prior messages as context, newest last", () => {
        const { batcher, flushed } = setup();
        batcher.recordContext(msg("1", "first"));
        batcher.recordContext(msg("2", "second"));
        batcher.add(msg("3", "tercero"));
        vi.advanceTimersByTime(700);

        expect(flushed[0].req.context.map(c => c.text)).toEqual(["first", "second"]);
    });

    it("caps context at contextSize, keeping the most recent", () => {
        const { batcher, flushed } = setup({ contextSize: 2 });
        batcher.recordContext(msg("1", "a"));
        batcher.recordContext(msg("2", "b"));
        batcher.recordContext(msg("3", "c"));
        batcher.add(msg("4", "d"));
        vi.advanceTimersByTime(700);

        expect(flushed[0].req.context.map(c => c.text)).toEqual(["b", "c"]);
    });

    it("sends empty context when the engine does not support it", () => {
        const { batcher, flushed } = setup({ supportsContext: false });
        batcher.recordContext(msg("1", "a"));
        batcher.add(msg("2", "b"));
        vi.advanceTimersByTime(700);

        expect(flushed[0].req.context).toEqual([]);
    });

    it("queued messages also become context for the next batch", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "uno"));
        vi.advanceTimersByTime(700);
        batcher.add(msg("2", "dos"));
        vi.advanceTimersByTime(700);

        expect(flushed[1].req.context.map(c => c.text)).toEqual(["uno"]);
    });

    it("dispose cancels a pending flush", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "hola"));
        batcher.dispose();
        vi.advanceTimersByTime(2000);
        expect(flushed).toHaveLength(0);
    });

    describe("drainPending", () => {
        it("returns every queued message across multiple channels", () => {
            const { batcher } = setup();
            batcher.add(msg("1", "hola", "c1"));
            batcher.add(msg("2", "que tal", "c1"));
            batcher.add(msg("3", "salut", "c2"));

            const drained = batcher.drainPending();

            expect(drained.map(m => m.id).sort()).toEqual(["1", "2", "3"]);
        });

        it("empties the queues so a later timer advance flushes nothing", () => {
            const { batcher, flushed } = setup();
            batcher.add(msg("1", "hola", "c1"));
            batcher.add(msg("2", "salut", "c2"));

            batcher.drainPending();
            vi.advanceTimersByTime(2000);

            expect(flushed).toHaveLength(0);
        });

        it("preserves the rolling context windows without leaking the drained message back in", () => {
            const { batcher, flushed } = setup();
            batcher.recordContext(msg("1", "first", "c1"));
            batcher.add(msg("2", "queued", "c1"));

            batcher.drainPending();

            // Re-add a fresh message and flush: if context survived the drain,
            // it must still include "first" ahead of the new message. And if
            // "2" was actually removed from the queue (not just ignored while
            // its timer kept running), it must not resurface in this flush's
            // messages either.
            batcher.add(msg("3", "third", "c1"));
            vi.advanceTimersByTime(700);

            expect(flushed).toHaveLength(1);
            expect(flushed[0].req.messages.map(m => m.id)).toEqual(["3"]);
            expect(flushed[0].req.context.map(c => c.text)).toEqual(["first"]);
        });

        it("does not flush the drained messages itself", () => {
            const { batcher, flushed } = setup();
            batcher.add(msg("1", "hola", "c1"));

            const drained = batcher.drainPending();

            expect(drained).toHaveLength(1);
            expect(flushed).toHaveLength(0);
        });
    });
});
