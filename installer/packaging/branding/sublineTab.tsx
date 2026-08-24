/*
 * Subline — the one settings pane the reader ever sees.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * Subline ships Vencord as its loader, and Vencord's settings surface is built
 * for people who run a client mod: seven panes covering plugins, themes, an
 * updater, a cloud sync account, backup/restore and a patch helper. A reader
 * who installed a translation tool opens Settings, finds all of that, and
 * correctly concludes they have installed something other than what they were
 * offered.
 *
 * So the section is reduced to ONE entry, and this is what sits behind it: the
 * translation plugin's own options, rendered directly, with no plugin card, no
 * modal and no enable toggle in front of them. There is nothing to enable —
 * Subline IS the plugin, and a reader who wants it gone uninstalls it.
 *
 * WHAT THIS IS NOT. It is not a reimplementation of Vencord's settings
 * rendering. Every control here comes from `OptionComponentMap`, the same map
 * `PluginModal` uses, so a new setting in settings.ts appears here with no
 * change to this file, and a Vencord change to how a SLIDER renders lands here
 * too. The only thing this file owns is the frame around them.
 */

import { hasAnyVisibleSettings, isSettingHidden } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { debounce } from "@shared/debounce";
import { Margins } from "@utils/margins";
import { OptionType, Plugin } from "@utils/types";
import { Alerts, Forms, React } from "@webpack/common";

import { SettingsTab, wrapTab } from "../BaseTab";
import { OptionComponentMap } from "../plugins/components";

// The generated stamp, by relative path: Vencord's tsconfig has no alias for
// src/userplugins. BUILD_ID is the identity the installer matched at patch
// time, so a support conversation that starts "which build are you on" is one
// screenshot long.
import { BUILD_ID, PLUGIN_VERSION } from "../../../../userplugins/vcTranslate/buildStamp";

const PLUGIN_NAME = "VcTranslate";

/**
 * The restart notice, shown only once something that needs one has changed.
 *
 * Vencord's plugin modal hands this job to the card behind it; with no card,
 * the pane has to say it itself — otherwise a reader flips the engine, sees
 * nothing happen, and concludes the setting is broken.
 */
function RestartNotice({ onRestart }: { onRestart: () => void; }) {
    return (
        <Forms.FormText className={Margins.top16} style={{ color: "var(--text-warning, var(--text-danger))" }}>
            Discord needs to reload for that to take effect.{" "}
            <a role="button" onClick={onRestart} style={{ textDecoration: "underline", cursor: "pointer" }}>
                Reload now
            </a>
        </Forms.FormText>
    );
}

function SublineSettings() {
    const plugin: Plugin | undefined = Vencord.Plugins.plugins[PLUGIN_NAME];
    const pluginSettings = useSettings([`plugins.${PLUGIN_NAME}.*`]).plugins[PLUGIN_NAME];
    const [needsRestart, setNeedsRestart] = React.useState(false);

    // Defensive, and deliberately loud rather than blank. If the plugin is
    // missing the bundle is broken — a patch that half-applied, a build that
    // pruned too much — and a reader staring at an empty settings pane has no
    // way to tell that from "there is nothing to configure".
    if (plugin === undefined) {
        return (
            <SettingsTab>
                <Forms.FormTitle tag="h5">Subline is not loaded</Forms.FormTitle>
                <Forms.FormText>
                    The translation plugin did not start. Reinstalling Subline should fix it;
                    if it does not, the installer writes a log naming the reason.
                </Forms.FormText>
            </SettingsTab>
        );
    }

    const { settings } = plugin;
    if (!hasAnyVisibleSettings(plugin) || !settings) {
        return (
            <SettingsTab>
                <Forms.FormText>There is nothing to configure.</Forms.FormText>
            </SettingsTab>
        );
    }

    const options = Object.entries(settings.def).map(([key, setting]) => {
        if (setting.type === OptionType.CUSTOM) return null;
        if (isSettingHidden(settings, setting)) return null;

        function onChange(newValue: any) {
            const option = settings!.def[key];
            if (!option || option.type === OptionType.CUSTOM) return;

            pluginSettings[key] = newValue;
            if (option.restartNeeded) setNeedsRestart(true);
        }

        const Component = OptionComponentMap[setting.type];
        return (
            <ErrorBoundary noop key={key}>
                <Component
                    id={key}
                    setting={setting}
                    onChange={debounce(onChange)}
                    pluginSettings={pluginSettings}
                    definedSettings={settings}
                />
            </ErrorBoundary>
        );
    });

    return (
        <SettingsTab>
            <Forms.FormText className={Margins.bottom16}>
                Subline translates incoming messages and shows them as subtitles underneath.
            </Forms.FormText>

            <div className="vc-plugins-settings">
                {options}
            </div>

            {needsRestart && (
                <RestartNotice
                    onRestart={() => Alerts.show({
                        title: "Reload Discord?",
                        body: "Subline's new settings take effect after a reload.",
                        confirmText: "Reload",
                        cancelText: "Later",
                        onConfirm: () => window.location.reload()
                    })}
                />
            )}

            <Forms.FormDivider className={Margins.top16} />
            <Forms.FormText className={Margins.top8} style={{ color: "var(--text-muted)" }}>
                Subline v{PLUGIN_VERSION} · build {BUILD_ID}
            </Forms.FormText>
        </SettingsTab>
    );
}

export default wrapTab(SublineSettings, "Subline");
