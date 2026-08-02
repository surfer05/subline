import { OptionType } from "./utils-types";

/**
 * Stand-in for Vencord's `@api/Settings`, aliased in vitest.config.ts.
 *
 * Deliberately reproduces the one behaviour of the real implementation that
 * settings.ts depends on: a setting's `default` is resolved LAZILY, on first
 * read, and then cached — see `getDefaultValue` in Vencord's
 * `src/api/Settings.ts`. `targetLang` relies on that to read `LocaleStore`
 * after the webpack stores exist, so a stub that resolved defaults eagerly at
 * definition time would quietly make that test vacuous.
 */

const resetters: (() => void)[] = [];

export function definePluginSettings(def: any, checks?: any) {
    // Same merge the real definePluginSettings performs, so `hidden`/`disabled`
    // declared in the second argument end up on the setting definition.
    if (checks) {
        for (const [name, check] of Object.entries(checks)) Object.assign(def[name], check);
    }

    const values: Record<string, unknown> = {};
    resetters.push(() => { for (const k of Object.keys(values)) delete values[k]; });

    const store = new Proxy(values, {
        get(target, key: string) {
            if (key in target) return target[key];
            const setting = def[key];
            if (!setting) return undefined;
            if ("default" in setting) return (target[key] = setting.default);
            if (setting.type === OptionType.SELECT) {
                const chosen = setting.options?.find((o: any) => o.default);
                if (chosen) return (target[key] = chosen.value);
            }
            return undefined;
        },
        set(target, key: string, value: unknown) {
            target[key] = value;
            return true;
        }
    });

    const definedSettings: any = {
        def,
        pluginName: "VcTranslate",
        get store() { return store; },
        get plain() { return values; },
        use: () => store,
        withPrivateSettings() { return this; }
    };

    return definedSettings;
}

/** Drop every resolved value so the next read re-runs the default resolution. */
export function __resetSettings(): void {
    for (const reset of resetters) reset();
}
