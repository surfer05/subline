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
    __resetWebpackCommon, __stubMarkAsDm, __stubSetSelectedChannel,
    FluxDispatcher, LocaleStore, shownToasts, stubMessages
} from "./stubs/webpack-common";

const CHANNEL = "c1";

const discordMessage = (id: string, content: string, authorId = "u1") => ({
    id,
    channel_id: CHANNEL,
    content,
    author: { id: authorId, username: "ana" }
});

/**
 * Run every pending timer and let the resulting promise chain settle.
 *
 * 5s, not 1s: the LLM engines now debounce for LLM_DEBOUNCE_MS (3s) to fit a
 * day's worth of messages into a few dozen requests, so a 1s window would
 * never flush a Claude/Gemini batch at all.
 */
async function settle() {
    await vi.advanceTimersByTimeAsync(5000);
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

    // The user is looking at CHANNEL. Live translation is now restricted to the
    // focused channel, so without this every MESSAGE_CREATE below would be
    // (correctly) ignored — see the "only the focused channel" suite.
    __stubSetSelectedChannel(CHANNEL);

    await plugin.start!();
    // start() kicks off the persisted-cache load and defers its initial
    // catch-up until that resolves. Let those microtasks drain here so the
    // deferred catch-up can't land in the middle of a test body.
    for (let i = 0; i < 20; i++) await Promise.resolve();
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

const key = (id: string) => makeKey(id, "en");

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

        expect(getTranslation(makeKey("1", "en"))).toEqual({ deferred: true });
        expect(native.translateBatch).toHaveBeenCalledTimes(1);

        // A second message arrives while still inside the 30s pause window
        // (two settle() calls are ~10s of fake time). It must never reach
        // translateBatch at all, and must be marked deferred, not failed —
        // this is the paused-early-return path in onFlush, distinct from the
        // 429-response path exercised above.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        expect(getTranslation(makeKey("2", "en"))).toEqual({ deferred: true });
        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("retries a deferred message on the next channel open, exactly like a failed one", async () => {
        setTranslation(makeKey("1", "en"), { deferred: true });
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        expect(requestAt(0).messages.map((m: any) => m.id)).toEqual(["1"]);
    });

    it("does NOT retry a skipped or a real translation the way it retries deferred", async () => {
        // Guards against a catch-up check broad enough to retry everything.
        setTranslation(makeKey("1", "en"), { skipped: true });
        setTranslation(makeKey("2", "en"), { lang: "es", text: "hola", via: "google" });
        stubMessages.set(CHANNEL, [discordMessage("1", "a"), discordMessage("2", "b")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("does not re-request a Google translation just because an LLM engine is now selected", async () => {
        // The deliberate consequence of dropping the engine from the cache
        // key. Switching engines must not re-spend budget upgrading messages
        // the user has already read — a real translation is resolved,
        // whichever engine produced it.
        setTranslation(makeKey("1", "en"), { lang: "es", text: "hola", via: "google" });
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        stubMessages.set(CHANNEL, [discordMessage("1", "a")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("still retries a failure recorded under one engine when another is selected", async () => {
        // The flip side: engine-agnostic resolution must not make `failed`
        // and `deferred` sticky across an engine switch.
        setTranslation(makeKey("1", "en"), { failed: true });
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        expect(requestAt(0).messages.map((m: any) => m.id)).toEqual(["1"]);
    });
});

describe("the rate gate — smooths a catch-up storm, never slows live chat", () => {
    it("caps an immediate burst across many channels, then drains at the refill rate", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        respondWith({ ok: true, results: [] });

        // Eight channels each get one message while the user is looking at
        // them — i.e. the user cycling quickly through channels. (Before this
        // phase the same shape came from globalAuto catch-up fanning out across
        // every open channel at once; focus gating makes that impossible now,
        // but the thing under test is unchanged: many independent batches
        // becoming due at the same moment.)
        const channels = Array.from({ length: 8 }, (_, i) => `burst-${i}`);
        for (const c of channels) {
            __stubSetSelectedChannel(c);
            FluxDispatcher.dispatch("MESSAGE_CREATE", {
                message: { ...discordMessage(`m-${c}`, "hola"), channel_id: c }
            });
        }

        // Let every channel's debounce timer fire, but nothing beyond that.
        await vi.advanceTimersByTimeAsync(3_000);
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
        await vi.advanceTimersByTimeAsync(3_000);
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

    /** The first node in the rendered tree carrying a `title` prop. */
    const titleOf = (node: any): string | undefined => {
        if (node === null || typeof node !== "object") return undefined;
        if (Array.isArray(node)) {
            for (const child of node) {
                const found = titleOf(child);
                if (found !== undefined) return found;
            }
            return undefined;
        }
        if (node.props?.title) return node.props.title;
        return titleOf(node.children);
    };

    it("renders the translation for a real result", () => {
        setTranslation(key("1"), { lang: "es", text: "hello there", via: "google" });
        expect(text(render(discordMessage("1", "hola")))).toContain("hello there");
    });

    it("finds and renders a Google translation while Gemini is the configured engine", () => {
        // THE point of dropping the engine from the cache key. A fallback
        // translation written under Google used to be written to a key the
        // Gemini-configured accessory never looked at, so the subtitle simply
        // never appeared. If this ever fails again, an engine fallback is
        // invisible to the user no matter how well it works.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        setTranslation(makeKey("1", "en"), { lang: "es", text: "hello there", via: "google" });

        const rendered = render(discordMessage("1", "hola"));
        expect(rendered).not.toBeNull();
        expect(text(rendered)).toContain("hello there");
    });

    it("marks an LLM translation with ✦ and a Google one with ≈", () => {
        setTranslation(key("1"), { lang: "es", text: "from gemini", via: "gemini" });
        setTranslation(key("2"), { lang: "es", text: "from claude", via: "claude" });
        setTranslation(key("3"), { lang: "es", text: "from google", via: "google" });

        expect(text(render(discordMessage("1", "hola")))).toContain("✦");
        expect(text(render(discordMessage("1", "hola")))).not.toContain("≈");
        expect(text(render(discordMessage("2", "hola")))).toContain("✦");
        expect(text(render(discordMessage("3", "hola")))).toContain("≈");
        expect(text(render(discordMessage("3", "hola")))).not.toContain("✦");
    });

    it("still shows the language code next to the provenance glyph", () => {
        setTranslation(key("1"), { lang: "es", text: "hello there", via: "gemini" });
        expect(text(render(discordMessage("1", "hola")))).toContain("es");
    });

    it("names the engine in a title attribute so the glyph is explainable on hover", () => {
        setTranslation(key("1"), { lang: "es", text: "a", via: "gemini" });
        expect(titleOf(render(discordMessage("1", "hola")))).toBe("Translated by Gemini");

        setTranslation(key("2"), { lang: "es", text: "b", via: "google" });
        expect(titleOf(render(discordMessage("2", "hola")))).toBe("Translated by Google Translate");

        setTranslation(key("3"), { lang: "es", text: "c", via: "claude" });
        expect(titleOf(render(discordMessage("3", "hola")))).toBe("Translated by Claude");
    });
});

describe("provenance is recorded from the engine that actually ran", () => {
    it("records via: gemini when Gemini produced the translation", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "hello", skip: false }] });
        await settle();

        expect(native.translateBatch.mock.calls[0][0]).toBe("gemini");
        expect(getTranslation(makeKey("1", "en"))).toEqual({ lang: "es", text: "hello", via: "gemini" });
    });

    it("records via: google when the Gemini key is missing and Google actually ran", async () => {
        // The engine the request was SENT to, not the one in settings — this
        // is the shape a Phase 3 fallback will write, and mislabelling it
        // would tell the user a Google line came from an LLM.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "hello", skip: false }] });
        await settle();

        expect(native.translateBatch.mock.calls[0][0]).toBe("google");
        expect(getTranslation(makeKey("1", "en"))).toEqual({ lang: "es", text: "hello", via: "google" });
    });
});

describe("MESSAGE_UPDATE", () => {
    async function translateOnce() {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        respondWith({ ok: true, results: [{ id: "1", lang: "es", text: "hello", skip: false }] });
        await settle();
        expect(getTranslation(key("1"))).toEqual({ lang: "es", text: "hello", via: "google" });
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
        expect(getTranslation(key("1"))).toEqual({ lang: "es", text: "bye", via: "google" });
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

describe("only the channel the user is actually looking at", () => {
    it("does not translate a message in a channel that is not focused", async () => {
        // THE waste this phase removes: globalAuto means "every channel", so
        // messages in every open channel used to be translated whether or not
        // the user had ever looked at them.
        __stubSetSelectedChannel("other");

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("still translates a message in the focused channel", async () => {
        // The other half of the same rule — without this, "focus" could be
        // implemented as "never translate anything" and still pass above.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("does not translate an edit in a channel that is not focused", async () => {
        __stubSetSelectedChannel("other");

        FluxDispatcher.dispatch("MESSAGE_UPDATE", { message: discordMessage("1", "adios") });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("does not catch up a channel whose history loads while the user is elsewhere", async () => {
        // LOAD_MESSAGES_SUCCESS also fires for background history fetches. If
        // it ignored focus, a restart would still fan out across every channel
        // Discord decides to hydrate.
        stubMessages.set("other", [{ ...discordMessage("1", "hola"), channel_id: "other" }]);

        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: "other" });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("translates that same backlog as soon as the user opens the channel", async () => {
        // Not-now is not never: the deferred work is exactly what catch-up on
        // channel open already does.
        stubMessages.set("other", [{ ...discordMessage("1", "hola"), channel_id: "other" }]);

        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: "other" });
        await settle();
        expect(native.translateBatch).not.toHaveBeenCalled();

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: "other" });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        expect(requestAt(0).messages.map((m: any) => m.id)).toEqual(["1"]);
    });

    it("catches up on CHANNEL_SELECT even before SelectedChannelStore has updated", async () => {
        // Flux does not guarantee that Discord's own stores have processed
        // CHANNEL_SELECT before our subscriber runs. If catch-up gated on the
        // store here, cold-channel catch-up — the "tab back in after a game"
        // feature — would silently never fire.
        stubMessages.set("cold", [{ ...discordMessage("1", "hola"), channel_id: "cold" }]);
        __stubSetSelectedChannel(CHANNEL);   // store still reports the OLD channel

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: "cold" });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });
});

describe("locally detected target-language messages never leave the client", () => {
    it("does not spend a request on an English message when the target is English", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: discordMessage("1", "we should have a fst mc server")
        });
        await settle();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("still sends a Spanish message", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: discordMessage("1", "no puedo jugar hoy porque tengo que estudiar")
        });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("still sends a short ambiguous message rather than guessing", async () => {
        // "THIS" contains an English function word and nothing else. Guessing
        // English here would silently drop it if it were, say, a foreign
        // proper noun — so it must be sent.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "THIS") });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("does not apply the English heuristic to a non-English target language", async () => {
        settings.store.targetLang = "es";

        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: discordMessage("1", "we should have a fst mc server")
        });
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });
});

describe("batch sizing follows the daily request budget", () => {
    it("holds an LLM batch past the old 700ms window", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });

        // Nothing has left yet at the OLD 700ms window.
        await vi.advanceTimersByTimeAsync(700);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(native.translateBatch).not.toHaveBeenCalled();

        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
    });

    it("packs 25 messages into a single LLM request", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";

        for (let i = 0; i < 25; i++) {
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage(String(i), "hola") });
        }
        await settle();

        expect(native.translateBatch).toHaveBeenCalledTimes(1);
        expect(requestAt(0).messages).toHaveLength(25);
    });

    it("keeps Google on its smaller, latency-tuned batch", async () => {
        // Google is per-message with its own concurrency cap and was never the
        // source of the 429s, so it must not inherit the LLM sizing.
        for (let i = 0; i < 25; i++) {
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage(String(i), "hola") });
        }
        await settle();

        expect(requestAt(0).messages).toHaveLength(10);
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
        // Focus the DM before posting in it, so the DM is rejected by the
        // guild_id check under test and not incidentally by the focus check —
        // otherwise this assertion would pass for the wrong reason.
        __stubSetSelectedChannel("dm1");
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
