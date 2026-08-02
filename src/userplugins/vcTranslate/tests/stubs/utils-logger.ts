/**
 * Stand-in for Vencord's `@utils/Logger`, aliased in vitest.config.ts.
 * Silent on purpose: index.tsx logs a warning for an unloadable MessageStore,
 * which several tests trigger deliberately.
 */
export class Logger {
    constructor(_name: string) { }
    log(..._args: unknown[]): void { }
    info(..._args: unknown[]): void { }
    warn(..._args: unknown[]): void { }
    error(..._args: unknown[]): void { }
    debug(..._args: unknown[]): void { }
}
