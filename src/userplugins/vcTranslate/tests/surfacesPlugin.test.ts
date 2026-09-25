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

import plugin, { __surfaceService, SURFACE_ACCESSORY_ID, SURFACE_CHANNEL_BUTTON_ID } from "../index";
import settings from "../settings";
import { clearStore, makeKey, setTranslation } from "../store";
import { SURFACE_CACHE_KEY } from "../surfaces/cache";
import { __resetTaste } from "../taste";
import * as DataStore from "./stubs/api-datastore";
import { ChatBarButtonMap } from "./stubs/api-chatbuttons";
import { accessories } from "./stubs/api-messageaccessories";
import { __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import { __resetSettings } from "./stubs/api-settings";
import {
    __resetWebpackCommon, __stubSetSelectedChannel, PresenceStore, shownToasts, stubActivities, stubEvents, stubMessageById, stubProfiles
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
const chatHint = (channel: any) => deep(ChatBarButtonMap.get(SURFACE_CHANNEL_BUTTON_ID)!.render({ channel }));

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
    it("registers the message accessory, the chat-bar hint, the member-list decorator and the profile patch", () => {
        expect(accessories.has(SURFACE_ACCESSORY_ID)).toBe(true);
        expect(ChatBarButtonMap.has(SURFACE_CHANNEL_BUTTON_ID)).toBe(true);
        expect(typeof (plugin as any).renderMemberListDecorator).toBe("function");
        const patch = (plugin as any).patches[0];
        expect(patch.find).toBe("#{intl::USER_PROFILE_PRONOUNS}");
        expect(patch.replacement.replace).toContain("$self.renderProfileSurface(arguments[0])");
    });

    it("removes its accessory and chat-bar hint on stop", () => {
        plugin.stop!();
        expect(accessories.has(SURFACE_ACCESSORY_ID)).toBe(false);
        expect(ChatBarButtonMap.has(SURFACE_CHANNEL_BUTTON_ID)).toBe(false);
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
            chatHint({ id: "c1", topic: "Hier wird geplaudert", isThread: () => false })
        ];
    }

    it("a free install renders nothing extra and sends zero surface requests", async () => {
        expect(renderEverything()).toEqual([null, null, null, null]);
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("a trial the relay has confirmed sends zero surface requests too", async () => {
        native.relayStatus.mockResolvedValue({ ok: true, plan: "trial", used: 0, cap: 300, trialEndsAt: Date.now() + 5 * DAY_MS });
        await restart();
        await settle(100);
        expect(renderEverything()).toEqual([null, null, null, null]);
        await settle();
        expect(surfaceCalls()).toEqual([]);
    });

    it("a paid install with the setting off sends zero surface requests", async () => {
        paid();
        settings.store.translateSurfaces = false;
        expect(renderEverything()).toEqual([null, null, null, null]);
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

    it("the profile row gets one mark covering status and bio", async () => {
        stubActivities.set("u1", [{ type: 4, state: "Bin gleich zurück" }]);
        stubProfiles.set("u1", { bio: "Ich liebe Pizza und lange Spaziergänge" });
        profile({ user: { id: "u1" } });
        await settle();
        const title = findTitle(profile({ user: { id: "u1" } }));
        expect(title).toContain("Status (✦ de): sharp: Bin gleich zurück");
        expect(title).toContain("About me (✦ de): sharp: Ich liebe Pizza und lange Spaziergänge");
    });

    it("the chat bar marks the open channel's topic, thread title, tags and live event", async () => {
        stubEvents.set("g1", [{ channel_id: "t1", status: 2, name: "Spieleabend mit allen" }]);
        const channel = {
            id: "t1", guild_id: "g1", parent_id: "f1", name: "Wie repariere ich mein Fahrrad?",
            topic: "", appliedTags: [], isThread: () => true
        };
        chatHint(channel);
        await settle();
        const title = findTitle(chatHint(channel));
        expect(title).toContain("Title (✦ de): sharp: Wie repariere ich mein Fahrrad?");
        expect(title).toContain("Event (✦ de): sharp: Spieleabend mit allen");
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
        expect(chatHint(undefined)).toBeNull();
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
