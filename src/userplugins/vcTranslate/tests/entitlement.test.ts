import { beforeEach, describe, expect, it } from "vitest";

import {
    __resetEntitlement, ENTITLEMENT_KEY, entitlementLevel, getEntitlement, loadEntitlement, parseEntitlement,
    setEntitlement, subscribeEntitlement
} from "../entitlement";
import { connectInstallIdSetting, INSTALL_ID_KEY, installIdOnce, __resetTaste } from "../taste";
import * as DataStore from "./stubs/api-datastore";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const HOUR = 3_600_000;

beforeEach(() => {
    DataStore.__reset();
    __resetEntitlement();
});

describe("what an install owns", () => {
    it("is nothing when nothing was ever stored", async () => {
        DataStore.clearEntitlementForTest();
        await loadEntitlement();
        expect(getEntitlement()).toBeNull();
        expect(entitlementLevel(NOW)).toBe("none");
    });

    it("reads Automatic, AI and nothing from the relay's answer", () => {
        setEntitlement({ automatic: true, ai: false, tokenExpiresAt: NOW + HOUR, checkedAt: NOW });
        expect(entitlementLevel(NOW)).toBe("automatic");
        setEntitlement({ automatic: true, ai: true, tokenExpiresAt: NOW + HOUR, checkedAt: NOW });
        expect(entitlementLevel(NOW)).toBe("ai");
        setEntitlement({ automatic: false, ai: false, tokenExpiresAt: NOW + HOUR, checkedAt: NOW });
        expect(entitlementLevel(NOW)).toBe("none");
        setEntitlement(null);
        expect(entitlementLevel(NOW)).toBe("none");
    });

    it("counts only until tokenExpiresAt: offline for up to that moment, and nothing after", () => {
        setEntitlement({ automatic: true, ai: true, tokenExpiresAt: NOW + HOUR, checkedAt: NOW });
        expect(entitlementLevel(NOW + HOUR - 1)).toBe("ai");
        expect(entitlementLevel(NOW + HOUR)).toBe("none");
    });

    it("drops AI at aiUntil and keeps Automatic", () => {
        setEntitlement({ automatic: true, ai: true, aiUntil: NOW + 1, tokenExpiresAt: NOW + HOUR, checkedAt: NOW });
        expect(entitlementLevel(NOW)).toBe("ai");
        expect(entitlementLevel(NOW + 1)).toBe("automatic");
    });

    it("is kept on disk and read back by the next session", async () => {
        setEntitlement({ automatic: true, ai: false, token: "p.s", tokenExpiresAt: NOW + HOUR, checkedAt: NOW });
        await Promise.resolve();
        __resetEntitlement();
        await loadEntitlement();
        expect(getEntitlement()).toEqual({ automatic: true, ai: false, token: "p.s", tokenExpiresAt: NOW + HOUR, checkedAt: NOW });
        expect(DataStore.writes).toContain(ENTITLEMENT_KEY);
    });

    it("never trusts a malformed stored value", () => {
        expect(parseEntitlement({ automatic: "yes", ai: false, tokenExpiresAt: 5 })).toBeNull();
        expect(parseEntitlement({ automatic: true, ai: false })).toBeNull();
        expect(parseEntitlement({ automatic: true, ai: false, tokenExpiresAt: -1 })).toBeNull();
        expect(parseEntitlement("automatic")).toBeNull();
        expect(parseEntitlement({ automatic: true, ai: false, tokenExpiresAt: 5, aiUntil: "x", token: 7 }))
            .toEqual({ automatic: true, ai: false, tokenExpiresAt: 5, checkedAt: 0 });
    });

    it("tells listeners when it changes", () => {
        let n = 0;
        const off = subscribeEntitlement(() => n++);
        setEntitlement({ automatic: true, ai: false, tokenExpiresAt: NOW + HOUR, checkedAt: NOW });
        off();
        setEntitlement(null);
        expect(n).toBe(1);
    });
});

describe("the installer's install id", () => {
    beforeEach(() => {
        __resetTaste();
        connectInstallIdSetting(null);
    });

    it("wins over the plugin's own id, and the DataStore copy follows it", async () => {
        await DataStore.set(INSTALL_ID_KEY, "a".repeat(32));
        let setting: unknown = "b".repeat(32);
        connectInstallIdSetting({ read: () => setting, write: id => { setting = id; } });
        expect(await installIdOnce()).toBe("b".repeat(32));
        expect(await DataStore.get(INSTALL_ID_KEY)).toBe("b".repeat(32));
    });

    it("is written back when the plugin has its own id and the setting is empty", async () => {
        await DataStore.set(INSTALL_ID_KEY, "a".repeat(32));
        let setting: unknown = "";
        connectInstallIdSetting({ read: () => setting, write: id => { setting = id; } });
        expect(await installIdOnce()).toBe("a".repeat(32));
        expect(setting).toBe("a".repeat(32));
    });

    it("is created, and written to both, for a brand new install", async () => {
        let setting: unknown = "";
        connectInstallIdSetting({ read: () => setting, write: id => { setting = id; } });
        const id = await installIdOnce();
        expect(id).toMatch(/^[0-9a-f]{32}$/);
        expect(setting).toBe(id);
        expect(await DataStore.get(INSTALL_ID_KEY)).toBe(id);
    });

    it("ignores a malformed seeded value", async () => {
        let setting: unknown = "free_" + "b".repeat(32);
        connectInstallIdSetting({ read: () => setting, write: id => { setting = id; } });
        const id = await installIdOnce();
        expect(id).toMatch(/^[0-9a-f]{32}$/);
        expect(setting).toBe(id);
    });
});
