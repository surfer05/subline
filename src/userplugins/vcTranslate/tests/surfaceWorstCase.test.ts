import { describe, expect, it } from "vitest";

import { SurfaceCache, type SurfaceStorage } from "../surfaces/cache";
import { SurfaceService, type SurfaceOutcome, type SurfaceTier } from "../surfaces/service";
import { setSurfaceService, tightTranslation } from "../surfaces/ui";

function clock() {
    let now = 1_000_000;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void; }>();
    return {
        now: () => now,
        schedule: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        cancel: (h: unknown) => { timers.delete(h as number); },
        async advance(ms: number) {
            const end = now + ms;
            for (let pass = 0; pass < 10_000; pass++) {
                const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > end) break;
                now = Math.max(now, next[1].at);
                timers.delete(next[0]);
                next[1].fn();
                for (let i = 0; i < 20; i++) await Promise.resolve();
            }
            now = end;
            for (let i = 0; i < 20; i++) await Promise.resolve();
        }
    };
}

function setup(opts: {
    quality?: () => boolean;
    budget?: number;
    translate?: (tier: SurfaceTier, texts: string[], n: number) => Promise<SurfaceOutcome>;
} = {}) {
    const c = clock();
    const mem = new Map<string, unknown>();
    const storage: SurfaceStorage = { get: async k => mem.get(k), set: async (k, v) => { mem.set(k, v); } };
    const cache = new SurfaceCache({ storage, now: c.now, schedule: c.schedule, cancel: c.cancel });
    let left = opts.budget ?? Number.POSITIVE_INFINITY;
    const calls: Array<{ tier: SurfaceTier; texts: string[]; }> = [];
    const translate = opts.translate ?? (async (tier: SurfaceTier, texts: string[]) =>
        texts.map(t => ({ lang: "de", text: `${tier === "quality" ? "Q" : "F"}:${t}`, conf: 0.99 })));
    const service = new SurfaceService({
        isPaid: () => true,
        ...(opts.quality ? { qualityAllowed: opts.quality } : {}),
        targetLang: () => "en",
        locallySkipped: () => false,
        translate: async (tier, texts) => { calls.push({ tier, texts }); return translate(tier, texts, calls.length); },
        cache,
        now: c.now,
        schedule: c.schedule,
        cancel: c.cancel,
        budget: { remaining: () => left, spend: u => { left -= u; } }
    });
    return { c, cache, service, calls, budgetLeft: () => left };
}

describe("AI surfaces when the day's ✦ budget runs out", () => {
    it("a tight text falls back to ≈ in place, not to the untranslated original", async () => {
        const { c, service, calls } = setup({ budget: 0 });
        setSurfaceService(service);
        try {
            service.want("Bin gleich zurück", { tight: true });
            await c.advance(5_000);
            expect(calls.map(x => x.tier)).toEqual(["fast"]);
            expect(tightTranslation("Bin gleich zurück")).toEqual({ lang: "de", text: "F:Bin gleich zurück", glyph: "≈" });
        } finally {
            setSurfaceService(null);
        }
    });

    it("spends ✦ on what is on screen now, newest first, and never on rows scrolled past", async () => {
        const { c, service, calls } = setup({ budget: 200 });
        const visible = Array.from({ length: 5 }, (_, i) => `Sichtbarer Status Nummer ${i}`);
        // Mounted rows re-render (and so want again) whenever told to.
        service.subscribe(() => { for (const v of visible) service.want(v, { tight: true }); });
        for (let i = 0; i < 300; i++) service.want(`Vorbeigescrollt Nummer ${i}`, { tight: true });
        await c.advance(100);
        for (const v of visible) service.want(v, { tight: true });
        await c.advance(60 * 60_000);

        const quality = calls.filter(x => x.tier === "quality");
        expect(quality.length).toBeGreaterThan(0);
        expect(quality[0]!.texts).toEqual(visible);
        // Rows wanted once and gone never cost a request.
        expect(quality.flatMap(x => x.texts).some(t => t.startsWith("Vorbeigescrollt"))).toBe(false);
        expect(tightTranslationOf(service, visible[4]!)).toBe("Q:" + visible[4]);
    });
});

function tightTranslationOf(service: SurfaceService, text: string): string | null {
    setSurfaceService(service);
    try {
        return tightTranslation(text)?.text ?? null;
    } finally {
        setSurfaceService(null);
    }
}

describe("a surface told \"not now\" comes back by itself", () => {
    it("asks again once the wait is over, for views still showing the text", async () => {
        const { c, service, calls, cache } = setup({
            translate: async (tier, texts, n) => n === 1 ? null : texts.map(t => ({ lang: "de", text: `Q:${t}` }))
        });
        const status = "Bin gleich zurück, muss kochen";
        service.subscribe(() => { service.want(status, { tight: true }); });
        service.want(status, { tight: true });
        await c.advance(10 * 60_000);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(tightTranslationOf(service, status)).toBe("Q:" + status);
        void cache;
    });

    it("a refusal before anything was sent costs no per-minute slot", async () => {
        let n = 0;
        const { c, service, calls } = setup({
            translate: async (_tier, texts) => ++n <= 4 ? "busy" : texts.map(t => ({ lang: "de", text: `Q:${t}` }))
        });
        const status = "Heute keine Zeit";
        service.subscribe(() => { service.want(status, { tight: true }); });
        service.want(status, { tight: true });
        // Four refusals before sending, every 8s, all inside one minute.
        await c.advance(50_000);
        expect(calls.length).toBe(5);
        expect(tightTranslationOf(service, status)).toBe("Q:" + status);
    });
});

describe("romanized text in tight places", () => {
    it("never swaps in Google's confident guess for romanized Darija", async () => {
        const source = "ana ma bghitsh nmchi l dar";
        const { c, service } = setup({
            quality: () => false,
            translate: async (_tier, texts) => texts.map(() => ({ lang: "ar", text: "I want to go home", conf: 1 }))
        });
        service.want(source, { tight: true });
        await c.advance(5_000);
        expect(tightTranslationOf(service, source)).toBeNull();
    });
});
