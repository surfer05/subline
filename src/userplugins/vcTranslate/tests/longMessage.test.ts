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
import { joinParts, LLM_TEXT_MAX, partId, splitTextToLimit } from "../fitRequest";
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
 * ✦ preview. It is now translated WHOLE, in parts cut at paragraph, sentence
 * or space boundaries, and the parts are joined in order. Owner rule: never
 * degrade or mislabel a translation, so a ✦ covering only part of the text
 * never replaces a ≈ of all of it: one failed part keeps the ≈ line.
 */

const CHANNEL = "c1";
const HOUR = 60 * 60_000;
const SENTENCE = "Das ist ein ziemlich langer Satz über das Wetter und die Stadt. ";
/** Over 6,000 characters of whole sentences, in two paragraphs. */
const LONG = SENTENCE.repeat(50).trim() + "\n\n" + SENTENCE.repeat(50).trim();
const msg = (id: string, content: string) => ({ id, channel_id: CHANNEL, content, author: { id: "u9", username: "ana" } });

/** What the relay was sent: one entry per request. */
const relayRequests: Array<{ ids: string[]; texts: string[]; mode?: string; }> = [];
/** Part ids the relay answers with a failed row. */
const failParts = new Set<string>();
function wire() {
    native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string): Promise<NativeResponse> => {
        const req = JSON.parse(payload);
        if (engine === "relay") relayRequests.push({ ids: req.messages.map((m: any) => m.id), texts: req.messages.map((m: any) => m.text), mode: req.mode });
        return {
            ok: true,
            results: req.messages.map((m: any) => engine === "google"
                ? { id: m.id, lang: "de", text: "rough whole", skip: false, conf: 0.4 }
                // The relay's own rule (relay/src/index.ts): over 4,000 is a failed row.
                : m.text.length > 4_000 || failParts.has(m.id)
                    ? { id: m.id, failed: true }
                    : { id: m.id, lang: "de", text: `<${m.id}>`, skip: false }),
            // The relay states a count only when it served something; this
            // stand-in states none when a part failed, so the test sees what
            // the CLIENT counts.
            ...(engine === "relay" && req.mode === "preview" && !req.messages.some((m: any) => failParts.has(m.id)) ? { quotaUsed: 1, quotaCap: 5 } : {})
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
const sentParts = () => relayRequests.flatMap(r => r.texts);

beforeEach(() => {
    vi.useFakeTimers();
    for (const f of Object.values(native)) f.mockReset();
    native.readStagedBuildId.mockResolvedValue(null);
    native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
    relayRequests.length = 0;
    failParts.clear();
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

async function startAi() {
    settings.store.engine = "relay";
    settings.store.sublineCode = "slp_paid";
    await plugin.start!();
}

async function startAutomatic() {
    DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
    native.relayStatus.mockResolvedValue({
        ok: true, plan: "", used: 0, cap: 0, automatic: true, ai: false, token: "t.s",
        tokenExpiresAt: Date.now() + 7 * 24 * HOUR, previews: { used: 0, cap: 5 }
    });
    await plugin.start!();
}

describe("G2: an AI subscriber and a message over the relay's per-text limit", () => {
    it("translates all of it: every part is sent, each under the limit, and the ✦ line joins them in order", async () => {
        await startAi();
        expect(LONG.length).toBeGreaterThan(6_000);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("m1", LONG) });
        await advance(30_000);

        const parts = sentParts();
        expect(parts.length).toBe(2);
        for (const t of parts) expect(t.length).toBeLessThanOrEqual(LLM_TEXT_MAX);
        // Nothing left out, nothing added, cut at the paragraph break.
        expect(parts.join("\n\n")).toBe(LONG);
        expect(sentParts().join("")).not.toContain("…");
        expect(getTranslation(makeKey("m1", "en"))).toMatchObject({ via: "relay", text: "<m1~p0>\n\n<m1~p1>" });
    });

    it("a failed part keeps the ≈ line of the whole text: no partial ✦", async () => {
        await startAi();
        failParts.add("m1~p1");
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg("m1", LONG) });
        await advance(30_000);
        expect(sentParts().length).toBe(2);
        expect(getTranslation(makeKey("m1", "en"))).toMatchObject({ via: "google", text: "rough whole" });
    });
});

describe("G2: an Automatic owner previews a message over the limit", () => {
    it("the preview covers all of it, and one preview is noted for the message", async () => {
        await startAutomatic();
        setTranslation(makeKey("p1", "en"), { lang: "de", text: "rough whole", via: "google", conf: 0.4 });
        __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("p1", LONG) as any)!.onClick!();
        await advance(5_000);

        expect(relayRequests.every(r => r.mode === "preview")).toBe(true);
        expect(sentParts().join("\n\n")).toBe(LONG);
        expect(tasteRemaining()).toBe(4);
        const shown = text(render(msg("p1", LONG)));
        expect(shown).toContain("<p1~p0>");
        expect(shown).toContain("<p1~p1>");
        expect(shown).not.toContain("…");
    });

    it("a failed part shows no preview, notes none spent, and keeps the ≈ line", async () => {
        await startAutomatic();
        failParts.add("p1~p1");
        setTranslation(makeKey("p1", "en"), { lang: "de", text: "rough whole", via: "google", conf: 0.4 });
        __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(msg("p1", LONG) as any)!.onClick!();
        await advance(5_000);
        expect(tasteRemaining()).toBe(5);
        const shown = text(render(msg("p1", LONG)));
        expect(shown).not.toContain("<p1~p0>");
        expect(shown).toContain("rough whole");
    });
});

describe("splitTextToLimit / joinParts", () => {
    const rebuild = (parts: string[], seps: string[]) => parts.map((p, i) => i === 0 ? p : seps[i - 1] + p).join("");

    it("leaves a text at the limit whole", () => {
        const t = "a".repeat(LLM_TEXT_MAX);
        expect(splitTextToLimit(t, LLM_TEXT_MAX)).toEqual({ parts: [t], seps: [] });
    });

    it("loses nothing and adds nothing: the parts and their separators are the text", () => {
        for (const t of [LONG, "wort ".repeat(3_000), "x" + "😀".repeat(6_000), "Satz. ".repeat(2_000) + "Ende"]) {
            const { parts, seps } = splitTextToLimit(t, LLM_TEXT_MAX);
            expect(parts.length).toBeGreaterThan(1);
            for (const p of parts) expect(p.length).toBeLessThanOrEqual(LLM_TEXT_MAX);
            // Only trailing whitespace after the last cut may be dropped.
            expect([t, t.trimEnd()]).toContain(rebuild(parts, seps));
            expect(parts.join("")).not.toContain("…");
        }
    });

    it("never cuts inside a link or a code block, and never splits an emoji", () => {
        const url = "https://example.com/" + "a".repeat(300);
        const { parts } = splitTextToLimit("wort ".repeat(760) + url + " ende", LLM_TEXT_MAX);
        expect(parts.filter(p => p.includes(url))).toHaveLength(1);
        const code = "```\n" + "x = 1\n".repeat(200) + "```";
        for (const p of splitTextToLimit("wort ".repeat(700) + code + " ende", LLM_TEXT_MAX).parts) {
            expect((p.match(/```/g) ?? []).length % 2).toBe(0);
        }
        for (const p of splitTextToLimit("x" + "😀".repeat(3_000), LLM_TEXT_MAX).parts) {
            const last = p.charCodeAt(p.length - 1);
            expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
        }
    });

    it("joins only when every part came back", () => {
        const rows = new Map<string, any>([
            [partId("m", 0), { id: partId("m", 0), lang: "de", text: "A", skip: false }],
            [partId("m", 1), { id: partId("m", 1), lang: "de", text: "B", skip: false }]
        ]);
        expect(joinParts("m", ["a", "b"], ["\n"], rows)).toEqual({ id: "m", lang: "de", text: "A\nB", skip: false });
        rows.set(partId("m", 1), { id: partId("m", 1), failed: true });
        expect(joinParts("m", ["a", "b"], ["\n"], rows)).toBeNull();
        rows.delete(partId("m", 1));
        expect(joinParts("m", ["a", "b"], ["\n"], rows)).toBeNull();
    });
});
