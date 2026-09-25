import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    normalizeSurfaceText, SURFACE_CACHE_KEY, SurfaceCache, surfaceKey, type SurfaceStorage
} from "../surfaces/cache";
import {
    appliedTagNames, customStatusText, embedTexts, forwardTexts, messageSurfaceTexts, onboardingPromptTexts, pollTexts,
    replyReference
} from "../surfaces/extract";
import { SurfaceService, type SurfaceOutcome, type SurfaceTier } from "../surfaces/service";
import { displayFor, hintTitle, safe, setSurfaceService, SurfaceHint, SurfaceLines } from "../surfaces/ui";

/* ------------------------------------------------------------ harness --- */

function memoryStorage() {
    const mem = new Map<string, unknown>();
    const writes: unknown[] = [];
    const storage: SurfaceStorage = {
        get: async key => mem.get(key),
        set: async (key, value) => { writes.push(value); mem.set(key, value); }
    };
    return { mem, writes, storage };
}

/** A clock and a timer queue the test advances by hand. */
function clock() {
    let now = 1_000_000;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void; }>();
    return {
        now: () => now,
        schedule: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        cancel: (h: unknown) => { timers.delete(h as number); },
        async advance(ms: number) {
            now += ms;
            for (let pass = 0; pass < 10; pass++) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= now);
                if (due.length === 0) break;
                for (const [id, t] of due) { timers.delete(id); t.fn(); }
                for (let i = 0; i < 20; i++) await Promise.resolve();
            }
            for (let i = 0; i < 20; i++) await Promise.resolve();
        },
        pending: () => timers.size
    };
}

function setup(opts: { paid?: () => boolean; translate?: (tier: SurfaceTier, texts: string[]) => Promise<SurfaceOutcome>; } = {}) {
    const c = clock();
    const { storage, writes, mem } = memoryStorage();
    const cache = new SurfaceCache({ storage, now: c.now, schedule: c.schedule, cancel: c.cancel });
    const calls: Array<{ tier: SurfaceTier; texts: string[]; }> = [];
    const translate = opts.translate ?? (async (tier: SurfaceTier, texts: string[]) =>
        texts.map(t => ({ lang: "de", text: `${tier === "quality" ? "Q" : "F"}:${t}`, conf: 0.99 })));
    const service = new SurfaceService({
        isPaid: opts.paid ?? (() => true),
        targetLang: () => "en",
        locallySkipped: t => /^hello\b/i.test(t),
        translate: async (tier, texts) => { calls.push({ tier, texts }); return translate(tier, texts); },
        cache,
        now: c.now,
        schedule: c.schedule,
        cancel: c.cancel
    });
    return { c, cache, service, calls, writes, mem, storage };
}

/* -------------------------------------------------------------- cache --- */

describe("surface cache", () => {
    it("keys by normalised text and target language, keeping line breaks", () => {
        expect(normalizeSurfaceText("  Hallo   Welt \n\n  zweite\tZeile ")).toBe("Hallo Welt\n\nzweite Zeile");
        expect(surfaceKey(" Hallo  Welt", "en")).toBe(surfaceKey("Hallo Welt ", "en"));
        expect(surfaceKey("Hallo", "en")).not.toBe(surfaceKey("Hallo", "fr"));
    });

    it("never replaces a ✦ with a ≈", () => {
        const { cache } = setup();
        cache.put("k", { quality: { lang: "de", text: "Q" } });
        cache.put("k", { fast: { lang: "de", text: "F" } });
        expect(cache.get("k")).toMatchObject({ quality: { text: "Q" } });
        expect(cache.get("k")?.fast).toBeUndefined();
    });

    it("evicts the least recently used past the limit, and a read counts as use", () => {
        const c = clock();
        const cache = new SurfaceCache({ storage: memoryStorage().storage, now: c.now, schedule: c.schedule, cancel: c.cancel, maxEntries: 3 });
        cache.put("a", { skip: true });
        cache.put("b", { skip: true });
        cache.put("c", { skip: true });
        cache.get("a");
        cache.put("d", { skip: true });
        expect(cache.keys()).toEqual(["c", "a", "d"]);
        expect(cache.get("b")).toBeUndefined();
    });

    it("stops serving entries older than 30 days", async () => {
        const c = clock();
        const cache = new SurfaceCache({ storage: memoryStorage().storage, now: c.now, schedule: c.schedule, cancel: c.cancel });
        cache.put("old", { quality: { lang: "de", text: "x" } });
        await c.advance(31 * 24 * 60 * 60 * 1000);
        expect(cache.get("old")).toBeUndefined();
    });

    it("persists once after a quiet period, however many entries changed", async () => {
        const { cache, c, writes } = setup();
        for (let i = 0; i < 50; i++) cache.put(`k${i}`, { quality: { lang: "de", text: `t${i}` } });
        expect(writes).toHaveLength(0);
        await c.advance(2_000);
        expect(writes).toHaveLength(1);
        expect((writes[0] as unknown[]).length).toBe(50);
    });

    it("reloads what it saved in the next session, dropping bad and expired rows", async () => {
        const { cache, c, storage, mem } = setup();
        cache.put(surfaceKey("Hallo Welt", "en"), { quality: { lang: "de", text: "Hello world" } });
        await cache.persistNow();
        const saved = mem.get(SURFACE_CACHE_KEY) as unknown[];
        mem.set(SURFACE_CACHE_KEY, [...saved, ["bad", { at: "x" }], 42, ["old", { at: c.now() - 31 * 24 * 60 * 60 * 1000, skip: true }]]);

        const next = new SurfaceCache({ storage, now: c.now, schedule: c.schedule, cancel: c.cancel });
        await next.load();
        expect(next.get(surfaceKey("Hallo Welt", "en"))?.quality?.text).toBe("Hello world");
        expect(next.size).toBe(1);
    });

    it("keeps an entry set this session over the disk copy", async () => {
        const { storage, c, mem } = setup();
        mem.set(SURFACE_CACHE_KEY, [["k", { at: c.now(), fast: { lang: "de", text: "old" } }]]);
        const cache = new SurfaceCache({ storage, now: c.now, schedule: c.schedule, cancel: c.cancel });
        cache.put("k", { quality: { lang: "de", text: "new" } });
        await cache.load();
        expect(cache.get("k")?.quality?.text).toBe("new");
    });
});

/* ------------------------------------------------------------ service --- */

describe("surface service", () => {
    it("a free or trial install queues nothing and sends nothing", async () => {
        const { service, calls, c } = setup({ paid: () => false });
        for (let i = 0; i < 50; i++) expect(service.want(`Status Nummer ${i}`)).toBeNull();
        await c.advance(10_000);
        expect(calls).toEqual([]);
        expect(c.pending()).toBe(0);
    });

    it("fifty statuses leave in two requests per tier, not fifty", async () => {
        const { service, calls, c } = setup();
        for (let i = 0; i < 50; i++) service.want(`Status Nummer ${i}`);
        await c.advance(400);
        await c.advance(1_500);
        await c.advance(1_500);
        const quality = calls.filter(x => x.tier === "quality");
        const fast = calls.filter(x => x.tier === "fast");
        expect(quality).toHaveLength(2);
        expect(fast).toHaveLength(2);
        expect(quality.flatMap(x => x.texts)).toHaveLength(50);
    });

    it("the same text in many places is one request, and a cached text is none", async () => {
        const { service, calls, c } = setup();
        for (let i = 0; i < 10; i++) service.want("Bin gleich zurück");
        await c.advance(5_000);
        expect(calls.flatMap(x => x.texts)).toEqual(["Bin gleich zurück", "Bin gleich zurück"]);
        expect(service.want("  Bin gleich   zurück ")).toMatchObject({ quality: { text: "Q:Bin gleich zurück" } });
        await c.advance(5_000);
        expect(calls).toHaveLength(2);
    });

    it("≈ first, then ✦ replaces it", async () => {
        const { service, c } = setup();
        service.want("Guten Morgen zusammen");
        await c.advance(400);
        expect(service.want("Guten Morgen zusammen")).toMatchObject({ fast: { text: "F:Guten Morgen zusammen" } });
        await c.advance(1_500);
        expect(service.want("Guten Morgen zusammen")).toMatchObject({ quality: { text: "Q:Guten Morgen zusammen" } });
    });

    it("respects the local skip rules: text already in the target language costs nothing", async () => {
        const { service, calls, c } = setup();
        expect(service.want("hello there friends")).toBeNull();
        expect(service.want("   ")).toBeNull();
        await c.advance(5_000);
        expect(calls).toEqual([]);
    });

    it("an engine's skip is final for both tiers", async () => {
        const { service, calls, c } = setup({ translate: async (_t, texts) => texts.map(() => "skip" as const) });
        service.want("ok ok ok");
        await c.advance(400);
        await c.advance(1_500);
        expect(calls.map(x => x.tier)).toEqual(["fast"]);
        expect(service.want("ok ok ok")).toBeNull();
    });

    it("'not now' retries after a minute; a failure waits ten", async () => {
        let answer: SurfaceOutcome = null;
        const { service, calls, c } = setup({ translate: async () => answer });
        service.want("Wir sehen uns morgen");
        await c.advance(2_000);
        const after = calls.length;
        service.want("Wir sehen uns morgen");
        await c.advance(2_000);
        expect(calls.length).toBe(after);
        await c.advance(60_000);
        answer = ["fail"];
        service.want("Wir sehen uns morgen");
        await c.advance(2_000);
        const afterFail = calls.length;
        await c.advance(5 * 60_000);
        service.want("Wir sehen uns morgen");
        await c.advance(2_000);
        expect(calls.length).toBe(afterFail);
    });

    it("sends nothing if the plan changes before the batch leaves", async () => {
        let paid = true;
        const { service, calls, c } = setup({ paid: () => paid });
        service.want("Bis später");
        paid = false;
        await c.advance(5_000);
        expect(calls).toEqual([]);
    });

    it("stop() drops the queue and writes nothing afterwards", async () => {
        const { service, calls, c } = setup();
        service.want("Bis später");
        service.stop();
        await c.advance(5_000);
        expect(calls).toEqual([]);
    });

    it("tells subscribers when something lands", async () => {
        const { service, c } = setup();
        const seen = vi.fn();
        service.subscribe(seen);
        service.want("Bis später");
        await c.advance(400);
        expect(seen).toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------ extract --- */

describe("what each surface offers for translation", () => {
    it("embeds: title, description and fields, from the message record's raw fields", () => {
        const texts = embedTexts([{ rawTitle: "Titel", rawDescription: "Beschreibung", fields: [{ rawName: "Name", rawValue: "Wert" }], author: { name: "Bot" } }]);
        expect(texts.map(t => [t.kind, t.text])).toEqual([
            ["embed-title", "Titel"], ["embed-description", "Beschreibung"], ["embed-field", "Name"], ["embed-field", "Wert"]
        ]);
    });

    it("polls: the question and every answer", () => {
        expect(pollTexts({ question: { text: "Pizza oder Pasta?" }, answers: [{ poll_media: { text: "Pizza" } }, { pollMedia: { text: "Pasta" } }] })
            .map(t => t.text)).toEqual(["Pizza oder Pasta?", "Pizza", "Pasta"]);
    });

    it("forwards: the snapshot's text and embeds", () => {
        expect(forwardTexts([{ message: { content: "Schau mal", embeds: [{ rawTitle: "Artikel" }] } }]).map(t => [t.label, t.text]))
            .toEqual([["Forwarded", "Schau mal"], ["Forwarded", "Artikel"]]);
    });

    it("replies: only a REPLY message points at what it quotes", () => {
        expect(replyReference({ type: 19, messageReference: { channel_id: "c", message_id: "m" } })).toEqual({ channelId: "c", messageId: "m" });
        expect(replyReference({ type: 0, messageReference: { channel_id: "c", message_id: "m" } })).toBeNull();
    });

    it("a message with nothing extra offers nothing, and never its author's name", () => {
        expect(messageSurfaceTexts({ content: "hi", author: { username: "Jürgen" }, embeds: [], poll: null, messageSnapshots: [] })).toEqual([]);
    });

    it("custom status: the state of the CUSTOM_STATUS activity only", () => {
        expect(customStatusText([{ type: 0, name: "Minecraft", state: "Im Menü" }, { type: 4, name: "Custom Status", state: "Bin müde" }])).toBe("Bin müde");
        expect(customStatusText([{ type: 0, name: "Spiel" }])).toBe("");
        expect(customStatusText(undefined)).toBe("");
    });

    it("forum tags: the applied tags' names, looked up on the parent forum", () => {
        const parent = { availableTags: [{ id: "t1", name: "Hilfe" }, { id: "t2", name: "Fehler" }] };
        expect(appliedTagNames({ appliedTags: ["t2", "gone"] }, parent)).toEqual(["Fehler"]);
        expect(appliedTagNames({ appliedTags: ["t1"] }, null)).toEqual([]);
    });

    it("onboarding: the question, then each option's title and description", () => {
        expect(onboardingPromptTexts({ title: "Was spielst du?", options: [{ title: "Rollenspiele", description: "Lange Abende" }, { title: "Shooter", description: "" }] })
            .map(t => t.text)).toEqual(["Was spielst du?", "Rollenspiele", "Lange Abende", "Shooter"]);
        expect(onboardingPromptTexts(null)).toEqual([]);
    });
});

/* ----------------------------------------------------------------- ui --- */

/** Every string in a rendered tree. */
function text(node: any): string {
    if (node === null || node === undefined || node === false) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    return text(node.children);
}

describe("surface rendering", () => {
    beforeEach(() => setSurfaceService(null));

    it("shows ✦ when it has it, a confident ≈ until then, and no unsure ≈ at all", () => {
        expect(displayFor({ at: 0, quality: { lang: "de", text: " Hi " } }, "Hallo")).toEqual({ glyph: "✦", lang: "de", text: "Hi" });
        expect(displayFor({ at: 0, fast: { lang: "de", text: "Hi", conf: 0.99 } }, "Hallo")).toMatchObject({ glyph: "≈" });
        expect(displayFor({ at: 0, fast: { lang: "de", text: "Hi", conf: 0.3 } }, "Hallo")).toBeNull();
        expect(displayFor(null, "x")).toBeNull();
    });

    it("renders nothing with no service (stopped plugin), and a small line per text with one", async () => {
        expect(SurfaceLines({ texts: [{ kind: "embed-title", label: "Embed", text: "Titel" }] })).toBeNull();
        const { service, c } = setup();
        setSurfaceService(service);
        const texts = [{ kind: "reply" as const, label: "Reply", text: "Titel des Artikels" }];
        SurfaceLines({ texts });
        await c.advance(2_000);
        const out = text(SurfaceLines({ texts }));
        expect(out).toContain("Reply · ✦ de · ");
        expect(out).toContain("Q:Titel des Artikels");
    });

    it("the tight form is a single inline mark with the translation in its tooltip", async () => {
        const { service, c } = setup();
        setSurfaceService(service);
        const texts = [{ kind: "status" as const, label: "Status", text: "Bin müde" }];
        expect(SurfaceHint({ texts })).toBeNull();
        await c.advance(2_000);
        const el: any = SurfaceHint({ texts });
        expect(el.type).toBe("span");
        expect(text(el)).toBe("✦");
        expect(el.props.title).toBe("Status (✦ de): Q:Bin müde");
        expect(hintTitle([])).toBeNull();
    });

    it("a throwing surface renders nothing and never breaks the tree", () => {
        const log = vi.fn();
        const render = safe("boom", () => { throw new Error("Discord changed"); }, log);
        expect(render({})).toBeNull();
        expect(log).toHaveBeenCalledTimes(1);
    });
});

describe("surface cost units", () => {
    it("costs 1 + one unit per started 1,000 characters", async () => {
        const { surfaceCost } = await import("../surfaces/service");
        expect(surfaceCost("Bin müde")).toBe(2);
        expect(surfaceCost("x".repeat(1000))).toBe(2);
        expect(surfaceCost("x".repeat(1001))).toBe(3);
        expect(surfaceCost("x".repeat(2000))).toBe(3);
    });
});
