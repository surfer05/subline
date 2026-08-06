import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same hoisted shape as index.test.ts — index.tsx and statusBeacon.ts both read
// `VencordNative.pluginHelpers.VcTranslate` at import time — plus the
// `reportStatus` half, which is the whole subject of this file.
const native = vi.hoisted(() => {
    const translateBatch = vi.fn();
    const reportStatus = vi.fn(async () => true);
    (globalThis as any).VencordNative = {
        pluginHelpers: { VcTranslate: { translateBatch, reportStatus } }
    };
    return { translateBatch, reportStatus };
});

import plugin from "../index";
import settings from "../settings";
import { clearStore, getTranslation, makeKey, setTranslation } from "../store";
import type { NativeResponse } from "../native";
import { sanitizeBeacon, type StatusBeacon } from "../statusShape";
import { __resetSettings } from "./stubs/api-settings";
import * as DataStore from "./stubs/api-datastore";
import { __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import { __resetLogCalls } from "./stubs/utils-logger";
import { __resetWebpackCommon, __stubSetSelectedChannel, FluxDispatcher } from "./stubs/webpack-common";

/**
 * THE POINT OF THIS FILE. statusBeacon.ts and statusShape.ts can both be
 * perfect while the plugin never calls them, and that install is exactly the
 * one this mechanism exists to catch: everything green, nothing working. So
 * every assertion here goes through `plugin` — start(), a real dispatched
 * message, the real accessory — and reads what actually crossed IPC.
 */

const CHANNEL = "c1";
const TEXT = "hola, nos vemos en el sitio de siempre";

const discordMessage = (id: string, content: string, authorId = "u1") => ({
    id,
    channel_id: CHANNEL,
    content,
    author: { id: authorId, username: "ana" }
});

async function settle() {
    await vi.advanceTimersByTimeAsync(21_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function respondWith(res: NativeResponse) {
    native.translateBatch.mockResolvedValue(res);
}

function googleAnswers(payload: string, text = "hello, see you at the usual place"): NativeResponse {
    return {
        ok: true,
        results: JSON.parse(payload).messages.map(
            (m: { id: string; }) => ({ id: m.id, lang: "es", text, skip: false })
        )
    };
}

/** Everything the plugin has ever sent towards the beacon file, concatenated. */
function everythingWritten(): string {
    return native.reportStatus.mock.calls.map(c => String(c[0])).join("\n");
}

/**
 * Actually render the accessory. `renderMessageAccessory` returns an ELEMENT;
 * the component body — where the render signal lives — only runs when the
 * element's type is invoked. Same idiom index.test.ts's accessory suite uses.
 */
function render(message: unknown): any {
    const el: any = plugin.renderMessageAccessory!({ message } as any);
    return el.type(el.props);
}

/** Every string in a rendered tree, concatenated. */
function renderedText(node: any): string {
    if (node === null || node === undefined || node === false) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(renderedText).join("");
    return renderedText(node.children);
}

function lastBeacon(): StatusBeacon | null {
    const { calls } = native.reportStatus.mock;
    if (calls.length === 0) return null;
    // Through the main process's sanitiser, because that is what reaches disk.
    return sanitizeBeacon(JSON.parse(String(calls[calls.length - 1][0])));
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
    native.translateBatch.mockReset();
    native.reportStatus.mockReset();
    native.reportStatus.mockResolvedValue(true);
    respondWith({ ok: true, results: [] });
    clearStore();
    __resetSettings();
    __resetWebpackCommon();
    __resetMessagePopover();
    DataStore.__reset();
    __resetLogCalls();

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

async function start() {
    await plugin.start!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("the plugin actually reports that it loaded", () => {
    it("writes a beacon during start(), not on the first translation", async () => {
        // Spec §7 step 3. A beacon that only appeared once something was
        // translated could not tell "never loaded" from "loaded, nothing
        // foreign on screen yet" — and those need completely different advice.
        await start();

        expect(native.reportStatus).toHaveBeenCalled();
        expect(lastBeacon()).toMatchObject({
            product: "subline",
            loadedAt: "2026-08-06T12:00:00.000Z",
            counts: { approx: 0, upgraded: 0 },
            lastRenderedAt: null
        });
    });

    it("stops reporting once the plugin is stopped", async () => {
        // A beacon written after stop() would be vouching for a session that
        // no longer exists.
        //
        // There has to be a write ALREADY PENDING when stop() runs, or the test
        // is vacuous (found by mutation): with nothing armed, an idle beacon
        // writes nothing whether stop() resets it or not. So this translates
        // first — which arms the coalescing timer — and stops inside the
        // window.
        await start();
        native.translateBatch.mockImplementation(
            async (_e: string, _k: string, payload: string) => googleAnswers(payload)
        );
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", TEXT) });
        await vi.advanceTimersByTimeAsync(1_000);   // past the fast tier, inside the write window
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(getTranslation(makeKey("1", "en"))).toMatchObject({ via: "google" });

        plugin.stop!();
        native.reportStatus.mockClear();

        await settle();

        expect(native.reportStatus).not.toHaveBeenCalled();
    });
});

describe("the plugin reports what it actually did", () => {
    it("counts a Google line as an approx-tier translation", async () => {
        await start();
        native.translateBatch.mockImplementation(
            async (_e: string, _k: string, payload: string) => googleAnswers(payload)
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", TEXT) });
        await settle();

        expect(getTranslation(makeKey("1", "en"))).toMatchObject({ via: "google" });
        expect(lastBeacon()).toMatchObject({
            counts: { approx: 1, upgraded: 0 },
            lastEngine: "google"
        });
    });

    it("counts an LLM upgrade separately from the Google line it replaced", async () => {
        // The ✦ tier is what a broken model setting silently costs the user,
        // and the counts are the only place that becomes visible.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        await start();

        native.translateBatch.mockImplementation(
            async (engine: string, _k: string, payload: string) => ({
                ok: true,
                results: JSON.parse(payload).messages.map((m: { id: string; }) => ({
                    id: m.id, lang: "es", text: engine === "google" ? "approx" : "better", skip: false
                }))
            } as NativeResponse)
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", TEXT) });
        await settle();

        expect(lastBeacon()!.counts).toEqual({ approx: 1, upgraded: 1 });
        expect(lastBeacon()!.lastEngine).toBe("gemini");
    });

    it("does not count a translation the store refused", async () => {
        // mayReplace() refuses a Google line over an existing LLM one. Nothing
        // was shown to the reader, so nothing may be counted — otherwise a
        // plugin whose every write is refused still reports translations.
        //
        // The ORDER here is the whole test, and getting it wrong makes the test
        // vacuous (found by mutation): if the LLM line is already in the store
        // when the message is dispatched, needsFast() answers "resolved", the
        // message is never sent to Google at all, and writeResult is never
        // reached — so a beacon that counted refused writes would still pass.
        // The line has to land WHILE the Google request is in flight, which is
        // also the real race: the two tiers write the same key from different
        // latencies.
        await start();
        native.translateBatch.mockImplementation(
            async (_e: string, _k: string, payload: string) => googleAnswers(payload)
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", TEXT) });
        // Inside the fast tier's 700ms debounce: queued, not yet answered.
        await vi.advanceTimersByTimeAsync(100);
        setTranslation(makeKey("1", "en"), { lang: "es", text: "already better", via: "gemini" });
        native.reportStatus.mockClear();

        await settle();

        // The Google result came back and was refused over the Gemini line.
        expect(getTranslation(makeKey("1", "en"))).toMatchObject({ via: "gemini" });
        expect(lastBeacon()?.counts.approx ?? 0).toBe(0);
    });

    it("does not count a failure marker as a translation", async () => {
        await start();
        respondWith({ ok: false, error: "google: HTTP 500" });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", TEXT) });
        await settle();

        expect(getTranslation(makeKey("1", "en"))).toEqual({ failed: true });
        expect(lastBeacon()!.counts).toEqual({ approx: 0, upgraded: 0 });
    });

    it("reports a rate limit as a code, never as the engine's own words", async () => {
        // res.error is remote text — it has already been observed carrying a
        // model name. The beacon takes the classification and discards the
        // string (see beaconErrorCode / BEACON_ERROR_CODES).
        await start();
        respondWith({ ok: false, error: "gemini: HTTP 429 quota exceeded for gemini-3.6-flash" });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", TEXT) });
        await settle();

        expect(lastBeacon()!.lastError).toMatchObject({ code: "rate-limited" });
        expect(everythingWritten()).not.toContain("quota exceeded");
    });

    it("distinguishes a rejected key from a rate limit and from a dead IPC call", async () => {
        await start();
        respondWith({ ok: false, error: "google: HTTP 401" });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", TEXT) });
        await settle();
        expect(lastBeacon()!.lastError).toMatchObject({ code: "auth-rejected" });

        native.translateBatch.mockRejectedValue(new Error("ipc gone"));
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", TEXT) });
        await settle();
        expect(lastBeacon()!.lastError).toMatchObject({ code: "ipc-failed" });
    });

    it("records that a subtitle was PAINTED, separately from producing one", async () => {
        // Spec §6's silent failure: the mod loads, translates, and the
        // accessory renders nothing. Only a render-side signal can see it.
        await start();
        native.translateBatch.mockImplementation(
            async (_e: string, _k: string, payload: string) => googleAnswers(payload)
        );
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", TEXT) });
        await settle();

        expect(lastBeacon()!.lastTranslationAt).not.toBeNull();
        expect(lastBeacon()!.lastRenderedAt).toBeNull();

        render(discordMessage("1", TEXT));
        await settle();

        expect(lastBeacon()!.lastRenderedAt).not.toBeNull();
    });

    it("does not claim a render for a message with nothing to show", async () => {
        // A skipped or unresolved message renders no subtitle. Counting those
        // would make "the accessory paints nothing" indistinguishable from
        // "the accessory works", which is the entire signal.
        await start();
        setTranslation(makeKey("1", "en"), { skipped: true, via: "google" });
        native.reportStatus.mockClear();

        render(discordMessage("1", TEXT));   // skipped — nothing to show
        render(discordMessage("2", TEXT));   // never translated at all
        await settle();

        expect(lastBeacon()?.lastRenderedAt ?? null).toBeNull();
    });
});

describe("the beacon never carries a conversation", () => {
    it("puts no message text, author or id anywhere in a whole session's writes", async () => {
        // The end-to-end version of the guarantee, driven through the real
        // plugin rather than through the sanitiser alone: translate, render,
        // fail, edit — then read everything that was ever sent.
        await start();
        native.translateBatch.mockImplementation(
            async (_e: string, _k: string, payload: string) => googleAnswers(payload, "the translated secret")
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("991827", TEXT) });
        await settle();
        render(discordMessage("991827", TEXT));
        await settle();

        respondWith({ ok: false, error: `google: HTTP 500 while translating "${TEXT}"` });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("991828", "otro secreto") });
        await settle();

        const all = everythingWritten();
        expect(all).not.toContain(TEXT);
        expect(all).not.toContain("otro secreto");
        expect(all).not.toContain("the translated secret");
        expect(all).not.toContain("991827");
        expect(all).not.toContain("ana");
        expect(all).not.toContain("c1");
    });
});

describe("a broken beacon never breaks translation", () => {
    it("still translates and still stores when every beacon write throws", async () => {
        // The rule this whole mechanism is subordinate to: diagnostics must
        // never become a new way for the product to fail.
        native.reportStatus.mockImplementation(() => {
            throw new Error("beacon exploded");
        });

        await start();
        native.translateBatch.mockImplementation(
            async (_e: string, _k: string, payload: string) => googleAnswers(payload)
        );

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", TEXT) });
        await settle();

        expect(getTranslation(makeKey("1", "en"))).toMatchObject({
            via: "google",
            text: "hello, see you at the usual place"
        });
    });

    it("still renders the subtitle when the beacon write throws", async () => {
        native.reportStatus.mockImplementation(() => {
            throw new Error("beacon exploded");
        });
        await start();
        setTranslation(makeKey("1", "en"), { lang: "es", text: "hello there", via: "google" });

        expect(renderedText(render(discordMessage("1", TEXT)))).toContain("hello there");
    });
});
