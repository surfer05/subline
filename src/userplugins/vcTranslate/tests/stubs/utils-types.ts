/**
 * Stand-in for Vencord's `@utils/types`, aliased in vitest.config.ts.
 * Only the two runtime exports the plugin actually uses are needed —
 * `PluginNative` is a type and is erased before this module is ever consulted.
 *
 * The OptionType numbers mirror Vencord's own enum ordering because
 * tests/stubs/api-settings.ts has to recognise SELECT (which carries its
 * default on an option rather than on the setting).
 */
export const OptionType = {
    STRING: 0,
    NUMBER: 1,
    BIGINT: 2,
    BOOLEAN: 3,
    SELECT: 4,
    SLIDER: 5,
    COMPONENT: 6,
    CUSTOM: 7
} as const;

export type PluginNative<T> = T;

export default function definePlugin<T>(plugin: T): T {
    return plugin;
}
