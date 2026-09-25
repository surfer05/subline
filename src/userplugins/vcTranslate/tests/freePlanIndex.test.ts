import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same hoisted native stand-in as index.test.ts: index.tsx reads it at import.
const native = vi.hoisted(() => {
    const translateBatch = vi.fn();
    const readStagedBuildId = vi.fn().mockResolvedValue(null);
    const relayStatus = vi.fn().mockResolvedValue({ ok: false, error: "status unavailable" });
    (globalThis as any).VencordNative = {
        pluginHelpers: { VcTranslate: { translateBatch, readStagedBuildId, relayStatus } }
    };
    return { translateBatch, readStagedBuildId, relayStatus };
});

import plugin, { FORCE_QUALITY_POPOVER_ID, FORCED_HINT_TTL_MS } from "../index";
import { setCooldown } from "../cooldownStore";
import { toggleChannelOptOut } from "../channels";
import { DAY_MS, TRIAL_MS } from "../freePlan";
import type { NativeResponse } from "../native";
import settings from "../settings";
import { clearStore, getTranslation, makeKey, setTranslation } from "../store";
import { __resetTaste } from "../taste";
import { WEEK_MS, WEEKLY_KEY } from "../weeklyNote";
import { __resetSettings } from "./stubs/api-settings";
import * as DataStore from "./stubs/api-datastore";
import { __getPopoverButton, __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import {
    __resetWebpackCommon, __stubMarkAsDm, __stubSetSelectedChannel, FluxDispatcher, shownToasts, stubMessages
} from "./stubs/webpack-common";

/**
 * THE FREE PLAN, end to end through the renderer (v0.1.6).
 *
 *   - a free install's first 7 days are automatic, ≈ and (once the relay
 *     confirms the trial) ✦, exactly like a paid install;
 *   - after that nothing is translated until the reader clicks "≈ Translate";
 *   - a free ≈ line the confidence logic rates unreliable reads "≈ rough";
 *   - a click on a rough line asks the relay for a ✦ preview (3 a day);
 *   - a paid install sees none of it, except the weekly note.
 */

const CHANNEL = "c1";
const key = (id: string) => makeKey(id, "en");
const msg = (id: string, content: string, authorId = "u1") => ({
    id, channel_id: CHANNEL, content, author: { id: authorId, username: "ana" }
});

async function flush() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}
async function settle() {
    await vi.advanceTimersByTimeAsync(21_000);
    await flush();
}

const calls = (engine?: string) =>
    native.translateBatch.mock.calls.filter(c => engine === undefined || c[0] === engine);
const payloadOf = (call: any[]) => JSON.parse(call[2]);

/** Answer every engine for the ids it was sent. */
function answer(opts: {
    google?: { text?: string; lang?: string; conf?: number };
    relay?: (m: { id: string }, payload: any) => any;
    relayQuota?: { used: number; cap: number };
} = {}) {
    native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string): Promise<NativeResponse> => {
        const p = JSON.parse(payload);
        if (engine === "google") {
            const g = opts.google ?? {};
            return {
                ok: true,
                results: p.messages.map((m: { id: string }) => ({
                    id: m.id, lang: g.lang ?? "es", text: g.text ?? "hello there", skip: false,
                    ...(g.conf !== undefined ? { conf: g.conf } : {})
                }))
            };
        }
        return {
            ok: true,
            results: p.messages.map((m: { id: string }) =>
                opts.relay ? opts.relay(m, p) : { id: m.id, lang: "es", text: "sharper " + m.id, skip: false }),
            ...(opts.relayQuota ? { quotaUsed: opts.relayQuota.used, quotaCap: opts.relayQuota.cap } : {})
        };
    });
}

const render = (message: unknown) => {
    const el: any = plugin.renderMessageAccessory!({ message } as any);
    return el.type(el.props);
};
const text = (node: any): string => {
    if (node === null || node === undefined || node === false) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    return text(node.children);
};
/** The first node in a rendered tree with an onClick, and its label. */
function clickable(node: any): { onClick: () => void; label: string } | null {
    if (node === null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
        for (const c of node) { const f = clickable(c); if (f) return f; }
        return null;
    }
    if (typeof node.props?.onClick === "function") return { onClick: node.props.onClick, label: text(node) };
    return clickable(node.children);
}

/** Restart the plugin with the given settings already in place, as a relaunch would. */
async function restart(setup: () => void = () => { }) {
    plugin.stop!();
    clearStore();
    __resetTaste();
    setup();
    await plugin.start!();
    await flush();
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 25, 12, 0, 0)));
    native.translateBatch.mockReset();
    native.relayStatus.mockReset();
    native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
    answer();
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
    await flush();
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

/** A free install whose trial ended `daysAgo` days ago by the local clock. */
function expiredLocally(daysAgo = 1) {
    settings.store.freeTrialStartedAt = Date.now() - TRIAL_MS - daysAgo * DAY_MS;
}

// ---------------------------------------------------------------------------
describe("the trial clock", () => {
    it("starts the first time a free install runs, and is stored in settings", () => {
        expect(settings.store.freeTrialStartedAt).toBe(Date.now());
    });

    it("is never restarted by a later session", async () => {
        const started = settings.store.freeTrialStartedAt;
        vi.setSystemTime(Date.now() + 3 * DAY_MS);
        await restart();
        expect(settings.store.freeTrialStartedAt).toBe(started);
    });

    it("does not start for a paid install", async () => {
        __resetSettings();
        await restart(() => {
            settings.store.targetLang = "en";
            settings.store.sublineCode = "SUBLINE-PAID";
        });
        expect(settings.store.freeTrialStartedAt).toBe(0);
    });

    it("asks the relay about the trial under the install bearer", () => {
        expect(native.relayStatus).toHaveBeenCalledTimes(1);
        expect(native.relayStatus.mock.calls[0][0]).toMatch(/^free_[0-9a-f]{32}$/);
    });
});

// ---------------------------------------------------------------------------
describe("during the trial: automatic", () => {
    it("translates with ≈ automatically while the relay has not confirmed the trial", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls().map(c => c[0])).toEqual(["google"]);
        expect(getTranslation(key("1"))).toMatchObject({ via: "google" });
    });

    it("adds automatic ✦ once the relay confirms the trial, under the free_ bearer with mode auto", async () => {
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: Date.now() + 5 * DAY_MS
        });
        await restart();

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();

        const relay = calls("relay");
        expect(relay).toHaveLength(1);
        expect(relay[0][1]).toMatch(/^free_[0-9a-f]{32}$/);
        expect(payloadOf(relay[0]).mode).toBe("auto");
        expect(getTranslation(key("1"))).toMatchObject({ via: "relay", text: "sharper 1" });
        // Nothing to click: the trial is automatic.
        expect(clickable(render(msg("2", "hola que tal")))).toBeNull();
    });

    it("never labels a ✦ trial line, and shows no ≈ Translate line", async () => {
        setTranslation(key("1"), { lang: "es", text: "sharper", via: "relay" });
        const out = text(render(msg("1", "hola que tal")));
        expect(out).toContain("✦");
        expect(out).not.toContain("rough");
        expect(out).not.toContain("Translate");
    });

    it("says nothing red and pins nothing when the relay refuses the trial credential", async () => {
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: Date.now() + 5 * DAY_MS
        });
        await restart();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "relay"
                ? { ok: false, error: "relay: HTTP 401 invalid or missing code" }
                : { ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "es", text: "hi", skip: false })) });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(shownToasts.some(t => t.type === "FAILURE")).toBe(false);
        expect(shownToasts.some(t => /Subline code/.test(t.message))).toBe(false);

        // ✦ stops for the session; ≈ carries on.
        native.translateBatch.mockClear();
        answer();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "que pasa amigo") });
        await settle();
        expect(calls().map(c => c[0])).toEqual(["google"]);
    });

    it("follows the relay when it refuses an automatic batch as 'trial ended'", async () => {
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: Date.now() + 5 * DAY_MS
        });
        await restart();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "relay"
                ? { ok: false, error: "relay: HTTP 402 trial ended", trialEndsAt: Date.now() - 1, serverNow: Date.now() }
                : { ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "es", text: "hi", skip: false })) });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();

        // Click-to-translate from here: the next message sends nothing.
        native.translateBatch.mockClear();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "que pasa amigo") });
        await settle();
        expect(calls()).toHaveLength(0);
        expect(clickable(render(msg("2", "que pasa amigo")))?.label).toBe("≈ Translate");
    });
});

// ---------------------------------------------------------------------------
describe("after the trial: translate on click", () => {
    beforeEach(async () => {
        await restart(() => expiredLocally());
    });

    it("translates nothing automatically, live or on channel open", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        stubMessages.set(CHANNEL, [msg("2", "bonjour tout le monde"), msg("3", "que pasa")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        await settle();
        expect(calls()).toHaveLength(0);
    });

    it("offers ≈ Translate under a message that may be foreign", () => {
        const line = clickable(render(msg("1", "hola que tal")));
        expect(line?.label).toBe("≈ Translate");
    });

    it("offers nothing under a message the local rules place in the reader's language, or the reader's own", () => {
        expect(render(msg("1", "hello everyone, how are you all doing today"))).toBeNull();
        expect(render(msg("2", "lol"))).toBeNull();
        expect(render(msg("3", "hola que tal", "me"))).toBeNull();
    });

    it("a click runs the normal ≈ translation for that one message and shows the ≈ line", async () => {
        answer({ google: { text: "hi, how are you", lang: "es", conf: 0.99 } });
        clickable(render(msg("1", "hola que tal")))!.onClick();
        expect(text(render(msg("1", "hola que tal")))).toContain("≈ translating…");
        await flush();

        expect(calls().map(c => c[0])).toEqual(["google"]);
        expect(payloadOf(calls()[0]).messages.map((m: any) => m.id)).toEqual(["1"]);
        expect(getTranslation(key("1"))).toMatchObject({ via: "google", text: "hi, how are you" });
        const out = text(render(msg("1", "hola que tal")));
        expect(out).toContain("≈ es");
        expect(out).toContain("hi, how are you");
        expect(out).not.toContain("rough");
    });

    it("offers the click again when the click could not reach Google", async () => {
        native.translateBatch.mockResolvedValue({ ok: false, error: "google: HTTP 503" });
        clickable(render(msg("1", "hola que tal")))!.onClick();
        await flush();
        expect(clickable(render(msg("1", "hola que tal")))?.label).toBe("≈ Translate");
    });

    it("tells the reader the trial ended, once, the first time a message is shown", async () => {
        // (The relay never answered here: the local clock may stand in, since
        // the local end is a full day past. See the announce suite below.)
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "que pasa amigo") });
        const ended = shownToasts.filter(t => /trial ended/.test(t.message));
        expect(ended).toHaveLength(1);
        expect(ended[0].message).toBe(
            "Your 7-day free trial ended. Messages now translate when you click. Upgrade to keep it automatic."
        );
        expect(ended[0].message).not.toContain("http");
        expect(ended[0].type).toBe("MESSAGE");
        expect(settings.store.freeTrialEndNoticeFor).toBeGreaterThan(0);

        // Never again, not even after a restart.
        const shown = settings.store.freeTrialStartedAt;
        await restart(() => { settings.store.freeTrialStartedAt = shown; });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("3", "hola otra vez") });
        expect(shownToasts.filter(t => /trial ended/.test(t.message))).toHaveLength(1);
    });

    it("also tells it on opening a channel whose backlog is foreign", () => {
        stubMessages.set(CHANNEL, [msg("2", "bonjour tout le monde")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        expect(shownToasts.filter(t => /trial ended/.test(t.message))).toHaveLength(1);
    });

    it("does not tell it for a backlog of the reader's own language", () => {
        stubMessages.set(CHANNEL, [msg("2", "hello everyone, how are you all doing today")]);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        expect(shownToasts).toHaveLength(0);
    });

    it("follows the relay's record over a fresh local clock", async () => {
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "taste", used: 0, cap: 3, trialEndsAt: Date.now() - DAY_MS
        });
        __resetSettings();
        await restart(() => { settings.store.targetLang = "en"; settings.store.globalAuto = true; });
        // Local clock just started (a wiped settings file), but the relay says over.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls()).toHaveLength(0);
        expect(clickable(render(msg("1", "hola que tal")))?.label).toBe("≈ Translate");
    });

    it("turns ⚡ into a ✦ preview: mode preview, three a day, never the full line", async () => {
        answer({
            relay: m => ({ id: m.id, lang: "es", text: "hi how are you doing this fine evening", skip: false, truncated: false }),
            relayQuota: { used: 1, cap: 3 }
        });
        const btn = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", "hola que tal"));
        expect(btn!.label).toBe("Preview Subline ✦ (3 of 3 left today)");
        btn!.onClick!(undefined as any);
        await flush();
        const relay = calls("relay");
        expect(relay).toHaveLength(1);
        expect(payloadOf(relay[0]).mode).toBe("preview");
        // Nothing stored as a translation; the preview renders under the click line.
        expect(getTranslation(key("1"))).toBeUndefined();
        const out = text(render(msg("1", "hola que tal")));
        expect(out).toContain("≈ Translate");
        expect(out).toContain("✦ reads this as: hi how are you doing… Upgrade");
        expect(out).not.toContain("fine evening");
        // Spent: the button goes, and the count went down.
        expect(__getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", "hola que tal"))).toBeNull();
        expect(__getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("2", "hola que tal"))!.label)
            .toContain("2 of 3 left today");
    });

    it("never shows the trial's allowance as the preview count (no '299 of 300')", async () => {
        answer({ relayQuota: { used: 1, cap: 300 } });
        const btn = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", "hola que tal"));
        btn!.onClick!(undefined as any);
        await flush();
        const label = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("2", "hola que tal"))!.label;
        expect(label).not.toContain("300");
        expect(label).toContain("of 3 left today");
    });

    it("the click line answers Enter and Space like a button", async () => {
        answer({ google: { text: "hi there", lang: "es", conf: 0.99 } });
        const node = render(msg("1", "hola que tal"));
        const onKeyDown = node.props.onKeyDown;
        expect(node.props.role).toBe("button");
        onKeyDown({ key: "a", preventDefault() { } });
        await flush();
        expect(calls()).toHaveLength(0);
        onKeyDown({ key: "Enter", preventDefault() { } });
        await flush();
        expect(calls("google")).toHaveLength(1);
        const node2 = render(msg("2", "que pasa amigo"));
        node2.props.onKeyDown({ key: " ", preventDefault() { } });
        await flush();
        expect(calls("google")).toHaveLength(2);
    });

    it("says Google is busy when a click lands during a Google cooldown", async () => {
        setCooldown("google", Date.now() + 30_000);
        clickable(render(msg("1", "hola que tal")))!.onClick();
        await flush();
        expect(calls()).toHaveLength(0);
        expect(text(render(msg("1", "hola que tal")))).toBe("Google is busy. Try again in a moment.");
        // Self-clearing: the click comes back.
        await vi.advanceTimersByTimeAsync(FORCED_HINT_TTL_MS);
        expect(clickable(render(msg("1", "hola que tal")))?.label).toBe("≈ Translate");
    });

    it("says Google is busy when the click itself was throttled", async () => {
        native.translateBatch.mockResolvedValue({ ok: false, error: "google: HTTP 429", retryAfterMs: 10_000 });
        clickable(render(msg("1", "hola que tal")))!.onClick();
        await flush();
        expect(text(render(msg("1", "hola que tal")))).toBe("Google is busy. Try again in a moment.");
    });
});

// ---------------------------------------------------------------------------
describe("≈ rough: only when the confidence logic says so", () => {
    it("labels a free romanized-guess line (the existing unsure test) ≈ rough", () => {
        setTranslation(key("1"), { lang: "ar", text: "I don't want to go home", via: "google", conf: 1 });
        const out = text(render(msg("1", "ana bghit nmchi l dar")));
        expect(out).toContain("≈ rough ar");
        expect(out).not.toContain("ar?");
    });

    it("labels a free low-confidence line ≈ rough", () => {
        setTranslation(key("1"), { lang: "ha", text: "it is", via: "google", conf: 0.217 });
        expect(text(render(msg("1", "ne")))).toContain("≈ rough ha");
    });

    it("never labels a confident free line", () => {
        setTranslation(key("1"), { lang: "es", text: "hello there", via: "google", conf: 0.99 });
        setTranslation(key("2"), { lang: "es", text: "hello there", via: "google" });
        expect(text(render(msg("1", "hola")))).not.toContain("rough");
        expect(text(render(msg("2", "hola")))).not.toContain("rough");
    });

    it("never shows the label to a paid install, which keeps its ?", () => {
        settings.store.sublineCode = "SUBLINE-PAID";
        setTranslation(key("1"), { lang: "ar", text: "I don't want to go home", via: "google", conf: 1 });
        const out = text(render(msg("1", "ana bghit nmchi l dar")));
        expect(out).not.toContain("rough");
        expect(out).toContain("ar?");
    });
});

// ---------------------------------------------------------------------------
describe("the ✦ preview after a click on a rough line", () => {
    const ROMANIZED = "ana bghit nmchi l dar daba";

    beforeEach(async () => {
        await restart(() => expiredLocally());
    });

    async function clickOn(id: string, content: string) {
        clickable(render(msg(id, content)))!.onClick();
        await flush();
    }

    it("asks the relay in preview mode, and shows the first words with an Upgrade link", async () => {
        answer({
            google: { lang: "ar", text: "I want to walk the house now", conf: 1 },
            relay: m => ({ id: m.id, lang: "ar", text: "I don't want to go", skip: false, truncated: true }),
            relayQuota: { used: 1, cap: 3 }
        });
        await clickOn("1", ROMANIZED);

        const relay = calls("relay");
        expect(relay).toHaveLength(1);
        expect(relay[0][1]).toMatch(/^free_[0-9a-f]{32}$/);
        const p = payloadOf(relay[0]);
        expect(p.mode).toBe("preview");
        expect(p.messages.map((m: any) => m.id)).toEqual(["1"]);

        const node = render(msg("1", ROMANIZED));
        const out = text(node);
        expect(out).toContain("≈ rough ar");
        expect(out).toContain("✦ reads this as: I don't want to go… Upgrade");
        // The preview is never stored as a translation.
        expect(getTranslation(key("1"))).toMatchObject({ via: "google" });
        // The link goes to pricing.
        const link = clickable(node);
        expect(link?.label).toBe("Upgrade");
    });

    it("does not ask for a preview when the ≈ line is not rough", async () => {
        answer({ google: { lang: "es", text: "hi, how are you", conf: 0.99 } });
        await clickOn("1", "hola que tal");
        expect(calls("relay")).toHaveLength(0);
    });

    it("does not ask without a click: an automatic trial ≈ line never previews", async () => {
        await restart();   // back in the trial, ≈ automatic
        answer({ google: { lang: "ar", text: "I want to walk", conf: 1 } });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", ROMANIZED) });
        await settle();
        expect(calls("relay")).toHaveLength(0);
        expect(text(render(msg("1", ROMANIZED)))).not.toContain("reads this as");
    });

    it("asks nothing once today's three are used, and says nothing", async () => {
        native.relayStatus.mockResolvedValue({ ok: true, plan: "taste", used: 3, cap: 3, trialEndsAt: Date.now() - DAY_MS });
        await restart(() => expiredLocally());
        answer({ google: { lang: "ar", text: "I want to walk", conf: 1 } });
        await clickOn("1", ROMANIZED);
        expect(calls("relay")).toHaveLength(0);
        expect(shownToasts.filter(t => !/trial ended/.test(t.message))).toHaveLength(0);
        expect(text(render(msg("1", ROMANIZED)))).not.toContain("reads this as");
    });

    it("stops silently when the relay says the three are used", async () => {
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "relay"
                ? { ok: false, error: "relay: HTTP 429 daily limit reached", retryAfterMs: 3_600_000 }
                : { ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "ar", text: "I want to walk", skip: false, conf: 1 })) });
        await clickOn("1", ROMANIZED);
        await clickOn("2", ROMANIZED + " ghda");
        expect(calls("relay")).toHaveLength(1);
        expect(shownToasts.filter(t => !/trial ended/.test(t.message))).toHaveLength(0);
    });

    it("shows nothing when ✦ reads it the same as ≈", async () => {
        answer({
            google: { lang: "ar", text: "I don't want to go home", conf: 1 },
            relay: m => ({ id: m.id, lang: "ar", text: "I don't want to go", skip: false, truncated: true })
        });
        await clickOn("1", ROMANIZED);
        expect(calls("relay")).toHaveLength(1);
        expect(text(render(msg("1", ROMANIZED)))).not.toContain("reads this as");
    });

    it("shows a short ✦ line whole, without the ellipsis", async () => {
        answer({
            google: { lang: "ar", text: "I want walk", conf: 1 },
            relay: m => ({ id: m.id, lang: "ar", text: "I'm going home", skip: false })
        });
        await clickOn("1", ROMANIZED);
        expect(text(render(msg("1", ROMANIZED)))).toContain("✦ reads this as: I'm going home Upgrade");
    });
});

// ---------------------------------------------------------------------------
describe("a paid install: unchanged", () => {
    beforeEach(async () => {
        __resetSettings();
        await restart(() => {
            native.relayStatus.mockClear();
            settings.store.targetLang = "en";
            settings.store.globalAuto = true;
            settings.store.sublineCode = "SUBLINE-PAID";
        });
    });

    it("translates automatically with its own code, no mode, no trial, no status call", async () => {
        answer({ google: { lang: "ar", text: "I want to walk", conf: 1 } });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "ana bghit nmchi l dar daba") });
        await settle();
        const relay = calls("relay");
        expect(relay.length).toBeGreaterThan(0);
        expect(relay.every(c => c[1] === "SUBLINE-PAID")).toBe(true);
        expect(relay.every(c => payloadOf(c).mode === undefined)).toBe(true);
        expect(native.relayStatus).not.toHaveBeenCalled();
    });

    it("gets no ≈ Translate line, no rough label and no preview", async () => {
        expect(render(msg("1", "hola que tal"))).toBeNull();
        setTranslation(key("2"), { lang: "ar", text: "I want to walk", via: "google", conf: 1 });
        const out = text(render(msg("2", "ana bghit nmchi l dar daba")));
        expect(out).not.toContain("rough");
        expect(out).not.toContain("reads this as");
    });

    it("never sees the trial-ended toast, even with an old trial start on file", async () => {
        settings.store.freeTrialStartedAt = Date.now() - 30 * DAY_MS;
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(shownToasts.some(t => /trial/.test(t.message))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe("the weekly note", () => {
    it("says how many messages in how many languages, once the week is over", async () => {
        answer({ google: { lang: "es", text: "hi", conf: 0.99 } });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        answer({ google: { lang: "fr", text: "hi", conf: 0.99 } });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "bonjour tout le monde") });
        await settle();
        expect(shownToasts.filter(t => /This week/.test(t.message))).toHaveLength(0);

        vi.setSystemTime(Date.now() + WEEK_MS);
        await restart(() => { settings.store.freeTrialStartedAt = Date.now(); });
        const notes = shownToasts.filter(t => /This week/.test(t.message));
        expect(notes).toHaveLength(1);
        expect(notes[0].message).toBe("This week: 2 messages in 2 languages.");
        expect(notes[0].type).toBe("MESSAGE");

        // Not again inside the next 7 days.
        await restart(() => { settings.store.freeTrialStartedAt = Date.now(); });
        expect(shownToasts.filter(t => /This week/.test(t.message))).toHaveLength(1);
    });

    it("counts a message once, when its ≈ line is later replaced by ✦", async () => {
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: Date.now() + 5 * DAY_MS
        });
        await restart();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(getTranslation(key("1"))).toMatchObject({ via: "relay" });
        const stored: any = await DataStore.get(WEEKLY_KEY);
        expect(stored.count).toBe(1);
    });

    it("stays quiet after an empty week", async () => {
        vi.setSystemTime(Date.now() + WEEK_MS);
        await restart(() => { settings.store.freeTrialStartedAt = Date.now(); });
        expect(shownToasts.filter(t => /This week/.test(t.message))).toHaveLength(0);
    });

    it("reaches paid installs too", async () => {
        __resetSettings();
        await restart(() => {
            settings.store.targetLang = "en";
            settings.store.globalAuto = true;
            settings.store.sublineCode = "SUBLINE-PAID";
        });
        answer();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        vi.setSystemTime(Date.now() + WEEK_MS);
        await restart(() => {
            settings.store.sublineCode = "SUBLINE-PAID";
        });
        expect(shownToasts.filter(t => t.message === "This week: 1 message in 1 language.")).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe("review fixes: an older relay, retries, the announcement, clock skew", () => {
    const ROMANIZED = "ana bghit nmchi l dar daba";

    it("cuts a preview on the client too, when the relay ignores mode and returns the full ✦ line", async () => {
        await restart(() => expiredLocally());
        // An OLD relay: no truncation, no flag, the whole line.
        answer({
            google: { lang: "ar", text: "I want to walk the house now", conf: 1 },
            relay: m => ({ id: m.id, lang: "ar", text: "I really do not want to go home tonight at all", skip: false })
        });
        clickable(render(msg("1", ROMANIZED)))!.onClick();
        await flush();
        const out = text(render(msg("1", ROMANIZED)));
        expect(out).toContain("✦ reads this as: I really do not want… Upgrade");
        expect(out).not.toContain("home tonight");
    });

    it("retries the startup status call at 5s, 15s, 60s, then every 5 minutes, until the relay answers", async () => {
        // beforeEach's start() made call 1, which failed.
        expect(native.relayStatus).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(4_999); await flush();
        expect(native.relayStatus).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1); await flush();
        expect(native.relayStatus).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(15_000); await flush();
        expect(native.relayStatus).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(60_000); await flush();
        expect(native.relayStatus).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(5 * 60_000); await flush();
        expect(native.relayStatus).toHaveBeenCalledTimes(5);

        // The relay answers: the trial is confirmed and retries stop.
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: Date.now() + 5 * DAY_MS, serverNow: Date.now()
        });
        await vi.advanceTimersByTimeAsync(5 * 60_000); await flush();
        expect(native.relayStatus).toHaveBeenCalledTimes(6);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls("relay")).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(60 * 60_000); await flush();
        expect(native.relayStatus).toHaveBeenCalledTimes(6);
    });

    it("stops retrying when the plugin stops", async () => {
        plugin.stop!();
        await vi.advanceTimersByTimeAsync(60 * 60_000); await flush();
        expect(native.relayStatus).toHaveBeenCalledTimes(1);
        await plugin.start!();   // afterEach stops it again
    });

    it("does not announce on the local clock alone until a full day past its end", async () => {
        await restart(() => { settings.store.freeTrialStartedAt = Date.now() - TRIAL_MS - 2 * 60 * 60_000; });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        expect(shownToasts.filter(t => /trial ended/.test(t.message))).toHaveLength(0);
        // The click line is there anyway (the local clock drives click mode).
        expect(clickable(render(msg("1", "hola que tal")))?.label).toBe("≈ Translate");
    });

    it("announces as soon as the relay states the trial ended, even the same hour", async () => {
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "taste", used: 0, cap: 3, trialEndsAt: Date.now() - 60_000, serverNow: Date.now()
        });
        await restart(() => { settings.store.freeTrialStartedAt = Date.now() - TRIAL_MS + 60_000; });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        expect(shownToasts.filter(t => /trial ended/.test(t.message))).toHaveLength(1);
    });

    it("announces after a 402 'trial ended' reply, and once per ending only", async () => {
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: Date.now() + DAY_MS, serverNow: Date.now()
        });
        await restart();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "relay"
                ? { ok: false, error: "relay: HTTP 402 trial ended", trialEndsAt: Date.now() - 1, serverNow: Date.now() }
                : { ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "es", text: "hi", skip: false })) });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "que pasa amigo") });
        expect(shownToasts.filter(t => /trial ended/.test(t.message))).toHaveLength(1);

        // The same ending seen again after a restart (the relay now states it): no second toast.
        const start = settings.store.freeTrialStartedAt;
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "taste", used: 0, cap: 3, trialEndsAt: Date.now() - 1, serverNow: Date.now()
        });
        await restart(() => { settings.store.freeTrialStartedAt = start; });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("3", "hola otra vez") });
        expect(shownToasts.filter(t => /trial ended/.test(t.message))).toHaveLength(1);
    });

    it("corrects a FAST client clock: a trial the relay says still runs stays automatic", async () => {
        const realNow = Date.now();
        vi.setSystemTime(realNow + 3 * DAY_MS);   // the reader's clock is 3 days ahead
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: realNow + 2 * DAY_MS, serverNow: realNow
        });
        await restart();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls("relay")).toHaveLength(1);
        expect(clickable(render(msg("2", "hola que tal")))).toBeNull();
    });

    it("corrects a SLOW client clock: a trial the relay says ended is over", async () => {
        const realNow = Date.now();
        vi.setSystemTime(realNow - 3 * DAY_MS);   // the reader's clock is 3 days behind
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "taste", used: 0, cap: 3, trialEndsAt: realNow - DAY_MS, serverNow: realNow
        });
        await restart();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls()).toHaveLength(0);
        expect(clickable(render(msg("1", "hola que tal")))?.label).toBe("≈ Translate");
        expect(shownToasts.filter(t => /trial ended/.test(t.message))).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe("re-review fixes", () => {
    const trialStatus = (over: Record<string, unknown> = {}) => ({
        ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: Date.now() + 5 * DAY_MS, serverNow: Date.now(), ...over
    });

    it("N2: a trial whose relay record was never written still ends at local start + 7 days", async () => {
        // The relay keeps answering a PROVISIONAL "now + 7 days" (its first
        // write failed). The local start is one hour from its end.
        const start = Date.now() - TRIAL_MS + 60 * 60_000;
        native.relayStatus.mockImplementation(async () => trialStatus({ trialEndsAt: Date.now() + TRIAL_MS, trialProvisional: true }));
        await restart(() => { settings.store.freeTrialStartedAt = start; });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls("relay")).toHaveLength(1);   // still in the trial: ✦ is on

        vi.setSystemTime(start + TRIAL_MS + 1);
        native.translateBatch.mockClear();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "que pasa amigo") });
        await settle();
        expect(calls()).toHaveLength(0);
        expect(clickable(render(msg("2", "que pasa amigo")))?.label).toBe("≈ Translate");
        // The provisional answer is not a stated ending: no toast before local end + 24h.
        expect(shownToasts.filter(t => /trial ended/.test(t.message))).toHaveLength(0);
    });

    it("N3: after the relay's 90-day record lapses, an install with a local start gets no new trial", async () => {
        // The relay has forgotten the id and started it afresh (a real, non-
        // provisional record 6 days from its end). The local start is 100 days old.
        native.relayStatus.mockResolvedValue(trialStatus({ trialEndsAt: Date.now() + 6 * DAY_MS }));
        const start = Date.now() - 100 * DAY_MS;
        await restart(() => { settings.store.freeTrialStartedAt = start; });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls()).toHaveLength(0);
        expect(clickable(render(msg("1", "hola que tal")))?.label).toBe("≈ Translate");
        expect(settings.store.freeTrialStartedAt).toBe(start);   // never reset
    });

    it("N4: a relay outage mid-trial (503) says nothing and changes nothing", async () => {
        native.relayStatus.mockResolvedValue(trialStatus());
        await restart();
        const start = settings.store.freeTrialStartedAt;
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "relay"
                ? { ok: false, error: "relay: HTTP 503 temporarily unavailable" }
                : { ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "es", text: "hi", skip: false })) });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(shownToasts).toHaveLength(0);
        expect(clickable(render(msg("2", "que pasa amigo")))).toBeNull();
        expect(settings.store.freeTrialStartedAt).toBe(start);
        answer();
        native.translateBatch.mockClear();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("3", "otra cosa amigo") });
        await settle();
        expect(calls("relay")).toHaveLength(1);   // still automatic ✦
    });

    it("N4: a 402 'trial ended' with no past trialEndsAt is not believed", async () => {
        native.relayStatus.mockResolvedValue(trialStatus());
        await restart();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "relay"
                ? { ok: false, error: "relay: HTTP 402 trial ended" }
                : { ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "es", text: "hi", skip: false })) });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(shownToasts).toHaveLength(0);
        expect(clickable(render(msg("2", "que pasa amigo")))).toBeNull();
    });

    it("N5: a preview that reads the same as ≈ says so, and ⚡ is gone once asked", async () => {
        await restart(() => expiredLocally());
        setTranslation(key("1"), { lang: "es", text: "hi, how are you", via: "google", conf: 0.99 });
        answer({ relay: m => ({ id: m.id, lang: "es", text: "Hi how are you", skip: false }), relayQuota: { used: 1, cap: 3 } });
        const btn = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", "hola que tal"));
        btn!.onClick!(undefined as any);
        await flush();
        expect(calls("relay")).toHaveLength(1);
        expect(text(render(msg("1", "hola que tal")))).toContain("✦ reads this the same way.");
        expect(__getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", "hola que tal"))).toBeNull();
    });

    it("N5: ⚡ is hidden once a preview was asked even if the relay refused it", async () => {
        await restart(() => expiredLocally());
        native.translateBatch.mockResolvedValue({ ok: false, error: "relay: HTTP 503 temporarily unavailable" });
        __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", "hola que tal"))!.onClick!(undefined as any);
        await flush();
        expect(__getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", "hola que tal"))).toBeNull();
    });
});

// ---------------------------------------------------------------------------
describe("N7: channels the reader has not opted into, and a code pasted mid-session", () => {
    const DM = "dm1";
    const dmMsg = (id: string, content: string) => ({ ...msg(id, content), channel_id: DM });

    for (const mode of ["trial", "click"] as const) {
        it(`${mode}: a DM sends nothing and shows no click line`, async () => {
            native.relayStatus.mockResolvedValue({ ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: Date.now() + 5 * DAY_MS, serverNow: Date.now() });
            await restart(() => { if (mode === "click") expiredLocally(); });
            if (mode === "click") native.relayStatus.mockResolvedValue({ ok: false, error: "down" });
            __stubMarkAsDm(DM);
            __stubSetSelectedChannel(DM);
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: dmMsg("1", "hola que tal") });
            stubMessages.set(DM, [dmMsg("2", "bonjour tout le monde")]);
            FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: DM });
            await settle();
            expect(calls()).toHaveLength(0);
            expect(render(dmMsg("1", "hola que tal"))).toBeNull();
            expect(shownToasts.filter(t => /trial ended/.test(t.message))).toHaveLength(0);
        });

        it(`${mode}: a server channel switched off sends nothing and shows no click line`, async () => {
            native.relayStatus.mockResolvedValue({ ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: Date.now() + 5 * DAY_MS, serverNow: Date.now() });
            await restart(() => { if (mode === "click") expiredLocally(); });
            await toggleChannelOptOut(CHANNEL);
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
            stubMessages.set(CHANNEL, [msg("2", "bonjour tout le monde")]);
            FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
            await settle();
            expect(calls()).toHaveLength(0);
            expect(render(msg("1", "hola que tal"))).toBeNull();
        });
    }

    it("click mode: pasting a code turns everything automatic with no labels or previews; removing it returns to the free plan", async () => {
        await restart(() => expiredLocally());
        expect(clickable(render(msg("1", "hola que tal")))?.label).toBe("≈ Translate");

        settings.store.sublineCode = "SUBLINE-PAID";
        answer({ google: { lang: "ar", text: "I want to walk", conf: 1 } });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "ana bghit nmchi l dar daba") });
        await settle();
        const relay = calls("relay");
        expect(relay.length).toBeGreaterThan(0);
        expect(relay.every(c => c[1] === "SUBLINE-PAID" && payloadOf(c).mode === undefined)).toBe(true);
        expect(render(msg("3", "hola que tal"))).toBeNull();   // no click line
        setTranslation(key("4"), { lang: "ar", text: "I want to walk", via: "google", conf: 1 });
        const out = text(render(msg("4", "ana bghit nmchi l dar daba")));
        expect(out).not.toContain("rough");
        expect(out).not.toContain("reads this as");
        expect(__getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("5", "hola que tal"))!.label).not.toContain("Preview");

        settings.store.sublineCode = "";
        native.translateBatch.mockClear();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("6", "que pasa amigo") });
        await settle();
        expect(calls()).toHaveLength(0);
        expect(clickable(render(msg("6", "que pasa amigo")))?.label).toBe("≈ Translate");
        expect(text(render(msg("4", "ana bghit nmchi l dar daba")))).toContain("≈ rough");
    });
});

// ---------------------------------------------------------------------------
describe("NEW-1: the client counts today's three itself", () => {
    it("counts down 3, 2, 1, 0 even when the relay states a trial-sized cap, and sends no fourth", async () => {
        await restart(() => expiredLocally());
        let served = 0;
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
            if (engine !== "relay") return { ok: true, results: [] };
            served++;
            return {
                ok: true,
                results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "es", text: "different words entirely here", skip: false })),
                quotaUsed: served, quotaCap: 300
            };
        });
        const label = () => __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("x", "hola que tal"))!.label;
        expect(label()).toContain("3 of 3 left today");
        for (const [id, left] of [["1", 2], ["2", 1], ["3", 0]] as const) {
            __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg(id, "hola que tal"))!.onClick!(undefined as any);
            await flush();
            expect(label()).toContain(`${left} of 3 left today`);
        }
        __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("4", "hola que tal"))!.onClick!(undefined as any);
        await flush();
        expect(served).toBe(3);
    });

    it("survives a restart the same UTC day, and resets the next", async () => {
        await restart(() => expiredLocally());
        answer({ relay: m => ({ id: m.id, lang: "es", text: "other words", skip: false }), relayQuota: { used: 1, cap: 300 } });
        __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", "hola que tal"))!.onClick!(undefined as any);
        await flush();
        const start = settings.store.freeTrialStartedAt;
        await restart(() => { settings.store.freeTrialStartedAt = start; });
        expect(__getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("2", "hola que tal"))!.label).toContain("2 of 3 left today");
        vi.setSystemTime(Date.now() + DAY_MS);
        expect(__getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("2", "hola que tal"))!.label).toContain("3 of 3 left today");
    });
});
