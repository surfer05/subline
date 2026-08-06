/**
 * Structured results for every patcher operation.
 *
 * Spec §7 requires a *named* error state per failure — "a generic thrown error
 * is not acceptable" — because the GUI renders a specific explanation (and
 * often a specific remedy, like a deep link to System Settings) for each one.
 * So nothing in this module throws for an expected condition: every operation
 * returns `Result`.
 */

/** Every failure the patcher core can report. */
export type PatcherErrorCode =
    /** No Discord installation was found in any search root. */
    | "DISCORD_NOT_FOUND"
    /** A path was supplied explicitly but does not look like a Discord app. */
    | "NOT_A_DISCORD_INSTALL"
    /** macOS App Management / plain filesystem permission refusal (EACCES/EPERM). */
    | "PERMISSION_DENIED"
    /** Target volume is mounted read-only (EROFS). */
    | "READ_ONLY_VOLUME"
    /** The install is in a half-patched / damaged state; refuse to make it worse. */
    | "BROKEN_INSTALL"
    /** Another client mod (Vencord, BetterDiscord, Equicord, …) owns this install. */
    | "FOREIGN_MOD_PRESENT"
    /** Our stub is present but `_app.asar` is gone — we cannot restore Discord. */
    | "BACKUP_MISSING"
    /** `_app.asar` exists but is not a usable original asar. */
    | "BACKUP_CORRUPT"
    /** Wrote the patch, read it back, and it did not match. Rolled back. */
    | "VERIFICATION_FAILED"
    /** Verification failed *and* the rollback also failed. The loud one. */
    | "ROLLBACK_FAILED"
    /** `build_info.json` is missing. */
    | "BUILD_INFO_MISSING"
    /** `build_info.json` is present but unparsable or missing `version`. */
    | "BUILD_INFO_MALFORMED"
    /** The file is not a valid asar archive. */
    | "INVALID_ASAR"
    /**
     * The plugin's status beacon exists but is unusable — unparsable, not ours,
     * or missing the load timestamp that dates it to an installation. Never a
     * reason to call an install broken: the beacon is evidence, and absent
     * evidence means "cannot confirm" (spec §7), not "does not work".
     */
    | "BEACON_MALFORMED"
    /** The beacon is a format version this installer does not understand. */
    | "BEACON_FORMAT_UNSUPPORTED"
    /** Anything else that came back from the filesystem. */
    | "IO_ERROR";

export interface PatcherError {
    code: PatcherErrorCode;
    /** Human-readable, safe to show in the GUI as-is. */
    message: string;
    /** The path the failure concerns, when there is one. */
    path?: string;
    /** Underlying error text, for the diagnostics log — never shown as the primary message. */
    cause?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: PatcherError };

export function ok<T>(value: T): Result<T> {
    return { ok: true, value };
}

export function err<T>(
    code: PatcherErrorCode,
    message: string,
    extra?: { path?: string; cause?: unknown }
): Result<T> {
    const error: PatcherError = { code, message };
    if (extra?.path !== undefined) error.path = extra.path;
    if (extra?.cause !== undefined) error.cause = describeCause(extra.cause);
    return { ok: false, error };
}

function describeCause(cause: unknown): string {
    if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
    return String(cause);
}

/** Node's errno, when the thrown value carries one. */
export function errnoOf(cause: unknown): string | undefined {
    if (typeof cause === "object" && cause !== null && "code" in cause) {
        const { code } = cause as { code?: unknown };
        if (typeof code === "string") return code;
    }
    return undefined;
}

/**
 * Turn a filesystem exception into the right named error.
 *
 * Permission and read-only volumes get their own codes because spec §7 lists
 * them as distinct failures the GUI must explain differently: App Management
 * has a remedy (deep link + poll), a read-only volume does not.
 */
export function fsError<T>(cause: unknown, path: string, what: string): Result<T> {
    const errno = errnoOf(cause);
    switch (errno) {
        case "EACCES":
        case "EPERM":
            return err<T>(
                "PERMISSION_DENIED",
                `Not allowed to ${what}. On macOS this is usually App Management: grant permission in System Settings, then try again.`,
                { path, cause }
            );
        case "EROFS":
            return err<T>("READ_ONLY_VOLUME", `Cannot ${what}: the volume is read-only.`, { path, cause });
        default:
            return err<T>("IO_ERROR", `Failed to ${what}.`, { path, cause });
    }
}
