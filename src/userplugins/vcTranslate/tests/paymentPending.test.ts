import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same hoisted native stand-in as planIndex.test.ts: index.tsx reads it at import.
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

import plugin, { FORCE_QUALITY_POPOVER_ID } from "../index";
import { PENDING_SHOWN_FOR_MS, POLL_EVERY_MS } from "../checkout";
import { __resetEntitlement, ENTITLEMENT_REFRESH_MS, setEntitlement } from "../entitlement";
import type { NativeResponse } from "../native";
import settings, { PlanCard } from "../settings";
import { clearStore, makeKey, setTranslation } from "../store";
import { __resetTaste } from "../taste";
import { isPaymentPending, openUpgrade } from "../upgradeBridge";
import { __resetSettings } from "./stubs/api-settings";
import { __resetNotices } from "./stubs/api-notices";
import * as DataStore from "./stubs/api-datastore";
import { __getPopoverButton, __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import {
    __resetWebpackCommon, __stubSetSelectedChannel, closedModals, openedModals, shownToasts
} from "./stubs/webpack-common";

/**
 * P4: while a payment is on its way, every place that sells says "Payment
 * being confirmed" and offers no second purchase. P5: when AI (or Automatic)
 * switches on, a panel selling it closes.
 */

const CHANNEL = "c1";
const HOUR = 60 * 60_000;
const ROMANIZED = "ana bghit nmchi l dar daba";
const SESSION = "https://checkout.dodopayments.com/session/cks_1";
const PENDING = "Payment being confirmed";
const msg = (id: string, content: string) => ({ id, channel_id: CHANNEL, content, author: { id: "u1", username: "ana" } });

async function flush() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

function v2(fields: { automatic: boolean; ai?: boolean; code?: string; previews?: { used: number; cap: number }; }) {
    return {
        ok: true, plan: "", used: 0, cap: 0,
        automatic: fields.automatic, ai: fields.ai === true,
        tokenExpiresAt: Date.now() + 7 * 24 * HOUR, token: "t.s",
        ...(fields.code !== undefined ? { code: fields.code } : {}),
        ...(fields.previews !== undefined ? { previews: fields.previews } : {})
    };
}

const text = (node: any): string => {
    if (node === null || node === undefined || node === false) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    return text(node.children);
};
function clickables(node: any, out: { label: string }[] = []) {
    if (node === null || typeof node !== "object") return out;
    if (Array.isArray(node)) { for (const c of node) clickables(c, out); return out; }
    if (typeof node.props?.onClick === "function") out.push({ label: text(node) });
    clickables(node.children, out);
    return out;
}
const render = (message: unknown) => {
    const el: any = plugin.renderMessageAccessory!({ message } as any);
    return el.type(el.props);
};
const card = () => PlanCard() as any;
const cardLinks = () => clickables(card()).map(c => c.label);

/** Render the modal opened last, as Discord would. */
function lastModal() {
    const renderFn = openedModals[openedModals.length - 1]!;
    return renderFn({ transitionState: 1, onClose: vi.fn() });
}

async function startAs(level: "none" | "automatic", previews = { used: 0, cap: 5 }) {
    if (level === "none") {
        DataStore.clearEntitlementForTest();
        native.relayStatus.mockResolvedValue(v2({ automatic: false }));
    } else {
        DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
        native.relayStatus.mockResolvedValue(v2({ automatic: true, code: "slp_auto", previews }));
    }
    await plugin.start!();
    await flush();
}

/** Press a plan in the Add AI panel (0 monthly, 1 annual). */
async function buyAi(plan = 0) {
    openUpgrade();
    lastModal().props.actions[plan].onClick();
    await flush();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 25, 12, 0, 0)));
    for (const f of Object.values(native)) f.mockReset();
    native.readStagedBuildId.mockResolvedValue(null);
    native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
    native.relayCheckout.mockResolvedValue({ ok: true, url: SESSION });
    native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string): Promise<NativeResponse> => ({
        ok: true,
        results: JSON.parse(payload).messages.map((m: { id: string }) => engine === "google"
            ? { id: m.id, lang: "ar", text: "I want to walk", skip: false, conf: 0.4 }
            : { id: m.id, lang: "ar", text: "I want to go home now", skip: false })
    }));
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

describe("P4: a checkout was opened", () => {
    it("the plan card, ⚡ and the panel say \"Payment being confirmed\" and sell nothing, until AI lands", async () => {
        await startAs("automatic");
        expect(cardLinks()).toContain("Add AI");

        await buyAi();
        expect(native.openExternal).toHaveBeenCalledWith(SESSION);
        expect(isPaymentPending()).toBe(true);

        // Plan card: plain words, no Add AI link.
        expect(text(card())).toContain(PENDING);
        expect(cardLinks()).not.toContain("Add AI");

        // The panel: "Payment being confirmed" with one OK, and no plan to buy.
        const opened = openedModals.length;
        openUpgrade();
        expect(openedModals.length).toBe(opened + 1);
        const panel = lastModal();
        expect(panel.props.title).toBe(PENDING);
        expect(panel.props.subtitle).toBe("Your payment is still being confirmed. It switches on by itself.");
        expect(panel.props.actions.map((a: any) => a.text)).toEqual(["OK"]);
        expect(native.relayCheckout).toHaveBeenCalledTimes(1);

        // AI lands: the poll sees it, the pending panel closes, Add AI is gone for good.
        native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: true, code: "LK-AI" }));
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        await flush();
        expect(isPaymentPending()).toBe(false);
        expect(closedModals).toContain(`modal-${opened + 1}`);
        expect(text(card())).not.toContain(PENDING);
        expect(cardLinks()).not.toContain("Add AI");
    });

    it("⚡ with today's previews used offers no Add AI while paying, and its press says what happens next", async () => {
        await startAs("automatic", { used: 5, cap: 5 });
        setTranslation(makeKey("1", "en"), { lang: "ar", text: "I want to walk", via: "google", conf: 1 });
        const before = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", ROMANIZED) as any)!;
        expect(before.label).toBe("Add AI ✦");

        await buyAi();
        const during = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", ROMANIZED) as any)!;
        expect(during.label).toBe(PENDING);
        during.onClick!();
        expect(lastModal().props.title).toBe(PENDING);
        expect(native.relayCheckout).toHaveBeenCalledTimes(1);
    });

    it("the ✦ preview line shows the words, not the Add AI link, while paying", async () => {
        await startAs("automatic");
        setTranslation(makeKey("1", "en"), { lang: "ar", text: "I want to walk", via: "google", conf: 0.4 });
        __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", ROMANIZED) as any)!.onClick!();
        await flush();
        expect(clickables(render(msg("1", ROMANIZED))).map(c => c.label)).toContain("Add AI");

        await buyAi();
        const line = render(msg("1", ROMANIZED));
        expect(text(line)).toContain("I want to go home now");
        expect(text(line)).toContain(PENDING);
        expect(clickables(line).map(c => c.label)).not.toContain("Add AI");
    });

    it("an install with nothing: Activate becomes the words while Automatic is paid for; Enter a code stays", async () => {
        await startAs("none");
        expect(cardLinks()).toEqual(["Activate", "Enter a code"]);
        openUpgrade();
        lastModal().props.actions[1].onClick(); // Buy for $4.99
        await flush();
        expect(native.relayCheckout.mock.calls[0]![1]).toBe("automatic");
        expect(text(card())).toContain(PENDING);
        expect(cardLinks()).toEqual(["Enter a code"]);
    });

    it("stops after PENDING_SHOWN_FOR_MS, so an abandoned checkout does not hide Add AI for two days", async () => {
        await startAs("automatic");
        await buyAi();
        expect(isPaymentPending()).toBe(true);
        await vi.advanceTimersByTimeAsync(PENDING_SHOWN_FOR_MS);
        await flush();
        expect(isPaymentPending()).toBe(false);
        expect(cardLinks()).toContain("Add AI");
    });
});

describe("P4: the relay says purchase_pending", () => {
    it("opens nothing, and shows \"Payment being confirmed\" in place of Add AI", async () => {
        await startAs("automatic");
        native.relayCheckout.mockResolvedValue({ ok: false, error: "relay checkout: HTTP 409 purchase_pending", errorCode: "purchase_pending", status: 409 });
        await buyAi(1);
        expect(native.openExternal).not.toHaveBeenCalled();
        expect(shownToasts.map(t => t.message)).toContain("Your payment is still being confirmed. It switches on by itself.");
        expect(isPaymentPending()).toBe(true);
        expect(cardLinks()).not.toContain("Add AI");
        openUpgrade();
        expect(lastModal().props.title).toBe(PENDING);
    });
});

describe("P5: what was being sold switched on", () => {
    it("an open Add AI panel closes when AI switches on, whichever way it arrived", async () => {
        await startAs("automatic");
        openUpgrade();
        const key = `modal-${openedModals.length}`;
        expect(closedModals).not.toContain(key);
        // A status refresh (not the checkout poll) brings AI.
        native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: true, code: "LK-AI" }));
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        expect(closedModals).toContain(key);
        // And nothing offers Add AI any more.
        expect(cardLinks()).not.toContain("Add AI");
        const before = openedModals.length;
        openUpgrade();
        expect(openedModals.length).toBe(before);
    });

    it("an open Activate panel closes once the install is activated", async () => {
        await startAs("none");
        openUpgrade();
        const key = `modal-${openedModals.length}`;
        setEntitlement({ automatic: true, ai: false, tokenExpiresAt: Date.now() + HOUR, checkedAt: Date.now() });
        expect(closedModals).toContain(key);
    });

    it("an Add AI panel left open closes when a payment starts elsewhere", async () => {
        await startAs("automatic");
        openUpgrade();
        const first = `modal-${openedModals.length}`;
        // A second panel's press starts the checkout; the first panel is still open.
        await buyAi();
        expect(closedModals).toContain(first);
    });

    it("a panel the reader closed with its own button is not closed again", async () => {
        await startAs("automatic");
        native.relayCheckout.mockResolvedValue({ ok: false, error: "relay checkout: HTTP 409", errorCode: "already_owned", status: 409 });
        await buyAi();
        setEntitlement({ automatic: true, ai: true, tokenExpiresAt: Date.now() + HOUR, checkedAt: Date.now() });
        expect(closedModals).toEqual([]);
    });
});
