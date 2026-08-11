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
    /**
     * Another process is holding the file open (EBUSY). Windows only, in
     * practice: it refuses to rename a file that has a live handle, where macOS
     * allows it. Distinct from PERMISSION_DENIED because the remedy is the
     * opposite — nothing needs granting, something needs closing.
     */
    | "FILE_IN_USE"
    /**
     * Discord is running, so its files cannot be changed.
     *
     * Not an I/O failure: it is a fact we can check BEFORE touching anything,
     * and the remedy is one the user can act on. Uninstall used to discover it
     * the hard way, as a FILE_IN_USE from a rename Windows refused.
     */
    | "DISCORD_RUNNING"
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
    /**
     * The mod bundle we were told to install is missing, incomplete, or its
     * manifest names a different build from the code beside it. Refused before
     * Discord is touched: installing a bundle whose identity is wrong produces
     * an install that patches cleanly and then reports itself as somebody
     * else's, which is the failure this project keeps rediscovering.
     */
    | "MOD_BUNDLE_INVALID"
    /**
     * The release feed could not be reached. Distinct from every other failure
     * here because it is the one that is routinely TRANSIENT — a laptop asleep
     * on a train is not a broken install, and the helper must not tell anybody it
     * is (spec §6: an updater that warns falsely gets ignored when it warns
     * truthfully).
     */
    | "NETWORK_ERROR"
    /** The release feed answered, but with something we cannot read as a release. */
    | "RELEASE_MALFORMED"
    /**
     * A downloaded artefact did not match the digest published with it. NEVER
     * transient: it means the bytes are not the bytes that were published, and
     * the helper surfaces it at once rather than retrying quietly.
     */
    | "RELEASE_UNVERIFIED"
    /** `launchctl` refused to register (or unregister) the background helper. */
    | "HELPER_REGISTRATION_FAILED"
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
        case "EBUSY":
            return err<T>(
                "FILE_IN_USE",
                `Cannot ${what}: another program still has Discord's files open. Close Discord completely — `
                + "including any Discord icon in the system tray, near the clock — then try again.",
                { path, cause }
            );
        default:
            // The errno goes in the MESSAGE, not only into the cause the UI
            // used to drop. An unnamed IO_ERROR is the one failure nobody can
            // act on from a screenshot, and it is the failure most likely to
            // reach a user, because every errno we did not anticipate lands here.
            return err<T>("IO_ERROR", `Failed to ${what}${errno === undefined ? "" : ` (${errno})`}.`, { path, cause });
    }
}
