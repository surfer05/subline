import * as DataStore from "@api/DataStore";

const KEY = "VcTranslate_enabledChannels";

let enabled = new Set<string>();

export async function loadEnabledChannels(): Promise<void> {
    const stored = await DataStore.get<string[]>(KEY);
    enabled = new Set(stored ?? []);
}

export function isChannelEnabled(id: string): boolean {
    return enabled.has(id);
}

export async function toggleChannel(id: string): Promise<boolean> {
    if (enabled.has(id)) enabled.delete(id);
    else enabled.add(id);

    await DataStore.set(KEY, [...enabled]);
    return enabled.has(id);
}
