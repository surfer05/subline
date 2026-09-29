import { describe, expect, it } from "vitest";

import { SurfaceCache, type SurfaceStorage } from "../surfaces/cache";
import { SURFACE_MAX_FAST_PER_MINUTE, SurfaceService, type SurfaceOutcome, type SurfaceTier } from "../surfaces/service";

/**
 * Google bursts from surfaces (a member list, a busy server): one Google
 * request at a time, and at most SURFACE_MAX_FAST_PER_MINUTE a minute.
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
        cancel: c.cancel,
        maxBatch: 1
    });
    return { c, service };
}

describe("surface Google bursts", () => {
    it("sends the next Google batch only after the current one has come back", async () => {
        let open = 0;
        let maxOpen = 0;
        const resolvers: Array<() => void> = [];
        const { c, service } = setup((_tier, texts) => {
            open++;
            maxOpen = Math.max(maxOpen, open);
            return new Promise(resolve => resolvers.push(() => {
                open--;
                resolve(texts.map(t => ({ lang: "de", text: "F:" + t })));
            }));
        });
        service.want("Hallo Nummer 0");
        await c.advance(10_000);
        expect(resolvers).toHaveLength(1);
        // More statuses come into view while that request is out: they wait.
        for (let i = 1; i < 5; i++) service.want(`Hallo Nummer ${i}`);
        await c.advance(10_000);
        // maxBatch 1: five texts need five requests, but only one is out.
        expect(resolvers).toHaveLength(1);
        for (let i = 0; i < 4; i++) {
            resolvers[i]!();
            await c.advance(10_000);
            expect(resolvers).toHaveLength(i + 2);
        }
        resolvers[4]!();
        await c.advance(10_000);
        expect(maxOpen).toBe(1);
        expect(service.sent.fast).toBe(5);
    });

    it("takes at most 60 Google requests a minute", async () => {
        const at: number[] = [];
        let now = () => 0;
        const { c, service } = setup(async (_tier, texts) => {
            at.push(now());
            return texts.map(t => ({ lang: "de", text: "F:" + t }));
        });
        now = c.now;
        expect(SURFACE_MAX_FAST_PER_MINUTE).toBe(60);
        for (let i = 0; i < 100; i++) service.want(`Hallo Nummer ${i}`);
        await c.advance(30_000);
        expect(service.sent.fast).toBe(60);
        await c.advance(150_000);
        expect(service.sent.fast).toBe(100);
        // No 60-second window ever holds more than 60 requests.
        for (let i = 0; i < at.length; i++) {
            expect(at.filter(t => t >= at[i]! && t < at[i]! + 60_000).length).toBeLessThanOrEqual(60);
        }
    });
});
