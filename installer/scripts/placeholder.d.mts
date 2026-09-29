/** Types for scripts/placeholder.mjs, which the release script runs as plain JavaScript. */
export declare const PLACEHOLDER: string;
export declare const ALLOW_ENV: string;
export declare const SHIPPED_PATHS: string[];
export interface PlaceholderHit { file: string; lines: number[] }
export declare function findPlaceholders(root: string, paths?: string[]): PlaceholderHit[];
export declare function placeholderAllowed(env?: Record<string, string | undefined>): boolean;
export declare function placeholderMessage(found: PlaceholderHit[]): string;
