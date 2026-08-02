import * as DataStore from "@api/DataStore";

const KEY = "VcTranslate_enabledChannels";

// Before loadEnabledChannels() resolves, isChannelEnabled returns false for
// everything. That fail-safe direction (translation off, not on) is deliberate.
let enabled = new Set<string>();

export async function loadEnabledChannels(): Promise<void> {
    const stored = await DataStore.get<unknown>(KEY);
    // DataStore returns whatever was persisted; a corrupted or older-format
    // entry must not throw (breaks all channels) or silently iterate a
    // string's characters into bogus ids.
    enabled = new Set(
        Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : []
    );
}

export function isChannelEnabled(id: string): boolean {
    return enabled.has(id);
}

export async function toggleChannel(id: string): Promise<boolean> {
    const wasEnabled = enabled.has(id);
    if (wasEnabled) enabled.delete(id);
    else enabled.add(id);

    try {
        await DataStore.set(KEY, [...enabled]);
    } catch (err) {
        // Roll back so memory never diverges from what is actually persisted.
        if (wasEnabled) enabled.add(id);
        else enabled.delete(id);
        throw err;
    }

    return enabled.has(id);
}
