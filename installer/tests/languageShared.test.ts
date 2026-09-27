import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { languageOptions, SUPPORTED_LANGUAGE_CODES } from "../src/app/language.js";

/**
 * ONE LANGUAGE LIST. The plugin's Reading Language dropdown
 * (src/userplugins/vcTranslate/languages.ts) and this installer's language
 * screen must offer the same codes, so a language picked here is always a row
 * in the plugin's dropdown. The installer cannot import the plugin file
 * (tsconfig.build.json compiles only installer/src into the app), so the list
 * lives in both places and this test fails the build when they drift.
 */
const PLUGIN_LANGUAGES = join(
    dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "userplugins", "vcTranslate", "languages.ts"
);

function pluginCodes(): string[] {
    const source = readFileSync(PLUGIN_LANGUAGES, "utf8");
    const match = /SUPPORTED_LANGUAGE_CODES[^=]*=\s*\[([^\]]*)\]/.exec(source);
    if (!match) throw new Error(`no SUPPORTED_LANGUAGE_CODES in ${PLUGIN_LANGUAGES}`);
    return [...match[1]!.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
}

describe("the installer and the plugin share one language list", () => {
    it("offers exactly the plugin dropdown's codes, in the same order", () => {
        expect(pluginCodes()).toEqual([...SUPPORTED_LANGUAGE_CODES]);
    });

    it("writes only codes the plugin dropdown has a row for", () => {
        const plugin = new Set(pluginCodes());
        for (const option of languageOptions()) expect(plugin.has(option.code), option.code).toBe(true);
    });
});
