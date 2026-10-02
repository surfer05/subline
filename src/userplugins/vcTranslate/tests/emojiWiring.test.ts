import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FIELD REPORT (0.2.1 test build): "@viktor HAPPY BIRTHDAY<emoji> Wszystkiego
 * najlepszego z okazji urodzin!<emoji> my dear 19 years old boy<emoji>" got the
 * ✦ line "@viktor HAPPY BIRTHDAY:921020213993046066: Happy birthday!:SHAKE: my
 * dear 19 years old boy:805935394238627880:". Emoji ids leaked as text and
 * names as :NAME:. End to end: what goes out, what comes back, what is drawn.
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

import plugin, { FORCE_QUALITY_POPOVER_ID } from "../index";
import { __resetEntitlement } from "../entitlement";
import { placeholder } from "../placeholders";
import settings from "../settings";
import { clearStore, getTranslation, makeKey, setTranslation } from "../store";
import { __resetTaste } from "../taste";
import * as DataStore from "./stubs/api-datastore";
import { __getPopoverButton, __reset as resetPopover } from "./stubs/api-messagepopover";
import { __resetNotices } from "./stubs/api-notices";
import { __resetSettings } from "./stubs/api-settings";
import { __resetWebpackCommon, __stubSetChannelName, __stubSetSelectedChannel, __stubSetUser, FluxDispatcher, stubMessages } from "./stubs/webpack-common";

const HOUR = 3_600_000;
const P = (n: number) => placeholder(n);
const U = "<@444444444444444444>";
const E1 = "<:HAPPYBDAY:111111111111111111>";
const E2 = "<:SHAKE:222222222222222222>";
const E3 = "<a:wave:333333333333333333>";
const FIELD = `${U} HAPPY BIRTHDAY${E1} Wszystkiego najlepszego z okazji urodzin!${E2} my dear 19 years old boy${E3}`;
const SNOWFLAKE = /\d{15,}/;

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

/** Google echoes "EN " + the masked text; the relay answers with `relay(masked)`. */
function answer(relay: (masked: string) => string = t => t.replace("Wszystkiego najlepszego z okazji urodzin!", "Happy birthday!")) {
    native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
        const p = JSON.parse(payload);
        return {
            ok: true,
            results: p.messages.map((m: any) => engine === "google"
                ? { id: m.id, lang: "pl", text: `EN ${m.text}`, skip: false, conf: 0.99 }
                : { id: m.id, lang: "pl", text: relay(m.text), skip: false })
        };
    });
}

const msg = (id: string, content: string) => ({ id, channel_id: "c1", content, author: { id: "u2", username: "bob" } });

async function start() {
    DataStore.setEntitlementForTest({ automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, checkedAt: Date.now() });
    native.relayStatus.mockResolvedValue({ ok: true, plan: "", used: 0, cap: 0, automatic: true, ai: true, tokenExpiresAt: Date.now() + 7 * 24 * HOUR, token: "t.s" });
    settings.store.sublineCode = "slp_ai";
    settings.store.engine = "relay";
    await plugin.start!();
    await flush();
}

async function send(message: any) {
    FluxDispatcher.dispatch("MESSAGE_CREATE", { message });
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
}

const sent = (engine: string) => native.translateBatch.mock.calls
    .filter(c => c[0] === engine)
    .map(c => JSON.parse(c[2]));

/** Render the message's accessory and flatten it to text. */
function rendered(message: unknown): string {
    const el: any = plugin.renderMessageAccessory!({ message } as any);
    const walk = (n: any): string => {
        if (n === null || n === undefined || n === false) return "";
        if (typeof n === "string" || typeof n === "number") return String(n);
        if (Array.isArray(n)) return n.map(walk).join("");
        return walk(n.children);
    };
    return walk(el.type(el.props));
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 2, 12)));
    for (const f of Object.values(native)) f.mockReset();
    native.readStagedBuildId.mockResolvedValue(null);
    clearStore(); __resetTaste(); __resetEntitlement(); __resetSettings(); __resetWebpackCommon(); __resetNotices(); resetPopover(); DataStore.__reset();
    settings.store.globalAuto = true;
    settings.store.targetLang = "en";
    __stubSetSelectedChannel("c1");
    __stubSetUser("444444444444444444", { username: "viktor" });
    __stubSetChannelName("666666666666666666", "general");
});
afterEach(() => { plugin.stop!(); clearStore(); vi.useRealTimers(); });

describe("the field case, end to end", () => {
    it("what goes out: placeholders, no Discord token, no id, to both tiers", async () => {
        answer();
        await start();
        await send(msg("9", FIELD));
        const expected = `${P(1)} HAPPY BIRTHDAY${P(2)} Wszystkiego najlepszego z okazji urodzin!${P(3)} my dear 19 years old boy${P(4)}`;
        for (const engine of ["google", "relay"]) {
            const text = sent(engine)[0].messages[0].text;
            expect(text).toBe(expected);
            expect(text).not.toMatch(SNOWFLAKE);
        }
    });

    it("what is drawn: the original tokens back in place, through Discord's parser", async () => {
        answer();
        await start();
        await send(msg("9", FIELD));
        const out = rendered(msg("9", FIELD));
        expect(out).toContain(`<md:${U} HAPPY BIRTHDAY${E1} Happy birthday!${E2} my dear 19 years old boy${E3}|c1>`);
    });

    it("the model's broken answer from the field (ids and :NAME:) is drawn with the emoji, never an id or :NAME:", async () => {
        answer(() => `${P(1)} HAPPY BIRTHDAY:111111111111111111: Happy birthday!:SHAKE: my dear 19 years old boy:333333333333333333:`);
        await start();
        await send(msg("9", FIELD));
        const out = rendered(msg("9", FIELD));
        expect(out).toContain(`<md:${U} HAPPY BIRTHDAY${E1} Happy birthday!${E2} my dear 19 years old boy${E3}|c1>`);
        expect(out.replace(/<a?:\w+:\d+>/g, "")).not.toMatch(/:\d{6,}:|:SHAKE:|:wave:|:HAPPYBDAY:/);
    });

    it("a translation stored before this fix, with \":id:\" junk, is cleaned when drawn", async () => {
        answer();
        await start();
        setTranslation(makeKey("9", "en"), { lang: "pl", via: "relay", text: "@viktor HAPPY BIRTHDAY:111111111111111111: Happy birthday!:SHAKE: my dear 19 years old boy:333333333333333333:" });
        const out = rendered(msg("9", FIELD));
        expect(out).toContain(`<md:@viktor HAPPY BIRTHDAY${E1} Happy birthday!${E2} my dear 19 years old boy${E3}|c1>`);
        expect(out.replace(/<a?:\w+:\d+>/g, "")).not.toMatch(/:\d{6,}:|:SHAKE:|:wave:|:HAPPYBDAY:/);
    });

    it("the next message's context reads names, never placeholders or ids", async () => {
        answer();
        await start();
        await send(msg("9", FIELD));
        await send(msg("10", "y tú qué opinas"));
        const ctx = sent("relay").at(-1)!.context.map((c: any) => c.text);
        expect(ctx).toContain("@viktor HAPPY BIRTHDAY Wszystkiego najlepszego z okazji urodzin! my dear 19 years old boy");
        for (const c of ctx) {
            expect(c).not.toMatch(/⟦|⟧/);
            expect(c).not.toMatch(SNOWFLAKE);
        }
    });
});

describe("worst cases", () => {
    it("a message that is only custom emoji is skipped as today: nothing is sent", async () => {
        answer();
        await start();
        await send(msg("11", `${E1}${E2} ${E3}`));
        const asked = native.translateBatch.mock.calls.flatMap(c => JSON.parse(c[2]).messages.map((m: any) => m.id));
        expect(asked).not.toContain("11");
    });

    it("mention, role, channel, emoji, link, timestamp, inline code and a code block together survive the round trip", async () => {
        const all = `oye ${U} y <@&555555555555555555> en <#666666666666666666> ${E1} mira https://example.com/x?a=1&b=2 a las <t:1700000000:R> usa \`npm i\`\n\`\`\`\nconst x = 1;\n\`\`\``;
        answer(t => t.replace("oye", "hey").replace("y", "and").replace("en", "in").replace("mira", "look").replace("a las", "at").replace("usa", "use"));
        await start();
        await send(msg("12", all));
        const out = sent("relay")[0].messages[0].text as string;
        expect(out).not.toMatch(SNOWFLAKE);
        expect(out).not.toContain("https://");
        expect(out).not.toContain("`");
        const drawn = rendered(msg("12", all));
        for (const token of [U, "<@&555555555555555555>", "<#666666666666666666>", E1, "https://example.com/x?a=1&b=2", "<t:1700000000:R>", "`npm i`", "```\nconst x = 1;\n```"]) {
            expect(drawn).toContain(token);
        }
    });

    it("a line that is only junk after repair shows nothing", async () => {
        answer(() => ":999999999999999999: ⟦8⟧");
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => ({
            ok: true, results: JSON.parse(payload).messages.map((m: any) => engine === "google"
                ? { id: m.id, skip: true, reason: "target" }
                : { id: m.id, lang: "pl", text: ":999999999999999999: ⟦8⟧", skip: false })
        }));
        await start();
        await send(msg("13", `${E1} dzień dobry`));
        expect(getTranslation(makeKey("13", "en"))).toMatchObject({ via: "relay" });
        expect(rendered(msg("13", `${E1} dzień dobry`))).toBe("");
    });

    it("unicode emoji are plain text: sent as they are, drawn as plain text without the parser", async () => {
        answer(t => t.replace("hola", "hi"));
        await start();
        await send(msg("14", "hola amigo 😀🎉 que tal"));
        expect(sent("relay")[0].messages[0].text).toBe("hola amigo 😀🎉 que tal");
        const drawn = rendered(msg("14", "hola amigo 😀🎉 que tal"));
        expect(drawn).toContain("hi amigo 😀🎉 que tal");
        expect(drawn).not.toContain("<md:");
    });

    it("⚡ on a message with emoji sends placeholders too (the forced path used to send raw tokens)", async () => {
        answer();
        await start();
        const m = msg("15", FIELD);
        stubMessages.set("c1", [msg("14", "hola"), m]);
        __getPopoverButton(FORCE_QUALITY_POPOVER_ID)!.render(m)!.onClick();
        await flush();
        const reqs = sent("relay").filter(r => r.messages[0].id === "15");
        expect(reqs.length).toBeGreaterThan(0);
        for (const r of reqs) {
            expect(r.messages[0].text).toContain(P(4));
            expect(r.messages[0].text).not.toMatch(SNOWFLAKE);
        }
    });

    it("right-to-left text with emoji: placeholders out, emoji back in the drawn line", async () => {
        const ar = `${E1} مبروك يا صديقي ${E2}`;
        answer(() => `${P(1)} Congratulations my friend ${P(2)}`);
        await start();
        await send(msg("16", ar));
        expect(sent("relay")[0].messages[0].text).toBe(`${P(1)} مبروك يا صديقي ${P(2)}`);
        expect(rendered(msg("16", ar))).toContain(`<md:${E1} Congratulations my friend ${E2}|c1>`);
    });
});
