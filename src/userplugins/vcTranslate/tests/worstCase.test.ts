import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same harness as index.test.ts: VencordNative must exist before index.tsx loads.
const native = vi.hoisted(() => {
    const translateBatch = vi.fn();
    const readStagedBuildId = vi.fn().mockResolvedValue(null);
    const relayStatus = vi.fn().mockResolvedValue({ ok: false, error: "status unavailable" });
    (globalThis as any).VencordNative = {
        pluginHelpers: { VcTranslate: { translateBatch, readStagedBuildId, relayStatus } }
    };
    return { translateBatch, readStagedBuildId, relayStatus };
});

import plugin from "../index";
import { cooldownUntil } from "../cooldownStore";
import settings from "../settings";
import { clearStore, getTranslation, makeKey, setTranslation } from "../store";
import { __resetTaste } from "../taste";
import { __resetSettings } from "./stubs/api-settings";
import * as DataStore from "./stubs/api-datastore";
import { __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import {
    __resetWebpackCommon, __stubSetSelectedChannel, FluxDispatcher, stubMessageById, stubMessages
} from "./stubs/webpack-common";

const CHANNEL = "c1";
const key = (id: string) => makeKey(id, "en");

const discordMessage = (id: string, content: string, channelId = CHANNEL) => ({
    id, channel_id: channelId, content, author: { id: "u1", username: "ana" }
});

async function flushMicrotasks() {
    for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await flushMicrotasks();
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

const answerAll = (payload: string, prefix: string, lang = "es") => ({
    ok: true as const,
    results: JSON.parse(payload).messages.map((m: { id: string; text: string; }) =>
        ({ id: m.id, lang, text: prefix + m.text, skip: false }))
});

beforeEach(async () => {
    vi.useFakeTimers();
    native.translateBatch.mockReset();
    native.translateBatch.mockResolvedValue({ ok: true, results: [] });
    native.relayStatus.mockReset();
    native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
    clearStore();
    __resetTaste();
    __resetSettings();
    __resetWebpackCommon();
    __resetMessagePopover();
    DataStore.__reset();
    settings.store.globalAuto = true;
    settings.store.targetLang = "en";
    settings.store.engine = "google";
    __stubSetSelectedChannel(CHANNEL);
    await plugin.start!();
    await flushMicrotasks();
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

describe("long messages never make the relay refuse ✦ batches", () => {
    const longJa = (n: number) => (`第${n}番目の投稿です。` + "これはとても長い日本語の文章です。".repeat(150)).slice(0, 2_000);

    function oversizeAwareMock(bodies: number[]) {
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
            if (engine === "google") return answerAll(payload, "G:", "ja");
            bodies.push(bytes(payload));
            if (bytes(payload) > 32_768) return { ok: false, error: "relay: HTTP 413 payload too large or malformed" };
            return answerAll(payload, "Q:", "ja");
        });
    }

    it("gives all seven 2,000-character posts in a row their ✦ line", async () => {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
        const bodies: number[] = [];
        oversizeAwareMock(bodies);

        for (let i = 1; i <= 7; i++) {
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage(String(i), longJa(i)) });
            await advance(10_000);
        }
        await advance(60_000);

        for (const b of bodies) expect(b).toBeLessThanOrEqual(32_768);
        for (let i = 1; i <= 7; i++) expect(getTranslation(key(String(i)))).toMatchObject({ via: "groq" });
    });

    it("splits a 25-message catch-up of long CJK posts into requests the relay accepts", async () => {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
        const bodies: number[] = [];
        oversizeAwareMock(bodies);

        stubMessages.set(CHANNEL, Array.from({ length: 25 }, (_, i) => discordMessage(String(100 + i), longJa(i))));
        settings.store.catchUpCount = 25;
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await advance(10 * 60_000);

        expect(bodies.length).toBeGreaterThan(1);
        for (const b of bodies) expect(b).toBeLessThanOrEqual(32_768);
        for (let i = 0; i < 25; i++) expect(getTranslation(key(String(100 + i)))).toMatchObject({ via: "groq" });
    });

    it("re-sends a request refused for its size in smaller parts", async () => {
        // A relay whose own limit is lower than the client's budget.
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
            if (engine === "google") return answerAll(payload, "G:");
            if (JSON.parse(payload).messages.length > 1) return { ok: false, error: "groq: HTTP 413 too large" };
            return answerAll(payload, "Q:");
        });
        for (let i = 1; i <= 3; i++) FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage(String(i), `hola amigo numero ${i}`) });
        await advance(30_000);
        for (let i = 1; i <= 3; i++) expect(getTranslation(key(String(i)))).toMatchObject({ via: "groq" });
    });

    it("sends a message whose mentions grew past 4,000 characters as Discord stored it", async () => {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
        const sent: string[] = [];
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
            if (engine === "google") return answerAll(payload, "G:");
            for (const m of JSON.parse(payload).messages) sent.push(m.text);
            return answerAll(payload, "Q:");
        });
        // 150 channel mentions of 21 chars each, which grow when resolved to names.
        const raw = "hola " + Array.from({ length: 150 }, (_, i) => `<#${String(100000000000000000 + i)}>`).join(" ");
        expect(raw.length).toBeLessThanOrEqual(4_000);
        const msg = discordMessage("m1", raw);
        stubMessageById.set(`${CHANNEL}:m1`, msg);
        const { ChannelStore } = await import("./stubs/webpack-common") as any;
        const realGet = ChannelStore.getChannel;
        ChannelStore.getChannel = (id: string) => id === CHANNEL ? realGet(id) : { id, name: "x".repeat(60) };
        try {
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg });
            await advance(30_000);
        } finally {
            ChannelStore.getChannel = realGet;
        }
        expect(sent.length).toBeGreaterThan(0);
        for (const t of sent) expect(t.length).toBeLessThanOrEqual(4_000);
    });
});

describe("an edit made while a translation is on its way", () => {
    const edit = (id: string, content: string) =>
        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage(id, content) });

    it("sends the edited text when the edit lands inside the ✦ window", async () => {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
        const qualityTexts: string[] = [];
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
            if (engine !== "google") for (const m of JSON.parse(payload).messages) qualityTexts.push(m.text);
            return answerAll(payload, engine === "google" ? "G:" : "Q:");
        });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola amigo como estas") });
        await advance(300);
        edit("1", "adios amigo hasta luego");
        await advance(30_000);

        expect(getTranslation(key("1"))).toMatchObject({ text: "Q:adios amigo hasta luego", via: "groq" });
        expect(qualityTexts).toEqual(["adios amigo hasta luego"]);
    });

    it("drops a ✦ answer for the old text and asks again", async () => {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
        const qualityTexts: string[] = [];
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
            if (engine === "google") return answerAll(payload, "G:");
            for (const m of JSON.parse(payload).messages) qualityTexts.push(m.text);
            await new Promise(r => setTimeout(r, 5_000));
            return answerAll(payload, "Q:");
        });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola amigo como estas") });
        await advance(2_000); // the ✦ request is out, and slow
        edit("1", "adios amigo hasta luego");
        await advance(60_000);

        expect(getTranslation(key("1"))).toMatchObject({ text: "Q:adios amigo hasta luego", via: "groq" });
        expect(qualityTexts).toEqual(["hola amigo como estas", "adios amigo hasta luego"]);
    });

    // Discord sends MESSAGE_UPDATE with the full message when a link preview
    // loads, so the text arrives again unchanged. That is not an edit.
    const withPreview = (id: string, content: string) =>
        FluxDispatcher.dispatch("MESSAGE_UPDATE", {
            message: { ...discordMessage(id, content), embeds: [{ type: "link", url: "https://example.com" }] }
        });

    const countRequests = () => {
        const calls = { quality: [] as string[], google: [] as string[] };
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
            const list = engine === "google" ? calls.google : calls.quality;
            for (const m of JSON.parse(payload).messages) list.push(m.text);
            if (engine !== "google") await new Promise(r => setTimeout(r, 5_000));
            return answerAll(payload, engine === "google" ? "G:" : "Q:");
        });
        return calls;
    };
    const linkText = "mira esto https://example.com amigo";

    it("a link preview loading while ✦ is out does not ask again", async () => {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
        const calls = countRequests();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", linkText) });
        await advance(2_000);
        withPreview("1", linkText);
        await advance(60_000);

        expect(calls.quality).toHaveLength(1);
        expect(calls.google).toHaveLength(1);
        expect(getTranslation(key("1"))).toMatchObject({ via: "groq" });
    });

    it("a link preview loading after the answer does not ask again", async () => {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
        const calls = countRequests();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", linkText) });
        await advance(60_000);
        withPreview("1", linkText);
        await advance(60_000);

        expect(calls.quality).toHaveLength(1);
        expect(calls.google).toHaveLength(1);
        expect(getTranslation(key("1"))).toMatchObject({ via: "groq" });
    });

    it("an update with no text, then reopening the channel, does not ask again", async () => {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
        const calls = countRequests();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", linkText) });
        await advance(60_000);
        // An older-style partial payload: no content field at all.
        FluxDispatcher.dispatch("MESSAGE_UPDATE", {
            message: { id: "1", channel_id: CHANNEL, embeds: [{ type: "link", url: "https://example.com" }] }
        });
        stubMessages.set(CHANNEL, [discordMessage("1", linkText)]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await advance(60_000);

        expect(calls.quality).toHaveLength(1);
        expect(calls.google).toHaveLength(1);
        expect(getTranslation(key("1"))).toMatchObject({ via: "groq" });
    });

    it("a real edit after a preview loaded is still sent", async () => {
        settings.store.engine = "groq";
        settings.store.groqApiKey = "gsk-test";
        const calls = countRequests();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", linkText) });
        await advance(60_000);
        withPreview("1", linkText);
        await advance(1_000);
        edit("1", "mira esto amigo, es buenisimo");
        await advance(60_000);

        expect(calls.quality).toHaveLength(2);
        expect(calls.quality[1]).toBe("mira esto amigo, es buenisimo");
        expect(getTranslation(key("1"))).toMatchObject({ text: "Q:mira esto amigo, es buenisimo", via: "groq" });
    });

    it("drops a ≈ answer for the old text when Google is the only translator", async () => {
        native.translateBatch.mockImplementation(async (_e: string, _k: string, payload: string) => {
            await new Promise(r => setTimeout(r, 3_000));
            return answerAll(payload, "G:");
        });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola amigo como estas") });
        await advance(500);
        edit("1", "adios amigo hasta luego");
        await advance(30_000);

        expect(getTranslation(key("1"))).toMatchObject({ text: "G:adios amigo hasta luego", via: "google" });
    });
});

describe("a ⏳ line in a quiet channel is retried on its own", () => {
    it("translates a message whose only request was throttled, with nobody else posting", async () => {
        let n = 0;
        native.translateBatch.mockImplementation(async (_e: string, _k: string, payload: string) =>
            ++n === 1 ? { ok: false, error: "google: HTTP 429" } : answerAll(payload, "G:"));
        const msg = discordMessage("1", "hola amigo como estas");
        stubMessages.set(CHANNEL, [msg]);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg });
        await advance(10 * 60_000);

        expect(native.translateBatch.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(getTranslation(key("1"))).toMatchObject({ via: "google", text: "G:hola amigo como estas" });
    });

    it("retries a message that arrived while another channel's throttle had Google parked", async () => {
        let n = 0;
        native.translateBatch.mockImplementation(async (_e: string, _k: string, payload: string) =>
            ++n === 1 ? { ok: false, error: "google: HTTP 429" } : answerAll(payload, "G:"));
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("a1", "hola desde a") });
        await advance(100);
        expect(cooldownUntil("google")).toBeGreaterThan(Date.now());

        __stubSetSelectedChannel("c2");
        const b = discordMessage("b1", "hola desde b", "c2");
        stubMessages.set("c2", [b]);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: b });
        await advance(100);
        expect(getTranslation(key("b1"))).toEqual({ deferred: true });

        await advance(5 * 60_000);
        expect(getTranslation(key("b1"))).toMatchObject({ via: "google", text: "G:hola desde b" });
    });

    it("asks again for a message that failed in a batch where another succeeded", async () => {
        let n = 0;
        native.translateBatch.mockImplementation(async (_e: string, _k: string, payload: string) => {
            if (++n === 1) {
                return {
                    ok: true,
                    results: [
                        { id: "1", failed: true, transport: true },
                        { id: "2", lang: "es", text: "G:two", skip: false }
                    ]
                };
            }
            return answerAll(payload, "G:");
        });
        const one = discordMessage("1", "hola uno");
        const two = discordMessage("2", "hola dos");
        stubMessages.set(CHANNEL, [one, two]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await advance(1_000);

        expect(getTranslation(key("1"))).toMatchObject({ via: "google", text: "G:hola uno" });
    });
});

describe("translations into right-to-left languages", () => {
    /** The rendered element whose only child is exactly `text`. */
    function elementWithText(node: any, text: string): any {
        if (node === null || typeof node !== "object") return null;
        if (Array.isArray(node)) {
            for (const n of node) { const hit = elementWithText(n, text); if (hit) return hit; }
            return null;
        }
        if (typeof node.type === "function") return elementWithText(node.type(node.props), text);
        const kids = node.children ?? [];
        if (kids.length === 1 && kids[0] === text) return node;
        return elementWithText(kids, text);
    }

    function renderLine(id: string, target: string, text: string) {
        settings.store.targetLang = target;
        setTranslation(makeKey(id, target), { lang: "en", text, via: "groq" });
        const el: any = plugin.renderMessageAccessory!({ message: discordMessage(id, "hello John, he says he will come") } as any);
        return elementWithText(el, text);
    }

    it("lays an Arabic line out right to left even when it starts with a Latin name", () => {
        const span = renderLine("r1", "ar", "John قال إنه سيأتي");
        expect(span).not.toBeNull();
        expect(span.props.dir).toBe("rtl");
    });

    it("lets a left-to-right target take its direction from the text", () => {
        const span = renderLine("r2", "en", "he says he will come");
        expect(span).not.toBeNull();
        expect(span.props.dir).toBe("auto");
    });
});
