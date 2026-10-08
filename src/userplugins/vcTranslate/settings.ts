import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { LocaleStore, React, Toasts } from "@webpack/common";

import { copyToClipboard } from "@utils/clipboard";

import { entitlementLevel, type Level, subscribeEntitlement } from "./entitlement";
import { type LanguageSelectOption, targetLanguageOptions } from "./languages";
import { isPaymentPending, openCodeEntryFromSettings, openUpgrade, subscribePaymentPending } from "./upgradeBridge";
import { notifySettingsChanged } from "./settingsBridge";
import { SETTINGS_COPY } from "./settingsCopy";
import { DEFAULT_GEMINI_MODEL, DEFAULT_GROQ_MODEL } from "./types";

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

/** The engine value a Subline code turns on. Same string the installer seeds (RELAY_ENGINE). */
export const RELAY_ENGINE = "relay";
/** The engine a blank code falls back to: Google (≈) for an Automatic owner, nothing for an install that is not activated. */
export const FREE_ENGINE = "google";

/**
 * Pasting a code is all it takes to turn ✦ on, and clearing it turns it off.
 *
 * The installer writes `engine: "relay"` alongside the code it saves, but a
 * code pasted here used to leave Engine on Google, so ✦ stayed off until the
 * user also found the Engine dropdown. Clearing the code switches back to
 * Google rather than leaving the relay selected with nothing to send: that
 * state is treated as free anyway (effectiveEngine falls back to Google), but
 * it also shows a red "no Subline code set" toast.
 *
 * Reads the store rather than the argument: Vencord writes the value before
 * it calls onChange, and the store is what every other reader sees.
 */
function syncEngineToCode(): void {
    const raw = settings.store.sublineCode;
    const code = typeof raw === "string" ? raw.trim() : "";
    const engine = settings.store.engine;
    if (code !== "" && engine !== RELAY_ENGINE) {
        settings.store.engine = RELAY_ENGINE;
    } else if (code === "" && engine === RELAY_ENGINE) {
        settings.store.engine = FREE_ENGINE;
    }
    notifySettingsChanged();
}

/** The one line that says what this install has. */
export function planLine(level: Level): string {
    return level === "ai" ? SETTINGS_COPY.plan.ai : level === "automatic" ? SETTINGS_COPY.plan.automatic : SETTINGS_COPY.plan.none;
}

const LINK_STYLE = { cursor: "pointer", color: "var(--text-link, #00a8fc)" } as const;

function link(text: string, onClick: () => void) {
    return React.createElement("a", {
        role: "button",
        tabIndex: 0,
        style: LINK_STYLE,
        onClick: (e: any) => { e?.preventDefault?.(); onClick(); }
    }, text);
}

/**
 * The plan card at the top of the page: what this install has, the saved code
 * with a Copy button (so a buyer can take it to another computer), and the one
 * action that helps: Activate / Enter a code when there is nothing, Add AI for
 * an Automatic owner. Redraws when the relay's answer changes.
 */
export function PlanCard() {
    const [, redraw] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => subscribeEntitlement(redraw), []);
    React.useEffect(() => subscribePaymentPending(redraw), []);
    const level = entitlementLevel();
    const raw = settings.store.sublineCode;
    const code = typeof raw === "string" ? raw.trim() : "";
    const muted = { color: "var(--text-muted)", fontSize: "0.9rem" };
    const rows: any[] = [React.createElement("div", { key: "plan", style: { color: "var(--text-default, var(--text-normal))" } }, planLine(level))];
    if (code !== "") {
        rows.push(React.createElement("div", { key: "code", style: { ...muted, display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
            SETTINGS_COPY.plan.codeLabel, " ",
            React.createElement("code", { style: { userSelect: "all" } }, code), " ",
            React.createElement("button", {
                type: "button",
                "data-subline-copy": "",
                onClick: () => {
                    void copyToClipboard(code).then(() => Toasts.show({
                        id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: SETTINGS_COPY.plan.copied
                    })).catch(() => { });
                }
            }, SETTINGS_COPY.plan.copy)
        ));
    }
    const actions: any[] = [];
    // P4: while a payment is on its way, plain words in place of the buy link.
    const buy = (text: string) => isPaymentPending()
        ? React.createElement("span", { "data-subline-payment-pending": "" }, SETTINGS_COPY.plan.paymentPending)
        : link(text, openUpgrade);
    if (level === "none") actions.push(buy(SETTINGS_COPY.plan.activate), " · ", link(SETTINGS_COPY.plan.enterCode, openCodeEntryFromSettings));
    else if (level === "automatic") actions.push(buy(SETTINGS_COPY.plan.addAi));
    if (actions.length > 0) rows.push(React.createElement("div", { key: "actions", style: { ...muted, marginTop: 4 } }, ...actions));
    return React.createElement("div", { style: { marginBottom: 8 } }, ...rows);
}

export const settings = definePluginSettings({
    engine: {
        type: OptionType.SELECT,
        // Not "the translator" any more: Google always runs first on every
        // message and is what puts the ≈ line on screen in about a second,
        // whatever is picked here. This setting only chooses what re-translates
        // that line with conversation context afterwards (✦).
        description: "Quality engine. Google always translates first (≈); this re-translates it with context (✦)",
        // ONLY Google (free) and the Subline code (relay). Bring-your-own-key
        // engines are deliberately NOT offered: they would let anyone self-serve
        // ✦ AI with a free provider key and never need a code, which defeats the
        // whole model (free ≈ Google, or a code for ✦ AI). The claude/gemini/groq
        // engine code still exists, unreachable, for the test suite; there is no
        // way into it from a shipped build. See tests/settings.test.ts.
        options: [
            { label: "Google (≈)", value: "google", default: true },
            { label: "Subline (keyless AI, just paste your code)", value: "relay" }
        ],
        // engine is captured by value when the batcher is built, so a change
        // here must rebuild it (see settingsBridge.ts / index.tsx).
        onChange: notifySettingsChanged
    },
    // The installer's install id (32 lowercase hex, no prefix): the install a
    // purchase or promo was tied to before Discord ever ran. taste.ts prefers
    // it. CUSTOM, never shown.
    installId: {
        type: OptionType.CUSTOM,
        default: ""
    },
    // First on the page: the plan, the code and its Copy button.
    plan: {
        type: OptionType.COMPONENT,
        component: () => React.createElement(PlanCard)
    },
    sublineCode: {
        type: OptionType.STRING,
        // Says where the code CAME FROM, not what it looks like: a bought code is
        // the store's license key and does not start with slp_.
        displayName: SETTINGS_COPY.sublineCode.title,
        description: SETTINGS_COPY.sublineCode.description,
        default: "",
        placeholder: "Paste your code",
        // Same immediacy requirement as the API keys: effectiveEngine() must
        // see a pasted/cleared code right away, not on next reload.
        onChange: syncEngineToCode
    },
    // The Subline code the reader last cleared by hand, "" for none. A
    // purchase the relay still links to this install is not saved again when
    // it is this code: clearing it was a choice. CUSTOM, never shown.
    clearedPurchaseCode: {
        type: OptionType.CUSTOM,
        default: ""
    },
    // When a 0.1.x build started this install's free trial (epoch ms), 0 for
    // never. 0.2.0 starts no trials; this is only read, as evidence of earlier
    // use for the early-user check (taste.ts priorUseHint). CUSTOM, never shown.
    freeTrialStartedAt: {
        type: OptionType.CUSTOM,
        default: 0
    },
    // The saved code the relay first called dead, and when (epoch ms). A code
    // is dropped only when a second dead answer comes at least an hour later,
    // so a relay storage lag cannot throw away a good code. CUSTOM, never shown.
    deadCodeSeen: {
        type: OptionType.CUSTOM,
        default: { code: "", at: 0 } as { code: string; at: number; }
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
            `free tier; try another (e.g. ${DEFAULT_GEMINI_MODEL}). Blank uses the default.`,
        default: DEFAULT_GEMINI_MODEL,
        placeholder: DEFAULT_GEMINI_MODEL,
        // Same immediacy requirement as the keys above: switching model to
        // escape a dead one must take effect on the next batch, not on next
        // reload — a user doing this is already stuck.
        onChange: notifySettingsChanged
    },
    groqApiKey: {
        type: OptionType.STRING,
        description: "Groq API key (only used when the Groq engine is selected)",
        default: "",
        placeholder: "gsk_...",
        // Same immediacy requirement as the two keys above.
        onChange: notifySettingsChanged
    },
    groqModel: {
        type: OptionType.STRING,
        // Written BEFORE this engine's first ever request, not after a week of
        // misdiagnosis — which is the only difference between this field and
        // geminiModel above. A model with no free-tier availability returns 429
        // to every request forever, which is the same status code as ordinary
        // throttling, and without a settings field the only cure is a rebuild.
        description:
            `Groq model (default ${DEFAULT_GROQ_MODEL}). If ✦ upgrades stop appearing, especially `
            + "if they never appear at all, this model may no longer be available on your key's "
            + "free tier. Try another from console.groq.com's model list; the change applies to "
            + "the next batch, with no restart. Blank uses the default.",
        default: DEFAULT_GROQ_MODEL,
        placeholder: DEFAULT_GROQ_MODEL,
        onChange: notifySettingsChanged
    },
    targetLang: {
        // A dropdown of language names (languages.ts, the same list the
        // installer's language screen offers). The value stays a bare code.
        type: OptionType.SELECT,
        displayName: SETTINGS_COPY.targetLang.title,
        description: SETTINGS_COPY.targetLang.description,
        // A getter, so the list always includes the value actually set: a
        // Discord locale we do not list, or an old free-text value that could
        // not be normalised (see index.tsx's normaliseTargetLangSetting). Vencord
        // reads `options` when it renders the dropdown (SelectSetting.tsx at the
        // pinned commit), never at definition time.
        get options(): LanguageSelectOption[] { return targetLanguageOptions(settings.store.targetLang); },
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
        displayName: SETTINGS_COPY.catchUpCount.title,
        description: SETTINGS_COPY.catchUpCount.description,
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
        displayName: SETTINGS_COPY.globalAuto.title,
        description: SETTINGS_COPY.globalAuto.description,
        default: true
    },
    translateSurfaces: {
        type: OptionType.BOOLEAN,
        // Paid only (hidden without a code, and the plugin checks the plan
        // itself too). Statuses, bios, embeds, polls, reply and forward
        // previews, and the open channel's topic, title, tags and live event.
        displayName: SETTINGS_COPY.translateSurfaces.title,
        description: SETTINGS_COPY.translateSurfaces.description,
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
        displayName: SETTINGS_COPY.debugLogging.title,
        description: SETTINGS_COPY.debugLogging.description,
        default: false
    }
}, {
    engine: {
        // Hidden: the engine follows the code by itself (syncEngineToCode). A
        // code turns the relay on and clearing it turns Google back on, so there
        // is nothing for the reader to choose. The value stays for the plugin.
        hidden: () => true
    },
    sublineCode: {
        // Shown in the plan card with a Copy button instead. A code is entered
        // through "Enter a code", which checks it with the relay first.
        hidden: () => true
    },
    translateSurfaces: {
        hidden: () => entitlementLevel() === "none"
    },
    anthropicApiKey: {
        // Permanently hidden: bring-your-own-key is not an offered path (see the
        // engine options above and tests/settings.test.ts). The field stays in
        // the schema so the engine machinery and its tests keep compiling.
        hidden: () => true
    },
    geminiApiKey: {
        hidden: () => true
    },
    geminiModel: {
        hidden: () => true
    },
    groqApiKey: {
        hidden: () => true
    },
    groqModel: {
        hidden: () => true
    }
});

export default settings;
