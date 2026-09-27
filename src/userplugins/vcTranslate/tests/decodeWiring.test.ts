import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same bootstrap as index.test.ts: index.tsx reads VencordNative at import.
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
import settings from "../settings";
import { clearStore, makeKey, setTranslation } from "../store";
import { __resetTaste } from "../taste";
import { __resetSettings } from "./stubs/api-settings";
import * as DataStore from "./stubs/api-datastore";
import { __getPopoverButton, __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import { __resetLogCalls } from "./stubs/utils-logger";
import { __resetWebpackCommon, __stubSetSelectedChannel, FluxDispatcher } from "./stubs/webpack-common";

const CHANNEL = "c1";
const DAY_MS = 86_400_000;

const discordMessage = (id: string, content: string, authorId = "u1") => ({
    id, channel_id: CHANNEL, content, author: { id: authorId, username: "ana" }
});

async function settle() {
    await vi.advanceTimersByTimeAsync(21_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Every message text sent to any engine so far. */
function sentTexts(): string[] {
    return native.translateBatch.mock.calls.flatMap(c => JSON.parse(c[2]).messages.map((m: any) => m.text));
}

/** Render the accessory and flatten it to its text. */
function rendered(message: unknown): string {
    const el: any = plugin.renderMessageAccessory!({ message } as any);
    const walk = (n: any): string => {
        if (n === null || n === undefined || n === false) return "";
        if (typeof n === "string" || typeof n === "number") return String(n);
        if (Array.isArray(n)) return n.map(walk).join("");
        return walk(n.children);
    };
    return walk(el.type(el.props)).replace(/\s+/g, " ");
}

beforeEach(async () => {
    vi.useFakeTimers();
    native.translateBatch.mockReset();
    native.translateBatch.mockImplementation(async (_engine: string, _cred: unknown, payload: string) => ({
        ok: true,
        results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "es", text: "hello friend", skip: false }))
    }));
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
    await plugin.start!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    __resetLogCalls();
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

describe("decoded line under a message", () => {
    it("shows a Morse message decoded, with no request needed", () => {
        const text = rendered(discordMessage("1", ".... .- .--. .--. -.-- / -... .. .-. - .... -.. .- -.--"));
        expect(text).toContain("decoded · morse · HAPPY BIRTHDAY");
        // ≈ means Google translated it. Nothing translated this line.
        expect(text).not.toContain("≈");
    });

    it("shows nothing extra for an ordinary message", () => {
        expect(rendered(discordMessage("1", "..."))).toBe("");
    });

    it("keeps the decoded line above the translation of the decoded text", () => {
        setTranslation(makeKey("1", "en"), { lang: "es", text: "hello friend", via: "google" });
        const text = rendered(discordMessage("1", "aG9sYSBhbWlnbw=="));
        expect(text).toContain("decoded · base64 · hola amigo");
        expect(text).toContain("hello friend");
        expect(text.indexOf("hola amigo")).toBeLessThan(text.indexOf("hello friend"));
    });

    it("still decodes on the free plan after the trial, without a click", async () => {
        settings.store.freeTrialStartedAt = Date.now() - 30 * DAY_MS;
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "aG9sYSBhbWlnbw==") });
        await settle();
        expect(native.translateBatch).not.toHaveBeenCalled();
        const text = rendered(discordMessage("1", "aG9sYSBhbWlnbw=="));
        expect(text).toContain("decoded · base64 · hola amigo");
        expect(text).toContain("≈ Translate");
    });
});

describe("codes in a message already in the reader's language", () => {
    it("gets its decoded line, and no translation", async () => {
        const msg = discordMessage("1", "You can tell him this -- . . - / -- . / - --- -.. .- -.--");
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg });
        await settle();
        expect(native.translateBatch).not.toHaveBeenCalled();
        const text = rendered(msg);
        expect(text).toContain("decoded · morse · MEET ME TODAY");
        expect(text).not.toContain("hello friend");
    });

    it("decodes a code followed by a mention, and sends nothing", async () => {
        const msg = discordMessage("1", ".... .- .--. .--. -.-- / -... .. .-. - .... -.. .- -.-- / @Gojer");
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg });
        await settle();
        expect(native.translateBatch).not.toHaveBeenCalled();
        expect(rendered(msg)).toContain("decoded · morse · HAPPY BIRTHDAY");
    });
});

describe("language labels", () => {
    it("never shows an undetermined language code", () => {
        for (const lang of ["und", "zxx", "", "qq"]) {
            clearStore();
            setTranslation(makeKey("1", "en"), { lang, text: "hello friend", via: "google" });
            const text = rendered(discordMessage("1", "hola amigo que tal"));
            expect(text, lang).toContain("≈ · hello friend");
            if (lang !== "") expect(text, lang).not.toContain(lang + " ·");
        }
    });

    it("still shows a real one", () => {
        setTranslation(makeKey("1", "en"), { lang: "es", text: "hello friend", via: "google" });
        expect(rendered(discordMessage("1", "hola amigo que tal"))).toContain("≈ es · hello friend");
    });
});

describe("decoded and normalised text goes through the normal pipeline", () => {
    it("sends a foreign decoded message to translation as its decoded text", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "aG9sYSBhbWlnbw==") });
        await settle();
        expect(sentTexts()).toEqual(["hola amigo"]);
    });

    it("never sends the dots and dashes themselves", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "--. .-. .- -.-. .. .- ...") });
        await settle();
        expect(sentTexts()).toEqual(["gracias"]);
    });

    it("translates fancy-font text as plain letters", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "ｈｏｌａ ａｍｉｇｏ") });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "𝓫𝓾𝓮𝓷𝓸𝓼 𝓭𝓲𝓪𝓼") });
        await settle();
        expect(sentTexts().sort()).toEqual(["buenos dias", "hola amigo"]);
    });

    it("skips fancy-font English locally, like plain English", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "𝓽𝓱𝓪𝓷𝓴 𝔂𝓸𝓾 𝓼𝓸 𝓶𝓾𝓬𝓱 𝓯𝓸𝓻 𝓽𝓱𝓮 𝓱𝓮𝓵𝓹") });
        await settle();
        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("never rewrites the author name", async () => {
        const msg = { ...discordMessage("1", "ｈｏｌａ ａｍｉｇｏ"), author: { id: "u1", username: "𝓪𝓷𝓪" } };
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: msg });
        await settle();
        const authors = native.translateBatch.mock.calls.flatMap(c => JSON.parse(c[2]).messages.map((m: any) => m.author));
        expect(authors).toEqual(["𝓪𝓷𝓪"]);
    });
});

describe("the ⚡ press sends the decoded text too", () => {
    async function press(content: string) {
        const btn: any = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(discordMessage("9", content));
        btn.onClick(undefined);
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    it("on a paid engine", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        await press("aG9sYSBhbWlnbw==");
        const gemini = native.translateBatch.mock.calls.filter(c => c[0] === "gemini");
        expect(gemini.map(c => JSON.parse(c[2]).messages[0].text)).toEqual(["hola amigo"]);
    });

    it("on a free install's taste", async () => {
        await press("ｈｏｌａ ａｍｉｇｏ");
        const relay = native.translateBatch.mock.calls.filter(c => c[0] === "relay");
        expect(relay.map(c => JSON.parse(c[2]).messages[0].text)).toEqual(["hola amigo"]);
    });
});
