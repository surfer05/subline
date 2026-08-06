import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { LocaleStore } from "@webpack/common";

import { notifySettingsChanged } from "./settingsBridge";
import { DEFAULT_GEMINI_MODEL } from "./types";

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
        // Not "the translator" any more: Google always runs first on every
        // message and is what puts the ≈ line on screen in about a second,
        // whatever is picked here. This setting only chooses what re-translates
        // that line with conversation context afterwards (✦).
        description: "Quality engine — Google always translates first (≈); this re-translates it with context (✦)",
        options: [
            { label: "Google only (free, no key — no ✦ upgrade)", value: "google", default: true },
            { label: "Claude Haiku (needs API key, best quality)", value: "claude" },
            { label: "Gemini Flash (needs free API key, context-aware)", value: "gemini" }
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
    geminiApiKey: {
        type: OptionType.STRING,
        description: "Gemini API key (only used when the Gemini engine is selected)",
        default: "",
        placeholder: "AIza...",
        // Same immediacy requirement as anthropicApiKey — effectiveEngine()
        // must see a pasted/cleared key right away, not on next reload.
        onChange: notifySettingsChanged
    },
    geminiModel: {
        type: OptionType.STRING,
        // The description is the whole point of this setting existing. Which
        // Gemini models a free-tier key may call changes without notice, and a
        // key with NO allowance for a model gets a 429 on its very first
        // request — indistinguishable from being throttled unless the user is
        // told what to try. The previous hardcoded default did exactly that
        // for days: every subtitle stayed Google's ≈ and nothing said why.
        description:
            `Gemini model (default ${DEFAULT_GEMINI_MODEL}). If ✦ upgrades stop appearing and you ` +
            "keep seeing a rate-limit toast, this model may no longer be available on your key's " +
            `free tier — try another (e.g. ${DEFAULT_GEMINI_MODEL}). Blank uses the default.`,
        default: DEFAULT_GEMINI_MODEL,
        placeholder: DEFAULT_GEMINI_MODEL,
        // Same immediacy requirement as the keys above: switching model to
        // escape a dead one must take effect on the next batch, not on next
        // reload — a user doing this is already stuck.
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
        // On by default so a fresh install works the moment it's enabled — no
        // channel to find, no button to discover. Only ever covers channels
        // with a guild_id; DMs and group DMs stay opt-in via the per-channel
        // globe button regardless of this setting (see channelActive).
        description: "Auto-translate every server channel you read. Turn off to require the per-channel globe button instead. DMs always stay opt-in, whatever this is set to.",
        default: true
    },
    debugLogging: {
        type: OptionType.BOOLEAN,
        // Says plainly what this does and where it goes: message TEXT is
        // included (it is the whole point — a decision log that hides the
        // message it decided about is not diagnosable), and it never leaves
        // this machine — it is printed through Vencord's own Logger, to the
        // same DevTools console every other plugin already logs to. Off by
        // default because most sessions do not need it and it is a
        // deliberate, informed opt-in when one does.
        description:
            "Log detailed per-message translation decisions to your own local " +
            "Discord console (which tier a message went to or which rule " +
            "skipped it, rate-gate/cooldown blocks, what each engine returned, " +
            "and store writes). Message text is included in these logs. " +
            "Nothing leaves your machine — this only affects what is printed " +
            "to the console. Off by default.",
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
    },
    geminiApiKey: {
        // Same mechanism, same reasoning, gated on the Gemini engine instead.
        hidden() { return this.store.engine !== "gemini"; }
    },
    geminiModel: {
        // Ditto: a model name is meaningless unless Gemini is what runs.
        hidden() { return this.store.engine !== "gemini"; }
    }
});

export default settings;
