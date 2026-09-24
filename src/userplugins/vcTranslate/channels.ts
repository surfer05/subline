import * as DataStore from "@api/DataStore";

/**
 * Two persisted per-channel lists, one for each meaning of the 🌐 button.
 *
 * ENABLED is the opt-in list: channels translated although globalAuto does not
 * cover them (globalAuto is off, or the channel is a DM).
 *
 * DISABLED is the opt-out list: server channels globalAuto WOULD translate but
 * the user switched off. Without it, "Disable auto-translate here" had nothing
 * to write to while globalAuto was on, so it added the channel to ENABLED and
 * the channel stayed on.
 *
 * Which list a click edits is decided by index.tsx (channelActive), because
 * that needs settings and Discord's channel store. This module only stores.
 */
const KEY = "VcTranslate_enabledChannels";
const DISABLED_KEY = "VcTranslate_disabledChannels";

// Before loadEnabledChannels() resolves, isChannelEnabled returns false for
// everything. That fail-safe direction (translation off, not on) is deliberate.
// start() awaits the load before it subscribes to any message event, so the
// empty DISABLED list is never consulted for a real message either.
let enabled = new Set<string>();
let disabled = new Set<string>();

function readIds(stored: unknown): Set<string> {
    // DataStore returns whatever was persisted; a corrupted or older-format
    // entry must not throw (breaks all channels) or silently iterate a
    // string's characters into bogus ids.
    return new Set(
        Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : []
    );
}

export async function loadEnabledChannels(): Promise<void> {
    enabled = readIds(await DataStore.get<unknown>(KEY));
    disabled = readIds(await DataStore.get<unknown>(DISABLED_KEY));
}

export function isChannelEnabled(id: string): boolean {
    return enabled.has(id);
}

export function isChannelDisabled(id: string): boolean {
    return disabled.has(id);
}

/**
 * Apply a change to both lists and persist it. On a failed write, both lists
 * are restored, so memory never diverges from what is actually persisted.
 */
async function commit(change: () => void): Promise<void> {
    const before = { enabled: new Set(enabled), disabled: new Set(disabled) };
    change();
    try {
        await DataStore.set(KEY, [...enabled]);
        await DataStore.set(DISABLED_KEY, [...disabled]);
    } catch (err) {
        enabled = before.enabled;
        disabled = before.disabled;
        // Best effort: put back whatever the first write may already have
        // changed on disk. A second failure here is swallowed; the original
        // error is the one worth reporting.
        try {
            await DataStore.set(KEY, [...enabled]);
            await DataStore.set(DISABLED_KEY, [...disabled]);
        } catch { /* the original error is rethrown below */ }
        throw err;
    }
}

/**
 * Opt-in toggle, for a channel globalAuto does not cover. Returns whether the
 * channel is now on. Turning it on also clears any earlier opt-out, so the
 * channel stays on if globalAuto is switched on later.
 */
export async function toggleChannel(id: string): Promise<boolean> {
    const wasEnabled = enabled.has(id);
    await commit(() => {
        if (wasEnabled) {
            enabled.delete(id);
        } else {
            enabled.add(id);
            disabled.delete(id);
        }
    });
    return enabled.has(id);
}

/**
 * Opt-out toggle, for a server channel globalAuto covers. Returns whether the
 * channel is now on. Turning it off also clears any earlier opt-in, so the two
 * lists never both hold the same channel.
 */
export async function toggleChannelOptOut(id: string): Promise<boolean> {
    const wasDisabled = disabled.has(id);
    await commit(() => {
        if (wasDisabled) {
            disabled.delete(id);
        } else {
            disabled.add(id);
            enabled.delete(id);
        }
    });
    return !disabled.has(id);
}
