import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FIELD REPORT (0.2.0, plan AI, reader en): "@danna balhin ubos" (Cebuano,
 * "move down") showed no translation line. This pins the client's side of the
 * decision for both raw forms Discord can deliver (a real mention, or literal
 * "@danna" text):
 *   - nothing local silences it (shouldSkip / isConfidentlyTargetLanguage);
 *   - both tiers are asked, with the mention rendered as "@name";
 *   - a ✦ translation shows whatever Google's confidence was;
 *   - the ONLY way it ends up blank is the ✦ tier answering skip (the
 *     relay's LLM decider), which by design retracts even a confident ≈ line.
 * So the silence was the model's call, not a client rule.
 */
const native = vi.hoisted(() => {
    const translateBatch = vi.fn();
    const readStagedBuildId = vi.fn().mockResolvedValue(null);
    const relayStatus = vi.fn().mockResolvedValue({ ok: false, error: "x" });
    (globalThis as any).VencordNative = {
        pluginHelpers: { VcTranslate: { translateBatch, readStagedBuildId, relayStatus, relayCheckout: vi.fn(), relayRedeem: vi.fn() } },
        native: { openExternal: vi.fn() }
    };
    return { translateBatch, readStagedBuildId, relayStatus };
});

import plugin from "../index";
import { __resetEntitlement } from "../entitlement";
import settings from "../settings";
import { shouldSkip } from "../skip";
import { isConfidentlyTargetLanguage } from "../detectLang";
import { clearStore, getTranslation, makeKey } from "../store";
import { __resetTaste } from "../taste";
import { __resetSettings } from "./stubs/api-settings";
import { __resetNotices } from "./stubs/api-notices";
import * as DataStore from "./stubs/api-datastore";
import { __reset as resetPopover } from "./stubs/api-messagepopover";
import { __resetWebpackCommon, __stubSetSelectedChannel, FluxDispatcher } from "./stubs/webpack-common";

const HOUR = 3_600_000;
const FORMS = [["a real mention", "<@1234567> balhin ubos"], ["literal @name text", "@danna balhin ubos"]] as const;
type G = { lang: string; conf?: number };

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

function answer(g: G, relay: "translate" | "skip") {
    native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
        const p = JSON.parse(payload);
        if (engine === "google") {
            return { ok: true, results: p.messages.map((m: any) => ({ id: m.id, lang: g.lang, text: "move down", skip: false, ...(g.conf !== undefined ? { conf: g.conf } : {}) })) };
        }
        return {
            ok: true,
            results: p.messages.map((m: any) => relay === "skip" ? { id: m.id, skip: true } : { id: m.id, lang: "ceb", text: "@danna move down", skip: false })
        };
    });
}

async function send(content: string) {
    DataStore.setEntitlementForTest({ automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
    native.relayStatus.mockResolvedValue({ ok: true, plan: "", used: 0, cap: 0, automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, token: "t.s" });
    settings.store.sublineCode = "slp_ai";
    settings.store.engine = "relay";
    await plugin.start!();
    await flush();
    FluxDispatcher.dispatch("MESSAGE_CREATE", { message: { id: "9", channel_id: "c1", content, author: { id: "u2", username: "bob" } } });
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    return getTranslation(makeKey("9", "en"));
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 25, 12)));
    for (const f of Object.values(native)) f.mockReset();
    native.readStagedBuildId.mockResolvedValue(null);
    clearStore(); __resetTaste(); __resetEntitlement(); __resetSettings(); __resetWebpackCommon(); __resetNotices(); resetPopover(); DataStore.__reset();
    settings.store.globalAuto = true;
    settings.store.targetLang = "en";
    __stubSetSelectedChannel("c1");
});
afterEach(() => { plugin.stop!(); clearStore(); vi.useRealTimers(); });

describe("a short foreign message that starts with a mention", () => {
    for (const [label, content] of FORMS) {
        it(`${label}: no local rule silences it`, () => {
            expect(shouldSkip(content, false)).toBe(false);
            expect(isConfidentlyTargetLanguage(content, "en")).toBe(false);
        });

        for (const g of [{ lang: "ceb", conf: 0.9 }, { lang: "ceb", conf: 0.5 }, { lang: "tl", conf: 0.3 }, { lang: "ceb" }] as G[]) {
            it(`${label}, Google ${JSON.stringify(g)}: both tiers are asked and the ✦ line is stored`, async () => {
                answer(g, "translate");
                const stored = await send(content);
                const engines = native.translateBatch.mock.calls.map(c => c[0]);
                expect(engines).toContain("google");
                expect(engines).toContain("relay");
                const relayText = JSON.parse(native.translateBatch.mock.calls.find(c => c[0] === "relay")![2]).messages[0].text;
                expect(relayText).toMatch(/^@\S+ balhin ubos$/);
                expect(stored).toMatchObject({ via: "relay", text: "@danna move down" });
            });
        }

        it(`${label}: only a ✦ skip leaves it blank, and it retracts even a confident ≈ line`, async () => {
            answer({ lang: "ceb", conf: 0.95 }, "skip");
            const stored = await send(content);
            expect(stored).toMatchObject({ skipped: true, via: "relay" });
        });
    }
});
