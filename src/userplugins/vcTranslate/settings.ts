import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { LocaleStore } from "@webpack/common";

import { notifySettingsChanged } from "./settingsBridge";

/**
 * Default target language, taken from Discord's own locale rather than a
 * hardcoded "en".
 *
 * Truncated to the primary subtag: Discord reports region-qualified tags
 * ("en-US", "pt-BR"), but google.ts decides "this message is already in the
 * target language" by comparing the target against the DETECTED language the
 * endpoint returns, which is a bare code ("en", "pt"). A region-qualified
 * target would therefore never match, and every message already in the user's
 * own language would be pointlessly translated.
 *
 * LocaleStore is resolved asynchronously by Vencord's webpack search, so it can
 * legitimately still be undefined very early; "en" is the fallback.
 */
function defaultTargetLang(): string {
    const locale = LocaleStore?.locale;
    if (typeof locale !== "string" || locale === "") return "en";
    return locale.split("-")[0].toLowerCase();
}

export const settings = definePluginSettings({
    engine: {
        type: OptionType.SELECT,
        description: "Translation engine",
        options: [
            { label: "Google (free, no key, lower quality)", value: "google", default: true },
            { label: "Claude Haiku (needs API key, best quality)", value: "claude" }
        ],
        // engine is captured by value when the batcher is built, so a change
        // here must rebuild it (see settingsBridge.ts / index.tsx).
        onChange: notifySettingsChanged
    },
    anthropicApiKey: {
        type: OptionType.STRING,
        description: "Anthropic API key (only used when the Claude engine is selected)",
        default: "",
        placeholder: "sk-ant-...",
        // Pasting a key (or clearing one) must be picked up by effectiveEngine()
        // immediately, not on next reload.
        onChange: notifySettingsChanged
    },
    targetLang: {
        type: OptionType.STRING,
        description: "Target language code",
        // A getter, not a literal. Vencord resolves a setting's `default`
        // LAZILY — getDefaultValue() in src/api/Settings.ts reads
        // `setting.default` the first time the value is actually needed, and
        // `definePluginSettings` stores this object by reference without
        // copying it. Evaluating LocaleStore at module scope instead would run
        // while the plugin index is being constructed, before
        // waitForStore("LocaleStore") has resolved, and would freeze the "en"
        // fallback in for everyone.
        get default() { return defaultTargetLang(); },
        // targetLang is captured by value when the batcher is built, so a
        // change here must rebuild it too.
        onChange: notifySettingsChanged
    },
    catchUpCount: {
        type: OptionType.SLIDER,
        description: "How many recent messages to translate when opening an enabled channel",
        markers: [0, 10, 20, 30, 50],
        default: 20,
        stickToMarkers: true
    },
    globalAuto: {
        type: OptionType.BOOLEAN,
        description: "Auto-translate every channel (otherwise use the per-channel globe button)",
        default: false
    }
}, {
    anthropicApiKey: {
        // The key field is meaningless unless Claude is the selected engine.
        // `hidden` as a function of `this.store` is Vencord's own supported
        // mechanism for conditional visibility (see IsDisabledOrHidden in
        // src/utils/types.ts, and src/plugins/translate/settings.tsx for the
        // same pattern applied to the DeepL/Kagi credentials).
        hidden() { return this.store.engine !== "claude"; }
    }
});

export default settings;
