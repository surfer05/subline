/** Types for vencordRewrites.mjs, so the tests that run it are type-checked. */
export declare function rewriteExactlyOnce(source: string, from: string, to: string, where: { file: string; what: string }): string;
export declare const PERSIST_FILE: string;
export declare const PERSIST_ANCHOR: string;
export declare const MARKER_CARRY_BLOCK: string;
export declare function carryMarkerOnHostUpdate(source: string): string;
