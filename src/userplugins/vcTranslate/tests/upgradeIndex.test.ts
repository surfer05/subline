import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adding AI from inside Discord (an Automatic owner), a purchase that lands
 * later, clearing the code, a stranded engine, and the reading-language
 * dropdown's effect on a running session. The activation flow itself (an
 * install that owns nothing) is in planIndex.test.ts.
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
const DAY_MS = 86_400_000;
const WEEK = 7 * DAY_MS;
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
    // An Automatic owner (no AI) with its code saved.
    DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + WEEK });
    settings.store.sublineCode = "slp_auto";
    __stubSetSelectedChannel(CHANNEL);
    await plugin.start!();
    await flush();
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

/** A v2 status answer. */
function v2(fields: { automatic: boolean; ai?: boolean; code?: string }) {
    return {
        ok: true, plan: "", used: 0, cap: 0, automatic: fields.automatic, ai: fields.ai === true,
        tokenExpiresAt: Date.now() + WEEK, ...(fields.code ? { code: fields.code } : {})
    };
}

describe("the Add AI panel", () => {
    it("opens from the settings plan card", () => {
        const el = (settings as any).def.plan.component();
        const card = el.type(el.props ?? {});
        const find = (n: any): any => {
            if (n === null || typeof n !== "object") return null;
            if (Array.isArray(n)) { for (const c of n) { const f = find(c); if (f) return f; } return null; }
            if (typeof n.props?.onClick === "function" && JSON.stringify(n.children) === JSON.stringify(["Add AI"])) return n;
            return find(n.children);
        };
        find(card).props.onClick({ preventDefault() { } });
        expect(openedModals).toHaveLength(1);
        expect(native.openExternal).not.toHaveBeenCalled();
    });

    it("shows both plans, with the annual one's months free", () => {
        openUpgrade();
        const el = openedModals[0]!({ transitionState: 1, onClose: () => { } });
        expect(el.props.title).toBe("Add AI");
        expect(el.props.actions.map((a: any) => a.text)).toEqual(["Monthly $1.99", "Yearly $19.99 · 2 months free"]);
        const body = el.children[0].type({});
        const flat = JSON.stringify(body);
        expect(flat).toContain("$1.99 a month");
        expect(flat).toContain("$19.99 a year");
        expect(flat).toContain("2 months free");
    });

    it("falls back to the pricing page once the plugin is stopped", () => {
        plugin.stop!();
        openUpgrade();
        expect(openedModals).toHaveLength(0);
        expect(native.openExternal).toHaveBeenCalledWith("https://surfer05.github.io/subline/#pricing");
    });
});

describe("buying AI from the panel", () => {
    it("opens the relay's checkout for the chosen plan, under the code and the install id", async () => {
        openUpgrade();
        pressPlan(1);
        await flush();
        const [credential, plan, install] = native.relayCheckout.mock.calls[0]!;
        expect(credential).toBe("slp_auto");
        expect(plan).toBe("annual");
        expect(install).toMatch(/^free_[0-9a-f]{32}$/);
        expect(native.openExternal).toHaveBeenCalledWith(SESSION_URL);
        expect(shownToasts.map(t => t.message)).toContain("Finish checkout in your browser.");
    });

    it("opens the static link, tagged with the install hash, when the relay cannot", async () => {
        native.relayCheckout.mockResolvedValue({ ok: false, error: "relay checkout: HTTP 503 checkout unavailable" });
        openUpgrade();
        pressPlan(0);
        await vi.waitFor(() => expect(native.openExternal).toHaveBeenCalled());
        const url = new URL(native.openExternal.mock.calls[0]![0]);
        expect(url.pathname).toBe("/buy/pdt_0No1xmbcAqHdYAvt1RNPR");
        expect(url.searchParams.get("metadata_install")).toMatch(/^[0-9a-f]{16}$/);
    });

    it("saves the AI key, turns ✦ on and says so once, when the relay links the purchase", async () => {
        openUpgrade();
        pressPlan(0);
        await flush();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await vi.advanceTimersByTimeAsync(25_000);
        await flush();
        expect(native.translateBatch.mock.calls.filter(c => c[0] === "relay")).toHaveLength(0);

        __resetNotices();
        native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: true, code: "LK-AI" }));
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        await flush();
        expect(settings.store.sublineCode).toBe("LK-AI");
        expectOnNotice();

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "que tal amigo") });
        await vi.advanceTimersByTimeAsync(25_000);
        await flush();
        const relay = native.translateBatch.mock.calls.filter(c => c[0] === "relay");
        expect(relay.length).toBeGreaterThan(0);
        expect(relay[0]![1]).toBe("LK-AI");
    });

    it("stops waiting when the plugin stops", async () => {
        openUpgrade();
        pressPlan(0);
        await flush();
        plugin.stop!();
        const n = native.relayStatus.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10 * POLL_EVERY_MS);
        await flush();
        expect(native.relayStatus.mock.calls.length).toBe(n);
        await plugin.start!();   // afterEach stops it again
    });
});

describe("a purchase linked while Discord was closed", () => {
    it("switches on from a later status check, after the one at start failed", async () => {
        await restart(() => DataStore.clearEntitlementForTest());
        expect(settings.store.sublineCode).toBe("slp_auto");
        native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: true, code: "LK-LATE" }));
        await vi.advanceTimersByTimeAsync(5_000);
        await flush();
        expect(settings.store.sublineCode).toBe("LK-LATE");
        expect(shownNotices.filter(n => n.message === ON)).toHaveLength(1);
    });

    it("says it once, however many paths deliver the same purchase", async () => {
        // The install owned nothing when Discord closed; the relay now links
        // a purchase. (An answer that hands back a code with nothing new is
        // no purchase, and says nothing: see planIndex's "losing AI".)
        native.relayStatus.mockResolvedValue(v2({ automatic: true, code: "LK-ONCE" }));
        await restart(() => DataStore.clearEntitlementForTest());
        openUpgrade();
        pressPlan(0);
        await flush();
        await vi.advanceTimersByTimeAsync(3 * POLL_EVERY_MS);
        await flush();
        expect(settings.store.sublineCode).toBe("LK-ONCE");
        expect(shownNotices.filter(n => n.message === ON)).toHaveLength(1);
    });
});

describe("clearing the code in settings", () => {
    it("turns ✦ off at once, and does not bring the cleared code back", async () => {
        native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: true, code: "LK-PAID" }));
        await restart();
        expect(settings.store.sublineCode).toBe("LK-PAID");
        settings.store.sublineCode = "";
        await flush();
        expect(settings.store.engine).toBe("google");
        expect(settings.store.sublineCode).toBe("");
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("9", "hola que tal") });
        await vi.advanceTimersByTimeAsync(25_000);
        await flush();
        expect(native.translateBatch.mock.calls.filter(c => c[0] === "relay")).toHaveLength(0);
    });

    it("translates what is on screen the moment a code is entered", async () => {
        await restart(() => {
            settings.store.sublineCode = "";
            DataStore.clearEntitlementForTest();
        });
        stubMessages.set(CHANNEL, [msg("1", "hola que tal")]);
        await vi.advanceTimersByTimeAsync(25_000);
        await flush();
        expect(native.translateBatch).not.toHaveBeenCalled();   // owns nothing
        native.relayStatus.mockResolvedValue(v2({ automatic: true }));
        settings.store.sublineCode = "LK-PASTED";
        await flush();
        await vi.advanceTimersByTimeAsync(25_000);
        await flush();
        expect(native.translateBatch.mock.calls.length).toBeGreaterThan(0);
    });

    it("keeps polling past a cleared code that is still linked, and saves a new purchase", async () => {
        native.relayStatus.mockResolvedValue(v2({ automatic: true, code: "LK-K1" }));
        await restart(() => { settings.store.sublineCode = ""; });
        expect(settings.store.sublineCode).toBe("LK-K1");
        settings.store.sublineCode = "";
        await flush();
        __resetNotices();
        openUpgrade();
        pressPlan(0);
        await flush();
        await vi.advanceTimersByTimeAsync(3 * POLL_EVERY_MS);
        await flush();
        expect(settings.store.sublineCode).toBe("");
        native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: true, code: "LK-K2" }));
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        await flush();
        expect(settings.store.sublineCode).toBe("LK-K2");
        expectOnNotice();
    });
});

describe("an engine left over from an older build", () => {
    const stranded: [string, Record<string, string>][] = [
        ["relay", {}],
        ["groq", { groqApiKey: "" }],
        ["gemini", { geminiApiKey: "" }],
        ["claude", { anthropicApiKey: "" }]
    ];
    for (const [engine, keys] of stranded) {
        it(`${engine} with no code or key becomes Google at start, with no red toast`, async () => {
            await restart(() => {
                settings.store.sublineCode = "";
                settings.store.engine = engine;
                Object.assign(settings.store, keys);
            });
            expect(settings.store.engine).toBe("google");
            FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("5", "hola que tal amigo") });
            await vi.advanceTimersByTimeAsync(25_000);
            await flush();
            expect(native.translateBatch.mock.calls.some(c => c[0] === "google")).toBe(true);
            expect(shownToasts.filter(t => /no .* set/i.test(String(t.message)))).toHaveLength(0);
        });
    }

    it("a saved code means the relay, whatever the stored engine says", async () => {
        await restart(() => {
            settings.store.sublineCode = "LK-SAVED";
            settings.store.engine = "google";
        });
        expect(settings.store.engine).toBe("relay");
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
