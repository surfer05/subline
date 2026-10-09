import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The app-too-old notice, wired through the real plugin start(): what it says,
 * where Download goes, and that "Later" takes down only this notice.
 */
const native = vi.hoisted(() => {
    const translateBatch = vi.fn();
    const readStagedBuildId = vi.fn().mockResolvedValue(null);
    const readAppSignals = vi.fn();
    const relayStatus = vi.fn().mockResolvedValue({ ok: false, error: "status unavailable" });
    const openExternal = vi.fn();
    (globalThis as any).VencordNative = {
        pluginHelpers: { VcTranslate: { translateBatch, readStagedBuildId, readAppSignals, relayStatus } },
        native: { openExternal }
    };
    return { translateBatch, readStagedBuildId, readAppSignals, relayStatus, openExternal };
});

import { APP_DOWNLOAD_URL, APP_NOTICE_SHOWN_KEY } from "../appNotice";
import plugin from "../index";
import settings from "../settings";
import { clearStore } from "../store";
import { PLUGIN_VERSION } from "../statusShape";
import { __resetTaste } from "../taste";
import * as DataStore from "./stubs/api-datastore";
import { __resetNotices, shownNotices } from "./stubs/api-notices";
import { __resetSettings } from "./stubs/api-settings";
import { __resetWebpackCommon } from "./stubs/webpack-common";

const TEXT = "Download the new Subline once to keep it working after Discord updates.";

async function flush() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

const mine = () => shownNotices.filter(n => n.buttonText === "Download");

/** Find the inline "Later" link in the rendered message. */
function laterLink(node: any): any {
    if (node === null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
        for (const c of node) { const f = laterLink(c); if (f) return f; }
        return null;
    }
    const kids = node.children ?? node.props?.children;
    if (node.type === "a" && (kids === "Later" || (Array.isArray(kids) && kids.includes("Later")))) return node;
    return laterLink(kids);
}

beforeEach(() => {
    vi.useFakeTimers();
    for (const f of Object.values(native)) f.mockReset();
    native.readStagedBuildId.mockResolvedValue(null);
    native.relayStatus.mockResolvedValue({ ok: false, error: "status unavailable" });
    native.translateBatch.mockResolvedValue({ ok: true, results: [] });
    clearStore();
    __resetTaste();
    __resetSettings();
    __resetWebpackCommon();
    __resetNotices();
    DataStore.__reset();
    settings.store.engine = "google";
});

afterEach(() => {
    plugin.stop!();
    clearStore();
    vi.useRealTimers();
});

describe("the app-too-old notice in Discord", () => {
    it("an old app (no signal file): shows once with the exact copy; Download opens the site", async () => {
        native.readAppSignals.mockResolvedValue({ managed: true, appVersion: null, cannotRepair: false });
        await plugin.start!();
        await flush();

        expect(mine()).toHaveLength(1);
        const notice = mine()[0]!;
        expect(laterLink(notice.message)).not.toBeNull();
        const text = JSON.stringify((notice.message as any).children[0]);
        expect(text).toBe(JSON.stringify(TEXT));
        expect(await DataStore.get(APP_NOTICE_SHOWN_KEY)).toBe(PLUGIN_VERSION);

        notice.onOkClick();
        expect(native.openExternal).toHaveBeenCalledWith(APP_DOWNLOAD_URL);
        expect(mine()).toHaveLength(0);

        // Next Discord start, same mod version: nothing.
        plugin.stop!();
        await plugin.start!();
        await flush();
        expect(mine()).toHaveLength(0);
    });

    it("Later takes down only this notice", async () => {
        native.readAppSignals.mockResolvedValue({ managed: true, appVersion: "0.1.3", cannotRepair: false });
        await plugin.start!();
        await flush();
        expect(mine()).toHaveLength(1);
        laterLink(mine()[0]!.message).props.onClick();
        expect(mine()).toHaveLength(0);
        expect(native.openExternal).not.toHaveBeenCalled();
    });

    it("a new app: no notice", async () => {
        native.readAppSignals.mockResolvedValue({ managed: true, appVersion: "0.2.3", cannotRepair: false });
        await plugin.start!();
        await flush();
        expect(mine()).toHaveLength(0);
    });

    it("a stale 'could not repair' alert on a new app: no notice, and the once-mark is not spent", async () => {
        native.readAppSignals.mockResolvedValue({ managed: true, appVersion: "0.2.3", cannotRepair: true });
        await plugin.start!();
        await flush();
        expect(mine()).toHaveLength(0);
        expect(await DataStore.get(APP_NOTICE_SHOWN_KEY)).toBeUndefined();
    });

    it("a bridge without the reader (an older main process) shows nothing and start() still succeeds", async () => {
        (globalThis as any).VencordNative.pluginHelpers.VcTranslate.readAppSignals = undefined;
        try {
            await plugin.start!();
            await flush();
            expect(mine()).toHaveLength(0);
        } finally {
            (globalThis as any).VencordNative.pluginHelpers.VcTranslate.readAppSignals = native.readAppSignals;
        }
    });
});
