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
import { __resetTaste } from "../taste";
import { UPGRADE_COPY } from "../upgradeCopy";
import { WEEK_MS } from "../weeklyNote";
import { OptionType } from "./stubs/utils-types";
import { __resetSettings } from "./stubs/api-settings";
import { __resetNotices, shownNotices } from "./stubs/api-notices";
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
describe("an install that owns nothing", () => {
    it("translates nothing, live or on channel open, and draws nothing", async () => {
        stubMessages.set(CHANNEL, [msg("0", "hola que tal amigo")]);
        await startNotActivated();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls()).toHaveLength(0);
        setTranslation(key("2"), { lang: "es", text: "hello", via: "google" });
        expect(render(msg("2", "hola"))).toBeNull();
        expect(__getPopoverButton(FORCE_QUALITY_POPOVER_ID)?.render(msg("2", "hola"))).toBeNull();
    });

    it("sends no surface requests", async () => {
        await startNotActivated();
        expect(__surfaceService()?.want("Hier wird geplaudert")).toBeNull();
        await settle();
        expect(calls()).toHaveLength(0);
    });

    it("shows the activation notice once, with an Activate button that opens the Activate panel", async () => {
        await startNotActivated();
        expect(activationNotices()).toHaveLength(1);
        expect(activationNotices()[0]!.buttonText).toBe("Activate");
        // Later answers saying the same do not raise it again.
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        expect(activationNotices()).toHaveLength(1);

        activationNotices()[0]!.onOkClick();
        const { el } = lastModal();
        expect(el.props.title).toBe("Activate Subline");
        expect(el.props.actions.map((a: any) => a.text)).toEqual(["Enter a code", "Buy for $4.99"]);
        expect(text(el.children[0].type({}))).toContain("$4.99 once");
    });

    it("shows the notice when the relay cannot be reached and nothing is stored", async () => {
        DataStore.clearEntitlementForTest();
        await plugin.start!();
        await flush();
        expect(activationNotices()).toHaveLength(1);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls()).toHaveLength(0);
    });

    it("buys Automatic: the relay's checkout, polling, then the saved code switches everything on", async () => {
        native.relayCheckout.mockResolvedValue({ ok: true, url: "https://checkout.dodopayments.com/session/cks_1" });
        await startNotActivated();
        activationNotices()[0]!.onOkClick();
        lastModal().el.props.actions[1].onClick();
        await flush();

        const [credential, plan, install] = native.relayCheckout.mock.calls[0]!;
        expect(plan).toBe("automatic");
        expect(install).toMatch(/^free_[0-9a-f]{32}$/);
        expect(credential).toBe(install);
        expect(native.openExternal).toHaveBeenCalledWith("https://checkout.dodopayments.com/session/cks_1");

        native.relayStatus.mockResolvedValue(v2({ automatic: true, code: "slp_bought" }));
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        await flush();
        expect(settings.store.sublineCode).toBe("slp_bought");
        expect(onNotices()).toHaveLength(1);

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls("google")).toHaveLength(1);
        // Automatic is not AI: no ✦ batch goes to the relay.
        expect(calls("relay")).toHaveLength(0);
    });

    it("opens nothing and says buying isn't available when the relay answers checkout unavailable", async () => {
        native.relayCheckout.mockResolvedValue({
            ok: false, error: "relay checkout: HTTP 503", errorCode: "checkout_unavailable", status: 503
        });
        await startNotActivated();
        activationNotices()[0]!.onOkClick();
        lastModal().el.props.actions[1].onClick();
        await vi.waitFor(() => expect(shownToasts.map(t => t.message))
            .toContain("Buying isn't available yet. Use a code, or try again later."));
        expect(native.openExternal).not.toHaveBeenCalled();
    });

    it("with the relay unreachable, opens the static Automatic link only once the product is set up", async () => {
        native.relayCheckout.mockResolvedValue({ ok: false, error: "fetch failed" });
        await startNotActivated();
        activationNotices()[0]!.onOkClick();
        lastModal().el.props.actions[1].onClick();
        await vi.waitFor(() => expect(native.openExternal.mock.calls.length + shownToasts.length).toBeGreaterThan(0));
        if (isConfiguredProduct(AUTOMATIC_PRODUCT_ID)) {
            // The install hash is a real SHA-256 (crypto.subtle), not a microtask.
            await vi.waitFor(() => expect(native.openExternal).toHaveBeenCalled());
            const url = new URL(native.openExternal.mock.calls[0]![0]);
            expect(url.pathname).toBe(`/buy/${AUTOMATIC_PRODUCT_ID}`);
            expect(url.searchParams.get("metadata_install")).toMatch(/^[0-9a-f]{16}$/);
        } else {
            expect(native.openExternal).not.toHaveBeenCalled();
            expect(shownToasts.map(t => t.message)).toContain("Buying isn't available yet. Use a code, or try again later.");
        }
    });
});

// ---------------------------------------------------------------------------
describe("what the install owns, from the relay", () => {
    it("asks with the install id, and with the saved code once there is one", async () => {
        await startNotActivated();
        const [credential, install] = native.relayStatus.mock.calls[0]!;
        expect(install).toMatch(/^free_[0-9a-f]{32}$/);
        expect(credential).toBe(install);

        await restart(() => { settings.store.sublineCode = "slp_mine"; });
        const last = native.relayStatus.mock.calls[native.relayStatus.mock.calls.length - 1]!;
        expect(last[0]).toBe("slp_mine");
        expect(last[1]).toBe(install);
    });

    it("an Automatic answer turns on ≈ for every message, and no ✦", async () => {
        await startNotActivated();
        native.relayStatus.mockResolvedValue(v2({ automatic: true, code: "slp_promo" }));
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        // The activation notice was taken down (popped), the purchase one is up.
        expect(shownNotices.map(n => n.message)).toEqual([UPGRADE_COPY.purchasedNotice]);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls("google")).toHaveLength(1);
        expect(calls("relay")).toHaveLength(0);
    });

    it("an AI answer with a code adds ✦ on everything, under the code and the install", async () => {
        await startAutomatic({ automatic: true, ai: true });
        settings.store.sublineCode = "slp_ai";
        await flush();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        const relay = calls("relay");
        expect(relay).toHaveLength(1);
        expect(relay[0]![1]).toBe("slp_ai");
        expect(relay[0]![5]).toMatch(/^free_[0-9a-f]{32}$/);
    });

    it("keeps working offline until tokenExpiresAt, then stops and asks to activate", async () => {
        DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 2 * HOUR, checkedAt: Date.now() });
        await plugin.start!();
        await flush();
        expect(activationNotices()).toHaveLength(0);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls("google")).toHaveLength(1);

        vi.setSystemTime(Date.now() + 3 * HOUR);
        await restart();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "que tal amigo") });
        await settle();
        expect(calls("google")).toHaveLength(1);
        expect(activationNotices()).toHaveLength(1);
    });

    it("asks again every 24 hours", async () => {
        await startAutomatic();
        const n = native.relayStatus.mock.calls.length;
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        expect(native.relayStatus.mock.calls.length).toBe(n + 1);
    });

    it("a 4th computer is refused: nothing translates, and the notice says why", async () => {
        DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
        native.relayStatus.mockResolvedValue({ ok: false, error: "relay: HTTP 403 device_limit", errorCode: "device_limit" });
        await plugin.start!();
        await flush();
        expect(shownNotices.map(n => n.message))
            .toContain("This code is on 3 computers already. It frees up after 30 days unused, or ask for a reset on GitHub.");
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls()).toHaveLength(0);
    });

    it("at the 3-computer limit the notice links to GitHub, and Activate never opens the buy panel", async () => {
        DataStore.clearEntitlementForTest();
        native.relayStatus.mockResolvedValue({ ok: false, error: "relay: HTTP 403 device_limit", errorCode: "device_limit" });
        await plugin.start!();
        await flush();
        const limit = shownNotices.find(n => n.message === UPGRADE_COPY.deviceLimit)!;
        expect(limit.buttonText).toBe("GitHub");
        limit.onOkClick();
        expect(native.openExternal).toHaveBeenCalledWith("https://github.com/surfer05/subline/issues");
        expect(activationNotices()).toHaveLength(0);
        // Any Activate link now repeats the limit instead of selling Automatic.
        const modals = openedModals.length;
        const { openUpgrade } = await import("../upgradeBridge");
        openUpgrade();
        expect(openedModals.length).toBe(modals);
        expect(shownToasts.map(t => t.message)).toContain(UPGRADE_COPY.deviceLimit);
    });

    it("an older relay's answer (no plan fields) changes nothing", async () => {
        DataStore.clearEntitlementForTest();
        native.relayStatus.mockResolvedValue({ ok: true, plan: "taste", used: 0, cap: 3 });
        await plugin.start!();
        await flush();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls()).toHaveLength(0);
    });

    it("saves a code the relay linked at start (a purchase landed while Discord was closed)", async () => {
        DataStore.clearEntitlementForTest();
        native.relayStatus.mockResolvedValue(v2({ automatic: true, code: "LK-LANDED" }));
        await plugin.start!();
        await flush();
        expect(settings.store.sublineCode).toBe("LK-LANDED");
        expect(onNotices()).toHaveLength(1);
    });

    it("does not save back a code the reader cleared", async () => {
        await startAutomatic({ automatic: true, code: "LK-OLD" });
        expect(settings.store.sublineCode).toBe("LK-OLD");
        settings.store.sublineCode = "";
        await flush();
        expect(settings.store.clearedPurchaseCode).toBe("LK-OLD");
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        expect(settings.store.sublineCode).toBe("");
    });
});

// ---------------------------------------------------------------------------
describe("entering a code", () => {
    async function enter(typed: string) {
        await flush();
        activationNotices()[0]!.onOkClick();
        lastModal().el.props.actions[0].onClick();   // Enter a code
        const { el, onClose } = lastModal();
        expect(el.props.title).toBe("Enter a code");
        const input = el.children.flat().find((c: any) => c?.type === "input");
        input.props.onChange({ target: { value: typed } });
        el.props.actions[0].onClick();
        await flush();
        return { onClose };
    }
    const failures = () => shownToasts.filter(t => t.type === "FAILURE").map(t => t.message);

    it("redeems a server's promo code for this install and switches on", async () => {
        await startNotActivated();
        native.relayRedeem.mockResolvedValue({ ok: true, code: "slp_promo1" });
        native.relayStatus.mockResolvedValue(v2({ automatic: true }));
        const { onClose } = await enter("  subline5 ");
        const [install, promo] = native.relayRedeem.mock.calls[0]!;
        expect(install).toMatch(/^free_[0-9a-f]{32}$/);
        expect(promo).toBe("SUBLINE5");
        expect(settings.store.sublineCode).toBe("slp_promo1");
        expect(onClose).toHaveBeenCalled();
        expect(onNotices()).toHaveLength(1);
        expect(failures()).toEqual([]);
    });

    const cases: [string, string][] = [
        ["claimed", "This code has been fully claimed."],
        ["not_found", "That code doesn't exist."],
        ["already", "Already yours."],
        ["unavailable", "Can't reach Subline right now. Try again in a minute."]
    ];
    for (const [errorCode, copy] of cases) {
        it(`says "${copy}" for a ${errorCode} refusal, and keeps the field open`, async () => {
            await startNotActivated();
            native.relayRedeem.mockResolvedValue({ ok: false, error: "relay redeem: HTTP 4xx", errorCode });
            const { onClose } = await enter("SERVER1");
            expect(failures()).toEqual([copy]);
            expect(onClose).not.toHaveBeenCalled();
            expect(settings.store.sublineCode).toBe("");
        });
    }

    it("says the relay cannot be reached when the redeem call itself fails", async () => {
        await startNotActivated();
        native.relayRedeem.mockRejectedValue(new Error("ipc"));
        await enter("SERVER1");
        expect(failures()).toEqual(["Can't reach Subline right now. Try again in a minute."]);
    });

    it("checks a typed key without linking it, asks, and only links it once confirmed", async () => {
        await startNotActivated();
        native.relayStatus.mockResolvedValue({ ...v2({ automatic: true }), check: { valid: true, automatic: true, ai: false } });
        const asked = native.relayStatus.mock.calls.length;
        const { onClose } = await enter("abcd-1234-efgh-5678");
        // One check-only call, with x-subline-check, and nothing saved yet.
        expect(native.relayStatus.mock.calls.length).toBe(asked + 1);
        const check = native.relayStatus.mock.calls[asked]!;
        expect(check[0]).toBe("abcd-1234-efgh-5678");
        expect(check[2]).toEqual({ check: true });
        expect(settings.store.sublineCode).toBe("");
        expect(onClose).toHaveBeenCalled();
        const confirm = lastModal();
        expect(confirm.el.props.title).toBe("Use this code?");
        expect(confirm.el.props.subtitle).toBe("It works on up to 3 computers.");
        expect(confirm.el.props.actions[0].text).toBe("Use it");
        confirm.el.props.actions[0].onClick();
        await flush();
        // Then the normal, linking status call (no check header).
        const link = native.relayStatus.mock.calls[asked + 1]!;
        expect(link[0]).toBe("abcd-1234-efgh-5678");
        expect(link[2]).toBeUndefined();
        expect(native.relayRedeem).not.toHaveBeenCalled();
        expect(settings.store.sublineCode).toBe("abcd-1234-efgh-5678");
        expect(confirm.onClose).toHaveBeenCalled();
        expect(onNotices()).toHaveLength(1);
    });

    it("a checked code that gives nothing is refused before anything is linked", async () => {
        await startNotActivated();
        native.relayStatus.mockResolvedValue({ ...v2({ automatic: false }), check: { valid: false, automatic: false, ai: false } });
        const modals = openedModals.length;
        await enter("abcd-1234-efgh-5678");
        expect(failures()).toEqual(["That code doesn't exist."]);
        expect(openedModals.length).toBe(modals + 2);   // the Activate panel and the code entry, no confirm
        expect(settings.store.sublineCode).toBe("");
    });

    it("says a key does not exist, or is on 3 computers already, and saves nothing", async () => {
        await startNotActivated();
        // A dead or unknown code: the check answers 200 with deadCode and a failed check.
        native.relayStatus.mockResolvedValue({ ...v2({ automatic: false }), deadCode: "abcd-1234-efgh-5678", check: { valid: false, automatic: false, ai: false } });
        await enter("abcd-1234-efgh-5678");
        native.relayStatus.mockResolvedValue({ ok: false, error: "relay: HTTP 403 device_limit", errorCode: "device_limit" });
        lastModal().el.props.actions[0].onClick();
        await flush();
        expect(failures()).toEqual([
            "That code doesn't exist.",
            "This code is on 3 computers already. It frees up after 30 days unused, or ask for a reset on GitHub."
        ]);
        expect(settings.store.sublineCode).toBe("");
    });

    it("asks for a code when the field is empty, and sends nothing", async () => {
        await startNotActivated();
        await enter("   ");
        expect(failures()).toEqual(["Type or paste a code first."]);
        expect(native.relayRedeem).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
describe("an Automatic owner", () => {
    it("labels a rough ≈ line and offers a ✦ preview, which goes to the relay in preview mode", async () => {
        await startAutomatic({ automatic: true, previews: { used: 0, cap: 3 } });
        answer({
            google: { lang: "ar", text: "I want to walk the house now", conf: 1 },
            relay: m => ({ id: m.id, lang: "ar", text: "I don't want to go", skip: false, truncated: true }),
            relayQuota: { used: 1, cap: 3 }
        });
        setTranslation(key("1"), { lang: "ar", text: "I want to walk the house now", via: "google", conf: 1 });
        const node = render(msg("1", ROMANIZED));
        expect(text(node)).toContain("≈ rough ar");
        const ask = clickables(node).find(c => c.label === "Preview ✦")!;
        expect(ask).toBeDefined();
        ask.onClick();
        await flush();

        const relay = calls("relay");
        expect(relay).toHaveLength(1);
        expect(payloadOf(relay[0]!).mode).toBe("preview");
        expect(relay[0]![5]).toMatch(/^free_[0-9a-f]{32}$/);
        const after = render(msg("1", ROMANIZED));
        expect(text(after)).toContain("✦ reads this as: I don't want to go… Add AI");
        expect(clickables(after).some(c => c.label === "Preview ✦")).toBe(false);
        // The preview is never stored as a translation.
        expect(getTranslation(key("1"))).toMatchObject({ via: "google" });
        // Its link opens the Add AI panel.
        clickables(after).find(c => c.label === "Add AI")!.onClick({ preventDefault() { } });
        expect(lastModal().el.props.title).toBe("Add AI");
    });

    it("offers no preview on a confident line", async () => {
        await startAutomatic();
        setTranslation(key("1"), { lang: "es", text: "hello there", via: "google", conf: 0.99 });
        const node = render(msg("1", "hola"));
        expect(text(node)).not.toContain("rough");
        expect(clickables(node).some(c => c.label === "Preview ✦")).toBe(false);
    });

    it("gets five a day: ⚡ counts down, and offers Add AI once they are used", async () => {
        await startAutomatic({ automatic: true, previews: { used: 3, cap: 5 } });
        setTranslation(key("1"), { lang: "ar", text: "I want to walk", via: "google", conf: 1 });
        const btn = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", ROMANIZED))!;
        expect(btn.label).toBe("Preview ✦ (2 left today)");

        native.relayStatus.mockResolvedValue(v2({ automatic: true, previews: { used: 5, cap: 5 } }));
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        const used = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", ROMANIZED))!;
        expect(used.label).toBe("Add AI ✦");
        expect(clickables(render(msg("1", ROMANIZED))).some(c => c.label === "Preview ✦")).toBe(false);
        used.onClick();
        expect(lastModal().el.props.title).toBe("Add AI");
    });

    it("buys AI from the Add AI panel, and a refusal opens no checkout", async () => {
        await startAutomatic({ automatic: true, code: "slp_auto" });
        native.relayCheckout.mockResolvedValue({ ok: false, error: "relay checkout: HTTP 403 automatic_required", errorCode: "automatic_required" });
        const { openUpgrade } = await import("../upgradeBridge");
        openUpgrade();
        const { el } = lastModal();
        expect(el.props.actions.map((a: any) => a.text)).toEqual(["Monthly $1.99", "Yearly $19.99 · Save 16%"]);
        el.props.actions[1].onClick();
        await flush();
        expect(native.relayCheckout.mock.calls[0]![1]).toBe("annual");
        expect(native.openExternal).not.toHaveBeenCalled();
        expect(shownToasts.map(t => t.message)).toContain("AI needs Automatic first.");
    });

    it("says under the AI plans that a coupon goes on the Monthly payment page", async () => {
        const { UpgradePanelBody } = await import("../upgradePanel");
        const text = (n: any): string => typeof n === "string" ? n
            : Array.isArray(n) ? n.map(text).join(" ")
            : n && typeof n === "object" && "children" in n ? text(n.children) : "";
        const body = text(UpgradePanelBody());
        expect(body).toContain("Have a coupon? Pick Monthly and enter it on the payment page.");
        // After the plans, not before them.
        expect(body.indexOf("Have a coupon?")).toBeGreaterThan(body.indexOf("$19.99 a year"));
    });

    it("stops polling an AI checkout once the relay says AI, and says so once", async () => {
        await startAutomatic({ automatic: true, code: "slp_auto" });
        __resetNotices();
        native.relayCheckout.mockResolvedValue({ ok: true, url: "https://checkout.dodopayments.com/session/cks_ai" });
        const { openUpgrade } = await import("../upgradeBridge");
        openUpgrade();
        lastModal().el.props.actions[0].onClick();
        await flush();
        native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: true, code: "LK-AI" }));
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        await flush();
        expect(settings.store.sublineCode).toBe("LK-AI");
        expect(onNotices()).toHaveLength(1);
        const n = native.relayStatus.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10 * POLL_EVERY_MS);
        await flush();
        expect(native.relayStatus.mock.calls.length).toBe(n);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls("relay").length).toBeGreaterThan(0);
    });

    it("has no Upgrade panel to open once it has AI", async () => {
        await startAutomatic({ automatic: true, ai: true });
        const { openUpgrade } = await import("../upgradeBridge");
        openUpgrade();
        expect(openedModals).toHaveLength(0);
    });

    it("gets the weekly note like any install", async () => {
        await startAutomatic();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        vi.setSystemTime(Date.now() + WEEK_MS);
        await restart(() => DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * 24 * HOUR }));
        expect(shownToasts.filter(t => t.message === "This week: 1 message in 1 language.")).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
describe("the relay refuses ✦ on what the install owns", () => {
    it("asks again instead of pinning to Google or raising a red toast", async () => {
        await startAutomatic({ automatic: true, ai: true });
        settings.store.sublineCode = "slp_ai";
        await flush();
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "relay"
                ? { ok: false, error: "relay: HTTP 402 ai_required", errorCode: "ai_required" }
                : { ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "es", text: "hi", skip: false })) });
        native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: false }));
        const n = native.relayStatus.mock.calls.length;
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(native.relayStatus.mock.calls.length).toBeGreaterThan(n);
        expect(shownToasts.filter(t => t.type === "FAILURE")).toHaveLength(0);
        // AI lapsed: the next message is Google only.
        const relayBefore = calls("relay").length;
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "que tal amigo") });
        await settle();
        expect(calls("relay").length).toBe(relayBefore);
    });
});

// ---------------------------------------------------------------------------
// The Windows test round: a machine that had Subline before, a promo code,
// the ✦ previews, then AI bought on top of it.
describe("the Windows test round", () => {
    const OLD_ID = "a".repeat(32);
    const NEW_ID = "b".repeat(32);

    it("a reinstall with a new install id does not reuse what the old one owned, even offline", async () => {
        // Discord keeps the plugin's store across an uninstall; the installer
        // seeds a fresh install id and no code.
        DataStore.setEntitlementForTest({
            automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now(),
            holder: holderFor("LK-OLD", OLD_ID)
        });
        await DataStore.set("VcTranslate_installId", OLD_ID);
        settings.store.installId = NEW_ID;
        native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
        await plugin.start!();
        await flush();
        expect(native.relayStatus.mock.calls[0]![1]).toBe(`free_${NEW_ID}`);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls()).toHaveLength(0);
        expect(activationNotices()).toHaveLength(1);
    });

    it("clearing the code drops at once to what the relay says for the install alone", async () => {
        await startAutomatic({ automatic: true, ai: true, code: "LK-OLD" });
        expect(settings.store.sublineCode).toBe("LK-OLD");
        // The relay is down when the code is cleared: the stored answer was about
        // the code, so nothing is translated with it any more.
        native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
        settings.store.sublineCode = "";
        await flush();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls()).toHaveLength(0);
        // The relay answers for the install alone, still linking the old code:
        // the code is not saved back, and the install owns only what it says.
        native.relayStatus.mockResolvedValue(v2({ automatic: false, code: "LK-OLD" }));
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();
        expect(settings.store.sublineCode).toBe("");
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("2", "que tal amigo") });
        await settle();
        expect(calls()).toHaveLength(0);
    });

    it("after a promo code: ≈ on every message, and the settings card says Automatic with the code and Copy", async () => {
        await startNotActivated();
        native.relayRedeem.mockResolvedValue({ ok: true, code: "slp_promo1" });
        native.relayStatus.mockResolvedValue(v2({ automatic: true, previews: { used: 0, cap: 5 } }));
        activationNotices()[0]!.onOkClick();
        lastModal().el.props.actions[0].onClick();
        const { el } = lastModal();
        const input = el.children.flat().find((c: any) => c?.type === "input");
        input.props.onChange({ target: { value: "myserver" } });
        el.props.actions[0].onClick();
        await flush();
        expect(settings.store.sublineCode).toBe("slp_promo1");

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls("google")).toHaveLength(1);
        expect(calls("relay")).toHaveLength(0);

        const cardEl = (settings as any).def.plan.component();
        const card = cardEl.type(cardEl.props ?? {});
        expect(text(card)).toContain("Plan: Automatic.");
        expect(text(card)).toContain("slp_promo1");
        expect(clickables(card).some(c => c.label === "Copy")).toBe(true);
    });

    it("AI bought on top of a saved Automatic code switches on when the relay says ai, with no new code", async () => {
        await startAutomatic({ automatic: true, code: "slp_auto" });
        __resetNotices();
        native.relayCheckout.mockResolvedValue({ ok: true, url: "https://checkout.dodopayments.com/session/cks_ai" });
        const { openUpgrade } = await import("../upgradeBridge");
        openUpgrade();
        lastModal().el.props.actions[0].onClick();   // Monthly $1.99
        await flush();
        const [credential, plan, install] = native.relayCheckout.mock.calls[0]!;
        expect(credential).toBe("slp_auto");
        expect(plan).toBe("monthly");
        expect(install).toMatch(/^free_[0-9a-f]{32}$/);
        expect(native.openExternal).toHaveBeenCalledWith("https://checkout.dodopayments.com/session/cks_ai");

        // Pending at the bank for a while: still Automatic.
        await vi.advanceTimersByTimeAsync(3 * POLL_EVERY_MS);
        await flush();
        expect(onNotices()).toHaveLength(0);
        // The relay joins the AI purchase to the account; with a code as the
        // credential it returns no code of its own.
        native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: true }));
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        await flush();
        expect(settings.store.sublineCode).toBe("slp_auto");
        expect(onNotices()).toHaveLength(1);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        const relay = calls("relay");
        expect(relay.length).toBeGreaterThan(0);
        expect(relay[0]![1]).toBe("slp_auto");
        // One notice, however often the relay says so again.
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        expect(onNotices()).toHaveLength(1);
    });

    it("keeps ≈ working while the relay is briefly unreachable, and asks again", async () => {
        DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
        native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
        await plugin.start!();
        await flush();
        const asked = native.relayStatus.mock.calls.length;
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls("google")).toHaveLength(1);
        expect(activationNotices()).toHaveLength(0);
        native.relayStatus.mockResolvedValue(v2({ automatic: true }));
        await vi.advanceTimersByTimeAsync(20_000);
        await flush();
        expect(native.relayStatus.mock.calls.length).toBeGreaterThan(asked);
    });

    it("an older build's stored AI answer (no holder) keeps a grandfathered Mac on AI, even offline", async () => {
        DataStore.setEntitlementForTest({ automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
        settings.store.sublineCode = "slp_mac";
        native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
        await plugin.start!();
        await flush();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal") });
        await settle();
        expect(calls("relay").length).toBeGreaterThan(0);
        expect(calls("relay")[0]![1]).toBe("slp_mac");
    });
});

// ---------------------------------------------------------------------------
describe("the audit round", () => {
    const DAY = 24 * HOUR;
    const lastStatusCall = () => native.relayStatus.mock.calls[native.relayStatus.mock.calls.length - 1]!;

    it("a dead code is dropped (not marked as cleared by the reader), and the Automatic code the relay hands back is saved", async () => {
        DataStore.setEntitlementForTest({ automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * DAY, checkedAt: Date.now() });
        settings.store.sublineCode = "LK-AI-GONE";
        settings.store.engine = "relay";
        native.relayStatus.mockResolvedValue({ ...v2({ automatic: true, code: "slp_auto9" }), deadCode: "LK-AI-GONE" });
        await plugin.start!();
        await flush();
        // One dead answer is not enough (a relay storage lag): the code stays.
        expect(settings.store.sublineCode).toBe("LK-AI-GONE");
        await vi.advanceTimersByTimeAsync(DEAD_CODE_CONFIRM_MS + 1_000);
        await flush();
        expect(settings.store.sublineCode).toBe("slp_auto9");
        // The relay dropped it, not the reader: a renewal can bring it back.
        expect(settings.store.clearedPurchaseCode).toBe("");
        // Automatic survives the AI lapse: ≈ on every message, no ✦.
        native.relayStatus.mockResolvedValue(v2({ automatic: true }));
        answer();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal amigo") });
        await settle();
        expect(calls("google")).toHaveLength(1);
        expect(calls("relay")).toHaveLength(0);
        expect(activationNotices()).toHaveLength(0);
    });

    it("one dead answer never drops a good code: a relay storage lag passes", async () => {
        DataStore.setEntitlementForTest({ automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * DAY, checkedAt: Date.now() });
        settings.store.sublineCode = "LK-NEW";
        settings.store.engine = "relay";
        native.relayStatus.mockResolvedValue({ ...v2({ automatic: true, code: "slp_other" }), deadCode: "LK-NEW" });
        await plugin.start!();
        await flush();
        expect(settings.store.sublineCode).toBe("LK-NEW");
        expect(settings.store.clearedPurchaseCode).toBe("");
        // The relay catches up before the hour is out: the re-check finds the
        // code live, and the earlier "dead" is forgotten.
        native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: true }));
        await vi.advanceTimersByTimeAsync(DEAD_CODE_CONFIRM_MS + 1_000);
        await flush();
        expect(settings.store.sublineCode).toBe("LK-NEW");
        expect(settings.store.deadCodeSeen).toEqual({ code: "", at: 0 });
    });

    it("a dead code with nothing handed back is dropped, and the relay is asked again with the install id", async () => {
        DataStore.setEntitlementForTest({ automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * DAY, checkedAt: Date.now() });
        settings.store.sublineCode = "LK-AI-GONE";
        settings.store.engine = "relay";
        native.relayStatus.mockResolvedValue({ ...v2({ automatic: true }), deadCode: "LK-AI-GONE" });
        await plugin.start!();
        await flush();
        expect(settings.store.sublineCode).toBe("LK-AI-GONE");
        await vi.advanceTimersByTimeAsync(DEAD_CODE_CONFIRM_MS + 1_000);
        await flush();
        expect(settings.store.sublineCode).toBe("");
        expect(settings.store.clearedPurchaseCode).toBe("");
        const [credential, install] = lastStatusCall();
        expect(credential).toMatch(/^free_[0-9a-f]{32}$/);
        expect(credential).toBe(install);
        // WAS: "the dead code never comes back". The relay never offers a
        // dead code, so one it offers again is live again (the renewal went
        // through after a declined card), and it is taken back.
        native.relayStatus.mockResolvedValue(v2({ automatic: true, code: "LK-AI-GONE" }));
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        expect(settings.store.sublineCode).toBe("LK-AI-GONE");
    });

    it("a ✦ refusal does not ask the relay again while a dead answer is unconfirmed: the hourly re-check owns it", async () => {
        DataStore.setEntitlementForTest({ automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * DAY, checkedAt: Date.now() });
        settings.store.sublineCode = "LK-LAG";
        settings.store.engine = "relay";
        native.relayStatus.mockResolvedValue({ ...v2({ automatic: true }), deadCode: "LK-LAG" });
        await plugin.start!();
        await flush();
        expect(settings.store.deadCodeSeen).toMatchObject({ code: "LK-LAG" });
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) =>
            engine === "relay"
                ? { ok: false, error: "relay: HTTP 402 ai_required", errorCode: "ai_required" }
                : { ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "es", text: "hi", skip: false })) });
        const n = native.relayStatus.mock.calls.length;
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal amigo") });
        await vi.advanceTimersByTimeAsync(25_000);
        await flush();
        expect(calls("relay").length).toBeGreaterThan(0);
        expect(native.relayStatus.mock.calls.length).toBe(n);
        // The hourly re-check still runs, and settles it.
        await vi.advanceTimersByTimeAsync(DEAD_CODE_CONFIRM_MS + 1_000);
        await flush();
        expect(native.relayStatus.mock.calls.length).toBeGreaterThan(n);
        expect(settings.store.sublineCode).toBe("");
        expect(settings.store.clearedPurchaseCode).toBe("");
    });

    it("a saved code the relay no longer knows keeps its plan on the first strike, then is dropped and the install id alone is asked (Automatic stays)", async () => {
        DataStore.setEntitlementForTest({ automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * DAY, checkedAt: Date.now() });
        settings.store.sublineCode = "LK-REFUNDED";
        settings.store.engine = "relay";
        // The relay answers 200 for the dead code: nothing owned through it.
        native.relayStatus.mockImplementation(async (credential: string) => credential === "LK-REFUNDED"
            ? { ...v2({ automatic: false }), deadCode: "LK-REFUNDED" }
            : v2({ automatic: true }));
        await plugin.start!();
        await flush();
        expect(settings.store.sublineCode).toBe("LK-REFUNDED");
        // First strike: the plan stored for the code is kept, AI included.
        expect(entitlementLevel()).toBe("ai");
        expect(activationNotices()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(DEAD_CODE_CONFIRM_MS + 1_000);
        await flush();
        expect(settings.store.sublineCode).toBe("");
        expect(settings.store.clearedPurchaseCode).toBe("");
        expect(lastStatusCall()[0]).toMatch(/^free_[0-9a-f]{32}$/);
        expect(activationNotices()).toHaveLength(0);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal amigo") });
        await settle();
        expect(calls("google")).toHaveLength(1);
    });

    it("keeps saying the install was used before 0.2.0 while the relay says automatic:false, and stops once it says true", async () => {
        settings.store.freeTrialStartedAt = Date.now() - 30 * DAY;
        await startNotActivated();
        expect(native.relayStatus.mock.calls[0]![2]).toEqual({ prior: true });
        // Still automatic:false: the next status call carries the hint again.
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        expect(lastStatusCall()[2]).toEqual({ prior: true });
        // Automatic now: the hint stops for good.
        native.relayStatus.mockResolvedValue(v2({ automatic: true }));
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        expect(lastStatusCall()[2]).toBeUndefined();
    });

    it("declares the local trial start as a hidden setting", () => {
        const def = (settings as any).def.freeTrialStartedAt;
        expect(def).toBeDefined();
        expect(def.type).toBe(OptionType.CUSTOM);
        expect(def.default).toBe(0);
    });

    it("an early user whose relay cannot be reached sees the early-user check, not the buy prompt, for up to a day", async () => {
        settings.store.freeTrialStartedAt = Date.now() - 30 * DAY;
        DataStore.clearEntitlementForTest();
        native.relayStatus.mockResolvedValue({ ok: false, error: "fetch failed" });
        await plugin.start!();
        await flush();
        const early = () => shownNotices.filter(n => n.message === "Checking your early-user access. This can take a minute.");
        expect(early()).toHaveLength(1);
        expect(early()[0]!.buttonText).toBe("OK");
        expect(activationNotices()).toHaveLength(0);
        // Hours of failed retries: still the check, never the buy prompt.
        await vi.advanceTimersByTimeAsync(20 * HOUR);
        await flush();
        expect(early()).toHaveLength(1);
        expect(activationNotices()).toHaveLength(0);
        // Past a day of retries: the activation notice.
        await vi.advanceTimersByTimeAsync(5 * HOUR);
        await flush();
        expect(activationNotices()).toHaveLength(1);
    });

    it("an early user the relay answers automatic:false to, with the hint sent, gets the activation notice", async () => {
        settings.store.freeTrialStartedAt = Date.now() - 30 * DAY;
        await startNotActivated();
        expect(native.relayStatus.mock.calls[0]![2]).toEqual({ prior: true });
        expect(shownNotices.filter(n => n.message === UPGRADE_COPY.earlyCheckingNotice)).toHaveLength(0);
        expect(activationNotices()).toHaveLength(1);
        // A later outage does not bring the early-user check back.
        native.relayStatus.mockResolvedValue({ ok: false, error: "fetch failed" });
        await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_MS);
        await flush();
        expect(shownNotices.filter(n => n.message === UPGRADE_COPY.earlyCheckingNotice)).toHaveLength(0);
    });

    it("an early user checked while offline gets Automatic once the relay answers", async () => {
        settings.store.freeTrialStartedAt = Date.now() - 30 * DAY;
        DataStore.clearEntitlementForTest();
        native.relayStatus.mockResolvedValue({ ok: false, error: "fetch failed" });
        await plugin.start!();
        await flush();
        native.relayStatus.mockResolvedValue({ ...v2({ automatic: true, code: "slp_early2" }), grant: "early" });
        await vi.advanceTimersByTimeAsync(5_000);
        await flush();
        expect(settings.store.sublineCode).toBe("slp_early2");
        expect(shownNotices.map(n => n.message)).toContain(UPGRADE_COPY.earlyNotice);
        expect(activationNotices()).toHaveLength(0);
    });

    it("says so too for an install id that was here before the installer seeded one", async () => {
        await DataStore.set("VcTranslate_installId", "a".repeat(32));
        await startNotActivated();
        expect(native.relayStatus.mock.calls[0]![1]).toBe("free_" + "a".repeat(32));
        expect(native.relayStatus.mock.calls[0]![2]).toEqual({ prior: true });
    });

    it("a fresh install sends no prior-use hint", async () => {
        await startNotActivated();
        expect(native.relayStatus.mock.calls[0]![2]).toBeUndefined();
    });

    it("an early user is thanked instead of told they bought something", async () => {
        DataStore.clearEntitlementForTest();
        native.relayStatus.mockResolvedValue({ ...v2({ automatic: true, code: "slp_early1" }), grant: "early" });
        await plugin.start!();
        await flush();
        expect(settings.store.sublineCode).toBe("slp_early1");
        const messages = shownNotices.map(n => n.message);
        expect(messages).toContain("Thanks for being early. Automatic is yours, free.");
        expect(messages).not.toContain(UPGRADE_COPY.purchasedNotice);
    });

    it("a saved code the relay cannot check yet shows the checking notice, never Activate, and keeps retrying", async () => {
        DataStore.clearEntitlementForTest();
        settings.store.sublineCode = "LK-SAVED";
        settings.store.engine = "relay";
        native.relayStatus.mockResolvedValue({ ok: false, error: "fetch failed" });
        await plugin.start!();
        await flush();
        const checking = () => shownNotices.filter(n => n.message === "Can't reach Subline to check your code. Retrying.");
        expect(checking()).toHaveLength(1);
        expect(checking()[0]!.buttonText).toBe("OK");
        expect(activationNotices()).toHaveLength(0);
        const asked = native.relayStatus.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);
        await flush();
        expect(native.relayStatus.mock.calls.length).toBe(asked + 1);
        expect(checking()).toHaveLength(1);   // not shown twice
        expect(activationNotices()).toHaveLength(0);
        // The relay answers: the notice comes down and translation starts.
        native.relayStatus.mockResolvedValue(v2({ automatic: true, ai: true }));
        await vi.advanceTimersByTimeAsync(15_000);
        await flush();
        expect(checking()).toHaveLength(0);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("1", "hola que tal amigo") });
        await settle();
        expect(calls("google")).toHaveLength(1);
    });

    for (const [clockName, localOffset] of [["fast", DAY], ["slow", -DAY]] as const) {
        it(`a ${clockName} local clock: the offline limit is 7 days of real time, measured on the local clock`, async () => {
            const serverNow = Date.now();
            vi.setSystemTime(serverNow + localOffset);
            DataStore.clearEntitlementForTest();
            native.relayStatus.mockResolvedValue({ ...v2({ automatic: true, tokenExpiresAt: serverNow + 7 * DAY }), serverNow });
            await plugin.start!();
            await flush();
            const { getEntitlement } = await import("../entitlement");
            expect(getEntitlement()!.tokenExpiresAt).toBe(Date.now() + 7 * DAY);
        });
    }

    it("a promo code that is already yours asks the relay what this install owns", async () => {
        await startNotActivated();
        native.relayRedeem.mockResolvedValue({ ok: false, error: "relay redeem: HTTP 409", errorCode: "already" });
        const asked = native.relayStatus.mock.calls.length;
        activationNotices()[0]!.onOkClick();
        lastModal().el.props.actions[0].onClick();
        const { el } = lastModal();
        el.children.flat().find((c: any) => c?.type === "input").props.onChange({ target: { value: "SERVER1" } });
        el.props.actions[0].onClick();
        await flush();
        expect(native.relayStatus.mock.calls.length).toBe(asked + 1);
    });

    it("buying Automatic again (409 already owned) asks the relay again", async () => {
        await startNotActivated();
        native.relayCheckout.mockResolvedValue({ ok: false, error: "relay checkout: HTTP 409", errorCode: "already_owned", status: 409 });
        const asked = native.relayStatus.mock.calls.length;
        activationNotices()[0]!.onOkClick();
        lastModal().el.props.actions[1].onClick();
        await vi.waitFor(() => expect(native.relayStatus.mock.calls.length).toBe(asked + 1));
        expect(native.openExternal).not.toHaveBeenCalled();
    });
});
