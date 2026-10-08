import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
    const translateBatch = vi.fn();
    const reportStatus = vi.fn(async (_json: string) => true);
    const relayPatchHealth = vi.fn(async (_install: string, _json: string) => true);
    (globalThis as any).VencordNative = {
        pluginHelpers: { VcTranslate: { translateBatch, reportStatus, relayPatchHealth } }
    };
    return { translateBatch, reportStatus, relayPatchHealth };
});

import plugin from "../index";
import settings from "../settings";
import { clearStore } from "../store";
import {
    createPatchHealthWatch, FALLBACK_MS, findFailedPatches, findName, HEALTH_STORE_KEY, MAX_FIND_CHARS,
    runPatchHealthCheck, scanFromVencord, SETTLE_MS, type CheckDeps, type FailedPatch, type PatchLike
} from "../patchHealth";
import { BUILD_ID, PLUGIN_VERSION } from "../buildStamp";
import { __resetSettings } from "./stubs/api-settings";
import * as DataStore from "./stubs/api-datastore";
import { __reset as __resetMessagePopover } from "./stubs/api-messagepopover";
import { __resetLogCalls } from "./stubs/utils-logger";
import { __resetWebpackCommon, __stubSetSelectedChannel, FluxDispatcher } from "./stubs/webpack-common";

const noYield = async () => { };

/** Module sources as Vencord would show them (String(factory)). */
const MODULES = [
    "function(e,t,n){let a=renderSuppressConfirmModal;return{children:[x,this.renderSuppressConf()]}}",
    "function(e,t,n){forum-tag-1;lineClamp:1,color:\"currentColor\",children:q}",
    "function(e,t,n){dup-find here}",
    "function(e,t,n){dup-find there}"
];

function scan(patches: Array<[string, PatchLike]>, opts: { pending?: unknown[]; messagesSeen?: boolean; modules?: string[]; } = {}) {
    const byPlugin = new Map<string, PatchLike[]>();
    for (const [p, patch] of patches) byPlugin.set(p, [...(byPlugin.get(p) ?? []), patch]);
    return findFailedPatches({
        plugins: [...byPlugin].map(([plugin, ps]) => ({ plugin, patches: ps })),
        pending: new Set(opts.pending ?? []),
        moduleSources: () => opts.modules ?? MODULES,
        messagesSeen: opts.messagesSeen ?? true,
        yieldFn: noYield,
        yieldEvery: 2
    });
}

describe("findFailedPatches", () => {
    it("reports nothing when every patch applies", async () => {
        expect(await scan([
            ["MessageAccessoriesAPI", { find: "renderSuppressConf", replacement: { match: /children:\[(x)/, replace: "children:[$1,y" } }],
            ["VcTranslate", { find: "forum-tag-", replacement: [{ match: /children:(\w)/, replace: "children:wrap($1)" }] }]
        ])).toEqual([]);
    });

    it("nomatch: the module is there but a replacement no longer changes it", async () => {
        expect(await scan([
            ["VcTranslate", { find: "forum-tag-", replacement: [{ match: /children:(\w)/, replace: "children:w($1)" }, { match: /gone/, replace: "x" }] }]
        ])).toEqual([{ plugin: "VcTranslate", find: "forum-tag-", state: "nomatch" }]);
    });

    it("applies replacements in order, like Vencord", async () => {
        // The second match only exists after the first replacement ran.
        expect(await scan([
            ["VcTranslate", { find: "forum-tag-", replacement: [{ match: /children:q/, replace: "children:MARK" }, { match: /MARK/, replace: "done" }] }]
        ])).toEqual([]);
    });

    it("a noWarn replacement may have no effect", async () => {
        expect(await scan([
            ["VcTranslate", { find: "forum-tag-", replacement: [{ match: /gone/, replace: "x", noWarn: true }] }]
        ])).toEqual([]);
    });

    it("multi: the find occurs in two loaded modules", async () => {
        expect(await scan([["VcTranslate", { find: "dup-find", replacement: { match: /here/, replace: "x" } }]]))
            .toEqual([{ plugin: "VcTranslate", find: "dup-find", state: "multi" }]);
        // An `all` patch may hit many.
        expect(await scan([["VcTranslate", { find: "dup-find", all: true, replacement: { match: /zzz/, replace: "x" } }]])).toEqual([]);
    });

    it("nofind only for the message body API, only while pending, only after messages loaded", async () => {
        const gone: PatchLike = { find: "noSuchFind", replacement: { match: /a/, replace: "b" } };
        expect(await scan([["MessageAccessoriesAPI", gone]], { pending: [gone] }))
            .toEqual([{ plugin: "MessageAccessoriesAPI", find: "noSuchFind", state: "nofind" }]);
        // Lazily loaded modules: a missing find elsewhere is not knowable here.
        expect(await scan([["VcTranslate", gone]], { pending: [gone] })).toEqual([]);
        // Before any message list is on screen, the module may not be loaded yet.
        expect(await scan([["MessageAccessoriesAPI", gone]], { pending: [gone], messagesSeen: false })).toEqual([]);
        // Already applied (Vencord removed it from its pending list).
        expect(await scan([["MessageAccessoriesAPI", gone]], { pending: [] })).toEqual([]);
    });

    it("skips a patch whose predicate is false, and survives one that throws", async () => {
        const bad: PatchLike = { find: "forum-tag-", predicate: () => false, replacement: { match: /gone/, replace: "x" } };
        const boom: PatchLike = { find: "forum-tag-", predicate: () => { throw new Error("x"); }, replacement: { match: /gone/, replace: "x" } };
        expect(await scan([["VcTranslate", bad], ["VcTranslate", boom]])).toEqual([]);
    });

    it("regex finds and global matches are tested from the start every time", async () => {
        const find = /forum-tag-\d/g;
        find.lastIndex = 999;
        expect(await scan([["VcTranslate", { find, replacement: { match: /children:(\w)/g, replace: "c:$1" } }]])).toEqual([]);
    });

    it("names are printable ASCII and bounded", () => {
        expect(findName("aé\nb")).toBe("a??b");
        expect(findName("x".repeat(500))).toHaveLength(MAX_FIND_CHARS);
        expect(findName(/a\.b/)).toBe("/a\\.b/");
    });

    it("yields to the UI between slices", async () => {
        const pause = vi.fn(async () => { });
        await findFailedPatches({
            plugins: [{ plugin: "VcTranslate", patches: [{ find: "x", replacement: { match: /x/, replace: "y" } }] }],
            pending: new Set(), moduleSources: () => Array.from({ length: 10 }, () => "x"), messagesSeen: true,
            yieldEvery: 3, yieldFn: pause
        });
        expect(pause).toHaveBeenCalledTimes(3);
    });
});

describe("scanFromVencord", () => {
    function vencord(over: Record<string, unknown> = {}) {
        const patch = { find: "renderSuppressConf", replacement: [{ match: /gone/, replace: "x" }] };
        const m: Record<string, unknown> = {};
        MODULES.forEach((src, i) => { m[String(i)] = { toString: () => src }; });
        // Factories are functions in Discord; give these a function shape whose String() is the source.
        for (const k of Object.keys(m)) { const src = MODULES[Number(k)]!; const f = function () { }; f.toString = () => src; m[k] = f; }
        return {
            Plugins: { plugins: { MessageAccessoriesAPI: { patches: [patch] }, NotOurs: { patches: [{ find: "dup-find", replacement: [] }] } }, isPluginEnabled: () => true },
            WebpackPatcher: { patches: [], getBuildNumber: () => 451234 },
            Webpack: { wreq: { m } },
            ...over
        };
    }

    it("reads plugins, pending patches and module sources from the running Vencord", async () => {
        expect(await scanFromVencord(vencord(), true, noYield)).toEqual([{ plugin: "MessageAccessoriesAPI", find: "renderSuppressConf", state: "nomatch" }]);
    });

    it("skips disabled plugins and plugins Subline does not depend on", async () => {
        const v = vencord();
        (v as any).Plugins.isPluginEnabled = () => false;
        expect(await scanFromVencord(v, true, noYield)).toEqual([]);
    });

    it("an absent or broken Vencord is nothing to report, never a throw", async () => {
        expect(await scanFromVencord(undefined, true, noYield)).toEqual([]);
        expect(await scanFromVencord({ Plugins: { get plugins() { throw new Error("x"); } } }, true, noYield)).toEqual([]);
    });
});

describe("runPatchHealthCheck", () => {
    const FAILED: FailedPatch[] = [{ plugin: "VcTranslate", find: "forum-tag-", state: "nomatch" }];
    function deps(over: Partial<CheckDeps> = {}) {
        let stored: unknown;
        const sent: unknown[] = [];
        const d: CheckDeps = {
            now: () => Date.parse("2026-10-08T12:00:00Z"),
            pluginVersion: "0.2.3", buildId: "c1c141a33e78dd5f",
            channel: () => "stable", buildNumber: () => 451234,
            load: async () => stored,
            save: async v => { stored = v; },
            scan: vi.fn(async () => FAILED),
            send: vi.fn(async r => { sent.push(r); return true; }),
            ...over
        };
        return { d, sent, stored: () => stored };
    }

    it("sends one report with only the agreed fields", async () => {
        const { d, sent } = deps();
        expect(await runPatchHealthCheck(d, true)).toBe("sent");
        expect(sent).toEqual([{ v: 1, plugin: "0.2.3", build: "c1c141a33e78dd5f", channel: "stable", discordBuild: 451234, failed: FAILED }]);
    });

    it("once per Discord build per day: a second run the same day does not even scan", async () => {
        const { d } = deps();
        await runPatchHealthCheck(d, true);
        expect(await runPatchHealthCheck(d, true)).toBe("skipped");
        expect(d.scan).toHaveBeenCalledTimes(1);
        expect(d.send).toHaveBeenCalledTimes(1);
    });

    it("a new Discord build or a new day reports again", async () => {
        const { d } = deps();
        await runPatchHealthCheck(d, true);
        d.buildNumber = () => 451300;
        expect(await runPatchHealthCheck(d, true)).toBe("sent");
        d.now = () => Date.parse("2026-10-09T00:00:01Z");
        expect(await runPatchHealthCheck(d, true)).toBe("sent");
        expect(d.send).toHaveBeenCalledTimes(3);
    });

    it("never sends when every patch applied", async () => {
        const { d } = deps({ scan: vi.fn(async () => []) });
        expect(await runPatchHealthCheck(d, true)).toBe("clean");
        expect(await runPatchHealthCheck(d, true)).toBe("skipped");
        expect(d.send).not.toHaveBeenCalled();
    });

    it("an unsent report is tried again next time", async () => {
        const { d } = deps({ send: vi.fn(async () => false) });
        expect(await runPatchHealthCheck(d, true)).toBe("unsent");
        expect(await runPatchHealthCheck(d, true)).toBe("unsent");
        expect(d.send).toHaveBeenCalledTimes(2);
    });

    it("never throws, whatever breaks", async () => {
        const boom = () => { throw new Error("boom"); };
        for (const over of [
            { scan: vi.fn(async () => { throw new Error("x"); }) },
            { send: vi.fn(async () => { throw new Error("x"); }) },
            { load: async () => { throw new Error("x"); } },
            { save: async () => { throw new Error("x"); } },
            { channel: boom },
            { buildNumber: boom }
        ] as Partial<CheckDeps>[]) {
            await expect(runPatchHealthCheck(deps(over).d, true)).resolves.toBeTypeOf("string");
        }
    });

    it("the largest report the scan can produce fits the native and relay body limit", async () => {
        const many: FailedPatch[] = Array.from({ length: 50 }, () => ({ plugin: "M".repeat(40), find: "~".repeat(MAX_FIND_CHARS), state: "nomatch" }));
        const { d, sent } = deps({ scan: vi.fn(async () => many), channel: () => "canary", buildNumber: () => 99_999_999 });
        await runPatchHealthCheck(d, true);
        expect((sent[0] as any).failed).toHaveLength(20);
        expect(JSON.stringify(sent[0]).length).toBeLessThan(8_192);
    });

    it("unknown channel and build number are sent as other and 0", async () => {
        const { d, sent } = deps({ channel: () => undefined, buildNumber: () => -1 });
        await runPatchHealthCheck(d, true);
        expect(sent[0]).toMatchObject({ channel: "other", discordBuild: 0 });
    });
});

describe("createPatchHealthWatch", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function watch() {
        const run = vi.fn(async (_seen: boolean) => { });
        const w = createPatchHealthWatch({ run, setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h as any) });
        return { run, w };
    }

    it("does nothing at start", async () => {
        const { run, w } = watch();
        w.start();
        await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
        expect(run).not.toHaveBeenCalled();
    });

    it("runs once, SETTLE_MS after messages first load", async () => {
        const { run, w } = watch();
        w.start();
        w.noteMessagesLoaded();
        w.noteMessagesLoaded();
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith(true);
        w.noteMessagesLoaded();
        await vi.advanceTimersByTimeAsync(FALLBACK_MS * 2);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("falls back to FALLBACK_MS without messages", async () => {
        const { run, w } = watch();
        w.start();
        await vi.advanceTimersByTimeAsync(FALLBACK_MS);
        expect(run).toHaveBeenCalledWith(false);
    });

    it("stop() cancels everything", async () => {
        const { run, w } = watch();
        w.start();
        w.noteMessagesLoaded();
        w.stop();
        await vi.advanceTimersByTimeAsync(FALLBACK_MS * 2);
        expect(run).not.toHaveBeenCalled();
    });

    it("a run that throws synchronously or rejects never escapes", async () => {
        const w = createPatchHealthWatch({ run: () => { throw new Error("x"); }, setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h as any) });
        w.start();
        w.noteMessagesLoaded();
        await expect(vi.advanceTimersByTimeAsync(SETTLE_MS)).resolves.not.toThrow();
    });
});

/* ================================================== through the plugin == */

describe("the plugin reports failed patches through the relay, once", () => {
    const CHANNEL = "418299174392016896";
    let applied = false;

    function installVencord() {
        const accessories = { find: "renderSuppressConf", replacement: [{ match: applied ? /children:\[/ : /gone/, replace: "children:[A," }] };
        const factory = function () { };
        factory.toString = () => MODULES[0]!;
        (globalThis as any).Vencord = {
            Plugins: { plugins: { MessageAccessoriesAPI: { patches: [accessories] } }, isPluginEnabled: () => true },
            WebpackPatcher: { patches: [], getBuildNumber: () => 451234 },
            Webpack: { wreq: { m: { 1: factory } } }
        };
        (globalThis as any).GLOBAL_ENV = { RELEASE_CHANNEL: "canary" };
    }

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
        native.relayPatchHealth.mockReset();
        native.relayPatchHealth.mockResolvedValue(true);
        native.reportStatus.mockResolvedValue(true);
        native.translateBatch.mockResolvedValue({ ok: true, results: [] });
        clearStore();
        __resetSettings();
        __resetWebpackCommon();
        __resetMessagePopover();
        DataStore.__reset();
        __resetLogCalls();
        settings.store.globalAuto = true;
        settings.store.targetLang = "en";
        settings.store.engine = "google";
        __stubSetSelectedChannel(CHANNEL);
        applied = false;
        installVencord();
    });

    afterEach(() => {
        plugin.stop!();
        delete (globalThis as any).Vencord;
        delete (globalThis as any).GLOBAL_ENV;
        vi.useRealTimers();
    });

    async function start() {
        await plugin.start!();
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    async function settle(ms = SETTLE_MS) {
        await vi.advanceTimersByTimeAsync(ms);
        for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    it("sends nothing at startup, then one report after messages load", async () => {
        await start();
        FluxDispatcher.dispatch("LOAD_MESSAGES_SUCCESS", { channelId: CHANNEL });
        expect(native.relayPatchHealth).not.toHaveBeenCalled();
        await settle();
        expect(native.relayPatchHealth).toHaveBeenCalledTimes(1);
        const [install, json] = native.relayPatchHealth.mock.calls[0]!;
        expect(install).toMatch(/^free_[0-9a-f]+$/);
        expect(JSON.parse(json)).toEqual({
            v: 1, plugin: PLUGIN_VERSION, build: BUILD_ID, channel: "canary", discordBuild: 451234,
            failed: [{ plugin: "MessageAccessoriesAPI", find: "renderSuppressConf", state: "nomatch" }]
        });
        expect(await DataStore.get(HEALTH_STORE_KEY)).toEqual({ key: "canary:451234:2026-10-08" });
    });

    it("a Discord reload on the same build and day does not report again", async () => {
        await start();
        await settle();
        plugin.stop!();
        await start();
        await settle(FALLBACK_MS);
        expect(native.relayPatchHealth).toHaveBeenCalledTimes(1);
    });

    it("never reports when every patch applied", async () => {
        applied = true;
        installVencord();
        await start();
        await settle(FALLBACK_MS);
        expect(native.relayPatchHealth).not.toHaveBeenCalled();
    });

    it("a relay that throws changes nothing for the user", async () => {
        native.relayPatchHealth.mockRejectedValue(new Error("offline"));
        await start();
        await expect(settle()).resolves.toBeUndefined();
        expect(native.relayPatchHealth).toHaveBeenCalledTimes(1);
    });

    it("no Vencord global at all: nothing sent, nothing thrown", async () => {
        delete (globalThis as any).Vencord;
        await start();
        await settle(FALLBACK_MS);
        expect(native.relayPatchHealth).not.toHaveBeenCalled();
    });

    it("stop() before the check means no report from a stopped plugin", async () => {
        await start();
        plugin.stop!();
        await settle(FALLBACK_MS);
        expect(native.relayPatchHealth).not.toHaveBeenCalled();
    });
});
