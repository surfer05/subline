/** Types for vencordRewrites.mjs, so the tests that run it are type-checked. */
export declare function rewriteExactlyOnce(source: string, from: string, to: string, where: { file: string; what: string }): string;
export declare const PERSIST_FILE: string;
export declare const PERSIST_ANCHOR: string;
export declare const MARKER_CARRY_BLOCK: string;
export declare function carryMarkerOnHostUpdate(source: string): string;
export declare const EVENTS_IMPORT: string;
export declare const SPAWN_IMPORT: string;
export declare const BEFORE_QUIT_ANCHOR: string;
export declare const QUIT_HOOK_BLOCK: string;
