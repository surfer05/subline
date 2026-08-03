import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must exist before index.tsx's module body runs: it reads
// `VencordNative.pluginHelpers.VcTranslate` at import time. vi.hoisted is the
// only hook that fires before the import statements below.
const native = vi.hoisted(() => {
    const translateBatch = vi.fn();
    (globalThis as any).VencordNative = {
        pluginHelpers: { VcTranslate: { translateBatch } }
    };
    return { translateBatch };
});

import plugin from "../index";
import settings from "../settings";
import { clearStore, getTranslation, makeKey, setTranslation } from "../store";
import type { NativeResponse } from "../native";
import { __resetSettings } from "./stubs/api-settings";
import { __reset as resetDataStore } from "./stubs/api-datastore";
import {
    __resetWebpackCommon, __stubMarkAsDm, FluxDispatcher, LocaleStore, shownToasts, stubMessages
} from "./stubs/webpack-common";

const CHANNEL = "c1";

const discordMessage = (id: string, content: string, authorId = "u1") => ({
    id,
    channel_id: CHANNEL,
    content,
    author: { id: authorId, username: "ana" }
});

/** Run every pending timer and let the resulting promise chain settle. */
async function settle() {
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function respondWith(res: NativeResponse) {
    native.translateBatch.mockResolvedValue(res);
}

/** The BatchRequest the nth translateBatch call was given. */
function requestAt(n: number) {
    return JSON.parse(native.translateBatch.mock.calls[n][2]);
}

beforeEach(async () => {
    vi.useFakeTimers();
    native.translateBatch.mockReset();
    respondWith({ ok: true, results: [] });
    clearStore();
    __resetSettings();
    __resetWebpackCommon();
    resetDataStore();

    settings.store.globalAuto = true;
    settings.store.targetLang = "en";
    settings.store.engine = "google";
    settings.store.anthropicApiKey = "";

    await plugin.start!();
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

const key = (id: string) => makeKey(id, "en", "google");

describe("skip results are written as a resolved marker", () => {
    it("stores { skipped: true } for a message the engine reported as already in the target language", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        respondWith({ ok: true, results: [{ id: "1", skip: true }] });
        await settle();

        expect(getTranslation(key("1"))).toEqual({ skipped: true });
    });

    it("stops catch-up re-enqueueing an already-target-language backlog on every channel open", async () => {
        // The regression this guards: a skip that wrote NOTHING was
        // indistinguishable from "never requested", so every channel open
        // re-sent the whole already-translated backlog — forever, and on
        // Claude, for money.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        respondWith({ ok: true, results: [{ id: "1", skip: true }] });
        await settle();
        expect(native.translateBatch).toHaveBeenCalledTimes(1);

        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("still retries a failed message on the next channel open", async () => {
        // The `skipped` marker must not be so blunt that it swallows `failed`.
        setTranslation(key("1"), { failed: true });
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        expect(requestAt(0).messages.map((m: any) => m.id)).toEqual(["1"]);
    });
});

describe("deferred results — rate-limited, not failed", () => {
    it("marks a batch deferred (not failed) when paused after a 429, without a second request", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        respondWith({ ok: false, error: "gemini: HTTP 429", retryAfterMs: 30_000 });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(getTranslation(makeKey("1", "en", "gemini"))).toEqual({ deferred: true });
        expect(native.translateBatch).toHaveBeenCalledTimes(1);

        // A second message arrives while still inside the 30s pause window
        // (only ~1s of fake time has elapsed). It must never reach
        // translateBatch at all, and must be marked deferred, not failed —
        // this is the paused-early-return path in onFlush, distinct from the
        // 429-response path exercised above.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        expect(getTranslation(makeKey("2", "en", "gemini"))).toEqual({ deferred: true });
        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("retries a deferred message on the next channel open, exactly like a failed one", async () => {
        setTranslation(makeKey("1", "en", "google"), { deferred: true });
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        expect(requestAt(0).messages.map((m: any) => m.id)).toEqual(["1"]);
    });

    it("does NOT retry a skipped or a real translation the way it retries deferred", async () => {
        // Guards against a catch-up check broad enough to retry everything.
        setTranslation(makeKey("1", "en", "google"), { skipped: true });
        setTranslation(makeKey("2", "en", "google"), { lang: "es", text: "hola" });
        stubMessages.set(CHANNEL, [discordMessage("1", "a"), discordMessage("2", "b")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });
});

describe("the rate gate — smooths a catch-up storm, never slows live chat", () => {
    it("caps an immediate burst across many channels, then drains at the refill rate", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        respondWith({ ok: true, results: [] });

        // Simulate globalAuto catch-up firing across 8 channels at once, each
        // with its own independent 700ms debounce window.
        const channels = Array.from({ length: 8 }, (_, i) => `burst-${i}`);
        for (const c of channels) {
            FluxDispatcher.dispatch("MESSAGE_CREATE", {
                message: { ...discordMessage(`m-${c}`, "hola"), channel_id: c }
            });
        }

        // Let every channel's debounce timer fire, but nothing beyond that.
        await vi.advanceTimersByTimeAsync(700);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // Only the burst capacity's worth of requests actually leave the
        // client immediately — this is the whole point of the gate. If this
        // is 8, nothing is throttling the storm at all.
        const afterBurst = native.translateBatch.mock.calls.length;
        expect(afterBurst).toBeGreaterThan(0);
        expect(afterBurst).toBeLessThan(8);

        // The remainder drains steadily rather than being dropped or stuck
        // forever: enough refill time gets every one of them through.
        await vi.advanceTimersByTimeAsync(4_000 * 8);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(native.translateBatch).toHaveBeenCalledTimes(8);
    });

    it("never makes a single live-chat batch wait", async () => {
        settings.store.engine = "claude";
        settings.store.anthropicApiKey = "sk-ant-test";
        respondWith({ ok: true, results: [] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        // Advance by exactly the debounce window, nothing more — a real
        // conversation's single flush must clear the gate with no extra wait.
        await vi.advanceTimersByTimeAsync(700);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });
});

describe("the subtitle accessory", () => {
    /** Call the accessory component directly and return what it rendered. */
    const render = (message: unknown) => {
        const el: any = plugin.renderMessageAccessory!({ message } as any);
        return el.type(el.props);
    };

    /** Every string in the rendered tree, concatenated. */
    const text = (node: any): string => {
        if (node === null || node === undefined || node === false) return "";
        if (typeof node === "string" || typeof node === "number") return String(node);
        if (Array.isArray(node)) return node.map(text).join("");
        return text(node.children);
    };

    it("renders nothing at all for a skipped message", () => {
        setTranslation(key("1"), { skipped: true });
        expect(render(discordMessage("1", "hello"))).toBeNull();
    });

    it("does not fall through to the failure marker for a skipped message", () => {
        setTranslation(key("1"), { skipped: true });
        expect(text(render(discordMessage("1", "hello")))).not.toContain("⚠");
    });

    it("still renders the failure marker for a failed message", () => {
        setTranslation(key("1"), { failed: true });
        expect(text(render(discordMessage("1", "hola")))).toContain("⚠");
    });

    it("renders a deferred message as pending, not as failed", () => {
        setTranslation(key("1"), { deferred: true });
        const rendered = text(render(discordMessage("1", "hola")));
        expect(rendered).toContain("retrying");
        expect(rendered).not.toContain("⚠");
    });

    it("renders the translation for a real result", () => {
        setTranslation(key("1"), { lang: "es", text: "hello there" });
        expect(text(render(discordMessage("1", "hola")))).toContain("hello there");
    });
});

describe("MESSAGE_UPDATE", () => {
    async function translateOnce() {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "hello", skip: false }] });
        await settle();
        expect(getTranslation(key("1"))).toEqual({ lang: "es", text: "hello" });
        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    }

    it("invalidates the stale translation", async () => {
        await translateOnce();

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "adios") });

        expect(getTranslation(key("1"))).toBeUndefined();
    });

    it("re-queues the edited message so the subtitle comes back", async () => {
        // Invalidating alone made the subtitle vanish until the next channel
        // open — manual checklist item 5 ("Subtitle re-translates to match the
        // edit") would have failed.
        await translateOnce();

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "adios") });
        respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "bye", skip: false }] });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(2);
        expect(requestAt(1).messages).toEqual([{ id: "1", author: "ana", text: "adios" }]);
        expect(getTranslation(key("1"))).toEqual({ lang: "es", text: "bye" });
    });

    it("ignores an embed-hydration update that carries no content", async () => {
        await translateOnce();

        // Discord fires MESSAGE_UPDATE for link previews and attachment
        // processing too; those payloads have no `content` field.
        FluxDispatcher.dispatch("MESSAGE_UPDATE", {
            message: { id: "1", channel_id: CHANNEL, author: { id: "u1", username: "ana" } }
        });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("ignores an update whose content is empty", async () => {
        await translateOnce();

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("does not re-queue an edit in a channel that is not active", async () => {
        await translateOnce();
        settings.store.globalAuto = false;

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "adios") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("does not re-queue an edit that the skip rules would reject anyway", async () => {
        await translateOnce();

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "https://example.com") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });
});

describe("missing Anthropic API key", () => {
    it("shows exactly one toast per session, not one per message", async () => {
        settings.store.engine = "claude";
        settings.store.anthropicApiKey = "";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const missingKeyToasts = shownToasts.filter(t => /no Anthropic API key/i.test(t.message));
        expect(missingKeyToasts).toHaveLength(1);
    });

    it("says nothing when a key is present", async () => {
        settings.store.engine = "claude";
        settings.store.anthropicApiKey = "sk-ant-test";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(shownToasts.filter(t => /no Anthropic API key/i.test(t.message))).toHaveLength(0);
    });

    it("says nothing when Google is the selected engine", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(shownToasts).toHaveLength(0);
    });
});

describe("missing Gemini API key — mirrors the Claude behaviour", () => {
    it("shows exactly one toast per session, not one per message", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const missingKeyToasts = shownToasts.filter(t => /no Gemini API key/i.test(t.message));
        expect(missingKeyToasts).toHaveLength(1);
    });

    it("says nothing when a key is present", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(shownToasts.filter(t => /no Gemini API key/i.test(t.message))).toHaveLength(0);
    });

    it("routes translateBatch to google (not gemini) while the key is missing", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        expect(native.translateBatch.mock.calls[0][0]).toBe("google");
    });

    it("falls back to google and announces once when gemini rejects the key", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-bad";
        respondWith({ ok: false, error: "gemini: HTTP 401" });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        const rejectedToasts = shownToasts.filter(t => /Gemini rejected the API key/i.test(t.message));
        expect(rejectedToasts).toHaveLength(1);

        // The session is now pinned to Google: a second message must not
        // dispatch through gemini again. Assert on the calls AFTER this point —
        // the earlier call necessarily went to gemini, because it is the very
        // request that discovered the key was bad.
        const before = native.translateBatch.mock.calls.length;
        respondWith({ ok: true, results: [] });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const laterCalls = native.translateBatch.mock.calls.slice(before);
        expect(laterCalls.length).toBeGreaterThan(0);
        expect(laterCalls.every(c => c[0] === "google")).toBe(true);
    });
});

describe("settings wiring", () => {
    it("hides the Anthropic key field unless Claude is selected", () => {
        const hidden = (settings as any).def.anthropicApiKey.hidden as (this: unknown) => boolean;
        expect(typeof hidden).toBe("function");

        settings.store.engine = "google";
        expect(hidden.call(settings)).toBe(true);

        settings.store.engine = "claude";
        expect(hidden.call(settings)).toBe(false);
    });

    it("hides the Gemini key field unless Gemini is selected", () => {
        const hidden = (settings as any).def.geminiApiKey.hidden as (this: unknown) => boolean;
        expect(typeof hidden).toBe("function");

        settings.store.engine = "google";
        expect(hidden.call(settings)).toBe(true);

        settings.store.engine = "claude";
        expect(hidden.call(settings)).toBe(true);

        settings.store.engine = "gemini";
        expect(hidden.call(settings)).toBe(false);
    });

    it("defaults the target language to Discord's locale, without the region subtag", () => {
        // Region-qualified would break google.ts's "already in the target
        // language" comparison, which is against a bare detected code.
        __resetSettings();
        LocaleStore.locale = "pt-BR";
        expect(settings.store.targetLang).toBe("pt");

        __resetSettings();
        LocaleStore.locale = "ja";
        expect(settings.store.targetLang).toBe("ja");
    });
});

describe("globalAuto does not reach private conversations", () => {
    it("translates a guild channel but never a DM", async () => {
        settings.store.globalAuto = true;

        // Same message posted in a guild channel and in a DM. The only
        // difference is the channel type, which is exactly the distinction
        // globalAuto must respect: sending a public channel to a third-party
        // endpoint is the user's decision to make, a private DM is not.
        __stubMarkAsDm("dm1");
        respondWith({
            ok: true,
            results: [{ id: "g1", lang: "es", text: "hello", skip: false }]
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: { ...discordMessage("g1", "hola"), channel_id: CHANNEL }
        });
        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: { ...discordMessage("d1", "hola"), channel_id: "dm1" }
        });
        await settle();

        const sent = native.translateBatch.mock.calls
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));

        expect(sent).toContain("g1");
        expect(sent).not.toContain("d1");
    });
});
