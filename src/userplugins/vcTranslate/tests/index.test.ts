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
import { rateGateSettings, REFILL_MS } from "../rateGate";
import { toggleChannel } from "../channels";
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
 * 21s, not 5s: the quality tier now debounces for QUALITY_DEBOUNCE_MS (20s) so
 * a busy channel sits an order of magnitude under the measured rate-limit
 * ceiling (see types.ts), so anything shorter would never flush a
 * Claude/Gemini batch at all.
 */
async function settle() {
    await vi.advanceTimersByTimeAsync(21_000);
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
    it("marks a batch deferred (not failed) only when the Google fallback fails too", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        // Blanket 429: Gemini is rate limited AND the Google fallback comes
        // back empty-handed. This is now the ONLY route to `deferred` — the
        // reader is shown a pending marker only when there is genuinely no
        // translation to be had from anywhere.
        respondWith({ ok: false, error: "gemini: HTTP 429", retryAfterMs: 30_000 });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(getTranslation(makeKey("1", "en"))).toEqual({ deferred: true });
        // Gemini refused, so the batch was immediately re-run through Google
        // rather than abandoned.
        expect(native.translateBatch.mock.calls.map(c => c[0])).toEqual(["gemini", "google"]);

        // A second message arrives while still inside the 30s cooldown window
        // (two settle() calls are ~10s of fake time). It must not touch Gemini
        // again — but it must still be ATTEMPTED, via Google — and with Google
        // also failing it is deferred, not failed.
        const before = native.translateBatch.mock.calls.length;
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        expect(getTranslation(makeKey("2", "en"))).toEqual({ deferred: true });
        const laterCalls = native.translateBatch.mock.calls.slice(before).map(c => c[0]);
        expect(laterCalls).toEqual(["google"]);
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

describe("a rate-limited LLM falls back to Google rather than showing nothing", () => {
    /** Per-engine canned responses; anything unlisted succeeds emptily. */
    function respondByEngine(map: Partial<Record<string, NativeResponse>>) {
        native.translateBatch.mockImplementation(
            async (engine: string) => map[engine] ?? { ok: true, results: [] }
        );
    }

    const RATE_LIMITED: NativeResponse = {
        ok: false, error: "gemini: HTTP 429", retryAfterMs: 30_000
    };

    const googleTranslated = (id: string): NativeResponse => ({
        ok: true, results: [{ id, lang: "es", text: "hello there", skip: false }]
    });

    /** Every string the accessory renders for a message id. */
    function renderedText(id: string): string {
        const el: any = plugin.renderMessageAccessory!({ message: discordMessage(id, "hola") } as any);
        const node = el.type(el.props);
        const walk = (n: any): string => {
            if (n === null || n === undefined || n === false) return "";
            if (typeof n === "string" || typeof n === "number") return String(n);
            if (Array.isArray(n)) return n.map(walk).join("");
            return walk(n.children);
        };
        return walk(node);
    }

    function useGemini() {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    }

    it("re-runs the rate-limited batch through Google instead of deferring it", async () => {
        // THE point of this phase. A mediocre Google translation is strictly
        // better than "⏳ retrying" forever.
        useGemini();
        respondByEngine({ gemini: RATE_LIMITED, google: googleTranslated("1") });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(native.translateBatch.mock.calls.map(c => c[0])).toEqual(["gemini", "google"]);
        const entry = getTranslation(makeKey("1", "en"));
        expect(entry).toEqual({ lang: "es", text: "hello there", via: "google" });
        expect(entry).not.toHaveProperty("deferred");
    });

    it("labels the fallback line as Google (≈), never as the configured LLM (✦)", async () => {
        // The provenance glyph is the reader's only signal that this is an
        // approximate, context-free translation. Recording `via: "gemini"` for
        // a line Google produced would make ✦ a lie.
        useGemini();
        respondByEngine({ gemini: RATE_LIMITED, google: googleTranslated("1") });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(getTranslation(makeKey("1", "en"))).toMatchObject({ via: "google" });
        expect(renderedText("1")).toContain("≈");
        expect(renderedText("1")).not.toContain("✦");
    });

    it("sends every batch during the cooldown straight to Google, without retrying the LLM", async () => {
        // Not retrying into the wall is the other half: roughly half the
        // observed API traffic was 429s we asked for.
        useGemini();
        respondByEngine({ gemini: RATE_LIMITED, google: googleTranslated("2") });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        const before = native.translateBatch.mock.calls.length;

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const laterCalls = native.translateBatch.mock.calls.slice(before).map(c => c[0]);
        expect(laterCalls.length).toBeGreaterThan(0);
        expect(laterCalls).not.toContain("gemini");
        expect(getTranslation(makeKey("2", "en"))).toMatchObject({ via: "google" });
    });

    it("resumes the LLM engine automatically once the cooldown expires — no restart", async () => {
        useGemini();
        let geminiCalls = 0;
        native.translateBatch.mockImplementation(async (engine: string) => {
            if (engine === "gemini") {
                geminiCalls++;
                // Rate limited for 2s, then healthy again.
                if (geminiCalls === 1) {
                    return { ok: false, error: "gemini: HTTP 429", retryAfterMs: 2_000 };
                }
                return { ok: true, results: [{ id: "2", lang: "es", text: "from gemini", skip: false }] };
            }
            return googleTranslated("1");
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();   // 5s of fake time — well past the 2s cooldown
        expect(getTranslation(makeKey("1", "en"))).toMatchObject({ via: "google" });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        // Back on the good engine, with nothing restarted and no setting
        // touched. If the cooldown never expired this would still say google.
        expect(getTranslation(makeKey("2", "en")))
            .toEqual({ lang: "es", text: "from gemini", via: "gemini" });
    });

    it("ignores a sub-second retry hint that would put us straight back on the wall", async () => {
        // The numbers here are the ones a REAL Gemini 429 returned: retry in
        // 551ms, limit 20/min. Obeying 551ms literally means waking up, being
        // granted the single slot that just aged out of the rolling window,
        // and being rejected again on the very next batch — the 429 treadmill
        // this phase exists to stop. The cooldown is floored at the rate
        // gate's refill interval instead.
        useGemini();
        respondByEngine({
            gemini: {
                ok: false, error: "gemini: HTTP 429",
                retryAfterMs: 551, quotaLimitPerMinute: 20
            },
            google: googleTranslated("2")
        });

        // One LLM debounce window (3s) per step, NOT settle()'s 5s: the whole
        // point is to land the second flush inside a cooldown that is longer
        // than 551ms but shorter than 5s.
        const tick = async () => {
            await vi.advanceTimersByTimeAsync(3_000);
            for (let i = 0; i < 20; i++) await Promise.resolve();
        };

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await tick();
        // The 429 retuned the gate to 75% of 20/min, i.e. one token per 4s —
        // which is what the floor is then read off.
        expect(rateGateSettings().refillMs).toBe(4_000);
        const before = native.translateBatch.mock.calls.length;

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await tick();

        // ~6s in: well past the 551ms the API asked for, still inside the 4s
        // floor. The gate has refilled, so a token IS available — the cooldown
        // is the only thing that can be keeping this off Gemini.
        const laterCalls = native.translateBatch.mock.calls.slice(before).map(c => c[0]);
        expect(laterCalls).not.toContain("gemini");
        expect(getTranslation(makeKey("2", "en"))).toMatchObject({ via: "google" });
    });

    it("says so once per session, not once per batch", async () => {
        useGemini();
        // A 2s cooldown that lapses between the two messages, so the engine is
        // genuinely re-entered into cooldown a second time — otherwise this
        // would pass without any guard at all.
        respondByEngine({
            gemini: { ok: false, error: "gemini: HTTP 429", retryAfterMs: 2_000 },
            google: googleTranslated("1")
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const geminiAttempts = native.translateBatch.mock.calls.filter(c => c[0] === "gemini");
        expect(geminiAttempts.length).toBeGreaterThan(1);   // cooldown entered twice

        const cooldownToasts = shownToasts.filter(t => /rate limited/i.test(t.message));
        expect(cooldownToasts).toHaveLength(1);
        // ...and it says what happened and roughly for how long.
        expect(cooldownToasts[0].message).toMatch(/Google/);
        expect(cooldownToasts[0].message).toMatch(/\d+[sm]/);
    });

    it("retunes the rate gate from the quota the 429 reported", async () => {
        // The compiled-in 15/minute guess is exactly that — a guess about
        // someone else's project. A response that states the real ceiling
        // wins.
        expect(rateGateSettings().refillMs).toBe(REFILL_MS);

        useGemini();
        respondByEngine({
            gemini: {
                ok: false, error: "gemini: HTTP 429", retryAfterMs: 2_000, quotaLimitPerMinute: 4
            },
            google: googleTranslated("1")
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        // floor(4 * 0.75) = 3/minute.
        expect(rateGateSettings().refillMs).toBe(20_000);
        expect(rateGateSettings().refillMs).toBeGreaterThan(REFILL_MS);
    });

    it("does not touch the rate gate when the 429 stated no quota", async () => {
        useGemini();
        respondByEngine({ gemini: RATE_LIMITED, google: googleTranslated("1") });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(rateGateSettings().refillMs).toBe(REFILL_MS);
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
        await vi.advanceTimersByTimeAsync(20_000);
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
        await vi.advanceTimersByTimeAsync(20_000);
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

    it("names the engine AND the language in a title attribute, so neither the glyph nor the code has to be decoded", () => {
        // The language NAME, not just the code: "ha" in the badge tells a
        // reader nothing, and "Hausa" appearing under a German conversation is
        // what makes a misdetection noticeable at all.
        setTranslation(key("1"), { lang: "es", text: "a", via: "gemini" });
        expect(titleOf(render(discordMessage("1", "hola")))).toBe("Translated by Gemini · Spanish");

        setTranslation(key("2"), { lang: "es", text: "b", via: "google" });
        expect(titleOf(render(discordMessage("2", "hola")))).toBe("Translated by Google Translate · Spanish");

        setTranslation(key("3"), { lang: "es", text: "c", via: "claude" });
        expect(titleOf(render(discordMessage("3", "hola")))).toBe("Translated by Claude · Spanish");

        setTranslation(key("4"), { lang: "ha", text: "it is", via: "google" });
        expect(titleOf(render(discordMessage("4", "ne")))).toBe("Translated by Google Translate · Hausa");
    });

    it("marks a low-confidence detection with ? so a wrong translation is not read as a right one", () => {
        // The real case: "ne" in a German channel, detected as Hausa at 0.217
        // and rendered "it is" — the opposite of the intended "no". Fluent and
        // plausible, so the badge is the reader's only warning.
        setTranslation(key("1"), { lang: "ha", text: "it is", via: "google", conf: 0.217 });
        const node = render(discordMessage("1", "ne"));
        expect(text(node)).toContain("ha?");
        expect(titleOf(node)).toContain("Hausa");
        expect(titleOf(node)).toContain("22%");
        expect(titleOf(node)).toContain("may be wrong");
    });

    it("does not mark a confident detection, so ? keeps meaning something", () => {
        setTranslation(key("1"), { lang: "de", text: "no", via: "google", conf: 0.99 });
        const node = render(discordMessage("1", "ne"));
        expect(text(node)).not.toContain("?");
        expect(titleOf(node)).not.toContain("may be wrong");
    });

    it("does not mark an LLM translation, which reports no confidence at all", () => {
        setTranslation(key("1"), { lang: "de", text: "no", via: "gemini" });
        expect(text(render(discordMessage("1", "ne")))).not.toContain("?");
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

describe("a rate-limit cooldown survives a restart", () => {
    /** Stop and start the plugin, exactly as quitting and reopening Discord does. */
    async function restart() {
        plugin.stop!();
        await plugin.start!();
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    it("does not spend a probe request on an engine still known to be rate limited", async () => {
        // Reported live: "whenever I open Discord and enter a channel I see a
        // Gemini rate-limit error". The cooldown lived only in module state, so
        // every launch inside a rate-limit window paid one request to
        // rediscover the limit — the single worst request to spend when the
        // quota is already gone — and greeted the user with a toast.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "gemini"
                ? { ok: false, error: "gemini: HTTP 429", retryAfterMs: 600_000 }
                : { ok: true, results: [{ id: "2", lang: "es", text: "hi", skip: false }] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        expect(native.translateBatch.mock.calls.map(c => c[0])).toContain("gemini");

        await restart();
        native.translateBatch.mockClear();

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        const engines = native.translateBatch.mock.calls.map(c => c[0]);
        expect(engines).not.toContain("gemini");
        expect(engines).toContain("google");
    });

    it("uses the LLM again after a restart once the cooldown has expired", async () => {
        // The mark must not become a permanent ban: it is a timestamp, so a
        // window that closed while Discord was shut counts as closed.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "gemini"
                ? { ok: false, error: "gemini: HTTP 429", retryAfterMs: 1_000 }
                : { ok: true, results: [] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();   // 5s of fake time — well past the 1s cooldown

        await restart();
        native.translateBatch.mockClear();
        native.translateBatch.mockResolvedValue({ ok: true, results: [] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();

        expect(native.translateBatch.mock.calls.map(c => c[0])).toContain("gemini");
    });
});

describe("globalAuto does not reach private conversations", () => {
    it("DOES translate a DM the user explicitly enabled, even with globalAuto off", async () => {
        // The other half of the rule, and the one that was never covered:
        // globalAuto deliberately refuses DMs, but an explicit per-channel
        // opt-in is a direct instruction about THIS conversation and overrides
        // that refusal. Without this test, "the globe button works in DMs" was
        // only ever an inference from reading channelActive.
        settings.store.globalAuto = false;
        __stubMarkAsDm("dm1");
        __stubSetSelectedChannel("dm1");
        await toggleChannel("dm1");

        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: { ...discordMessage("d1", "hola"), channel_id: "dm1" }
        });
        await settle();

        const sent = native.translateBatch.mock.calls
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));
        expect(sent).toContain("d1");
    });

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

describe("catch-up spends its budget on requests, not on messages it will skip locally", () => {
    /** Confidently English by detectLang's rules, so it costs no request. */
    const english = (id: string) =>
        discordMessage(id, "i think that we should go to the server now");

    it("reaches an older foreign message past a wall of English chatter", async () => {
        // THE regression, reported from a live English-majority channel: French
        // messages from the morning were still untranslated in the evening, and
        // scrolling back never fixed them.
        //
        // catchUpCount is 20. A locally-skipped message writes NOTHING to the
        // store (deliberately — see enqueue), so it is never "resolved", and
        // counting it against the budget means 20 English lines exhaust catch-up
        // before it ever reaches the message the user actually needed.
        settings.store.engine = "google";
        settings.store.catchUpCount = 20;

        const backlog = [
            discordMessage("fr", "je vais m'en aller incessamment sous peu"),
            ...Array.from({ length: 25 }, (_, i) => english(`en${i}`))
        ];
        stubMessages.set(CHANNEL, backlog);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        const sent = native.translateBatch.mock.calls
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));
        expect(sent).toContain("fr");
    });

    it("still bounds how many REQUESTS a single catch-up can spend", async () => {
        // The budget must still exist — the fix is what it counts, not whether
        // it counts. 25 foreign messages, budget 20, so 5 must be left behind.
        settings.store.engine = "google";
        settings.store.catchUpCount = 20;

        stubMessages.set(CHANNEL, Array.from({ length: 25 },
            (_, i) => discordMessage(`f${i}`, "je vais m'en aller incessamment sous peu")));

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await settle();

        const sent = native.translateBatch.mock.calls
            .flatMap(c => JSON.parse(c[2] as string).messages.map((m: any) => m.id));
        expect(sent).toHaveLength(20);
    });
});

describe("a short reply borrows its parent's language instead of being guessed at", () => {
    /** A message that Discord marks as a reply to `parentId`. */
    const replyTo = (id: string, content: string, parentId: string) => ({
        ...discordMessage(id, content),
        message_reference: { message_id: parentId }
    });

    /** The sourceLang the Google engine was asked to pin, for message `id`. */
    function sentSourceLang(id: string): string | undefined {
        for (const call of native.translateBatch.mock.calls) {
            if (call[0] !== "google") continue;
            const m = JSON.parse(call[2] as string).messages.find((m: any) => m.id === id);
            if (m) return m.sourceLang;
        }
        return undefined;
    }

    beforeEach(() => {
        settings.store.engine = "google";
    });

    it("pins the parent's language for a short reply — the 'ne' case", async () => {
        // Live: "ne" under sl=auto is Hausa "it is"; the German parent makes it
        // sl=de, which returns "no". The parent here is the actual message that
        // preceded it in the channel this was captured from.
        setTranslation(makeKey("p", "en"), {
            lang: "de", text: "Are the group rooms air-conditioned at the university?",
            via: "google", conf: 1
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: replyTo("1", "ne", "p") });
        await settle();

        expect(sentSourceLang("1")).toBe("de");
    });

    it("leaves a LONG reply to auto-detect, so a different language is not forced into the parent's", async () => {
        // The multilingual-channel guard: someone answering a German message in
        // Spanish at length must still be detected as Spanish. Length is what
        // makes auto-detection trustworthy, so length is where borrowing stops.
        setTranslation(makeKey("p", "en"), { lang: "de", text: "x", via: "google", conf: 1 });

        FluxDispatcher.dispatch("MESSAGE_CREATE", {
            message: replyTo("1", "pues la verdad es que no tengo ni idea", "p")
        });
        await settle();

        expect(sentSourceLang("1")).toBeUndefined();
    });

    it("does not borrow from a parent that was itself only guessed at", async () => {
        // Otherwise one bad detection propagates down an entire reply chain,
        // and every message in it looks equally confident.
        setTranslation(makeKey("p", "en"), {
            lang: "ha", text: "it is", via: "google", conf: 0.217
        });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: replyTo("1", "ne", "p") });
        await settle();

        expect(sentSourceLang("1")).toBeUndefined();
    });

    it("does not borrow when the message is not a reply at all", async () => {
        setTranslation(makeKey("p", "en"), { lang: "de", text: "x", via: "google", conf: 1 });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "ne") });
        await settle();

        expect(sentSourceLang("1")).toBeUndefined();
    });

    it("does not borrow from a parent that has no translation yet", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: replyTo("1", "ne", "nope") });
        await settle();

        expect(sentSourceLang("1")).toBeUndefined();
    });
});
