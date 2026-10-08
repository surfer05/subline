/** Types for checkPatches.mjs, so the installer's tests typecheck against it. */

export interface PatchRow {
    plugin: string;
    find: string;
    modules: number;
    all: boolean;
    match: string;
    count: number;
    ok: boolean;
    why: string;
}

export interface PatchLike {
    plugin: string;
    find: string | RegExp;
    all?: boolean;
    noWarn?: boolean;
    replacement:
        | { match: string | RegExp; replace: unknown; noWarn?: boolean; expect?: number; }
        | Array<{ match: string | RegExp; replace: unknown; noWarn?: boolean; expect?: number; }>;
}

export function canonicalize(match: string | RegExp, hashKey: (key: string) => string): string | RegExp;
export function checkPatch(
    patch: PatchLike,
    modules: Map<string, string>,
    options?: { hashKey?: (key: string) => string; pluginPath?: string; }
): PatchRow[];
export function lazyChunkFiles(runtimeSource: string): string[];
export function modulesFromChunk(source: string): Map<string, string>;
export function modulesFromRuntime(source: string, ts: unknown): Map<string, string>;
export function fetchBundle(dir: string, log?: (message: string) => void, origin?: string): Promise<{ files: string[]; runtime: string; }>;
export const CHANNEL_ORIGINS: { stable: string; ptb: string; canary: string; };
export function originFor(channel: string): string | null;
export function loadModules(dir: string, files: string[], runtime: string, ts: unknown): Map<string, string>;
export function keptPluginEntries(vencordDir: string, keptDirs: string[]): string[];
export function activePlugins(plugins: Array<Record<string, any> & { name: string; }>): Set<string>;
export function runtimeHashMessageKey(key: string, h64: (key: string, seed: number) => bigint): string;
