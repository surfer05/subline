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
    __resetWebpackCommon, __stubMarkAsDm, __stubSetChannel, __stubSetSelectedChannel, FluxDispatcher, PresenceStore, shownToasts, stubActivities, stubMessageById, stubProfiles
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
const decorator = (userId: string) => deep((plugin as any).renderMemberListDecorator({ user: { id: userId }, type: "guild" }));
const profile = (props: any) => deep((plugin as any).renderProfileSurface(props));
const P = plugin as any;
const bioLine = (props: any) => deep(P.renderBioLine(props));
const GUILD_CHANNEL = { id: "c1", guild_id: "g1" };
/** Discord's own child, which a non-paid install must get back as the SAME value. */
const ORIGINAL = { type: "discord-original", props: {}, children: [] };
const thread = (title: unknown, channel: unknown = GUILD_CHANNEL) => deep(P.threadTitleChildren(ORIGINAL, title, channel));
const stage = (topic: unknown, channel: unknown = GUILD_CHANNEL) => deep(P.stageTopicChildren(ORIGINAL, topic, channel));
const forumTitle = (channel: unknown) => deep(P.forumTitleChildren(ORIGINAL, channel));
const tagsMark = (channel: any) => deep(P.renderForumTagsMark(channel));
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
    it("registers the message accessory, the member-list decorator and the profile patch", () => {
        expect(accessories.has(SURFACE_ACCESSORY_ID)).toBe(true);
        expect(typeof (plugin as any).renderMemberListDecorator).toBe("function");
        const patch = (plugin as any).patches[0];
        expect(patch.find).toBe("#{intl::USER_PROFILE_PRONOUNS}");
        expect(patch.replacement[0].replace).toContain("$self.renderProfileSurface(arguments[0])");
    });

    it("removes its accessory on stop", () => {
        plugin.stop!();
        expect(accessories.has(SURFACE_ACCESSORY_ID)).toBe(false);
        expect(__surfaceService()).toBeNull();
    });

    it("the settings toggle exists, defaults on, and is hidden without a code", () => {
        const def = (settings as any).def.translateSurfaces;
        expect(def.description).toBe("Translate profiles, embeds and more");
        expect(settings.store.translateSurfaces).toBe(true);
        expect(def.hidden()).toBe(true);
        paid();
        expect(def.hidden()).toBe(false);
    });
});

describe("free and trial installs see no change", () => {
    function renderEverything() {
        stubActivities.set("u1", [{ type: 4, state: "Bin gleich zurück" }]);
        stubProfiles.set("u1", { bio: "Ich liebe Pizza" });
        return [
            accessory(embedMessage()),
            decorator("u1"),
            profile({ user: { id: "u1" } }),
            bioLine({ userId: "u1", userBio: "Ich liebe Pizza" }),
            tagsMark({ guild_id: "g1", parent_id: "f1", appliedTags: ["t1"] })
        ];
    }

    /** Patches that wrap Discord's own child hand back that very child. */
    function childrenUntouched() {
        expect(P.threadTitleChildren(ORIGINAL, "Wie repariere ich mein Fahrrad?", GUILD_CHANNEL)).toBe(ORIGINAL);
        expect(P.stageTopicChildren(ORIGINAL, "Wir reden über Bücher", GUILD_CHANNEL)).toBe(ORIGINAL);
        expect(P.forumTitleChildren(ORIGINAL, { ...GUILD_CHANNEL, name: "Hilfe beim Kochen" })).toBe(ORIGINAL);
        expect(P.onboardingHeading(ORIGINAL, { title: "Was spielst du gern?", options: [] })).toBe(ORIGINAL);
    }

    /** Discord's own parser output, which must come back untouched. */
    function parsersUntouched() {
        for (const p of ["topic", "topic-truncated", "voice-status", "rule", "guidelines", "event"]) {
            expect(parsed(p, "Hier wird geplaudert")).toEqual(["<Hier wird geplaudert>"]);
        }
    }

    it("a free install renders nothing extra and sends zero surface requests", async () => {
        expect(renderEverything()).toEqual([null, null, null, null, null]);
        parsersUntouched();
        childrenUntouched();
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("a trial the relay has confirmed sends zero surface requests too", async () => {
        native.relayStatus.mockResolvedValue({ ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: Date.now() + 5 * DAY_MS });
        await restart();
        await settle(100);
        expect(renderEverything()).toEqual([null, null, null, null, null]);
        parsersUntouched();
        childrenUntouched();
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("a paid install with the setting off sends zero surface requests", async () => {
        paid();
        settings.store.translateSurfaces = false;
        expect(renderEverything()).toEqual([null, null, null, null, null]);
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

    it("a reply preview reuses the quoted message's translation instead of buying it again", async () => {
        stubMessageById.set("c1:q1", { id: "q1", content: "Kommst du heute Abend?" });
        setTranslation(makeKey("q1", "en"), { lang: "de", text: "Are you coming tonight?", via: "relay" });
        const reply = { ...embedMessage("m3"), embeds: [], type: 19, messageReference: { channel_id: "c1", message_id: "q1" } };
        const out = text(accessory(reply));
        expect(out).toContain("Reply · ✦ de · Are you coming tonight?");
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("a reply preview with no translation yet is translated as a surface", async () => {
        stubMessageById.set("c1:q2", { id: "q2", content: "Wo treffen wir uns morgen?" });
        const reply = { ...embedMessage("m4"), embeds: [], type: 19, messageReference: { channel_id: "c1", message_id: "q2" } };
        accessory(reply);
        await settle();
        expect(text(accessory(reply))).toContain("Reply · ✦ de · sharp: Wo treffen wir uns morgen?");
    });

    it("fifty statuses in the member list make two relay requests, and rows get only an inline mark", async () => {
        for (let i = 0; i < 50; i++) stubActivities.set(`u${i}`, [{ type: 4, state: `Heute bin ich müde, Nummer ${i}` }]);
        for (let i = 0; i < 50; i++) expect(decorator(`u${i}`)).toBeNull();
        await settle();
        expect(surfaceCalls("relay")).toHaveLength(2);
        const mark = decorator("u7");
        expect(mark.type).toBe("span");
        expect(text(mark)).toBe("✦");
        expect(findTitle(mark)).toBe("Status (✦ de): sharp: Heute bin ich müde, Nummer 7");
    });

    it("the profile name row marks the status when there is no bio", async () => {
        stubActivities.set("u1", [{ type: 4, state: "Bin gleich zurück" }]);
        profile({ user: { id: "u1" } });
        await settle();
        expect(findTitle(profile({ user: { id: "u1" } }))).toBe("Status (✦ de): sharp: Bin gleich zurück");
    });

    it("the header topic and voice channel status get a ✦ before them; the topic popout, rules, guidelines and events a line after", async () => {
        const topic = "Hier plaudern wir über alles Mögliche";
        parsed("topic-truncated", topic);
        await settle();
        const tight = parsed("topic-truncated", topic);
        expect(tight[1]).toEqual([`<${topic}>`]);
        expect(tight[0].type).toBe("span");
        expect(findTitle(tight[0])).toBe(`Description (✦ de): sharp: ${topic}`);

        const voice = parsed("voice-status", "Wir spielen gerade Minecraft");
        await settle();
        expect(findTitle(parsed("voice-status", "Wir spielen gerade Minecraft"))).toContain("Voice status (✦ de): sharp: Wir spielen gerade Minecraft");
        void voice;

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

    it("thread titles, stage topics and forum titles get a ✦ beside Discord's own element, which is untouched", async () => {
        thread("Wie repariere ich mein Fahrrad?");
        stage("Wir reden über Bücher");
        forumTitle({ ...GUILD_CHANNEL, name: "Hilfe beim Kochen gesucht" });
        await settle();
        // One flex row: the mark, then Discord's element in a shrinkable cell.
        const t = thread("Wie repariere ich mein Fahrrad?");
        expect(t.type).toBe("span");
        expect(t.props.style).toEqual({ display: "flex", alignItems: "center", minWidth: 0, gap: 4 });
        const [markCell, originalCell] = t.children;
        expect(findTitle(markCell)).toBe("Title (✦ de): sharp: Wie repariere ich mein Fahrrad?");
        expect(originalCell.props.style).toMatchObject({ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" });
        expect(originalCell.children).toEqual([ORIGINAL]);
        expect(findTitle(stage("Wir reden über Bücher"))).toBe("Stage topic (✦ de): sharp: Wir reden über Bücher");
        expect(findTitle(forumTitle({ ...GUILD_CHANNEL, name: "Hilfe beim Kochen gesucht" }))).toBe("Title (✦ de): sharp: Hilfe beim Kochen gesucht");
    });

    it("forum tags get a tight ✦ at the end of the tag row", async () => {
        __stubSetChannel("f1", { id: "f1", availableTags: [{ id: "t1", name: "Hilfe gesucht" }, { id: "t2", name: "Gelöst" }] });
        const post = { id: "p1", guild_id: "g1", parent_id: "f1", appliedTags: ["t1", "t2"] };
        tagsMark(post);
        await settle();
        const tags = findTitle(tagsMark(post));
        expect(tags).toContain("Tag (✦ de): sharp: Hilfe gesucht");
        expect(tags).toContain("Tag (✦ de): sharp: Gelöst");
    });

    it("the bio gets a line under it with the status; the name row then stays quiet", async () => {
        stubActivities.set("u1", [{ type: 4, state: "Bin gleich zurück" }]);
        stubProfiles.set("u1", { bio: "Ich liebe Pizza und lange Spaziergänge" });
        bioLine({ userId: "u1", userBio: "Ich liebe Pizza und lange Spaziergänge" });
        await settle();
        const out = text(bioLine({ userId: "u1", userBio: "Ich liebe Pizza und lange Spaziergänge" }));
        expect(out).toContain("✦ de · sharp: Ich liebe Pizza und lange Spaziergänge");
        expect(out).toContain("Status · ✦ de · sharp: Bin gleich zurück");
        expect(profile({ user: { id: "u1" } })).toBeNull();
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
        const original = PresenceStore.getActivities;
        PresenceStore.getActivities = () => { throw new Error("Discord changed"); };
        try {
            expect(decorator("u1")).toBeNull();
            expect(profile({ user: { id: "u1" } })).toBeNull();
        } finally {
            PresenceStore.getActivities = original;
        }
        expect(profile(undefined)).toBeNull();
        expect(profile({ user: null })).toBeNull();
        expect(accessory(null)).toBeNull();
        expect(P.threadTitleChildren(ORIGINAL, undefined, GUILD_CHANNEL)).toBe(ORIGINAL);
        expect(P.stageTopicChildren(ORIGINAL, "Wir reden", undefined)).toBe(ORIGINAL);
        expect(tagsMark(undefined)).toBeNull();
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

    it("a reply quoting a DM message is not translated from a server channel", async () => {
        __stubMarkAsDm("d1");
        stubMessageById.set("d1:q9", { id: "q9", content: "Das ist privat, bitte nicht weitersagen" });
        const reply = { ...embedMessage("m9"), embeds: [], type: 19, messageReference: { channel_id: "d1", message_id: "q9" } };
        expect(accessory(reply)).toBeNull();
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("channel-level text in a DM (topic, voice status, titles) is never translated", async () => {
        __stubMarkAsDm("d1");
        for (const p of ["topic", "topic-truncated", "voice-status", "guidelines", "event"]) {
            expect(parsed(p, "Hier wird geplaudert", { channelId: "d1" })).toEqual(["<Hier wird geplaudert>"]);
        }
        const dm = { id: "d1" };
        expect(P.threadTitleChildren(ORIGINAL, "Wie repariere ich mein Fahrrad?", dm)).toBe(ORIGINAL);
        expect(P.stageTopicChildren(ORIGINAL, "Wir reden über Bücher", dm)).toBe(ORIGINAL);
        expect(P.forumTitleChildren(ORIGINAL, { ...dm, name: "Hilfe beim Kochen" })).toBe(ORIGINAL);
        expect(tagsMark({ ...dm, parent_id: "f1", appliedTags: ["t1"] })).toBeNull();
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
            thread: P.threadTitleChildren(ORIGINAL, "Wie repariere ich mein Fahrrad?", channel),
            stage: P.stageTopicChildren(ORIGINAL, "Wir reden über Bücher", channel),
            forum: P.forumTitleChildren(ORIGINAL, { ...channel, name: "Hilfe beim Kochen" }),
            tags: tagsMark(channel)
        };
    }

    function expectUntouched(r: ReturnType<typeof channelLevel>) {
        for (const out of r.parsers) expect(out).toEqual(["<Hier wird geplaudert>"]);
        expect(r.thread).toBe(ORIGINAL);
        expect(r.stage).toBe(ORIGINAL);
        expect(r.forum).toBe(ORIGINAL);
        expect(r.tags).toBeNull();
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
        expect(on.parsers[1]).not.toEqual(["<Hier wird geplaudert>"]);
        expect(on.thread).not.toBe(ORIGINAL);
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
        // Roomy lines fall back to ≈; tight marks show nothing.
        expect(text(accessory(embedMessage()))).toContain("≈ de · google: Neue Pizzeria in der Stadt");
        expect(decorator("u1")).toBeNull();

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
