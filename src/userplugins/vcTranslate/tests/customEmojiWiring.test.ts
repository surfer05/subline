import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FIELD REPORT (0.2.1 dogfood): "@viktor HAPPY BIRTHDAY<e1> Wszystkiego
 * najlepszego z okazji urodzin!<e2> my dear 19 years old boy<e3>" came back as
 * "@viktor HAPPY BIRTHDAY:921020213993046066: Happy birthday!:SHAKE: my dear
 * 19 years old boy:805935394238627880:". Custom emoji now never reach a
 * translator, and any junk a translator or the old cache returns is cleaned
 * where it is drawn (customEmoji.ts). Fixture ids are clearly fake.
 */
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
import { __resetWebpackCommon, __stubSetSelectedChannel, __stubSetUser, FluxDispatcher } from "./stubs/webpack-common";

const CHANNEL = "c1";
const E1 = "<:cake:111111111111111111>";
const E2 = "<a:SHAKE:222222222222222222>";
const E3 = "<:heart:333333333333333333>";
const VIKTOR = "<@900000000000000009>";
const FIELD = `${VIKTOR} HAPPY BIRTHDAY${E1} Wszystkiego najlepszego z okazji urodzin!${E2} my dear 19 years old boy${E3}`;
const SENT = "@viktor HAPPY BIRTHDAY Wszystkiego najlepszego z okazji urodzin! my dear 19 years old boy";
const BROKEN = "@viktor HAPPY BIRTHDAY:111111111111111111: Happy birthday!:SHAKE: my dear 19 years old boy:333333333333333333:";

const discordMessage = (id: string, content: string, authorId = "u1") => ({
    id, channel_id: CHANNEL, content, author: { id: authorId, username: "ana" }
});

async function settle() {
    await vi.advanceTimersByTimeAsync(21_000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function sent(engine?: string): string[] {
    return native.translateBatch.mock.calls
        .filter(c => engine === undefined || c[0] === engine)
        .flatMap(c => JSON.parse(c[2]).messages.map((m: any) => m.text as string));
}

function sentContext(): string[] {
    return native.translateBatch.mock.calls.flatMap(c => (JSON.parse(c[2]).context ?? []).map((m: any) => m.text as string));
}

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

/** Every engine answers with the same text for every message. */
function answer(text: string, lang = "pl") {
    native.translateBatch.mockImplementation(async (_e: string, _k: unknown, payload: string) => ({
        ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang, text, skip: false }))
    }));
}

beforeEach(async () => {
    vi.useFakeTimers();
    native.translateBatch.mockReset();
    answer("Happy birthday, my dear 19 year old boy");
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
    __stubSetUser("900000000000000009", { username: "viktor" });
    await plugin.start!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

const NO_EMOJI = /<a?:\w+:\d+>|\d{15,}|:cake:|:SHAKE:|:heart:/i;

describe("custom emoji never reach a translator", () => {
    it("the field message: Google gets readable text with no emoji tokens", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", FIELD) });
        await settle();
        expect(sent("google")).toEqual([SENT]);
    });

    it("the field message on the AI plan: ✦ gets the same text", async () => {
        settings.store.sublineCode = "SUBLINE-TEST-CODE";
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", FIELD) });
        await settle();
        expect(sent("relay")).toContain(SENT);
        for (const t of sent()) expect(t).not.toMatch(NO_EMOJI);
    });

    it("⚡ sends readable text too, never the raw tokens", async () => {
        settings.store.sublineCode = "SUBLINE-TEST-CODE";
        const m = discordMessage("2", FIELD);
        const button = __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(m as any)!;
        button.onClick?.();
        await settle();
        expect(sent("relay")).toContain(SENT);
        for (const t of sent()) expect(t).not.toMatch(NO_EMOJI);
    });

    it("context handed to the next message carries no emoji tokens", async () => {
        settings.store.sublineCode = "SUBLINE-TEST-CODE";
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", FIELD) });
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", `Dzięki ${E1} wielkie`) });
        await settle();
        for (const t of [...sent(), ...sentContext()]) expect(t).not.toMatch(NO_EMOJI);
        expect(sent()).toContain("Dzięki wielkie");
    });

    it("25 custom emoji in one message", async () => {
        const many = Array.from({ length: 25 }, (_, i) => `<a:e${i}:${String(i % 9 + 1).repeat(18)}>`).join(" ");
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("3", `Hola ${many} amigos de verdad`) });
        await settle();
        expect(sent("google")).toEqual(["Hola amigos de verdad"]);
    });

    it("an emoji between every word", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("4", `Hola${E1}amigos${E2}de${E3}verdad`) });
        await settle();
        expect(sent("google")).toEqual(["Hola amigos de verdad"]);
    });

    it("an emoji-only message is skipped as before: nothing is sent", async () => {
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("5", `${E1} ${E2}${E3}`) });
        await settle();
        expect(native.translateBatch).not.toHaveBeenCalled();
    });

    it("a long number the author typed goes out and stays in the line", async () => {
        answer("my order 987654321098765432 has arrived");
        const m = discordMessage("6", `mi pedido 987654321098765432 llegó ${E1}`);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: m });
        await settle();
        expect(sent("google")).toEqual(["mi pedido 987654321098765432 llegó"]);
        expect(rendered(m)).toContain("my order 987654321098765432 has arrived");
    });
});

describe("what a translator or the old cache returns is shown clean", () => {
    it("the field's broken answer renders with no ids and no :NAME:", async () => {
        answer(BROKEN);
        const m = discordMessage("1", FIELD);
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: m });
        await settle();
        const line = rendered(m);
        expect(line).toContain("@viktor HAPPY BIRTHDAY Happy birthday! my dear 19 years old boy");
        expect(line).not.toMatch(NO_EMOJI);
    });

    it("a translation cached before this fix, with junk in it, is cleaned on render", () => {
        const m = discordMessage("7", FIELD);
        setTranslation(makeKey("7", "en"), { lang: "pl", text: BROKEN, via: "relay" });
        const line = rendered(m);
        expect(line).toContain("Happy birthday!");
        expect(line).not.toMatch(NO_EMOJI);
    });

    it("right-to-left: junk is cleaned out of an Arabic line", () => {
        settings.store.targetLang = "ar";
        const m = discordMessage("8", `Happy birthday ${E1} my friend`);
        setTranslation(makeKey("8", "ar"), { lang: "en", text: "عيد ميلاد سعيد :cake: يا صديقي", via: "google" });
        const line = rendered(m);
        expect(line).toContain("عيد ميلاد سعيد يا صديقي");
        expect(line).not.toMatch(NO_EMOJI);
    });
});
