import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Buying from inside Discord, end to end through the renderer, and the
 * reading-language dropdown's effect on a running session.
 */
const native = vi.hoisted(() => {
    const translateBatch = vi.fn();
    const readStagedBuildId = vi.fn().mockResolvedValue(null);
    const relayStatus = vi.fn().mockResolvedValue({ ok: false, error: "status unavailable" });
    const relayCheckout = vi.fn();
    const openExternal = vi.fn();
    (globalThis as any).VencordNative = {
        pluginHelpers: { VcTranslate: { translateBatch, readStagedBuildId, relayStatus, relayCheckout } },
        native: { openExternal }
    };
    return { translateBatch, readStagedBuildId, relayStatus, relayCheckout, openExternal };
});

import plugin from "../index";
import { POLL_EVERY_MS } from "../checkout";
import { DAY_MS, TRIAL_MS } from "../freePlan";
import settings from "../settings";
import { clearStore, getTranslation, makeKey, setTranslation } from "../store";
import { __resetTaste } from "../taste";
import { openUpgrade } from "../upgradeBridge";
import * as DataStore from "./stubs/api-datastore";
import { __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import { __resetNotices, shownNotices } from "./stubs/api-notices";
import { __resetSettings } from "./stubs/api-settings";
import {
    __resetWebpackCommon, __stubSetSelectedChannel, FluxDispatcher, openedModals, shownToasts, stubMessages
} from "./stubs/webpack-common";

const CHANNEL = "c1";
const SESSION_URL = "https://checkout.dodopayments.com/session/cks_1";
const msg = (id: string, content: string) => ({ id, channel_id: CHANNEL, content, author: { id: "u1", username: "ana" } });

async function flush() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

function answerAll() {
    native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
        const p = JSON.parse(payload);
        return {
            ok: true,
            results: p.messages.map((m: { id: string }) => ({ id: m.id, lang: "es", text: `${engine} ${p.targetLang} ${m.id}`, skip: false }))
        };
    });
}

/** Render the panel that was opened last and press one of its plan buttons. */
function pressPlan(index: 0 | 1) {
    const render = openedModals[openedModals.length - 1]!;
    const onClose = vi.fn();
    const el = render({ transitionState: 1, onClose });
    el.props.actions[index].onClick();
    expect(onClose).toHaveBeenCalled();
    return el;
}

const ON = "You're on. Every message translates by itself now.";
/** Exactly one "You're on." notice, which stays until dismissed; no toast. */
function expectOnNotice() {
    const on = shownNotices.filter(n => n.message === ON);
    expect(on).toHaveLength(1);
    expect(on[0]!.buttonText).toBe("OK");
    expect(shownToasts.map(t => t.message)).not.toContain(ON);
}

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
    for (const f of Object.values(native)) f.mockReset();
    native.readStagedBuildId.mockResolvedValue(null);
    native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
    native.relayCheckout.mockResolvedValue({ ok: true, url: SESSION_URL });
    answerAll();
    clearStore();
    __resetTaste();
    __resetSettings();
    __resetWebpackCommon();
    __resetNotices();
    __resetMessagePopover();
    DataStore.__reset();
    settings.store.globalAuto = true;
    settings.store.targetLang = "en";
    settings.store.engine = "google";
    // A free install whose trial ended yesterday: click to translate.
    settings.store.freeTrialStartedAt = Date.now() - TRIAL_MS - DAY_MS;
    __stubSetSelectedChannel(CHANNEL);
    await plugin.start!();
    await flush();
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

describe("the Upgrade panel", () => {
    it("opens from the free-plan settings line", () => {
        const def: any = (settings as any).def.freePlanStatus;
        const link = def.component().children[2];
        link.props.onClick({ preventDefault() { } });
        expect(openedModals).toHaveLength(1);
        expect(native.openExternal).not.toHaveBeenCalled();
    });

    it("shows both plans, with the annual one's months free", () => {
        openUpgrade();
        const el = openedModals[0]!({ transitionState: 1, onClose() { } });
        expect(el.props.title).toBe("Upgrade Subline");
        expect(el.props.actions.map((a: any) => a.text)).toEqual(["Monthly $2.49", "Annual $19.99"]);
        const body = el.children[0];
        const bodyTree = JSON.stringify(body.type(body.props));
        expect(bodyTree).toContain("$2.49 a month");
        expect(bodyTree).toContain("$19.99 a year");
        expect(bodyTree).toContain("4 months free");
    });

    it("is not offered to a paid install", async () => {
        await restart(() => { settings.store.sublineCode = "LK-PAID"; });
        openUpgrade();
        expect(openedModals).toHaveLength(0);
        expect(native.openExternal).not.toHaveBeenCalled();
    });

    it("falls back to the pricing page once the plugin is stopped", () => {
        plugin.stop!();
        openUpgrade();
        expect(openedModals).toHaveLength(0);
        expect(native.openExternal).toHaveBeenCalledWith("https://surfer05.github.io/subline/#pricing");
    });
});

describe("buying from the panel", () => {
    it("opens the relay's checkout for the chosen plan, under the install id", async () => {
        openUpgrade();
        pressPlan(1);
        await flush();
        expect(native.relayCheckout).toHaveBeenCalledTimes(1);
        expect(native.relayCheckout.mock.calls[0][0]).toMatch(/^free_[0-9a-f]{32}$/);
        expect(native.relayCheckout.mock.calls[0][1]).toBe("annual");
        expect(native.openExternal).toHaveBeenCalledWith(SESSION_URL);
        expect(shownToasts.map(t => t.message)).toContain("Finish checkout in your browser.");
    });

    it("opens the static link, tagged with the install hash, when the relay cannot", async () => {
        native.relayCheckout.mockResolvedValue({ ok: false, error: "relay checkout: HTTP 503 checkout unavailable" });
        openUpgrade();
        pressPlan(0);
        // The hash comes from crypto.subtle, which settles off the microtask queue.
        await vi.waitFor(() => expect(native.openExternal).toHaveBeenCalled());
        const url = new URL(native.openExternal.mock.calls[0][0]);
        expect(url.pathname).toBe("/buy/pdt_0No1xmbcAqHdYAvt1RNPR");
        expect(url.searchParams.get("metadata_install")).toMatch(/^[0-9a-f]{16}$/);
        expect(url.searchParams.get("redirect_url")).toBe("https://surfer05.github.io/subline/?from=discord");
    });

    it("saves the key, switches to the relay and translates automatically once the purchase is linked", async () => {
        openUpgrade();
        pressPlan(0);
        await flush();
        const bearer = native.relayCheckout.mock.calls[0][0];

        // Nothing is translated automatically before the purchase (click mode).
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(native.translateBatch).not.toHaveBeenCalled();

        native.relayStatus.mockResolvedValue({
            ok: true, plan: "taste", used: 0, cap: 3, purchase: { code: "LK-BOUGHT", plan: "monthly" }
        });
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        await flush();
        expect(native.relayStatus).toHaveBeenCalledWith(bearer);
        expect(settings.store.sublineCode).toBe("LK-BOUGHT");
        expect(settings.store.engine).toBe("relay");
        expectOnNotice();

        // The running session is paid now: a new message goes out on its own,
        // and the ✦ tier uses the saved key.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "que pasa amigo") });
        await vi.advanceTimersByTimeAsync(25_000);
        await flush();
        const relay = native.translateBatch.mock.calls.filter(c => c[0] === "relay");
        expect(relay.length).toBeGreaterThan(0);
        expect(relay[0][1]).toBe("LK-BOUGHT");
    });

    it("stops waiting when the plugin stops", async () => {
        openUpgrade();
        pressPlan(0);
        await flush();
        const asked = native.relayStatus.mock.calls.length;
        plugin.stop!();
        await vi.advanceTimersByTimeAsync(10 * POLL_EVERY_MS);
        expect(native.relayStatus.mock.calls.length).toBe(asked);
        await plugin.start!();
    });
});

describe("a purchase linked while Discord was closed", () => {
    const linked = { ok: true, plan: "taste", used: 0, cap: 3, purchase: { code: "LK-LATE", plan: "annual" } };

    it("switches on at start when the normal status reply carries it", async () => {
        await restart(() => {
            settings.store.sublineCode = "";
            native.relayStatus.mockResolvedValue(linked);
        });
        expect(native.relayCheckout).not.toHaveBeenCalled();
        expect(settings.store.sublineCode).toBe("LK-LATE");
        expect(settings.store.engine).toBe("relay");
        expectOnNotice();
    });

    it("does nothing when the reply has no purchase", async () => {
        await restart(() => {
            settings.store.sublineCode = "";
            native.relayStatus.mockResolvedValue({ ok: true, plan: "taste", used: 0, cap: 3 });
        });
        expect(settings.store.sublineCode).toBe("");
        expect(settings.store.engine).toBe("google");
    });

    it("switches on from a later status check, after the one at start failed", async () => {
        await restart(() => {
            settings.store.sublineCode = "";
            native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
        });
        expect(settings.store.sublineCode).toBe("");
        native.relayStatus.mockResolvedValue(linked);
        await vi.advanceTimersByTimeAsync(5_000);
        await flush();
        expect(settings.store.sublineCode).toBe("LK-LATE");
        expectOnNotice();
    });

    it("says it once, however many paths deliver the same purchase", async () => {
        openUpgrade();
        pressPlan(0);
        await flush();
        native.relayStatus.mockResolvedValue(linked);
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        await flush();
        // A second delivery (the retry, a restart) finds the code already saved.
        await restart();
        expect(settings.store.sublineCode).toBe("LK-LATE");
        expect(shownNotices.filter(n => n.message === ON)).toHaveLength(1);
    });

    it("never replaces the code of an install that already has one", async () => {
        await restart(() => {
            settings.store.sublineCode = "LK-MINE";
            settings.store.engine = "relay";
            native.relayStatus.mockResolvedValue(linked);
        });
        expect(settings.store.sublineCode).toBe("LK-MINE");
    });
});

describe("clearing the code in settings", () => {
    it("turns the running session free at once, and does not bring the cleared code back", async () => {
        await restart(() => {
            settings.store.sublineCode = "LK-PAID";
            settings.store.engine = "relay";
        });
        // The relay still links that purchase to this install (it keeps the link for 30 days).
        native.relayStatus.mockResolvedValue({ ok: true, plan: "taste", used: 0, cap: 3, purchase: { code: "LK-PAID", plan: "monthly" } });
        const asked = native.relayStatus.mock.calls.length;
        settings.store.sublineCode = "";
        await flush();
        expect(settings.store.engine).toBe("google");
        // The free plan is asked again straight away...
        expect(native.relayStatus.mock.calls.length).toBeGreaterThan(asked);
        // ...and its answer does not re-save the code the reader just cleared.
        expect(settings.store.sublineCode).toBe("");
        // Click mode now: a new message is not translated automatically.
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("9", "hola que tal") });
        await vi.advanceTimersByTimeAsync(25_000);
        expect(native.translateBatch.mock.calls.filter(c => c[0] === "relay")).toHaveLength(0);
    });

    it("asks the relay again after a purchase made this session is cleared", async () => {
        openUpgrade();
        pressPlan(0);
        await flush();
        native.relayStatus.mockResolvedValue({ ok: true, plan: "taste", used: 0, cap: 3, purchase: { code: "LK-THIS", plan: "monthly" } });
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        await flush();
        expect(settings.store.sublineCode).toBe("LK-THIS");
        native.relayStatus.mockResolvedValue({ ok: true, plan: "taste", used: 1, cap: 3 });
        const asked = native.relayStatus.mock.calls.length;
        settings.store.sublineCode = "";
        await flush();
        expect(native.relayStatus.mock.calls.length).toBe(asked + 1);
        expect(settings.store.sublineCode).toBe("");
    });

    it("translates what is on screen the moment a code is pasted", async () => {
        stubMessages.set(CHANNEL, [msg("1", "hola que tal")]);
        await vi.advanceTimersByTimeAsync(25_000);
        await flush();
        expect(native.translateBatch).not.toHaveBeenCalled();   // click mode
        settings.store.sublineCode = "LK-PASTED";
        await flush();
        await vi.advanceTimersByTimeAsync(25_000);
        await flush();
        expect(native.translateBatch.mock.calls.length).toBeGreaterThan(0);
    });

    it("still saves a different purchase later", async () => {
        await restart(() => {
            settings.store.sublineCode = "LK-OLD";
            settings.store.engine = "relay";
        });
        settings.store.sublineCode = "";
        await flush();
        native.relayStatus.mockResolvedValue({ ok: true, plan: "taste", used: 0, cap: 3, purchase: { code: "LK-NEW", plan: "annual" } });
        await restart();
        expect(settings.store.sublineCode).toBe("LK-NEW");
    });
});

describe("changing the reading language", () => {
    it("drops what was cached in the old language and translates into the new one", async () => {
        await restart(() => { settings.store.sublineCode = "LK-PAID"; });
        setTranslation(makeKey("1", "en"), { lang: "es", text: "hi", via: "google" });
        setTranslation(makeKey("9", "de"), { lang: "es", text: "hallo", via: "google" });
        stubMessages.set(CHANNEL, [msg("1", "hola que tal")]);

        settings.store.targetLang = "fr";
        await flush();
        await vi.advanceTimersByTimeAsync(25_000);
        await flush();

        expect(getTranslation(makeKey("1", "en"))).toBeUndefined();
        expect(getTranslation(makeKey("9", "de"))).toBeDefined();
        const google = native.translateBatch.mock.calls.filter(c => c[0] === "google");
        expect(google.length).toBeGreaterThan(0);
        expect(JSON.parse(google[0][2]).targetLang).toBe("fr");
        expect(getTranslation(makeKey("1", "fr"))).toBeDefined();
    });

    it("turns an old free-text value into a code at start", async () => {
        await restart(() => {
            settings.store.sublineCode = "LK-PAID";
            settings.store.targetLang = "pt-BR";
            setTranslation(makeKey("1", "pt-BR"), { lang: "es", text: "oi", via: "google" });
        });
        expect(settings.store.targetLang).toBe("pt");
        expect(getTranslation(makeKey("1", "pt-BR"))).toBeUndefined();
    });

    it("leaves a value it cannot map alone", async () => {
        await restart(() => {
            settings.store.sublineCode = "LK-PAID";
            settings.store.targetLang = "Klingon";
        });
        expect(settings.store.targetLang).toBe("Klingon");
    });
});
