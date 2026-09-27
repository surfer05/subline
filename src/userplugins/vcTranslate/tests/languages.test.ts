import { describe, expect, it } from "vitest";

import { languageLabel, normalizeTargetLang, SUPPORTED_LANGUAGE_CODES, targetLanguageOptions } from "../languages";
import settings from "../settings";
import { __resetSettings } from "./stubs/api-settings";
import { LocaleStore } from "./stubs/webpack-common";

describe("the reading language dropdown", () => {
    it("is a dropdown, not a text field", () => {
        const def: any = (settings as any).def.targetLang;
        expect(def.type).toBe(4); // OptionType.SELECT
        expect(def.description).not.toContain("—");
    });

    it("offers every supported language by name, valued by bare code", () => {
        const options = targetLanguageOptions("en");
        expect(options.map(o => o.value).sort()).toEqual([...SUPPORTED_LANGUAGE_CODES].sort());
        expect(options.find(o => o.value === "de")!.label).toBe("Deutsch (German)");
        expect(options.find(o => o.value === "en")!.label).toBe("English");
        expect(options.find(o => o.value === "ja")!.label).toBe("日本語 (Japanese)");
    });

    it("is sorted by what it shows", () => {
        const labels = targetLanguageOptions().map(o => o.label);
        expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "en")));
    });

    it("always shows the value actually set, even one not in the list", () => {
        const options = targetLanguageOptions("haw");
        expect(options[0]!.value).toBe("haw");
        expect(options.filter(o => o.value === "haw")).toHaveLength(1);
        expect(targetLanguageOptions("en").filter(o => o.value === "en")).toHaveLength(1);
    });

    it("reads its options from the current setting", () => {
        __resetSettings();
        settings.store.targetLang = "haw";
        const def: any = (settings as any).def.targetLang;
        expect(def.options[0].value).toBe("haw");
        __resetSettings();
    });

    it("still defaults to Discord's language as a bare code", () => {
        __resetSettings();
        LocaleStore.locale = "pt-BR";
        expect(settings.store.targetLang).toBe("pt");
        LocaleStore.locale = "en-US";
        __resetSettings();
    });

    it("falls back to the code for a language ICU cannot name", () => {
        expect(languageLabel("qqq")).toBe("qqq");
    });
});

describe("turning an old free-text value into a code", () => {
    it("drops a region and normalises case", () => {
        expect(normalizeTargetLang("pt-BR")).toBe("pt");
        expect(normalizeTargetLang("PT_br")).toBe("pt");
        expect(normalizeTargetLang(" es ")).toBe("es");
    });

    it("maps an English or native name", () => {
        expect(normalizeTargetLang("English")).toBe("en");
        expect(normalizeTargetLang("german")).toBe("de");
        expect(normalizeTargetLang("Deutsch")).toBe("de");
    });

    it("leaves anything else alone", () => {
        expect(normalizeTargetLang("Klingon")).toBeNull();
        expect(normalizeTargetLang("")).toBeNull();
        expect(normalizeTargetLang(undefined)).toBeNull();
    });
});
