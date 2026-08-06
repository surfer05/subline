/**
 * Stand-in for Vencord's `@utils/Logger`, aliased in vitest.config.ts.
 * Silent on the real console on purpose: index.tsx logs a warning for an
 * unloadable MessageStore, which several tests trigger deliberately, and a
 * printed warning on every test run would be noise no one reads.
 *
 * Calls ARE recorded (in `calls`, below) rather than dropped entirely: the
 * debugLogging setting exists specifically to make certain decisions
 * diagnosable, and a test asserting "nothing was logged with the setting off"
 * / "the skip reason was logged with it on" needs somewhere to look. This is
 * a SINGLE MODULE-LEVEL array, deliberately not per-Logger-instance: every
 * `new Logger(...)` anywhere in the plugin (index.tsx's, and a second one in
 * engines/llmShared.ts — see its own comment for why a second instance is
 * unavoidable there) resolves to this same stub under vitest's module cache,
 * exactly mirroring how both real instances share one console and one
 * "VcTranslate" prefix.
 */
export interface LoggedCall {
    level: "log" | "info" | "warn" | "error" | "debug";
    args: unknown[];
}

export const calls: LoggedCall[] = [];

/** Drop every call recorded so far. Call this at the start of a test that
 * inspects `calls`, so an unrelated earlier test's logging cannot leak in. */
export function __resetLogCalls(): void {
    calls.length = 0;
}

export class Logger {
    constructor(_name: string) { }
    log(...args: unknown[]): void { calls.push({ level: "log", args }); }
    info(...args: unknown[]): void { calls.push({ level: "info", args }); }
    warn(...args: unknown[]): void { calls.push({ level: "warn", args }); }
    error(...args: unknown[]): void { calls.push({ level: "error", args }); }
    debug(...args: unknown[]): void { calls.push({ level: "debug", args }); }
}
