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

import plugin, { __surfaceService, SURFACE_ACCESSORY_ID } from "../index";
import settings from "../settings";
import { clearStore, makeKey, setTranslation } from "../store";
import { toggleChannel, toggleChannelOptOut } from "../channels";
import { setCooldown } from "../cooldownStore";
import { SURFACE_BUDGET_KEY, SURFACE_DAILY_BUDGET, utcDay } from "../surfaces/budget";
import { SURFACE_CACHE_KEY } from "../surfaces/cache";
import { __resetTaste } from "../taste";
import * as DataStore from "./stubs/api-datastore";
import { accessories } from "./stubs/api-messageaccessories";
import { __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import { __resetSettings } from "./stubs/api-settings";
import {
    __resetWebpackCommon, __stubMarkAsDm, __stubSetChannel, __stubSetChannelName, __stubSetSelectedChannel, __stubSetUser, FluxDispatcher, stubMessages, shownToasts, stubActivities, stubMessageById, stubProfiles
} from "./stubs/webpack-common";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Render a tree all the way down: function components are called, elements kept. */
function deep(node: any): any {
    if (node === null || node === undefined || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(deep);
    if (typeof node.type === "function") return deep(node.type({ ...(node.props ?? {}), children: node.children }));
    return { ...node, children: deep(node.children) };
}

function text(node: any): string {
    if (node === null || node === undefined || node === false) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    return text(node.children);
}

const text2 = (node: any) => text(node);

function findTitle(node: any): string | undefined {
    if (node === null || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
        for (const c of node) { const t = findTitle(c); if (t !== undefined) return t; }
        return undefined;
    }
    if (typeof node.props?.title === "string") return node.props.title;
    return findTitle(node.children);
}

/** Surface requests are the ones whose ids are s0, s1, ... */
function surfaceCalls(engine?: string) {
    return native.translateBatch.mock.calls.filter(c =>
        (engine === undefined || c[0] === engine) && JSON.parse(c[2]).messages[0]?.id === "s0");
}

function answerEverything() {
    native.translateBatch.mockImplementation(async (engine: string, _key: string, payload: string) => ({
        ok: true,
        results: JSON.parse(payload).messages.map((m: any) => ({
            id: m.id, lang: "de", text: `${engine === "relay" ? "sharp" : "rough"}: ${m.text}`, skip: false,
            ...(engine === "google" ? { conf: 0.99 } : {})
        }))
    }));
}

async function settle(ms = 5_000) {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function restart(configure?: () => void) {
    plugin.stop!();
    configure?.();
    await plugin.start!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function paid() {
    settings.store.engine = "relay";
    settings.store.sublineCode = "slp_paid";
}

const accessory = (message: any) => deep(accessories.get(SURFACE_ACCESSORY_ID)!.render({ message }));
const P = plugin as any;
const statusOf = (userId: string): string =>
    ((stubActivities.get(userId) ?? []) as any[]).find(a => a?.type === 4)?.state ?? "";
/** Discord's member-list / DM-list custom status text for a user, as the patch hands it over. */
const decorator = (userId: string) => { const st = statusOf(userId); return deep(P.statusTextChildren(st, st)); };
const bioLine = (props: any) => deep(P.renderBioLine(props));
const GUILD_CHANNEL = { id: "c1", guild_id: "g1" };
/** Discord's own child, which a non-paid install must get back as the SAME value. */
const ORIGINAL = { type: "discord-original", props: {}, children: [] };
const threadProps = (title: unknown, channel: unknown = GUILD_CHANNEL) => P.threadTitleProps(title, channel);
const stageProps = (topic: unknown, channel: unknown = GUILD_CHANNEL) => P.stageTopicProps(topic, channel);
const thread = (title: unknown, channel: unknown = GUILD_CHANNEL) => deep(threadProps(title, channel).children);
const stage = (topic: unknown, channel: unknown = GUILD_CHANNEL) => deep(stageProps(topic, channel).children);
const forumTitle = (channel: unknown) => deep(P.forumTitleChildren(ORIGINAL, channel));
/** A tag pill's name, in the forum being viewed (a server channel by default). */
const tag = (name: unknown, viewing = "f1") => { __stubSetSelectedChannel(viewing); return deep(P.forumTagChildren(name)); };
/** A translated-in-place text: "✦ translation", the original as its tooltip. */
function expectInPlace(node: any, original: string, translation: string) {
    expect(node.type).toBe("span");
    expect(node.props.title).toBe(original);
    expect(text(node)).toBe(`✦ ${translation}`);
}
const onboarding = (prompt: any) => deep(P.onboardingHeading(ORIGINAL, prompt));
/** One of Discord's parser functions, wrapped as the patch wraps it, in a server channel by default. */
const parsed = (parser: string, text: string, state: unknown = { channelId: "c1" }) =>
    deep(P.wrapParser(parser, (t: string) => [`<${t}>`])(text, true, state));

const embedMessage = (id = "m1") => ({
    id, channel_id: "c1", type: 0, content: "",
    author: { id: "u1", username: "jürgen" },
    embeds: [{ rawTitle: "Neue Pizzeria in der Stadt", rawDescription: "Die beste Pizza weit und breit" }],
    poll: null, messageSnapshots: []
});

beforeEach(async () => {
    vi.useFakeTimers();
    native.translateBatch.mockReset();
    native.relayStatus.mockReset();
    native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
    answerEverything();
    clearStore();
    __resetTaste();
    __resetSettings();
    __resetWebpackCommon();
    __resetMessagePopover();
    DataStore.__reset();
    settings.store.targetLang = "en";
    settings.store.engine = "google";
    __stubSetSelectedChannel(null);
    await plugin.start!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
});

afterEach(() => {
    plugin.stop!();
    vi.useRealTimers();
});

describe("surface hooks", () => {
    it("registers the message accessory and no hover-only marks: no member-list decorator, no name-row patch", () => {
        expect(accessories.has(SURFACE_ACCESSORY_ID)).toBe(true);
        expect(P.renderMemberListDecorator).toBeUndefined();
        expect(P.renderProfileSurface).toBeUndefined();
        expect(P.patches.map((p: any) => p.find)).not.toContain("#{intl::USER_PROFILE_PRONOUNS}");
    });

    it("removes its accessory on stop", () => {
        plugin.stop!();
        expect(accessories.has(SURFACE_ACCESSORY_ID)).toBe(false);
        expect(__surfaceService()).toBeNull();
    });

    it("the settings toggle exists, defaults on, and is hidden only for an install that owns nothing", async () => {
        const def = (settings as any).def.translateSurfaces;
        expect(def.displayName).toBe("Profiles, embeds and more");
        expect(def.description).toBe("Also translate statuses, bios, embeds, polls, topics and titles.");
        expect(settings.store.translateSurfaces).toBe(true);
        expect(def.hidden()).toBe(false);
        await restart(() => DataStore.clearEntitlementForTest());
        expect(def.hidden()).toBe(true);
    });
});

describe("an install that owns nothing sees no change", () => {
    function renderEverything() {
        stubActivities.set("u1", [{ type: 4, state: "Bin gleich zurück" }]);
        stubProfiles.set("u1", { bio: "Ich liebe Pizza" });
        return [
            accessory(embedMessage()),
            decorator("u1"),
            bioLine({ userId: "u1", userBio: "Ich liebe Pizza" }),
            tag("Hilfe gesucht")
        ];
    }

    /** Patches that wrap Discord's own child hand back that very child. */
    function childrenUntouched() {
        const title = "Wie repariere ich mein Fahrrad?";
        // Exactly Discord's own props for its OverflowTooltip: { children }.
        expect(P.threadTitleProps(title, GUILD_CHANNEL)).toEqual({ children: title });
        expect(P.stageTopicProps(title, GUILD_CHANNEL)).toEqual({ children: title });
        expect(P.forumTitleChildren(ORIGINAL, { ...GUILD_CHANNEL, name: "Hilfe beim Kochen" })).toBe(ORIGINAL);
        expect(P.onboardingHeading(ORIGINAL, { title: "Was spielst du gern?", options: [] })).toBe(ORIGINAL);
        expect(P.statusTextChildren(ORIGINAL, "Bin gleich zurück")).toBe(ORIGINAL);
        expect(P.forumTagChildren("Hilfe gesucht")).toBe("Hilfe gesucht");
        expect(P.statusBubbleChildren("Bin gleich zurück")).toBe("Bin gleich zurück");
        expect(P.replyQuoteChildren(ORIGINAL, { referencedMessage: { message: { id: "q1", channel_id: "c1", content: "Kommst du?" } } })).toBe(ORIGINAL);
    }

    /** Discord's own parser output, which must come back untouched. */
    function parsersUntouched() {
        for (const p of ["topic", "topic-truncated", "voice-status", "rule", "guidelines", "event"]) {
            expect(parsed(p, "Hier wird geplaudert")).toEqual(["<Hier wird geplaudert>"]);
        }
    }

    it("renders nothing extra and sends zero surface requests", async () => {
        await restart(() => DataStore.clearEntitlementForTest());
        expect(renderEverything()).toEqual([null, "Bin gleich zurück", null, "Hilfe gesucht"]);
        parsersUntouched();
        childrenUntouched();
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("an Automatic owner gets ≈ on surfaces, tight ones in place too, and nothing goes to the relay", async () => {
        await restart(() => DataStore.setEntitlementForTest({ automatic: true, ai: false, tokenExpiresAt: Date.now() + 7 * DAY_MS }));
        paid();   // an Automatic code is saved, so the engine setting reads "relay"
        __stubSetSelectedChannel("f1");
        tag("Hilfe gesucht");
        await settle();
        const node = tag("Hilfe gesucht");
        expect(node.type).toBe("span");
        expect(node.props.title).toBe("Hilfe gesucht");
        expect(text(node)).toBe("≈ rough: Hilfe gesucht");
        expect(surfaceCalls("google").length).toBeGreaterThan(0);
        expect(surfaceCalls("relay")).toEqual([]);
    });

    it("a paid install with the setting off sends zero surface requests", async () => {
        paid();
        settings.store.translateSurfaces = false;
        expect(renderEverything()).toEqual([null, "Bin gleich zurück", null, "Hilfe gesucht"]);
        parsersUntouched();
        childrenUntouched();
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });
});

describe("a paid install", () => {
    beforeEach(() => paid());

    it("embeds: ≈ then ✦ under the message, sent with no conversation context", async () => {
        expect(text(accessory(embedMessage()))).toBe("");
        await settle();
        const relay = surfaceCalls("relay");
        expect(relay).toHaveLength(1);
        expect(relay[0][1]).toBe("slp_paid");
        const req = JSON.parse(relay[0][2]);
        expect(req.context).toEqual([]);
        expect(req.messages.map((m: any) => m.text)).toEqual(["Neue Pizzeria in der Stadt", "Die beste Pizza weit und breit"]);
        const out = text(accessory(embedMessage()));
        expect(out).toContain("✦ de · sharp: Neue Pizzeria in der Stadt");
        expect(out).toContain("✦ de · sharp: Die beste Pizza weit und breit");
    });

    it("polls and forwards get lines too, the forward labelled", async () => {
        const message = {
            ...embedMessage("m2"), embeds: [],
            poll: { question: { text: "Pizza oder Pasta heute?" }, answers: [{ poll_media: { text: "Lieber Pasta" } }] },
            messageSnapshots: [{ message: { content: "Schau dir das an", embeds: [] } }]
        };
        accessory(message);
        await settle();
        const out = text(accessory(message));
        expect(out).toContain("sharp: Pizza oder Pasta heute?");
        expect(out).toContain("sharp: Lieber Pasta");
        expect(out).toContain("Forwarded · ✦ de · sharp: Schau dir das an");
    });

    it("a reply gets no \"Reply\" line under it: only its own embeds, polls and forwards", async () => {
        stubMessageById.set("c1:q1", { id: "q1", channel_id: "c1", content: "Kommst du heute Abend?" });
        setTranslation(makeKey("q1", "en"), { lang: "de", text: "Are you coming tonight?", via: "relay" });
        const reply = { ...embedMessage("m3"), embeds: [], type: 19, messageReference: { channel_id: "c1", message_id: "q1" } };
        expect(accessory(reply)).toBeNull();
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("fifty statuses in the member list make two relay requests; each row shows its translation in place of the status", async () => {
        for (let i = 0; i < 50; i++) stubActivities.set(`u${i}`, [{ type: 4, state: `Heute bin ich müde, Nummer ${i}` }]);
        // Until ✦ lands: Discord's own status text, untouched.
        for (let i = 0; i < 50; i++) expect(decorator(`u${i}`)).toBe(statusOf(`u${i}`));
        await settle();
        expect(surfaceCalls("relay")).toHaveLength(2);
        expectInPlace(decorator("u7"), "Heute bin ich müde, Nummer 7", "sharp: Heute bin ich müde, Nummer 7");
    });

    it("a status after an emoji keeps Discord's leading space", async () => {
        const original = " Bin gleich zurück, muss kochen";
        expect(deep(P.statusTextChildren(original, "Bin gleich zurück, muss kochen"))).toBe(original);
        await settle();
        const out = deep(P.statusTextChildren(original, "Bin gleich zurück, muss kochen"));
        expect(out.type).toBe("Fragment");
        expect(out.children[0]).toBe(" ");
        expectInPlace(out.children[1], "Bin gleich zurück, muss kochen", "sharp: Bin gleich zurück, muss kochen");
    });

    it("the header topic and voice channel status show their translation in place; the topic popout, rules, guidelines and events a line after", async () => {
        const topic = "Hier plaudern wir über alles Mögliche";
        // Pending: Discord's own parsed topic.
        expect(parsed("topic-truncated", topic)).toEqual([`<${topic}>`]);
        await settle();
        // Rendered through the same parser, same state.
        expectInPlace(parsed("topic-truncated", topic), topic, `<sharp: ${topic}>`);

        expect(parsed("voice-status", "Wir spielen gerade Minecraft")).toEqual(["<Wir spielen gerade Minecraft>"]);
        await settle();
        expectInPlace(parsed("voice-status", "Wir spielen gerade Minecraft"), "Wir spielen gerade Minecraft", "<sharp: Wir spielen gerade Minecraft>");

        for (const p of ["topic", "rule", "guidelines", "event"]) {
            const text = `Bitte seid nett zueinander, Regel ${p}`;
            parsed(p, text);
            // Past the surfaces' four-a-minute relay cap.
            await settle(61_000);
            const out = parsed(p, text);
            expect(out[0]).toEqual([`<${text}>`]);
            expect(text2(out[1])).toContain(`✦ de · sharp: ${text}`);
        }
    });

    it("thread titles, stage topics and forum titles show their translation in place, Discord's text until then", async () => {
        expect(thread("Wie repariere ich mein Fahrrad?")).toBe("Wie repariere ich mein Fahrrad?");
        expect(stage("Wir reden über Bücher")).toBe("Wir reden über Bücher");
        expect(forumTitle({ ...GUILD_CHANNEL, name: "Hilfe beim Kochen gesucht" })).toEqual(ORIGINAL);
        await settle();
        expectInPlace(thread("Wie repariere ich mein Fahrrad?"), "Wie repariere ich mein Fahrrad?", "sharp: Wie repariere ich mein Fahrrad?");
        expectInPlace(stage("Wir reden über Bücher"), "Wir reden über Bücher", "sharp: Wir reden über Bücher");
        expectInPlace(forumTitle({ ...GUILD_CHANNEL, name: "Hilfe beim Kochen gesucht" }), "Hilfe beim Kochen gesucht", "sharp: Hilfe beim Kochen gesucht");
        // Tight places never ask Google.
        expect(surfaceCalls("google")).toEqual([]);
    });

    it("forum tag pills show the tag's translation in place", async () => {
        expect(tag("Hilfe gesucht")).toBe("Hilfe gesucht");
        await settle();
        expectInPlace(tag("Hilfe gesucht"), "Hilfe gesucht", "sharp: Hilfe gesucht");
    });

    it("a tight text that is skipped or fails keeps Discord's original", async () => {
        native.translateBatch.mockImplementation(async (_e: string, _k: string, payload: string) => ({
            ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, skip: true }))
        }));
        thread("Wie repariere ich mein Fahrrad?");
        await settle();
        expect(thread("Wie repariere ich mein Fahrrad?")).toBe("Wie repariere ich mein Fahrrad?");
        native.translateBatch.mockResolvedValue({ ok: false, error: "relay: HTTP 500 upstream" });
        stage("Wir reden heute über Bücher");
        await settle();
        expect(stage("Wir reden heute über Bücher")).toBe("Wir reden heute über Bücher");
    });

    it("the bio gets its line under it (the status has its own, in its bubble)", async () => {
        stubActivities.set("u1", [{ type: 4, state: "Bin gleich zurück" }]);
        bioLine({ userId: "u1", userBio: "Ich liebe Pizza und lange Spaziergänge" });
        await settle();
        const out = text(bioLine({ userId: "u1", userBio: "Ich liebe Pizza und lange Spaziergänge" }));
        expect(out).toContain("✦ de · sharp: Ich liebe Pizza und lange Spaziergänge");
        expect(out).not.toContain("Bin gleich zurück");
    });

    it("a line whose language the engine could not name shows no language label", async () => {
        native.translateBatch.mockImplementation(async (engine: string, _key: string, payload: string) => ({
            ok: true,
            results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "und", text: `${engine === "relay" ? "sharp" : "rough"}: ${m.text}`, skip: false }))
        }));
        bioLine({ userId: "u1", userBio: "Ich liebe Pizza und lange Spaziergänge" });
        await settle();
        const out = text(bioLine({ userId: "u1", userBio: "Ich liebe Pizza und lange Spaziergänge" }));
        expect(out).toContain("✦ · sharp: Ich liebe Pizza und lange Spaziergänge");
        expect(out).not.toContain("und ·");
    });

    it("an onboarding question gets lines for itself and its options", async () => {
        const prompt = { title: "Was spielst du gern?", options: [{ title: "Rollenspiele", description: "Lange Abende mit Freunden" }] };
        onboarding(prompt);
        await settle();
        const both = onboarding(prompt);
        expect(both[0]).toEqual(ORIGINAL);
        const out = text(both[1]);
        expect(out).toContain("Question · ✦ de · sharp: Was spielst du gern?");
        expect(out).toContain("Option · ✦ de · sharp: Rollenspiele");
        expect(out).toContain("Option · ✦ de · sharp: Lange Abende mit Freunden");
    });

    it("text already in the reader's language costs nothing", async () => {
        stubActivities.set("u1", [{ type: 4, state: "be right back, grabbing food" }]);
        decorator("u1");
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("the cache persists: the next session renders from disk and sends nothing", async () => {
        accessory(embedMessage());
        await settle();
        const sent = surfaceCalls().length;
        expect(sent).toBeGreaterThan(0);
        await restart(paid);
        const saved = await DataStore.get<unknown[]>(SURFACE_CACHE_KEY);
        expect(Array.isArray(saved) && saved.length).toBeGreaterThan(0);
        await settle(100);
        expect(text(accessory(embedMessage()))).toContain("✦ de · sharp: Neue Pizzeria in der Stadt");
        await settle();
        expect(surfaceCalls().length).toBe(sent);
    });

    it("fails safe: a store that throws, or junk props from a moved patch, render nothing", () => {
        expect(accessory(null)).toBeNull();
        expect(P.threadTitleProps(undefined, GUILD_CHANNEL)).toEqual({ children: undefined });
        expect(P.stageTopicProps("Wir reden", undefined)).toEqual({ children: "Wir reden" });
        expect(P.statusTextChildren(ORIGINAL, undefined)).toBe(ORIGINAL);
        expect(P.forumTagChildren(undefined)).toBeUndefined();
        expect(P.replyQuoteChildren(null, {})).toBeNull();
        expect(deep(P.replyQuoteChildren(ORIGINAL, undefined))).toEqual(ORIGINAL);
        expect(bioLine(undefined)).toBeNull();
        expect(deep(P.onboardingHeading(ORIGINAL, 42))[1]).toBeNull();
        expect(parsed("topic", 42 as any)).toEqual(["<42>"]);
    });

    it("a refusal is quiet: nothing shown, nothing red, retried after a minute", async () => {
        native.translateBatch.mockResolvedValue({ ok: false, error: "relay: HTTP 500 upstream" });
        accessory(embedMessage());
        await settle();
        expect(text(accessory(embedMessage()))).toBe("");
        expect(shownToasts.some(t => t.type === "FAILURE")).toBe(false);
        const first = surfaceCalls().length;
        expect(first).toBeGreaterThan(0);
        accessory(embedMessage());
        await settle();
        expect(surfaceCalls().length).toBe(first);
        await settle(60_000);
        accessory(embedMessage());
        await settle();
        expect(surfaceCalls().length).toBeGreaterThan(first);
    });
});

describe("privacy: surfaces follow the same channel rules as messages", () => {
    beforeEach(() => paid());

    it("a DM or group DM sends nothing: no embed, poll, forward or reply line", async () => {
        __stubMarkAsDm("d1");
        __stubMarkAsDm("gdm1");
        const inDm = { ...embedMessage("dm1"), channel_id: "d1" };
        const inGroup = {
            ...embedMessage("gdm1m"), channel_id: "gdm1",
            poll: { question: { text: "Pizza oder Pasta heute?" }, answers: [] },
            messageSnapshots: [{ message: { content: "Schau dir das an" } }]
        };
        expect(accessory(inDm)).toBeNull();
        expect(accessory(inGroup)).toBeNull();
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("a server channel the reader switched off sends nothing", async () => {
        await toggleChannelOptOut("c1");
        expect(accessory(embedMessage())).toBeNull();
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("a DM the reader switched on is translated like its messages", async () => {
        __stubMarkAsDm("d2");
        await toggleChannel("d2");
        accessory({ ...embedMessage("dm2"), channel_id: "d2" });
        await settle();
        expect(surfaceCalls("relay")).toHaveLength(1);
    });

    it("channel-level text in a DM (topic, voice status, titles) is never translated", async () => {
        __stubMarkAsDm("d1");
        for (const p of ["topic", "topic-truncated", "voice-status", "guidelines", "event"]) {
            expect(parsed(p, "Hier wird geplaudert", { channelId: "d1" })).toEqual(["<Hier wird geplaudert>"]);
        }
        const dm = { id: "d1" };
        expect(P.threadTitleProps("Wie repariere ich mein Fahrrad?", dm)).toEqual({ children: "Wie repariere ich mein Fahrrad?" });
        expect(P.stageTopicProps("Wir reden über Bücher", dm)).toEqual({ children: "Wir reden über Bücher" });
        expect(P.forumTitleChildren(ORIGINAL, { ...dm, name: "Hilfe beim Kochen" })).toBe(ORIGINAL);
        expect(tag("Hilfe gesucht", "d1")).toBe("Hilfe gesucht");
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });
});

describe("channel-level text follows the message rules of its channel", () => {
    beforeEach(() => paid());

    function channelLevel(channelId: string) {
        const channel = { id: channelId, guild_id: "g1", parent_id: "f1", appliedTags: ["t1"] };
        __stubSetChannel("f1", { id: "f1", availableTags: [{ id: "t1", name: "Hilfe gesucht" }] });
        return {
            parsers: ["topic", "topic-truncated", "voice-status", "guidelines", "event"]
                .map(p => parsed(p, "Hier wird geplaudert", { channelId })),
            thread: P.threadTitleProps("Wie repariere ich mein Fahrrad?", channel).children,
            stage: P.stageTopicProps("Wir reden über Bücher", channel).children,
            forum: P.forumTitleChildren(ORIGINAL, { ...channel, name: "Hilfe beim Kochen" }),
            tags: tag("Hilfe gesucht", channelId)
        };
    }

    function expectUntouched(r: ReturnType<typeof channelLevel>) {
        for (const out of r.parsers) expect(out).toEqual(["<Hier wird geplaudert>"]);
        expect(r.thread).toBe("Wie repariere ich mein Fahrrad?");
        expect(r.stage).toBe("Wir reden über Bücher");
        expect(r.forum).toBe(ORIGINAL);
        expect(r.tags).toBe("Hilfe gesucht");
    }

    it("a server channel switched off here gets no topic, status, title or tag translation", async () => {
        await toggleChannelOptOut("off1");
        expectUntouched(channelLevel("off1"));
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("with Global Auto off, only channels switched on get channel-level translation", async () => {
        settings.store.globalAuto = false;
        expectUntouched(channelLevel("plain1"));
        await toggleChannel("on1");
        const on = channelLevel("on1");
        // Allowed: the patch hands back our in-place component (Discord's
        // text shows until ✦ lands), not Discord's value itself.
        expect(on.thread).not.toBe("Wie repariere ich mein Fahrrad?");
        expect(on.parsers[0]).not.toEqual(["<Hier wird geplaudert>"]);
    });

    it("an event with no channel follows the server rule; one with a channel follows that channel", async () => {
        await toggleChannelOptOut("off2");
        expect(parsed("event", "Spieleabend für alle", { channelId: "off2", guildId: "g1" })).toEqual(["<Spieleabend für alle>"]);
        expect(parsed("event", "Spieleabend für alle", { guildId: "g1" })).not.toEqual(["<Spieleabend für alle>"]);
        expect(parsed("event", "Spieleabend für alle", {})).toEqual(["<Spieleabend für alle>"]);
    });
});

describe("size limits", () => {
    beforeEach(() => paid());

    it("a text over 2,000 characters is not sent and gets no line; the others in its batch still translate", async () => {
        const long = "Das ist ein sehr langer Absatz über Pizza. ".repeat(100).slice(0, 4096);
        const message = { ...embedMessage("big"), embeds: [{ rawTitle: "Neue Pizzeria in der Stadt", rawDescription: long }] };
        accessory(message);
        await settle();
        const sent = surfaceCalls().flatMap(c => JSON.parse(c[2]).messages.map((m: any) => m.text));
        expect(sent).toContain("Neue Pizzeria in der Stadt");
        expect(sent.some((t: string) => t.length > 2000)).toBe(false);
        const out = text(accessory(message));
        expect(out).toContain("✦ de · sharp: Neue Pizzeria in der Stadt");
        expect(out).not.toContain("sharp: Das ist ein sehr langer");
    });

    it("a batch of long fields splits so no request carries more than 20 KB", async () => {
        const field = (i: number) => ({ rawName: `Feld ${i}`, rawValue: `Abschnitt ${i}: ` + "Wir erklären hier alles über die Regeln. ".repeat(40).slice(0, 1_900) });
        const message = { ...embedMessage("fields"), embeds: [{ fields: Array.from({ length: 20 }, (_, i) => field(i)) }] };
        accessory(message);
        await settle(300_000);
        const relay = surfaceCalls("relay").map(c => JSON.parse(c[2]).messages as Array<{ text: string; }>);
        expect(relay.length).toBeGreaterThan(1);
        for (const batch of relay) {
            const bytes = batch.reduce((n, m) => n + new TextEncoder().encode(m.text).length, 0);
            expect(bytes).toBeLessThanOrEqual(20 * 1024);
        }
        expect(relay.flat().filter(m => m.text.startsWith("Abschnitt"))).toHaveLength(20);
    });
});

describe("budget and priority: messages always come first", () => {
    beforeEach(() => paid());

    /** Record when each call was made, so per-minute rates can be checked. */
    function timedAnswers() {
        const times: Array<{ at: number; engine: string; surface: boolean; ids: string[]; }> = [];
        native.translateBatch.mockImplementation(async (engine: string, _k: string, payload: string) => {
            const ids = JSON.parse(payload).messages.map((m: any) => m.id);
            times.push({ at: Date.now(), engine, surface: ids[0] === "s0", ids });
            return {
                ok: true,
                results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "de", text: `${engine}: ${m.text}`, skip: false, ...(engine === "google" ? { conf: 0.99 } : {}) }))
            };
        });
        return times;
    }

    it("scrolling a 1,000-row member list never sends more than 4 surface relay requests a minute, or any Google request", async () => {
        const times = timedAnswers();
        for (let i = 0; i < 1000; i++) stubActivities.set(`u${i}`, [{ type: 4, state: `Heute bin ich wirklich müde, Nummer ${i}` }]);
        // Twenty rows come into view every two seconds for 200 seconds.
        for (let step = 0; step < 50; step++) {
            for (let i = step * 20; i < step * 20 + 20; i++) decorator(`u${i}`);
            await settle(2_000);
        }
        await settle(120_000);
        const relay = times.filter(t => t.surface && t.engine === "relay").map(t => t.at);
        expect(relay.length).toBeGreaterThan(0);
        for (const at of relay) expect(relay.filter(x => x >= at && x < at + 60_000).length).toBeLessThanOrEqual(4);
        // Tight marks are ✦ only: no ≈ fan-out to Google.
        expect(times.filter(t => t.surface && t.engine === "google")).toEqual([]);
    });

    it("a message batch that arrives mid-scroll goes out on time, without waiting behind surfaces", async () => {
        const times = timedAnswers();
        __stubSetSelectedChannel("c1");
        for (let i = 0; i < 300; i++) stubActivities.set(`u${i}`, [{ type: 4, state: `Heute bin ich wirklich müde, Nummer ${i}` }]);
        // Enough queued statuses for the surfaces to take every slot they
        // may (all but the two they must leave), right before the message.
        for (let i = 0; i < 150; i++) decorator(`u${i}`);
        await settle(7_000);
        expect(times.filter(t => t.surface && t.engine === "relay").length).toBeGreaterThanOrEqual(2);
        const sentAt = Date.now();
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: { id: "live1", channel_id: "c1", content: "hola, ¿qué tal estáis todos?", author: { id: "u2", username: "ana" } } });
        for (let i = 150; i < 300; i++) decorator(`u${i}`);
        await settle(5_000);
        const message = times.find(t => t.engine === "relay" && t.ids.includes("live1"));
        expect(message).toBeDefined();
        // The quality debounce (1.5s) and nothing more: no wait at the gate.
        expect(message!.at - sentAt).toBeLessThan(2_000);
    });

    it("once 200 surface texts are spent today, surfaces stop asking for ✦ but messages still get it", async () => {
        const times = timedAnswers();
        await DataStore.set(SURFACE_BUDGET_KEY, { day: utcDay(Date.now()), used: SURFACE_DAILY_BUDGET });
        await restart(paid);
        stubActivities.set("u1", [{ type: 4, state: "Bin gleich zurück, muss kochen" }]);
        decorator("u1");
        accessory(embedMessage());
        await settle();
        expect(times.filter(t => t.surface && t.engine === "relay")).toEqual([]);
        // Roomy lines fall back to ≈; tight places keep Discord's original.
        expect(text(accessory(embedMessage()))).toContain("≈ de · google: Neue Pizzeria in der Stadt");
        expect(decorator("u1")).toBe("Bin gleich zurück, muss kochen");

        __stubSetSelectedChannel("c1");
        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: { id: "live2", channel_id: "c1", content: "hola, ¿qué tal estáis todos?", author: { id: "u2", username: "ana" } } });
        await settle();
        expect(times.some(t => t.engine === "relay" && t.ids.includes("live2"))).toBe(true);
    });

    it("the budget counts cost units: 1 + one per started 1,000 characters, so 10 units buy 5 statuses", async () => {
        const times = timedAnswers();
        await DataStore.set(SURFACE_BUDGET_KEY, { day: utcDay(Date.now()), used: SURFACE_DAILY_BUDGET - 10 });
        await restart(paid);
        for (let i = 0; i < 50; i++) stubActivities.set(`u${i}`, [{ type: 4, state: `Heute bin ich wirklich müde, Nummer ${i}` }]);
        for (let i = 0; i < 50; i++) decorator(`u${i}`);
        await settle(300_000);
        const texts = times.filter(t => t.surface && t.engine === "relay").reduce((n, t) => n + t.ids.length, 0);
        expect(texts).toBe(5);
    });

    it("surfaces pause entirely while Google or the relay is cooling down", async () => {
        const times = timedAnswers();
        setCooldown("google", Date.now() + 10 * 60_000);
        accessory(embedMessage());
        stubActivities.set("u1", [{ type: 4, state: "Bin gleich zurück, muss kochen" }]);
        decorator("u1");
        await settle();
        expect(times.filter(t => t.surface)).toEqual([]);
    });

    it("roomy lines ask Google one text at a time", async () => {
        const times = timedAnswers();
        accessory(embedMessage());
        await settle();
        const google = native.translateBatch.mock.calls.find(c => c[0] === "google" && JSON.parse(c[2]).messages[0]?.id === "s0");
        expect(JSON.parse(google![2]).maxConcurrency).toBe(1);
        void times;
    });
});

describe("the reply bar", () => {
    const props = (quoted: any, extra: Record<string, unknown> = {}) =>
        ({ referencedMessage: { state: 0, message: quoted }, baseMessage: { id: "b1" }, ...extra });
    const bar = (quoted: any, extra: Record<string, unknown> = {}) => deep(P.replyQuoteChildren(ORIGINAL, props(quoted, extra)));
    const quoted = (id: string, channelId = "c1", content = "Kommst du heute Abend zum Essen?", more: Record<string, unknown> = {}) =>
        ({ id, channel_id: channelId, content, ...more });

    it("an install that owns nothing gets Discord's quoted line back, the very same value", async () => {
        await restart(() => DataStore.clearEntitlementForTest());
        expect(P.replyQuoteChildren(ORIGINAL, props(quoted("q1")))).toBe(ORIGINAL);
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("shows a quoted code decoded in place, original on hover, on any plan and with nothing sent", async () => {
        const morse = ".... .- .--. .--. -.-- / -... .. .-. - .... -.. .- -.-- / @Gojer";
        const free = bar(quoted("q9", "c1", morse));
        expect(free.type).toBe("span");
        expect(free.props.title).toBe(morse);
        expect(text(free)).toBe("decoded · morse · <md:HAPPY BIRTHDAY @Gojer|c1>");
        paid();
        setTranslation(makeKey("q9", "en"), { skipped: true, via: "google" } as any);
        expect(text(bar(quoted("q9", "c1", morse)))).toBe("decoded · morse · <md:HAPPY BIRTHDAY @Gojer|c1>");
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("decodes only the code in a quoted message that is partly words", () => {
        expect(text(bar(quoted("q8", "c1", "or ..-. ..- -.-. -.- / -.-- --- ..- / .... .- -.- .- ..")))).toBe("decoded · morse · <md:or FUCK YOU HAKAI|c1>");
    });

    it("reuses the quoted message's translation, in place of the quoted line, original in the tooltip; nothing sent", async () => {
        paid();
        setTranslation(makeKey("q1", "en"), { lang: "de", text: "Are you coming to dinner tonight?", via: "relay" });
        expectInPlace(bar(quoted("q1")), "Kommst du heute Abend zum Essen?", "<md:Are you coming to dinner tonight?|c1>");
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("with no cached translation, shows Discord's line and asks (✦ only) when the quoted channel translates messages", async () => {
        paid();
        expect(bar(quoted("q2"))).toEqual(ORIGINAL);
        await settle();
        expect(surfaceCalls("google")).toEqual([]);
        expectInPlace(bar(quoted("q2")), "Kommst du heute Abend zum Essen?", "<md:sharp: Kommst du heute Abend zum Essen?|c1>");
    });

    it("never asks for a quoted message from a DM that is not turned on, or a switched-off channel", async () => {
        paid();
        __stubMarkAsDm("d1");
        await toggleChannelOptOut("off9");
        expect(bar(quoted("q3", "d1"))).toEqual(ORIGINAL);
        expect(bar(quoted("q4", "off9"))).toEqual(ORIGINAL);
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("keeps Discord's line for a quoted message already in the reader's language", () => {
        paid();
        setTranslation(makeKey("q5", "en"), { skipped: true, via: "relay" });
        expect(bar(quoted("q5"))).toEqual(ORIGINAL);
    });

    it("blocked, ignored and suspended authors: Discord's own line, the same value, and nothing sent", async () => {
        paid();
        setTranslation(makeKey("q1", "en"), { lang: "de", text: "Are you coming to dinner tonight?", via: "relay" });
        expect(P.replyQuoteChildren(ORIGINAL, props(quoted("q1"), { isReplyAuthorBlocked: true }))).toBe(ORIGINAL);
        expect(P.replyQuoteChildren(ORIGINAL, props(quoted("q7"), { isReplyAuthorIgnored: true }))).toBe(ORIGINAL);
        expect(P.replyQuoteChildren(ORIGINAL, props(quoted("q1", "c1", "Kommst du?", { hasFlag: (f: number) => f === 1 << 17 })))).toBe(ORIGINAL);
        expect(P.replyQuoteChildren(ORIGINAL, props(quoted("q7", "c1", "Kommst du?", { flags: (1 << 17) | 4 })))).toBe(ORIGINAL);
        await settle();
        expect(surfaceCalls()).toEqual([]);
        // The same message without the flag is translated.
        expectInPlace(bar(quoted("q1", "c1", "Kommst du heute Abend zum Essen?", { hasFlag: () => false })), "Kommst du heute Abend zum Essen?", "<md:Are you coming to dinner tonight?|c1>");
    });

    it("a quoted message in the loaded message list is left to the message pipeline: no surface request", async () => {
        paid();
        stubMessages.set("c1", [{ id: "q8", channel_id: "c1", content: "Wo treffen wir uns morgen früh?" }]);
        expect(bar(quoted("q8", "c1", "Wo treffen wir uns morgen früh?"))).toEqual(ORIGINAL);
        await settle();
        expect(surfaceCalls()).toEqual([]);
        setTranslation(makeKey("q8", "en"), { lang: "de", text: "Where do we meet tomorrow morning?", via: "relay" });
        expectInPlace(bar(quoted("q8", "c1", "Wo treffen wir uns morgen früh?")), "Wo treffen wir uns morgen früh?", "<md:Where do we meet tomorrow morning?|c1>");
    });
});

describe("the custom status bubble", () => {
    const status = "Só sei que nada sei, mas gosto de aprender";

    it("a non-paid install gets Discord's own text back, the same string", () => {
        expect(P.statusBubbleChildren(status)).toBe(status);
        expect(P.statusBubbleChildren(undefined)).toBeUndefined();
    });

    it("paid: the original text, then a second smaller line \"✦ translation\" inside the bubble, bio or not", async () => {
        paid();
        stubProfiles.set("u1", { bio: "Ich liebe Pizza" });
        expect(P.statusBubbleChildren(status)).toBe(status);
        await settle();
        const out = P.statusBubbleChildren(status);
        expect(out[0]).toBe(status);
        const line = out[1];
        expect(line.type).toBe("div");
        expect(line.props.style).toMatchObject({ whiteSpace: "normal", overflowWrap: "anywhere" });
        expect(text(line)).toBe("✦ sharp: " + status);
        // ✦ only: no ≈ request for the bubble.
        expect(surfaceCalls("google")).toEqual([]);
    });

    it("the bubble's re-measure hook returns a version number and never throws", () => {
        expect(typeof P.useSurfaceVersion()).toBe("number");
        plugin.stop!();
        expect(typeof P.useSurfaceVersion()).toBe("number");
    });
});

describe("markup in tight swaps: readable text out, Discord's parser in", () => {
    beforeEach(() => {
        paid();
        __stubSetUser("900000000000000009", { username: "deniz" });
        __stubSetChannelName("700000000000000007", "allgemein");
    });

    /** The relay echoes the German text back in "translation", keeping names and :emoji: as sent. */
    function echoTranslation(prefix = "EN ") {
        native.translateBatch.mockImplementation(async (_e: string, _k: string, payload: string) => ({
            ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "de", text: prefix + m.text, skip: false }))
        }));
    }
    const sentTexts = () => surfaceCalls("relay").flatMap(c => JSON.parse(c[2]).messages.map((m: any) => m.text as string));
    /** The wrapped parser: records what it was asked to render, and with which state. */
    const rendered: string[] = [];
    const parseWith = (parser: string, source: string, state: unknown = { channelId: "c1" }) =>
        deep(P.wrapParser(parser, (t: string, _i: unknown, st: any) => { rendered.push(`${t}|${st?.channelId}`); return [`<p:${t}>`]; })(source, true, state));

    it("a header topic with a link, a channel mention and a custom emoji: readable text goes out, the translation is rendered by the same parser with its tokens back", async () => {
        echoTranslation();
        const topic = "Regeln lesen in <#700000000000000007> und https://example.com/regeln <:blobwave:123456789012345678>";
        expect(parseWith("topic-truncated", topic)).toEqual([`<p:${topic}>`]);
        await settle();
        expect(sentTexts()).toEqual(["Regeln lesen in #allgemein und https://example.com/regeln :blobwave:"]);
        rendered.length = 0;
        const out = parseWith("topic-truncated", topic);
        expect(out.props.title).toBe("Regeln lesen in #allgemein und https://example.com/regeln :blobwave:");
        // Discord's parser gets the translation with the raw tokens restored, and the same state.
        expect(rendered).toContain(`EN Regeln lesen in <#700000000000000007> und https://example.com/regeln <:blobwave:123456789012345678>|c1`);
        expect(text(out)).toBe(`✦ <p:EN Regeln lesen in <#700000000000000007> und https://example.com/regeln <:blobwave:123456789012345678>>`);
    });

    it("a voice status with a custom emoji and a user mention renders the same way", async () => {
        echoTranslation();
        const status = "Zocken mit <@900000000000000009> <a:party:223456789012345678>";
        parseWith("voice-status", status);
        await settle();
        expect(sentTexts()).toContain("Zocken mit @deniz :party:");
        const out = parseWith("voice-status", status);
        expect(text(out)).toBe("✦ <p:EN Zocken mit <@900000000000000009> <a:party:223456789012345678>>");
        expect(out.props.title).toBe("Zocken mit @deniz :party:");
    });

    it("a model that answers with raw Discord tokens: Discord's original stays", async () => {
        native.translateBatch.mockImplementation(async (_e: string, _k: string, payload: string) => ({
            ok: true, results: JSON.parse(payload).messages.map((m: any) => ({ id: m.id, lang: "de", text: "Read the rules in <#999> <@&42>", skip: false }))
        }));
        const topic = "Lies die Regeln im Kanal <#700000000000000007>";
        parseWith("topic-truncated", topic);
        await settle();
        expect(parseWith("topic-truncated", topic)).toEqual([`<p:${topic}>`]);
    });

    it("a parser that throws on the translation: Discord's original stays", async () => {
        echoTranslation();
        const source = "Heute Abend gemütliche Runde";
        let calls = 0;
        const wrapped = P.wrapParser("voice-status", (t: string) => { calls++; if (calls > 1) throw new Error("bad"); return [`<p:${t}>`]; });
        wrapped(source, true, { channelId: "c1" });
        await settle();
        calls = 0;
        expect(deep(wrapped(source, true, { channelId: "c1" }))).toEqual([`<p:${source}>`]);
    });

    it("the reply bar renders the translation with Discord's markdown parser, readable text out and as the tooltip", async () => {
        echoTranslation();
        const q = { id: "q20", channel_id: "c1", content: "Frag <@900000000000000009> in <#700000000000000007> <:blobwave:123456789012345678>" };
        const props = { referencedMessage: { state: 0, message: q } };
        expect(deep(P.replyQuoteChildren(ORIGINAL, props))).toEqual(ORIGINAL);
        await settle();
        expect(sentTexts()).toContain("Frag @deniz in #allgemein :blobwave:");
        const out = deep(P.replyQuoteChildren(ORIGINAL, props));
        expect(out.props.title).toBe("Frag @deniz in #allgemein :blobwave:");
        expect(text(out)).toBe("✦ <md:EN Frag <@900000000000000009> in <#700000000000000007> <:blobwave:123456789012345678>|c1>");
    });

    it("a reply whose cached translation carries raw tokens keeps Discord's line", () => {
        setTranslation(makeKey("q21", "en"), { lang: "de", text: "Ask <@12345> about it", via: "relay" });
        const q = { id: "q21", channel_id: "c1", content: "Frag ihn danach" };
        expect(deep(P.replyQuoteChildren(ORIGINAL, { referencedMessage: { state: 0, message: q } }))).toEqual(ORIGINAL);
    });

    it("the thread title and stage topic keep a real aria-label: the translation once known, else the original", async () => {
        const title = "Wie repariere ich mein Fahrrad?";
        expect(threadProps(title)["aria-label"]).toBe(title);
        await settle();
        const props = threadProps(title);
        expect(props["aria-label"]).toBe(`EN ${title}`.replace("EN ", "sharp: "));
        expect(typeof stageProps("Wir reden über Bücher")["aria-label"]).toBe("string");
    });
});

