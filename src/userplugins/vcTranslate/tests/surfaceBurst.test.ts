import { describe, expect, it } from "vitest";

import { SurfaceCache, type SurfaceStorage } from "../surfaces/cache";
import { SURFACE_MAX_FAST_BATCH, SURFACE_MAX_FAST_PER_MINUTE, SurfaceService, type SurfaceOutcome, type SurfaceTier } from "../surfaces/service";

/**
 * Google bursts from surfaces (a member list, a busy server): one Google
 * batch at a time, at most SURFACE_MAX_FAST_BATCH texts a batch, and at most
 * SURFACE_MAX_FAST_PER_MINUTE texts a minute.
 */

function clock() {
    let now = 1_000_000;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void; }>();
    return {
        now: () => now,
        schedule: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        cancel: (h: unknown) => { timers.delete(h as number); },
        /** Move time forward in 100 ms steps, so timers armed along the way fire too. */
        async advance(ms: number) {
            for (let t = 0; t < ms; t += 100) await this.step(Math.min(100, ms - t));
        },
        async step(ms: number) {
            now += ms;
            for (let pass = 0; pass < 50; pass++) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= now);
                if (due.length === 0) break;
                for (const [id, t] of due) { timers.delete(id); t.fn(); }
                for (let i = 0; i < 20; i++) await Promise.resolve();
            }
            for (let i = 0; i < 20; i++) await Promise.resolve();
        }
    };
}

/** The service with PRODUCTION batch sizes and caps (no maxBatch override). */
function setup(translate: (tier: SurfaceTier, texts: string[]) => Promise<SurfaceOutcome>) {
    const c = clock();
    const storage: SurfaceStorage = { get: async () => undefined, set: async () => { } };
    const cache = new SurfaceCache({ storage, now: c.now, schedule: c.schedule, cancel: c.cancel });
    const service = new SurfaceService({
        isPaid: () => true,
        qualityAllowed: () => false,
        targetLang: () => "en",
        locallySkipped: () => false,
        translate,
        cache,
        now: c.now,
        schedule: c.schedule,
        cancel: c.cancel
    });
    return { c, service };
}

describe("surface Google bursts", () => {
    it("sends the next Google batch only after the current one has come back", async () => {
        let open = 0;
        let maxOpen = 0;
        const batches: string[][] = [];
        const resolvers: Array<() => void> = [];
        const { c, service } = setup((_tier, texts) => {
            open++;
            maxOpen = Math.max(maxOpen, open);
            batches.push(texts);
            return new Promise(resolve => resolvers.push(() => {
                open--;
                resolve(texts.map(t => ({ lang: "de", text: "F:" + t })));
            }));
        });
        service.want("Hallo Nummer 0");
        await c.advance(10_000);
        expect(resolvers).toHaveLength(1);
        // Nine more statuses come into view while that request is out: they wait.
        for (let i = 1; i < 10; i++) service.want(`Hallo Nummer ${i}`);
        await c.advance(10_000);
        expect(resolvers).toHaveLength(1);
        resolvers[0]!();
        await c.advance(10_000);
        expect(resolvers).toHaveLength(2);
        resolvers[1]!();
        await c.advance(10_000);
        expect(resolvers).toHaveLength(3);
        resolvers[2]!();
        await c.advance(10_000);
        expect(maxOpen).toBe(1);
        expect(batches.map(b => b.length)).toEqual([1, 5, 4]);
    });

    it("never puts more than 5 texts in one Google batch", async () => {
        const sizes: number[] = [];
        const { c, service } = setup(async (_tier, texts) => {
            sizes.push(texts.length);
            return texts.map(t => ({ lang: "de", text: "F:" + t }));
        });
        expect(SURFACE_MAX_FAST_BATCH).toBe(5);
        for (let i = 0; i < 23; i++) service.want(`Hallo Nummer ${i}`);
        await c.advance(30_000);
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(23);
        expect(Math.max(...sizes)).toBe(5);
    });

    it("sends at most 60 texts to Google a minute, counting texts, not batches", async () => {
        const at: number[] = [];
        let now = () => 0;
        const { c, service } = setup(async (_tier, texts) => {
            for (const _ of texts) at.push(now());
            return texts.map(t => ({ lang: "de", text: "F:" + t }));
        });
        now = c.now;
        expect(SURFACE_MAX_FAST_PER_MINUTE).toBe(60);
        for (let i = 0; i < 100; i++) service.want(`Hallo Nummer ${i}`);
        await c.advance(30_000);
        expect(at.length).toBe(60);
        await c.advance(150_000);
        expect(at.length).toBe(100);
        // No 60-second window ever holds more than 60 Google texts.
        for (let i = 0; i < at.length; i++) {
            expect(at.filter(t => t >= at[i]! && t < at[i]! + 60_000).length).toBeLessThanOrEqual(60);
        }
    });
});
