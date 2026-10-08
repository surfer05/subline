/**
 * The diagnostics log (spec §7).
 *
 * THE RULE: **never message text.** This tool reads private messages, including
 * DMs. Spec §1: "a plaintext log of other people's conversations on disk is a
 * liability the moment a stranger installs this." So the log does not accept
 * free-form strings and hope callers behave — it accepts a named event plus
 * *scalar fields*, and every field goes through a redactor that
 *
 *  - blanks any key on the sensitive list outright, and
 *  - caps every remaining string, so a whole message cannot be smuggled through
 *    a field named something innocent.
 *
 * The cap is structural rather than advisory for the same reason `patchInstall`
 * derives its build id instead of taking one: an invariant a caller can forget
 * is an invariant that will be forgotten.
 *
 * The second rule is that the copyable bundle is redacted differently from the
 * on-disk file. The local file may contain the user's own home path — it is
 * their machine. A bundle destined for a bug report on a public tracker may not,
 * because `/Users/firstname.lastname/…` is a real name, pasted by someone who
 * did not think about it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

/** Only scalars. An object would be a place for message text to hide. */
export type LogFieldValue = string | number | boolean | null | undefined;

export type LogFields = Record<string, LogFieldValue>;

/**
 * Field names whose value is replaced wholesale, whatever it holds.
 *
 * Named after the things the plugin actually handles, so that a future caller
 * reaching for the obvious name gets stopped by the obvious guard.
 */
export const REDACTED_FIELD_KEYS: readonly string[] = [
    "text",
    "content",
    "body",
    "message",
    "messageText",
    "original",
    "originalText",
    "translated",
    "translatedText",
    "translation",
    "apiKey",
    "key",
    "token",
    "authorization"
];

export const REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Longest a logged string may be. Generous enough for a path or an error
 * message, far short of a conversation.
 */
export const MAX_FIELD_CHARS = 200;

/** Version stamp written at the top of every log file (spec §7). */
export interface DiagnosticsHeader {
    productVersion: string;
    /** Discord's version, when we have managed to read it. */
    discordVersion?: string | null;
    /** The mod bundle's plugin build id. */
    modBuildId?: string | null;
    modVersion?: string | null;
    os: string;
    osVersion?: string;
    arch?: string;
    /**
     * Whether the unpatched `original-fs` was available (see `realFs.ts`).
     *
     * Recorded because a `false` here changes the meaning of every subsequent
     * filesystem error in the log: it means Electron's asar interception is in
     * play and the paths we touch are not the files we think they are. It was
     * exported and never logged, so a real Windows failure could not be told
     * apart from an ordinary one without another round trip to the user.
     */
    originalFs?: boolean;
}

export interface DiagnosticsLogOptions {
    /** Directory to write into — `~/Library/Logs/Subline` in production. */
    dir: string;
    /** Rotate once the active file passes this size. */
    maxBytes?: number;
    /** How many rotated generations to keep, `subline.log.1` … `subline.log.N`. */
    maxFiles?: number;
    clock?: () => number;
    /** The home directory to strip when producing a shareable bundle. */
    home?: string;
}

export const LOG_FILENAME = "subline.log";
export const DEFAULT_MAX_BYTES = 512 * 1024;
export const DEFAULT_MAX_FILES = 3;
/** A rotation claim older than this was left by a writer that died mid-rotation. */
export const ROTATION_CLAIM_STALE_MS = 30_000;

function isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase();
    return REDACTED_FIELD_KEYS.some(candidate => candidate.toLowerCase() === lower);
}

/**
 * One field, made safe to write.
 *
 * Exported because the redaction rule is the part of this module most worth
 * testing directly, and because the IPC layer applies it to anything crossing
 * from the renderer before it reaches a file.
 */
export function redactField(key: string, value: LogFieldValue): string {
    if (isSensitiveKey(key)) return REDACTED_PLACEHOLDER;
    if (value === undefined || value === null) return "null";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    const flattened = value.replace(/[\r\n\t]+/g, " ");
    return flattened.length > MAX_FIELD_CHARS
        ? `${flattened.slice(0, MAX_FIELD_CHARS)}…[truncated]`
        : flattened;
}

export function formatEntry(at: number, level: LogLevel, event: string, fields: LogFields): string {
    const stamp = new Date(at).toISOString();
    const parts = Object.entries(fields).map(([key, value]) => `${key}=${redactField(key, value)}`);
    const tail = parts.length > 0 ? ` ${parts.join(" ")}` : "";
    return `${stamp} ${level.toUpperCase().padEnd(5)} ${event}${tail}\n`;
}

/**
 * Replace the user's home directory with `~` everywhere it appears.
 *
 * Applied only to the *shared* bundle. Doing it on write would make the local
 * log worse at its actual job — telling us which path failed — for no privacy
 * gain on the machine that already knows its own name.
 */
export function redactHome(text: string, home: string): string {
    if (home.length === 0) return text;
    return text.split(home).join("~");
}

export class DiagnosticsLog {
    private readonly dir: string;
    private readonly maxBytes: number;
    private readonly maxFiles: number;
    private readonly clock: () => number;
    private readonly home: string;
    /**
     * Lines that could not be written, and why (audit 2026-10-06 #20). The
     * next line that lands is preceded by one "subline.log.lost" entry with
     * the count and the errno, so a full disk or a locked folder is visible
     * in the very log it interrupted.
     */
    private lost: { count: number; code: string | null; path: string } | null = null;

    /** The last write failure, or null once a line has landed again. For tests and the header. */
    get lastWriteError(): { count: number; code: string | null; path: string } | null {
        return this.lost === null ? null : { ...this.lost };
    }

    private noteLost(cause: unknown, path: string): void {
        const code = typeof (cause as { code?: unknown } | null)?.code === "string" ? (cause as { code: string }).code : null;
        if (this.lost === null) {
            this.lost = { count: 0, code, path };
            try {
                process.stderr.write(`subline: could not write the diagnostics log at ${path} (${code ?? String(cause)})\n`);
            } catch {
                // stderr itself may be gone; nothing more to do.
            }
        }
        this.lost.count += 1;
        this.lost.code = code ?? this.lost.code;
    }
    /** Kept so the copied bundle can restate what version wrote it. */
    private header: DiagnosticsHeader | null = null;

    constructor(options: DiagnosticsLogOptions) {
        this.dir = options.dir;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
        this.clock = options.clock ?? Date.now;
        this.home = options.home ?? homedir();
    }

    get path(): string {
        return join(this.dir, LOG_FILENAME);
    }

    rotatedPath(generation: number): string {
        return `${this.path}.${generation}`;
    }

    /**
     * Write the version header. Called once per run, and again after every
     * rotation — a rotated-away header would leave the newest file, the one
     * anybody actually reads, with no idea which build produced it.
     */
    writeHeader(header: DiagnosticsHeader): void {
        this.header = header;
        this.append(this.renderHeader(header));
    }

    private renderHeader(header: DiagnosticsHeader): string {
        const fields: LogFields = {
            product: header.productVersion,
            discord: header.discordVersion ?? null,
            modBuild: header.modBuildId ?? null,
            modVersion: header.modVersion ?? null,
            os: header.os,
            osVersion: header.osVersion ?? null,
            arch: header.arch ?? null,
            originalFs: header.originalFs ?? null
        };
        return formatEntry(this.clock(), "info", "subline.session", fields);
    }

    log(level: LogLevel, event: string, fields: LogFields = {}): void {
        this.append(formatEntry(this.clock(), level, event, fields));
    }

    info(event: string, fields?: LogFields): void {
        this.log("info", event, fields ?? {});
    }

    warn(event: string, fields?: LogFields): void {
        this.log("warn", event, fields ?? {});
    }

    error(event: string, fields?: LogFields): void {
        this.log("error", event, fields ?? {});
    }

    /**
     * NEVER THROWS (audit 2026-10-06 #39). A log line must never stop an
     * install or a helper run: the installer and the helper write this file at
     * the same moment on macOS (WatchPaths fires on the patch), and a throw
     * from a rotation they raced on escaped from a log call inside the patch
     * and left the installer stuck with no helper registered.
     */
    private append(line: string): void {
        try {
            mkdirSync(this.dir, { recursive: true });
        } catch (cause) {
            this.noteLost(cause, this.dir);
            return; // Nowhere to write. Losing a line beats stopping the caller.
        }
        try {
            this.rotateIfNeeded(line.length);
        } catch {
            // A rotation that failed leaves an oversized file, which is fine.
        }
        const lost = this.lost;
        const text = lost === null
            ? line
            : formatEntry(this.clock(), "warn", "subline.log.lost", { lines: lost.count, code: lost.code, path: lost.path }) + line;
        try {
            appendFileSync(this.path, text, "utf8");
            this.lost = null;
        } catch (cause) {
            // Same rule: never let a log line stop the caller.
            this.noteLost(cause, this.path);
        }
    }

    private get claimPath(): string {
        return `${this.path}.rotating`;
    }

    /**
     * Claim the rotation for this process. mkdir is atomic, so of two writers
     * that both saw the file over the cap, only one shifts the generations;
     * the other appends to whatever file is active. A claim older than
     * ROTATION_CLAIM_STALE_MS was left by a crash and is broken.
     */
    private claimRotation(): boolean {
        try {
            mkdirSync(this.claimPath);
            return true;
        } catch {
            // Held by another writer, or left behind by a crash.
        }
        try {
            if (Date.now() - statSync(this.claimPath).mtimeMs < ROTATION_CLAIM_STALE_MS) return false;
            rmdirSync(this.claimPath);
            mkdirSync(this.claimPath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Rotate *before* the write that would overflow, not after.
     *
     * Rotating afterwards lets a single burst push the active file arbitrarily
     * past the cap and then rotate an already-oversized file, which is how a
     * "512 KB log" becomes several megabytes on the one machine that is
     * misbehaving enough to need the log read.
     */
    private rotateIfNeeded(incomingBytes: number): void {
        let size = 0;
        try {
            size = statSync(this.path).size;
        } catch {
            return; // No active file yet — nothing to rotate.
        }
        if (size + incomingBytes <= this.maxBytes) return;
        if (!this.claimRotation()) return;

        try {
            // Re-read under the claim: another writer may have rotated between
            // our first look and the claim, and its fresh file must not be
            // shifted over generation 1.
            try {
                size = statSync(this.path).size;
            } catch {
                return;
            }
            if (size + incomingBytes <= this.maxBytes) return;

            // Drop the oldest generation, then shift each one down.
            const oldest = this.rotatedPath(this.maxFiles);
            if (existsSync(oldest)) rmSync(oldest, { force: true });
            for (let generation = this.maxFiles - 1; generation >= 1; generation -= 1) {
                const from = this.rotatedPath(generation);
                if (existsSync(from)) renameSync(from, this.rotatedPath(generation + 1));
            }
            renameSync(this.path, this.rotatedPath(1));

            if (this.header !== null) {
                appendFileSync(this.path, this.renderHeader(this.header), "utf8");
            }
        } finally {
            try {
                rmdirSync(this.claimPath);
            } catch {
                // Already gone: a stale-claim breaker took it. Harmless.
            }
        }
    }

    /** The active file's contents, or `""` when nothing has been logged. */
    read(): string {
        try {
            return readFileSync(this.path, "utf8");
        } catch {
            return "";
        }
    }

    /**
     * The "copy diagnostics" payload (spec §7).
     *
     * The newest rotated generation is included alongside the active file,
     * because the interesting failure is routinely the one *before* the retry
     * the user finally reported.
     */
    copyBundle(): string {
        const previous = existsSync(this.rotatedPath(1)) ? readFileSync(this.rotatedPath(1), "utf8") : "";
        const combined = previous.length > 0
            ? `--- previous ---\n${previous}--- current ---\n${this.read()}`
            : this.read();
        return redactHome(combined, this.home);
    }
}
