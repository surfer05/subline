import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { notifySettingsChanged } from "./settingsBridge";

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
        default: "en",
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
});

export default settings;
