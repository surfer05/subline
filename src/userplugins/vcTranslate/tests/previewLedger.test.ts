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

import plugin, { FORCE_QUALITY_POPOVER_ID } from "../index";
import { contentHash, PREVIEW_LEDGER_KEY } from "../freePlan";
import settings from "../settings";
import { clearStore, makeKey, setTranslation } from "../store";
import { __resetTaste } from "../taste";
import * as DataStore from "./stubs/api-datastore";
import { __getPopoverButton, __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import { __resetSettings } from "./stubs/api-settings";
import { __resetWebpackCommon, __stubSetSelectedChannel } from "./stubs/webpack-common";

/**
 * The preview ledger is written whole (rememberPreview). A preview that
 * lands after stop() cleared the map, or before start() read the ledger
 * back, must never replace the stored ledger with one row: those messages
 * would then show ≈ again and cost a second preview.
 */

const CHANNEL = "c1";
const HOUR = 60 * 60_000;
const msg = (id: string, content: string) => ({ id, channel_id: CHANNEL, content, author: { id: "u9", username: "ana" } });
const STORED = ["s1", "s2", "s3"].map(id => [id, { text: "fine " + id, lang: "de", src: contentHash("hallo " + id), targetLang: "en" }]);

let release: () => void = () => { };
let relayCalls = 0;

async function flush() {
    for (let i = 0; i < 60; i++) await Promise.resolve();
}

beforeEach(() => {
    vi.useFakeTimers();
    for (const f of Object.values(native)) f.mockReset();
    native.readStagedBuildId.mockResolvedValue(null);
    relayCalls = 0;
    // The relay's answer waits for release().
    const gate = new Promise<void>(r => { release = r; });
    native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
        const req = JSON.parse(payload);
        if (engine === "relay") {
            relayCalls++;
            await gate;
        }
        return {
            ok: true,
            results: req.messages.map((m: any) => ({ id: m.id, lang: "de", text: "fine " + m.id, skip: false })),
            ...(engine === "relay" ? { quotaUsed: 1, quotaCap: 5 } : {})
        };
    });
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
    DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
    native.relayStatus.mockResolvedValue({
        ok: true, plan: "", used: 0, cap: 0, automatic: true, ai: false, token: "t.s",
        tokenExpiresAt: Date.now() + 7 * 24 * HOUR, previews: { used: 0, cap: 5 }
    });
    void DataStore.set(PREVIEW_LEDGER_KEY, STORED);
});

afterEach(() => {
    release();
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

const press = (m: ReturnType<typeof msg>) => __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(m as any)!.onClick!();
const storedIds = async () => ((await DataStore.get<any[]>(PREVIEW_LEDGER_KEY)) ?? []).map(r => r[0]);

describe("the preview ledger is never overwritten by a near-empty map", () => {
    it("a preview that lands after stop() leaves the stored ledger as it was", async () => {
        await plugin.start!();
        setTranslation(makeKey("p9", "en"), { lang: "de", text: "rough", via: "google", conf: 0.4 });
        press(msg("p9", "hallo p9"));
        await flush();
        expect(relayCalls).toBe(1);
        plugin.stop!();
        release();
        await flush();
        expect(await storedIds()).toEqual(["s1", "s2", "s3"]);
    });

    it("a press while start() is still reading the ledger waits for it: a stored preview is never asked again", async () => {
        let open!: () => void;
        DataStore.__holdGet(PREVIEW_LEDGER_KEY, new Promise<void>(r => { open = r; }));
        const started = plugin.start!();
        await flush();
        setTranslation(makeKey("s1", "en"), { lang: "de", text: "rough", via: "google", conf: 0.4 });
        press(msg("s1", "hallo s1"));
        await flush();
        open();
        await started;
        await flush();
        release();
        await flush();
        expect(relayCalls).toBe(0);
        expect(await storedIds()).toEqual(["s1", "s2", "s3"]);
    });
});
