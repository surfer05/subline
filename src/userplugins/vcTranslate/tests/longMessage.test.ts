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
import { fitMessageText, fitTextToLimit, LLM_TEXT_MAX } from "../fitRequest";
import type { NativeResponse } from "../native";
import settings from "../settings";
import { clearStore, getTranslation, makeKey, setTranslation } from "../store";
import { __resetTaste, tasteRemaining } from "../taste";
import * as DataStore from "./stubs/api-datastore";
import { __getPopoverButton, __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import { __resetSettings } from "./stubs/api-settings";
import { __resetWebpackCommon, __stubSetSelectedChannel, FluxDispatcher } from "./stubs/webpack-common";

/**
 * G2. A message longer than the relay's 4,000-character limit (after mention
 * expansion) used to be refused as a failed row: it could never get ✦ or a
 * ✦ preview. Its first part is now sent, cut where a long surface text is
 * cut, and the ✦ text that comes back is shown as it came, with no "…".
 */

const CHANNEL = "c1";
const HOUR = 60 * 60_000;
const SENTENCE = "Das ist ein ziemlich langer Satz über das Wetter und die Stadt. ";
/** Over 6,000 characters of whole sentences. */
const LONG = SENTENCE.repeat(100).trim();
const msg = (id: string, content: string) => ({ id, channel_id: CHANNEL, content, author: { id: "u9", username: "ana" } });

/** The relay's own rule (relay/src/index.ts): a text over 4,000 is a failed row. */
const relaySent: string[] = [];
function wire() {
    native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string): Promise<NativeResponse> => {
        const req = JSON.parse(payload);
        if (engine === "relay") for (const m of req.messages) relaySent.push(m.text);
        return {
            ok: true,
            results: req.messages.map((m: any) => engine === "google"
                ? { id: m.id, lang: "de", text: "rough", skip: false, conf: 0.4 }
                : m.text.length > 4_000
                    ? { id: m.id, failed: true }
                    : { id: m.id, lang: "de", text: `sharp ${m.text.length}`, skip: false }),
            ...(engine === "relay" && req.mode === "preview" ? { quotaUsed: 1, quotaCap: 5 } : {})
        };
    });
}

async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 40; i++) await Promise.resolve();
}
const text = (node: any): string => {
    if (node === null || node === undefined || node === false) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    return text(node.children);
};
const render = (message: unknown) => {
    const el: any = plugin.renderMessageAccessory!({ message } as any);
    return el.type(el.props);
};

beforeEach(() => {
    vi.useFakeTimers();
    for (const f of Object.values(native)) f.mockReset();
    native.readStagedBuildId.mockResolvedValue(null);
    native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
    relaySent.length = 0;
    wire();
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
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

describe("G2: a message over the relay's per-text limit", () => {
    it("an AI subscriber gets ✦ for it: its first part is sent, whole sentences, and the ✦ text is shown as it came", async () => {
        settings.store.engine = "relay";
        settings.store.sublineCode = "slp_paid";
        await plugin.start!();
        expect(LONG.length).toBeGreaterThan(6_000);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("m1", LONG) });
        await advance(30_000);

        expect(relaySent).toHaveLength(1);
        const sent = relaySent[0]!;
        expect(sent.length).toBeLessThanOrEqual(LLM_TEXT_MAX);
        expect(LONG.startsWith(sent)).toBe(true);
        expect(sent.endsWith(".")).toBe(true);
        expect(sent).not.toContain("…");
        expect(getTranslation(makeKey("m1", "en"))).toMatchObject({ via: "relay", text: `sharp ${sent.length}` });
    });

    it("an Automatic owner can preview it, and the preview is spent once and shown in full", async () => {
        DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
        native.relayStatus.mockResolvedValue({
            ok: true, plan: "", used: 0, cap: 0, automatic: true, ai: false, token: "t.s",
            tokenExpiresAt: Date.now() + 7 * 24 * HOUR, previews: { used: 0, cap: 5 }
        });
        await plugin.start!();
        setTranslation(makeKey("p1", "en"), { lang: "de", text: "rough", via: "google", conf: 0.4 });
        __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("p1", LONG) as any)!.onClick!();
        await advance(5_000);

        expect(relaySent).toHaveLength(1);
        expect(relaySent[0]!.length).toBeLessThanOrEqual(LLM_TEXT_MAX);
        expect(tasteRemaining()).toBe(4);
        const shown = text(render(msg("p1", LONG)));
        expect(shown).toContain(`sharp ${relaySent[0]!.length}`);
        expect(shown).not.toContain("…");
        expect(shown).not.toContain("Preview didn't load");
    });
});

describe("fitTextToLimit / fitMessageText", () => {
    it("leaves a text at the limit alone", () => {
        const t = "a".repeat(LLM_TEXT_MAX);
        expect(fitMessageText(t)).toBe(t);
        expect(fitTextToLimit(t, LLM_TEXT_MAX)).toEqual({ text: t, partial: false });
    });

    it("never adds an ellipsis, never cuts inside a link or a code block, never splits an emoji", () => {
        const url = "https://example.com/" + "a".repeat(300);
        const withLink = "wort ".repeat(760) + url + " ende";
        const out = fitMessageText(withLink);
        expect(out.length).toBeLessThanOrEqual(LLM_TEXT_MAX);
        expect(out).not.toContain("https://");
        expect(out).not.toContain("…");

        const code = "```\n" + "x = 1\n".repeat(200) + "```";
        const withCode = "wort ".repeat(700) + code + " ende";
        const out2 = fitMessageText(withCode);
        expect((out2.match(/```/g) ?? []).length % 2).toBe(0);

        // No space or break anywhere: a hard cut, but never on half a surrogate pair.
        const emoji = "x" + "😀".repeat(3_000);
        const out3 = fitMessageText(emoji);
        expect(out3.length).toBeLessThanOrEqual(LLM_TEXT_MAX);
        const last = out3.charCodeAt(out3.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    });
});
