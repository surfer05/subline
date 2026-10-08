import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must exist before index.tsx's module body runs (see index.test.ts).
const native = vi.hoisted(() => {
    const translateBatch = vi.fn();
    const readStagedBuildId = vi.fn().mockResolvedValue(null);
    const relayStatus = vi.fn().mockResolvedValue({ ok: false, error: "status unavailable" });
    (globalThis as any).VencordNative = {
        pluginHelpers: { VcTranslate: { translateBatch, readStagedBuildId, relayStatus } }
    };
    return { translateBatch, readStagedBuildId, relayStatus };
});

import plugin, { FORCE_QUALITY_POPOVER_ID, SURFACE_ACCESSORY_ID } from "../index";
import { entitlementLevel } from "../entitlement";
import type { NativeResponse } from "../native";
import settings from "../settings";
import { clearStore, getTranslation, makeKey, setTranslation } from "../store";
import { __resetTaste, tasteRemaining } from "../taste";
import { resetInPlaceFlips } from "../surfaces/ui";
import * as DataStore from "./stubs/api-datastore";
import { accessories } from "./stubs/api-messageaccessories";
import { __getPopoverButton, __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import { __resetNotices, shownNotices } from "./stubs/api-notices";
import { __resetSettings } from "./stubs/api-settings";
import {
    __resetWebpackCommon, __stubSetSelectedChannel, FluxDispatcher, shownToasts, stubActivities
} from "./stubs/webpack-common";

/**
 * P9 (MUST TEST, owner order). The relay is unreachable while Discord works.
 * For every way it can be down:
 *   - ≈ keeps working on every surface (messages, embeds, statuses);
 *   - ✦ fails quietly: no toast, no notice (at most the existing quiet hint);
 *   - no ✦ preview is spent, and an AI subscriber keeps AI;
 *   - it recovers by itself once the relay answers again.
 * Each outage is the NativeResponse native.ts hands the renderer for it
 * (native.ts maps a thrown fetch error to { ok: false, error }, and a 429's
 * retry hint to retryAfterMs; see tests at the bottom for that mapping).
 */

const CHANNEL = "c1";
const HOUR = 60 * 60_000;
const ROMANIZED = "ana bghit nmchi l dar daba";
const failed = (error: string, extra: Partial<Extract<NativeResponse, { ok: false }>> = {}): NativeResponse =>
    ({ ok: false, error, ...extra });

type Outage = { name: string; reply: () => NativeResponse | Promise<NativeResponse>; heals: number; };
const OUTAGES: Outage[] = [
    { name: "a timeout", reply: () => failed("The operation was aborted due to timeout"), heals: 0 },
    { name: "a DNS failure", reply: () => failed("fetch failed"), heals: 0 },
    { name: "a 5xx", reply: () => failed("relay: HTTP 503 temporarily unavailable"), heals: 0 },
    // A long 429: the case that used to toast "✦ is catching up".
    { name: "a 429", reply: () => failed("relay: HTTP 429 translation service busy", { retryAfterMs: 5 * 60_000 }), heals: 5 * 60_000 },
    // 200 with an HTML body: relay.ts throws "relay: HTTP 200" (no JSON).
    { name: "malformed JSON", reply: () => failed("relay: HTTP 200"), heals: 0 },
    {
        name: "a very slow reply",
        reply: () => new Promise<NativeResponse>(r => setTimeout(() => r(failed("The operation was aborted due to timeout")), 61_000)),
        heals: 0
    },
    // A network that blocks the relay (a 403 page in front of it). It used to toast and pin for the session.
    { name: "a network block (403)", reply: () => failed("relay: HTTP 403"), heals: 16 * 60_000 }
];

let relayDown: Outage | null = null;
const sent: Array<{ engine: string; ids: string[]; mode?: string; }> = [];

function wire() {
    native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string): Promise<NativeResponse> => {
        const req = JSON.parse(payload);
        sent.push({ engine, ids: req.messages.map((m: any) => m.id), mode: req.mode });
        if (engine === "relay" && relayDown !== null) return relayDown.reply();
        return {
            ok: true,
            results: req.messages.map((m: any) => engine === "google"
                ? { id: m.id, lang: "de", text: `rough: ${m.text}`, skip: false, conf: 0.99 }
                : { id: m.id, lang: "de", text: `sharp: ${m.text}`, skip: false }),
            ...(engine === "relay" && req.mode === "preview" ? { quotaUsed: 1, quotaCap: 5 } : {})
        };
    });
}

async function flush() {
    for (let i = 0; i < 40; i++) await Promise.resolve();
}
async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
}

/** Render a tree all the way down: function components are called. */
function deep(node: any): any {
    if (node === null || node === undefined || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(deep);
    if (typeof node.type === "function") return deep(node.type({ ...(node.props ?? {}), children: node.children }));
    return { ...node, children: deep(node.children) };
}
const text = (node: any): string => {
    if (node === null || node === undefined || node === false) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    return text(node.children);
};
const P = plugin as any;
const msg = (id: string, content: string) => ({ id, channel_id: CHANNEL, content, author: { id: "u9", username: "ana" } });
const embedMessage = (id: string) => ({
    id, channel_id: CHANNEL, type: 0, content: "", author: { id: "u9", username: "jürgen" },
    embeds: [{ rawTitle: `Neue Pizzeria in der Stadt ${id}`, rawDescription: "" }], poll: null, messageSnapshots: []
});
const embedLine = (id: string) => text(deep(accessories.get(SURFACE_ACCESSORY_ID)!.render({ message: embedMessage(id) })));
const status = (user: string) => {
    const st = (stubActivities.get(user) as any[])[0].state;
    return deep(P.statusTextChildren(st, st));
};
const line = (id: string) => getTranslation(makeKey(id, "en"));
const quietUi = () => ({ toasts: shownToasts.map(t => t.message), notices: shownNotices.map(n => n.message) });

async function startAi() {
    settings.store.engine = "relay";
    settings.store.sublineCode = "slp_paid";
    // DataStore's default plan is AI with an answer that never runs out.
    native.relayStatus.mockResolvedValue({
        ok: true, plan: "", used: 0, cap: 0, automatic: true, ai: true, token: "t.s", tokenExpiresAt: Date.now() + 7 * 24 * HOUR
    });
    await plugin.start!();
    await flush();
}

async function startAutomatic() {
    DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
    native.relayStatus.mockResolvedValue({
        ok: true, plan: "", used: 0, cap: 0, automatic: true, ai: false, token: "t.s",
        tokenExpiresAt: Date.now() + 7 * 24 * HOUR, previews: { used: 0, cap: 5 }
    });
    await plugin.start!();
    await flush();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 8, 12, 0, 0)));
    for (const f of Object.values(native)) f.mockReset();
    native.readStagedBuildId.mockResolvedValue(null);
    relayDown = null;
    sent.length = 0;
    wire();
    clearStore();
    __resetTaste();
    __resetSettings();
    __resetWebpackCommon();
    __resetNotices();
    __resetMessagePopover();
    DataStore.__reset();
    resetInPlaceFlips();
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

describe.each(OUTAGES)("P9: the relay is down with $name", outage => {
    it("an AI subscriber keeps ≈ on messages, embeds and statuses, hears nothing, keeps AI, and gets ✦ back by itself", async () => {
        await startAi();
        relayDown = outage;
        // The status endpoint is down the same way.
        native.relayStatus.mockResolvedValue({ ok: false, error: "fetch failed" });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("m1", "Hallo zusammen, wie geht es euch heute?") });
        stubActivities.set("u1", [{ type: 4, state: "Bin gleich zurück, muss kochen" }]);
        embedLine("e1");
        status("u1");
        await advance(70_000);
        // Mounted views draw again when the service says so (and when a
        // parked text is due): each draw asks for what is still missing.
        for (let i = 0; i < 3; i++) {
            embedLine("e1");
            status("u1");
            await advance(30_000);
        }

        expect(sent.some(s => s.engine === "relay")).toBe(true);
        // Messages: the ≈ line is there, and ✦ wrote nothing over it.
        expect(line("m1")).toMatchObject({ via: "google", text: "rough: Hallo zusammen, wie geht es euch heute?" });
        // Embeds: their ≈ line.
        expect(embedLine("e1")).toContain("≈");
        expect(embedLine("e1")).toContain("rough: Neue Pizzeria in der Stadt e1");
        // Statuses: ≈ in place, never left untranslated.
        expect(text(status("u1"))).toBe("≈ rough: Bin gleich zurück, muss kochen");
        // Quiet: no toast, no notice.
        expect(quietUi()).toEqual({ toasts: [], notices: [] });
        // Still AI: an unreachable relay takes nothing away.
        expect(entitlementLevel()).toBe("ai");

        // The relay is back. ✦ returns by itself, with no restart and no click.
        relayDown = null;
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "", used: 0, cap: 0, automatic: true, ai: true, token: "t.s", tokenExpiresAt: Date.now() + 7 * 24 * HOUR
        });
        await advance(outage.heals);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("m2", "Und jetzt geht es wieder, oder etwa nicht?") });
        stubActivities.set("u2", [{ type: 4, state: "Heute bin ich wirklich sehr müde" }]);
        status("u2");
        await advance(70_000);
        status("u2");
        await advance(70_000);
        expect(line("m2")).toMatchObject({ via: "relay", text: "sharp: Und jetzt geht es wieder, oder etwa nicht?" });
        expect(text(status("u2"))).toBe("✦ sharp: Heute bin ich wirklich sehr müde");
        expect(quietUi()).toEqual({ toasts: [], notices: [] });
    });

    it("an Automatic owner's ✦ preview fails quietly, spends nothing, and works again once the relay is back", async () => {
        await startAutomatic();
        relayDown = outage;
        native.relayStatus.mockResolvedValue({ ok: false, error: "fetch failed" });
        setTranslation(makeKey("1", "en"), { lang: "ar", text: "I want to walk", via: "google", conf: 0.4 });
        const left = tasteRemaining();
        expect(left).toBe(5);

        const btn = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", ROMANIZED) as any)!;
        btn.onClick!();
        await advance(70_000);
        expect(sent.filter(s => s.mode === "preview")).toHaveLength(1);
        // Not spent: the same five, and the message may be asked again.
        expect(tasteRemaining()).toBe(left);
        const again = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("1", ROMANIZED) as any)!;
        expect(again.label).toBe("Preview ✦ (5 left today)");
        // The ≈ line is still what the message shows; nothing loud happened.
        expect(line("1")).toMatchObject({ via: "google" });
        expect(quietUi()).toEqual({ toasts: [], notices: [] });
        expect(entitlementLevel()).toBe("automatic");

        relayDown = null;
        await advance(outage.heals);
        again.onClick!();
        await advance(5_000);
        expect(sent.filter(s => s.mode === "preview")).toHaveLength(2);
        expect(tasteRemaining()).toBe(4);
        expect(quietUi()).toEqual({ toasts: [], notices: [] });
    });
});

/* ------------------------------------------------------------------ */
/* The native side of the same outages: what native.ts hands back.     */
/* ------------------------------------------------------------------ */

describe("P9: native.ts maps every relay outage to a quiet { ok: false } (never a throw)", () => {
    const REQ = JSON.stringify({ messages: [{ id: "1", author: "a", text: "hola" }], context: [], targetLang: "en" });
    let realFetch: typeof fetch;
    beforeEach(() => { realFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = realFetch; });

    async function viaNative(fetchImpl: (...args: any[]) => Promise<Response>) {
        globalThis.fetch = vi.fn(fetchImpl) as unknown as typeof fetch;
        const { translateBatch } = await vi.importActual<typeof import("../native")>("../native");
        const out = translateBatch(undefined as any, "relay", "slp_paid", REQ, undefined, false, "free_0");
        await vi.advanceTimersByTimeAsync(2_000);
        return out;
    }

    it("DNS failure", async () => {
        const res = await viaNative(async () => { throw new TypeError("fetch failed"); });
        expect(res).toMatchObject({ ok: false, error: "fetch failed" });
        expect((res as any).retryAfterMs).toBeUndefined();
    });

    it("timeout (the abort AbortSignal.timeout raises)", async () => {
        const res = await viaNative(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
        expect(res).toMatchObject({ ok: false });
        expect((res as any).retryAfterMs).toBeUndefined();
    });

    it("5xx", async () => {
        const res = await viaNative(async () => new Response(JSON.stringify({ ok: false, error: "temporarily unavailable" }), { status: 503 }));
        expect(res).toMatchObject({ ok: false, error: "relay: HTTP 503 temporarily unavailable" });
        expect((res as any).retryAfterMs).toBeUndefined();
    });

    it("429 carries the relay's retry hint, so the renderer parks ✦ for exactly that long", async () => {
        const res = await viaNative(async () => new Response(JSON.stringify({ ok: false, error: "translation service busy", retryAfterMs: 300_000 }), { status: 429 }));
        expect(res).toMatchObject({ ok: false, retryAfterMs: 300_000 });
    });

    it("malformed JSON", async () => {
        const res = await viaNative(async () => new Response("<html>bad gateway</html>", { status: 200 }));
        expect(res).toMatchObject({ ok: false, error: "relay: HTTP 200" });
    });
});

describe("P9: a status call to a relay that never answers gives up", () => {
    it("aborts after its timeout instead of waiting out the socket", async () => {
        vi.useRealTimers();
        const { fetchRelayStatus } = await vi.importActual<typeof import("../engines/relay")>("../engines/relay");
        let aborted = false;
        const hang = ((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); });
        })) as unknown as typeof fetch;
        const started = Date.now();
        await expect(fetchRelayStatus("slp_paid", hang, "free_0", {}, 50)).rejects.toBeDefined();
        expect(aborted).toBe(true);
        expect(Date.now() - started).toBeLessThan(5_000);
    });
});
