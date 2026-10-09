import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same hoisted native stand-in as index.test.ts: index.tsx reads it at import.
const native = vi.hoisted(() => {
    const translateBatch = vi.fn();
    const readStagedBuildId = vi.fn().mockResolvedValue(null);
    const relayStatus = vi.fn().mockResolvedValue({ ok: false, error: "status unavailable" });
    const relayCheckout = vi.fn();
    const relayRedeem = vi.fn();
    const openExternal = vi.fn();
    (globalThis as any).VencordNative = {
        pluginHelpers: { VcTranslate: { translateBatch, readStagedBuildId, relayStatus, relayCheckout, relayRedeem } },
        native: { openExternal }
    };
    return { translateBatch, readStagedBuildId, relayStatus, relayCheckout, relayRedeem, openExternal };
});

import plugin, { DEAD_CODE_CONFIRM_MS, FORCE_QUALITY_POPOVER_ID, __surfaceService } from "../index";
import { AUTOMATIC_PRODUCT_ID, isConfiguredProduct, POLL_EVERY_MS } from "../checkout";
import { ENTITLEMENT_REFRESH_MS, entitlementLevel, holderFor, __resetEntitlement } from "../entitlement";
import type { NativeResponse } from "../native";
import settings from "../settings";
import { clearStore, getTranslation, makeKey, setTranslation } from "../store";
import { __resetTaste, noteRelayClock, recordTasteQuota, rolloverTasteIfNewUtcDay, tasteExhausted } from "../taste";
import { UPGRADE_COPY } from "../upgradeCopy";
import { WEEK_MS } from "../weeklyNote";
import { OptionType } from "./stubs/utils-types";
import { __resetSettings } from "./stubs/api-settings";
import { __resetNotices, currentNotice, noticesQueue, shownNotices, userDismiss } from "./stubs/api-notices";
import * as DataStore from "./stubs/api-datastore";
import { __getPopoverButton, __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import {
    __resetWebpackCommon, __stubSetSelectedChannel, FluxDispatcher, openedModals, shownToasts, stubMessages
} from "./stubs/webpack-common";

/**
 * THE PAID-ONLY MODEL, end to end through the renderer.
 *
 *   - an install with nothing translates nothing and shows one activation
 *     notice, whose Activate button opens the Activate panel (buy Automatic,
 *     or enter a code);
 *   - Automatic: ≈ Google on every message, and five ✦ previews a day on
 *     rough ≈ lines (a "Preview ✦" link, or ⚡);
 *   - AI: ✦ on everything, as a paid install always had;
 *   - what the install owns comes from the relay's v2 /v1/status, is kept on
 *     disk, and works offline only until the relay's tokenExpiresAt.
 */

const CHANNEL = "c1";
const HOUR = 60 * 60_000;
const key = (id: string) => makeKey(id, "en");
const msg = (id: string, content: string, authorId = "u1") => ({
    id, channel_id: CHANNEL, content, author: { id: authorId, username: "ana" }
});
const ROMANIZED = "ana bghit nmchi l dar daba";

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

/** A v2 /v1/status answer (what native.relayStatus hands the renderer). */
function v2(fields: {
    automatic: boolean; ai?: boolean; code?: string; previews?: { used: number; cap: number };
    tokenExpiresAt?: number; aiUntil?: number;
}) {
    return {
        ok: true, plan: "", used: 0, cap: 0,
        automatic: fields.automatic, ai: fields.ai === true,
        tokenExpiresAt: fields.tokenExpiresAt ?? Date.now() + 7 * 24 * HOUR,
        token: "t.s",
        ...(fields.code !== undefined ? { code: fields.code } : {}),
        ...(fields.previews !== undefined ? { previews: fields.previews } : {}),
        ...(fields.aiUntil !== undefined ? { aiUntil: fields.aiUntil } : {})
    };
}

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
/** Every node in a rendered tree with an onClick, with its label. */
function clickables(node: any, out: { onClick: (e?: any) => void; label: string; props: any }[] = []) {
    if (node === null || typeof node !== "object") return out;
    if (Array.isArray(node)) { for (const c of node) clickables(c, out); return out; }
    if (typeof node.props?.onClick === "function") out.push({ onClick: node.props.onClick, label: text(node), props: node.props });
    clickables(node.children, out);
    return out;
}

/** Render the modal opened last. */
function lastModal() {
    const renderFn = openedModals[openedModals.length - 1]!;
    const onClose = vi.fn();
    const el = renderFn({ transitionState: 1, onClose });
    return { el, onClose };
}

const activationNotices = () => shownNotices.filter(n => n.message === UPGRADE_COPY.activateNotice);
const onNotices = () => shownNotices.filter(n => n.message === UPGRADE_COPY.purchasedNotice);

/** Restart the plugin as a relaunch would, with the given setup in place first. */
async function restart(setup: () => void = () => { }) {
    plugin.stop!();
    clearStore();
    __resetTaste();
    __resetEntitlement();
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
    answer();
    clearStore();
    __resetTaste();
    __resetEntitlement();
    __resetSettings();
    __resetWebpackCommon();
    __resetNotices();
    __resetMessagePopover();
    DataStore.__reset();
    settings.store.globalAuto = true;
    settings.store.targetLang = "en";
    settings.store.engine = "google";
    __stubSetSelectedChannel(CHANNEL);
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

/** Start as an install that owns nothing (nothing stored; the relay says so too). */
async function startNotActivated() {
    DataStore.clearEntitlementForTest();
    native.relayStatus.mockResolvedValue(v2({ automatic: false }));
    await plugin.start!();
    await flush();
}

/** Start as an Automatic owner (stored answer; the relay agrees). */
async function startAutomatic(extra: Parameters<typeof v2>[0] = { automatic: true }) {
    DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
    native.relayStatus.mockResolvedValue(v2(extra));
    await plugin.start!();
    await flush();
}


// ---------------------------------------------------------------------------
// WORST CASES, 2026-10-01. Each test fails on the code before its fix.

describe("an AI code that lapses during a failed renewal", () => {
    const DAY = 24 * HOUR;

    async function lapseAndDrop() {
        DataStore.setEntitlementForTest({ automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * DAY, checkedAt: Date.now() });
        settings.store.sublineCode = "AIKEY";
        settings.store.engine = "relay";
        native.relayStatus.mockResolvedValue({ ...v2({ automatic: true }), deadCode: "AIKEY" });
        await plugin.start!();
        await flush();
        await vi.advanceTimersByTimeAsync(DEAD_CODE_CONFIRM_MS + 61_000);
        await flush();
        expect(settings.store.sublineCode).toBe("");
    }

    it("takes the key back once the renewal goes through, and AI with it", async () => {
        await lapseAndDrop();
        // Renewed: the relay links the key to this install again. Asked with
        // the install id alone it says ai:false; asked with the key, ai:true.
        native.relayStatus.mockImplementation(async (credential: string) =>
            credential === "AIKEY" ? v2({ automatic: true, ai: true, code: "AIKEY" }) : v2({ automatic: true, code: "AIKEY" }));
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        expect(settings.store.sublineCode).toBe("AIKEY");
        // The answer came for the install id; the key itself is presented next.
        expect(native.relayStatus.mock.calls.some(c => c[0] === "AIKEY")).toBe(true);
        expect(entitlementLevel()).toBe("ai");
    });

    it("a settings change after the drop does not mark the key as cleared by the reader", async () => {
        await lapseAndDrop();
        settings.store.globalAuto = false;
        settings.store.globalAuto = true;
        const { notifySettingsChanged } = await import("../settingsBridge");
        notifySettingsChanged();
        expect(settings.store.clearedPurchaseCode).toBe("");
    });
});

describe("the stored answer running out while Discord runs", () => {
    it("asks the relay again at the AI renewal moment, not a day later", async () => {
        await startAutomatic({ automatic: true, ai: true, aiUntil: Date.now() + 60_000 });
        expect(entitlementLevel()).toBe("ai");
        const n = native.relayStatus.mock.calls.length;
        await vi.advanceTimersByTimeAsync(65_000);
        await flush();
        expect(native.relayStatus.mock.calls.length).toBeGreaterThan(n);
    });

    it("asks again just before the offline allowance runs out", async () => {
        await startAutomatic({ automatic: true, tokenExpiresAt: Date.now() + 60_000 });
        const n = native.relayStatus.mock.calls.length;
        await vi.advanceTimersByTimeAsync(65_000);
        await flush();
        expect(native.relayStatus.mock.calls.length).toBeGreaterThan(n);
    });

    it("asks at once after a week asleep, and redraws for the level it finds", async () => {
        await startAutomatic({ automatic: true, tokenExpiresAt: Date.now() + 7 * 24 * HOUR });
        const n = native.relayStatus.mock.calls.length;
        native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
        // The lid closed for 8 days: the wall clock moved, the timers did not.
        vi.setSystemTime(Date.now() + 8 * 24 * HOUR);
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();
        expect(native.relayStatus.mock.calls.length).toBeGreaterThan(n);
        expect(entitlementLevel()).toBe("none");
        expect(activationNotices()).toHaveLength(1);
    });

    it("a far-off renewal asks nothing extra", async () => {
        await startAutomatic({ automatic: true, ai: true, aiUntil: Date.now() + 365 * 24 * HOUR });
        const n = native.relayStatus.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await flush();
        expect(native.relayStatus.mock.calls.length).toBe(n);
    });
});

describe("\"You're on.\" only when the install gained something", () => {
    it("is not shown to a reader who just lost AI", async () => {
        DataStore.setEntitlementForTest({ automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
        settings.store.sublineCode = "AIKEY";
        settings.store.engine = "relay";
        native.relayStatus.mockResolvedValue({ ...v2({ automatic: true, code: "AUTOKEY" }), deadCode: "AIKEY" });
        await plugin.start!();
        await flush();
        await vi.advanceTimersByTimeAsync(DEAD_CODE_CONFIRM_MS + 61_000);
        await flush();
        expect(settings.store.sublineCode).toBe("AUTOKEY");
        expect(entitlementLevel()).toBe("automatic");
        expect(onNotices()).toHaveLength(0);
    });

    it("is still shown when a purchase switches an install on", async () => {
        DataStore.clearEntitlementForTest();
        native.relayStatus.mockResolvedValue(v2({ automatic: true, code: "AUTOKEY" }));
        await plugin.start!();
        await flush();
        expect(onNotices()).toHaveLength(1);
    });
});

describe("Subline's notices never touch anyone else's", () => {
    it("pressing Activate at the 3-computer limit never queues a second copy", async () => {
        DataStore.clearEntitlementForTest();
        native.relayStatus.mockResolvedValue({ ok: false, error: "relay: HTTP 403 device_limit", errorCode: "device_limit" });
        await plugin.start!();
        await flush();
        const { openUpgrade } = await import("../upgradeBridge");
        openUpgrade();
        openUpgrade();
        openUpgrade();
        expect(shownNotices.filter(n => n.message === UPGRADE_COPY.deviceLimit)).toHaveLength(1);
    });

    it("an activation notice the reader closed is not taken down again over the update banner", async () => {
        await startNotActivated();
        expect(activationNotices()).toHaveLength(1);
        userDismiss();
        const { showNotice } = await import("./stubs/api-notices");
        showNotice("Subline updated in the background.", "Restart", () => { });
        native.relayStatus.mockResolvedValue(v2({ automatic: true, code: "AUTOKEY" }));
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        expect(entitlementLevel()).toBe("automatic");
        expect(currentNotice?.[1]).toBe("Subline updated in the background.");
    });

    it("a checking notice queued behind the update banner is taken out of the queue, not the banner off the screen", async () => {
        const { showNotice } = await import("./stubs/api-notices");
        showNotice("Subline updated in the background.", "Restart", () => { });
        DataStore.clearEntitlementForTest();
        settings.store.sublineCode = "slp_saved";
        settings.store.engine = "relay";
        native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
        await plugin.start!();
        await flush();
        expect(noticesQueue.some(e => e[1] === UPGRADE_COPY.checkingNotice)).toBe(true);
        native.relayStatus.mockResolvedValue(v2({ automatic: true }));
        await vi.advanceTimersByTimeAsync(6_000);
        await flush();
        expect(currentNotice?.[1]).toBe("Subline updated in the background.");
        expect(noticesQueue.some(e => e[1] === UPGRADE_COPY.checkingNotice)).toBe(false);
    });
});

describe("a ✦ preview that fails", () => {
    for (const [name, fail] of [
        ["the relay is down", () => native.translateBatch.mockRejectedValue(new Error("network"))],
        ["the relay answers 503", () => native.translateBatch.mockResolvedValue({ ok: false, error: "relay: HTTP 503 temporarily unavailable" })]
    ] as const) {
        it(`is offered again when ${name}, and says so`, async () => {
            await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
            setTranslation(key("1"), { lang: "ar", text: "I want to walk", via: "google", conf: 1 });
            fail();
            const btn = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", ROMANIZED))!;
            expect(btn.label).toBe("Preview ✦ (5 left today)");
            btn.onClick!();
            await flush();
            expect(text(render(msg("1", ROMANIZED)))).toContain("Preview didn't load. Try again.");
            const again = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", ROMANIZED));
            expect(again?.label).toBe("Preview ✦ (5 left today)");
        });
    }

    it("a served preview whose row was skipped is not offered again", async () => {
        await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
        setTranslation(key("1"), { lang: "ar", text: "I want to walk", via: "google", conf: 1 });
        answer({ relay: m => ({ id: m.id, skip: true }) });
        __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", ROMANIZED))!.onClick!();
        await flush();
        expect(__getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", ROMANIZED))).toBeNull();
    });
});

describe("the previews' day is the relay's day", () => {
    it("a local clock an hour fast does not lose the next day's previews", () => {
        const T = Date.UTC(2026, 8, 26, 0, 30);   // local 00:30, relay 23:30 the day before
        noteRelayClock(T - HOUR, T);
        recordTasteQuota(5, 5, T);
        expect(tasteExhausted(T)).toBe(true);
        // Local 01:05 is relay 00:05: the relay's day turned.
        expect(rolloverTasteIfNewUtcDay(T + 35 * 60_000)).toBe(true);
        expect(tasteExhausted(T + 35 * 60_000)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// P1 (field test 2026-10-08): ONE ✦ PREVIEW PER MESSAGE. "Translating…" at
// once, a second press never spends or sends, the FULL ✦ text replaces the ≈
// line with "Add AI" on it, across channel switches and restarts.
describe("one ✦ preview per message", () => {
    const LONG_SRC = ROMANIZED + " " + "w".repeat(10);
    /** A relay answer the test releases by hand. */
    function heldRelay(row: (m: { id: string }) => any = m => ({ id: m.id, lang: "ar", text: "I don't want to go", skip: false })) {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
            const p = JSON.parse(payload);
            if (engine !== "relay") return { ok: true, results: [] };
            await gate;
            return { ok: true, results: p.messages.map(row), quotaUsed: calls("relay").length, quotaCap: 5 };
        });
        return () => release();
    }
    const rough = (id = "1", t = "I want to walk") =>
        setTranslation(key(id), { lang: "ar", text: t, via: "google", conf: 1 });
    const popover = (id = "1", content = ROMANIZED) => __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg(id, content));
    const link = (id = "1", content = ROMANIZED) => clickables(render(msg(id, content))).find(c => c.label === "Preview ✦");

    it("shows translating at once, and a double click (⚡ then the link, then ⚡ again) sends one request", async () => {
        await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
        rough();
        const release = heldRelay();
        const ask = link()!;
        const bolt = popover()!;
        ask.onClick({ preventDefault() { } });
        // Synchronously, before anything was awaited: the pending state shows.
        expect(text(render(msg("1", ROMANIZED)))).toContain("translating…");
        bolt.onClick!();
        ask.onClick({ preventDefault() { } });
        await flush();
        expect(popover()).toBeNull();
        expect(link()).toBeUndefined();
        release();
        await flush();
        expect(calls("relay")).toHaveLength(1);
        expect(payloadOf(calls("relay")[0]!)).toMatchObject({ mode: "preview", force: true });
        expect(popover()?.label ?? null).toBeNull();
        expect(text(render(msg("1", ROMANIZED)))).toBe("✦ ar · I don't want to go · Add AI");
    });

    it("keeps the pending state and the result across a channel switch", async () => {
        await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
        rough();
        const release = heldRelay();
        popover()!.onClick!();
        __stubSetSelectedChannel("c2");
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: "c2" });
        await flush();
        __stubSetSelectedChannel(CHANNEL);
        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await flush();
        expect(text(render(msg("1", ROMANIZED)))).toContain("translating…");
        expect(popover()).toBeNull();
        release();
        await flush();
        expect(text(render(msg("1", ROMANIZED)))).toBe("✦ ar · I don't want to go · Add AI");
        expect(calls("relay")).toHaveLength(1);
    });

    it("a restart shows the same ✦ line and never offers or sends again", async () => {
        await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
        rough();
        answer({ relay: m => ({ id: m.id, lang: "ar", text: "I don't want to go", skip: false }), relayQuota: { used: 1, cap: 5 } });
        popover()!.onClick!();
        await flush();
        await restart(() => {
            DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
            native.relayStatus.mockResolvedValue(v2({ automatic: true, previews: { used: 1, cap: 5 } }));
        });
        rough();
        expect(text(render(msg("1", ROMANIZED)))).toBe("✦ ar · I don't want to go · Add AI");
        expect(popover()).toBeNull();
        expect(link()).toBeUndefined();
        expect(calls("relay")).toHaveLength(1);
        // And the other messages still count from four left.
        rough("2");
        expect(popover("2")!.label).toBe("Preview ✦ (4 left today)");
    });

    it("pressed while the ≈ line is still pending: the ✦ line wins once ≈ lands", async () => {
        await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
        const release = heldRelay();
        popover()!.onClick!();
        expect(text(render(msg("1", ROMANIZED)))).toContain("translating…");
        release();
        await flush();
        rough();
        expect(text(render(msg("1", ROMANIZED)))).toBe("✦ ar · I don't want to go · Add AI");
    });

    for (const [name, fail] of [
        ["times out", () => native.translateBatch.mockResolvedValue({ ok: false, error: "relay: HTTP 429 translation service busy", retryAfterMs: 60_000 })],
        ["answers 500", () => native.translateBatch.mockResolvedValue({ ok: false, error: "relay: HTTP 500 internal" })],
        ["returns a failed row", () => answer({ relay: m => ({ id: m.id, failed: true }), relayQuota: { used: 0, cap: 5 } })]
    ] as const) {
        it(`spends no preview when the relay ${name}, and recovers on the next press`, async () => {
            await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
            rough();
            fail();
            popover()!.onClick!();
            await flush();
            expect(text(render(msg("1", ROMANIZED)))).toContain("Preview didn't load. Try again.");
            expect(popover()!.label).toBe("Preview ✦ (5 left today)");
            answer({ relay: m => ({ id: m.id, lang: "ar", text: "I don't want to go", skip: false }), relayQuota: { used: 1, cap: 5 } });
            popover()!.onClick!();
            await flush();
            expect(text(render(msg("1", ROMANIZED)))).toBe("✦ ar · I don't want to go · Add AI");
        });
    }

    it("a cut preview (an older relay's `truncated` row) is never stored or shown as the full ✦ line", async () => {
        await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
        rough();
        answer({ relay: m => ({ id: m.id, lang: "ar", text: "I don't want", skip: false, truncated: true }), relayQuota: { used: 1, cap: 5 } });
        popover()!.onClick!();
        await flush();
        const shown = text(render(msg("1", ROMANIZED)));
        expect(shown).not.toContain("✦ ar");
        expect(shown).toContain("I want to walk");
        expect(popover()).not.toBeNull();
        expect(link()).toBeDefined();
    });

    it("a preview made in another reading language is not shown, and is offered again; switching back shows it", async () => {
        await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
        rough();
        answer({ relay: m => ({ id: m.id, lang: "ar", text: "I don't want to go", skip: false }), relayQuota: { used: 1, cap: 5 } });
        popover()!.onClick!();
        await flush();
        expect(text(render(msg("1", ROMANIZED)))).toBe("✦ ar · I don't want to go · Add AI");
        settings.store.targetLang = "es";
        try {
            setTranslation(makeKey("1", "es"), { lang: "ar", text: "Quiero caminar", via: "google", conf: 1 });
            const shown = text(render(msg("1", ROMANIZED)));
            expect(shown).not.toContain("I don't want to go");
            expect(shown).toContain("Quiero caminar");
            expect(popover()).not.toBeNull();
        } finally {
            settings.store.targetLang = "en";
        }
        expect(text(render(msg("1", ROMANIZED)))).toBe("✦ ar · I don't want to go · Add AI");
        expect(popover()).toBeNull();
    });

    it("when ✦ reads it the same as ≈, the ✦ line simply replaces ≈", async () => {
        await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
        rough("1", "I want to walk");
        answer({ relay: m => ({ id: m.id, lang: "ar", text: "I want to walk", skip: false }), relayQuota: { used: 1, cap: 5 } });
        popover()!.onClick!();
        await flush();
        const shown = text(render(msg("1", ROMANIZED)));
        expect(shown).toBe("✦ ar · I want to walk · Add AI");
        expect(shown).not.toContain("same way");
    });

    it("shows a very long ✦ line in full, never cut with …", async () => {
        await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
        rough("1", "x");
        const long = Array.from({ length: 300 }, (_, i) => "word" + i).join(" ");
        answer({ relay: m => ({ id: m.id, lang: "ar", text: long, skip: false }), relayQuota: { used: 1, cap: 5 } });
        popover("1", LONG_SRC)!.onClick!();
        await flush();
        const shown = text(render(msg("1", LONG_SRC)));
        expect(shown).toBe(`✦ ar · ${long} · Add AI`);
        expect(shown).not.toContain("…");
    });

    // Owner decision 2026-10-08: an EDITED message gets a new ✦ preview offer.
    // The old ✦ line describes text that is gone, so it is dropped; the edited
    // text costs exactly one preview (the relay counts the same id with
    // different text as a new one), and never a second.
    describe("an edited message", () => {
        const edited = ROMANIZED + " ghda";
        const translated = (m: { id: string; text?: string }) =>
            ({ id: m.id, lang: "ar", text: String(m.text).includes("ghda") ? "I don't want to go tomorrow" : "I don't want to go", skip: false });

        async function previewThenEdit() {
            await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
            rough();
            answer({ relay: translated, relayQuota: { used: 1, cap: 5 } });
            popover()!.onClick!();
            await flush();
            expect(text(render(msg("1", ROMANIZED)))).toBe("✦ ar · I don't want to go · Add AI");
            rough("1", "I want to walk tomorrow");
        }

        it("drops the old ✦ line and offers a preview again (link and ⚡)", async () => {
            await previewThenEdit();
            const shown = text(render(msg("1", edited)));
            expect(shown).toContain("I want to walk tomorrow");
            expect(shown).not.toContain("I don't want to go");
            expect(link("1", edited)).toBeDefined();
            expect(popover("1", edited)!.label).toBe("Preview ✦ (4 left today)");
            // The original text, were it shown again, is still the one preview.
            expect(popover("1", ROMANIZED)).toBeNull();
            expect(calls("relay")).toHaveLength(1);
        });

        it("a preview of the edited text costs exactly one, and shows the edited text's ✦", async () => {
            await previewThenEdit();
            answer({ relay: translated, relayQuota: { used: 2, cap: 5 } });
            popover("1", edited)!.onClick!();
            await flush();
            expect(calls("relay")).toHaveLength(2);
            const sent = payloadOf(calls("relay")[1]!) as any;
            expect(sent).toMatchObject({ mode: "preview", force: true });
            expect(sent.messages.map((m: any) => m.id)).toEqual(["1"]);
            expect(sent.messages[0].text).toContain("ghda");
            expect(text(render(msg("1", edited)))).toBe("✦ ar · I don't want to go tomorrow · Add AI");
            rough("2");
            expect(popover("2")!.label).toBe("Preview ✦ (3 left today)");
        });

        it("a repeat press on the same edited text never sends or charges again, also after a restart", async () => {
            await previewThenEdit();
            answer({ relay: translated, relayQuota: { used: 2, cap: 5 } });
            const ask = link("1", edited)!;
            const bolt = popover("1", edited)!;
            bolt.onClick!();
            ask.onClick({ preventDefault() { } });
            bolt.onClick!();
            await flush();
            ask.onClick({ preventDefault() { } });
            bolt.onClick!();
            await flush();
            expect(calls("relay")).toHaveLength(2);
            expect(popover("1", edited)).toBeNull();
            expect(link("1", edited)).toBeUndefined();
            await restart(() => {
                DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
                native.relayStatus.mockResolvedValue(v2({ automatic: true, previews: { used: 2, cap: 5 } }));
            });
            rough("1", "I want to walk tomorrow");
            expect(text(render(msg("1", edited)))).toBe("✦ ar · I don't want to go tomorrow · Add AI");
            expect(popover("1", edited)).toBeNull();
            expect(link("1", edited)).toBeUndefined();
            expect(calls("relay")).toHaveLength(2);
        });

        it("an edit while the preview is out never shows the old text's ✦ for the new text", async () => {
            await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
            rough();
            const release = heldRelay();
            popover()!.onClick!();
            // Edited before the relay answered.
            rough("1", "I want to walk tomorrow");
            expect(popover("1", edited)).toBeNull();
            release();
            await flush();
            const shown = text(render(msg("1", edited)));
            expect(shown).toContain("I want to walk tomorrow");
            expect(shown).not.toContain("I don't want to go");
            // That answer was for the old text: the new text is offered.
            expect(popover("1", edited)).not.toBeNull();
            expect(link("1", edited)).toBeDefined();
            expect(calls("relay")).toHaveLength(1);
        });
    });

    it("with none left, a stale Preview ✦ link opens Add AI and sends nothing", async () => {
        await startAutomatic({ automatic: true, previews: { used: 4, cap: 5 } });
        rough("1"); rough("2");
        const stale = link("2")!;
        answer({ relay: m => ({ id: m.id, lang: "ar", text: "I don't want to go", skip: false }), relayQuota: { used: 5, cap: 5 } });
        popover("1")!.onClick!();
        await flush();
        expect(popover("2")!.label).toBe("Add AI ✦");
        const before = openedModals.length;
        stale.onClick({ preventDefault() { } });
        await flush();
        expect(calls("relay")).toHaveLength(1);
        expect(openedModals.length).toBe(before + 1);
        expect(lastModal().el.props.title).toBe("Add AI");
    });

    it("an AI subscriber's ✦ lines carry no Add AI, even for a message once previewed", async () => {
        await startAutomatic({ automatic: true, previews: { used: 0, cap: 5 } });
        rough();
        answer({ relay: m => ({ id: m.id, lang: "ar", text: "I don't want to go", skip: false }), relayQuota: { used: 1, cap: 5 } });
        popover()!.onClick!();
        await flush();
        await restart(() => {
            DataStore.setEntitlementForTest({ automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
            native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: true, code: "slp_ai" }));
        });
        setTranslation(key("1"), { lang: "ar", text: "I really don't want to go", via: "relay" });
        rough("2");
        expect(text(render(msg("1", ROMANIZED)))).toBe("✦ ar · I really don't want to go");
        expect(text(render(msg("2", ROMANIZED)))).not.toContain("Add AI");
    });
});
