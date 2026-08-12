import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    defaultLanguage,
    discordSettingsPathFor,
    endonymOf,
    isKnownLanguage,
    languageOptions,
    normalizeLangCode,
    PLUGIN_SETTINGS_KEY,
    readDiscordLocale,
    readTargetLanguage,
    setApiKey,
    setTargetLanguage,
    SUPPORTED_LANGUAGE_CODES,
    TARGET_LANG_KEY,
    vencordSettingsPathFor
} from "../src/app/language.js";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subline-lang-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

describe("normalizeLangCode", () => {
    it("strips the region, because pt-BR would never match the detector's pt", () => {
        expect(normalizeLangCode("pt-BR")).toBe("pt");
        expect(normalizeLangCode("en-US")).toBe("en");
        expect(normalizeLangCode("zh-Hans-CN")).toBe("zh");
    });

    it("accepts an underscore separator as well as a hyphen", () => {
        expect(normalizeLangCode("en_GB")).toBe("en");
    });

    it("lower-cases", () => {
        expect(normalizeLangCode("TR")).toBe("tr");
    });

    it("keeps three-letter codes, which are real language tags", () => {
        expect(normalizeLangCode("fil")).toBe("fil");
    });

    it("returns null rather than inventing a code", () => {
        expect(normalizeLangCode("")).toBeNull();
        expect(normalizeLangCode("   ")).toBeNull();
        expect(normalizeLangCode("english")).toBeNull();
        expect(normalizeLangCode("1")).toBeNull();
        expect(normalizeLangCode("e")).toBeNull();
        expect(normalizeLangCode(null)).toBeNull();
        expect(normalizeLangCode(undefined)).toBeNull();
        expect(normalizeLangCode(42 as unknown as string)).toBeNull();
    });
});

describe("endonymOf", () => {
    it("gives the name in the language's own language, not in English", () => {
        expect(endonymOf("tr")).toBe("Türkçe");
        expect(endonymOf("ja")).toBe("日本語");
        expect(endonymOf("ru")).toBe("Русский");
        expect(endonymOf("ar")).toBe("العربية");
    });

    it("does not label Turkish 'Turkish'", () => {
        expect(endonymOf("tr")).not.toBe("Turkish");
    });

    it("upper-cases the first letter with the language's own casing rules", () => {
        expect(endonymOf("pt")).toBe("Português");
        // Turkish dotted-I: a naive toUpperCase would produce "Iṡ"-class bugs.
        expect(endonymOf("tr")?.charAt(0)).toBe("T");
    });

    it("returns null for a code ICU cannot name, rather than echoing it back", () => {
        expect(endonymOf("xx")).toBeNull();
        expect(endonymOf("qqq")).toBeNull();
    });
});

describe("languageOptions", () => {
    it("names every supported code — the shipped list contains nothing ICU cannot render", () => {
        expect(languageOptions()).toHaveLength(SUPPORTED_LANGUAGE_CODES.length);
    });

    it("carries the endonym and the English name separately", () => {
        const turkish = languageOptions().find(option => option.code === "tr");
        expect(turkish).toEqual({ code: "tr", endonym: "Türkçe", englishName: "Turkish" });
    });

    it("sorts by the English name, because that is the name the picker shows", () => {
        const names = languageOptions(["tr", "ja", "de", "en"]).map(option => option.englishName);
        expect(names).toEqual(["English", "German", "Japanese", "Turkish"]);
    });

    it("does not order by a key the reader cannot see", () => {
        // The regression this replaces: sorted by endonym while displaying
        // English names put German (Deutsch) above English and Spanish (Español)
        // among the E's, so a correctly sorted list read as unsorted.
        const endonyms = languageOptions(["tr", "ja", "de", "en"]).map(option => option.endonym);
        expect(endonyms).not.toEqual([...endonyms].sort((a, b) => a.localeCompare(b)));
    });

    it("normalizes and de-duplicates the codes it is given", () => {
        expect(languageOptions(["pt-BR", "pt", "PT"]).map(option => option.code)).toEqual(["pt"]);
    });

    it("drops unrenderable codes instead of showing a row that reads 'xx'", () => {
        expect(languageOptions(["tr", "xx", "notalang"]).map(option => option.code)).toEqual(["tr"]);
    });

    it("stores bare codes only — no option carries a region qualifier", () => {
        for (const option of languageOptions()) expect(option.code).not.toContain("-");
    });
});

describe("isKnownLanguage", () => {
    it("accepts real languages, region qualifier or not", () => {
        expect(isKnownLanguage("tr")).toBe(true);
        expect(isKnownLanguage("pt-BR")).toBe(true);
        expect(isKnownLanguage("fil")).toBe(true);
    });

    it("rejects a well-shaped subtag that is not a language — the 'not-a-language' hole", () => {
        expect(normalizeLangCode("not-a-language")).toBe("not");
        expect(isKnownLanguage("not-a-language")).toBe(false);
        expect(isKnownLanguage("zzz")).toBe(false);
        expect(isKnownLanguage("qq")).toBe(false);
        expect(isKnownLanguage(null)).toBe(false);
    });
});

describe("readDiscordLocale", () => {
    it("reads locale from Discord's settings.json and bares the code", () => {
        const path = join(dir, "discord", "settings.json");
        writeJson(path, { locale: "tr-TR", OPEN_ON_STARTUP: true });
        expect(readDiscordLocale(path)).toBe("tr");
    });

    it("returns null — never throws — when the file is absent, corrupt, or locale-less", () => {
        expect(readDiscordLocale(join(dir, "nope.json"))).toBeNull();
        expect(readDiscordLocale(null)).toBeNull();
        const corrupt = join(dir, "corrupt.json");
        writeFileSync(corrupt, "{not json", "utf8");
        expect(readDiscordLocale(corrupt)).toBeNull();
        const noLocale = join(dir, "nolocale.json");
        writeJson(noLocale, { OPEN_ON_STARTUP: true });
        expect(readDiscordLocale(noLocale)).toBeNull();
        const wrongType = join(dir, "wrongtype.json");
        writeJson(wrongType, { locale: 7 });
        expect(readDiscordLocale(wrongType)).toBeNull();
    });
});

describe("discordSettingsPathFor / vencordSettingsPathFor", () => {
    it("finds Discord's settings under Application Support on macOS", () => {
        expect(discordSettingsPathFor("darwin", {}, "/Users/x"))
            .toBe("/Users/x/Library/Application Support/discord/settings.json");
    });

    it("uses APPDATA on Windows and null without it", () => {
        expect(discordSettingsPathFor("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "/h"))
            .toContain("discord");
        expect(discordSettingsPathFor("win32", {}, "/h")).toBeNull();
        expect(discordSettingsPathFor("linux", {}, "/h")).toBeNull();
    });

    it("honours VENCORD_USER_DATA_DIR above everything else", () => {
        expect(vencordSettingsPathFor("darwin", { VENCORD_USER_DATA_DIR: "/custom" }, "/Users/x"))
            .toBe("/custom/settings/settings.json");
    });

    it("falls back to Vencord's default macOS location", () => {
        expect(vencordSettingsPathFor("darwin", {}, "/Users/x"))
            .toBe("/Users/x/Library/Application Support/Vencord/settings/settings.json");
    });

    it("returns null on a platform we do not support rather than inventing a path", () => {
        expect(vencordSettingsPathFor("linux", {}, "/h")).toBeNull();
    });
});

describe("defaultLanguage", () => {
    it("prefers Discord's locale", () => {
        expect(defaultLanguage({ discordLocale: "tr-TR", systemLocale: "en-US" })).toBe("tr");
    });

    it("falls back to the system locale, then to English", () => {
        expect(defaultLanguage({ discordLocale: null, systemLocale: "ja-JP" })).toBe("ja");
        expect(defaultLanguage({})).toBe("en");
        expect(defaultLanguage({ discordLocale: "garbage", systemLocale: "also garbage" })).toBe("en");
        // A locale that parses but names no language must fall through, not stick.
        expect(defaultLanguage({ discordLocale: "not-a-language", systemLocale: "ja" })).toBe("ja");
    });
});

describe("setTargetLanguage", () => {
    it("creates the settings file when Vencord has never run", () => {
        const path = join(dir, "Vencord", "settings", "settings.json");
        const result = setTargetLanguage(path, "tr-TR");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.created).toBe(true);
        expect(result.value.code).toBe("tr");
        expect(result.value.previous).toBeNull();
        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.plugins[PLUGIN_SETTINGS_KEY][TARGET_LANG_KEY]).toBe("tr");
    });

    it("stores the bare code even when handed a region-qualified locale", () => {
        const path = join(dir, "settings.json");
        setTargetLanguage(path, "pt-BR");
        expect(readTargetLanguage(path)).toBe("pt");
    });

    it("enables the plugin, since a disabled plugin translates nothing", () => {
        const path = join(dir, "settings.json");
        setTargetLanguage(path, "de");
        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.plugins[PLUGIN_SETTINGS_KEY].enabled).toBe(true);
    });

    it("MERGES: an existing Vencord user keeps every other plugin and setting", () => {
        const path = join(dir, "settings.json");
        writeJson(path, {
            autoUpdate: false,
            themeLinks: ["https://example.invalid/theme.css"],
            plugins: {
                SomeOtherPlugin: { enabled: true, favouriteColour: "green" },
                [PLUGIN_SETTINGS_KEY]: { enabled: true, engine: "gemini", targetLang: "en" }
            }
        });
        const result = setTargetLanguage(path, "ja");
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.previous).toBe("en");

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.autoUpdate).toBe(false);
        expect(written.themeLinks).toEqual(["https://example.invalid/theme.css"]);
        expect(written.plugins.SomeOtherPlugin).toEqual({ enabled: true, favouriteColour: "green" });
        // Our own other settings survive too.
        expect(written.plugins[PLUGIN_SETTINGS_KEY].engine).toBe("gemini");
        expect(written.plugins[PLUGIN_SETTINGS_KEY].targetLang).toBe("ja");
    });

    it("refuses to overwrite a corrupt settings file, and says so", () => {
        const path = join(dir, "settings.json");
        writeFileSync(path, "{ this is not json", "utf8");
        const result = setTargetLanguage(path, "tr");
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.message).toContain("could not be read as JSON");
        // The user's file is untouched.
        expect(readFileSync(path, "utf8")).toBe("{ this is not json");
    });

    it("refuses a settings file that parses to an array rather than an object", () => {
        const path = join(dir, "settings.json");
        writeFileSync(path, "[1,2,3]", "utf8");
        expect(setTargetLanguage(path, "tr").ok).toBe(false);
    });

    it("rejects a non-language code with a named error instead of writing it", () => {
        const path = join(dir, "settings.json");
        const result = setTargetLanguage(path, "not-a-language");
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("is not a language code");
        expect(existsSync(path)).toBe(false);
    });

    it("reports a named error when the platform has no settings path", () => {
        const result = setTargetLanguage(null, "tr");
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("IO_ERROR");
    });

    it("leaves no temp file behind", () => {
        const path = join(dir, "settings.json");
        setTargetLanguage(path, "tr");
        expect(existsSync(`${path}.subline-tmp`)).toBe(false);
    });

    it("survives a plugins key that is not an object", () => {
        const path = join(dir, "settings.json");
        writeJson(path, { plugins: "corrupted" });
        expect(setTargetLanguage(path, "tr").ok).toBe(true);
        expect(readTargetLanguage(path)).toBe("tr");
    });
});

describe("readTargetLanguage", () => {
    it("returns null for a missing or unreadable file rather than throwing", () => {
        expect(readTargetLanguage(join(dir, "absent.json"))).toBeNull();
        expect(readTargetLanguage(null)).toBeNull();
        const corrupt = join(dir, "corrupt.json");
        writeFileSync(corrupt, "nope", "utf8");
        expect(readTargetLanguage(corrupt)).toBeNull();
    });
});

describe("setApiKey", () => {
    it("stores the key and selects the engine that uses it", () => {
        const path = join(dir, "settings.json");
        const result = setApiKey(path, "gsk_abcdefghijklmnop");
        expect(result.ok).toBe(true);

        const written = JSON.parse(readFileSync(path, "utf8"));
        const plugin = written.plugins[PLUGIN_SETTINGS_KEY];
        expect(plugin.groqApiKey).toBe("gsk_abcdefghijklmnop");
        // A key with no engine selected changes nothing: the plugin would go on
        // using Google and the user would have handed over a key for no result.
        expect(plugin.engine).toBe("groq");
        expect(plugin.enabled).toBe(true);
    });

    it("trims a pasted key", () => {
        // A key arriving with a trailing space is rejected by the provider with
        // a 401, which the plugin then reports as a rejected key — sending
        // somebody to replace a credential that was correct.
        const path = join(dir, "settings.json");
        setApiKey(path, "  gsk_padded  \n");
        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.plugins[PLUGIN_SETTINGS_KEY].groqApiKey).toBe("gsk_padded");
    });

    it("refuses an empty key rather than storing one", () => {
        const path = join(dir, "settings.json");
        const result = setApiKey(path, "   ");
        expect(result.ok).toBe(false);
        expect(existsSync(path)).toBe(false);
    });

    it("never returns the key, only its length", () => {
        const result = setApiKey(join(dir, "settings.json"), "gsk_secret");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(JSON.stringify(result.value)).not.toContain("gsk_secret");
        expect(result.value.keyLength).toBe("gsk_secret".length);
    });

    it("keeps every other plugin's settings", () => {
        // The file is Vencord's, not ours. Overwriting it would silently lose
        // whatever else the user has configured.
        const path = join(dir, "settings.json");
        writeFileSync(path, JSON.stringify({ plugins: { SomethingElse: { enabled: true, size: 3 } } }), "utf8");
        setApiKey(path, "gsk_x");

        const written = JSON.parse(readFileSync(path, "utf8"));
        expect(written.plugins.SomethingElse).toEqual({ enabled: true, size: 3 });
    });

    it("refuses a settings file it cannot parse rather than replacing it", () => {
        const path = join(dir, "settings.json");
        writeFileSync(path, "{ not json", "utf8");
        const result = setApiKey(path, "gsk_x");
        expect(result.ok).toBe(false);
        expect(readFileSync(path, "utf8")).toBe("{ not json");
    });
});
