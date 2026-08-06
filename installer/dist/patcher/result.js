/**
 * Structured results for every patcher operation.
 *
 * Spec §7 requires a *named* error state per failure — "a generic thrown error
 * is not acceptable" — because the GUI renders a specific explanation (and
 * often a specific remedy, like a deep link to System Settings) for each one.
 * So nothing in this module throws for an expected condition: every operation
 * returns `Result`.
 */
export function ok(value) {
    return { ok: true, value };
}
export function err(code, message, extra) {
    const error = { code, message };
    if (extra?.path !== undefined)
        error.path = extra.path;
    if (extra?.cause !== undefined)
        error.cause = describeCause(extra.cause);
    return { ok: false, error };
}
function describeCause(cause) {
    if (cause instanceof Error)
        return `${cause.name}: ${cause.message}`;
    return String(cause);
}
/** Node's errno, when the thrown value carries one. */
export function errnoOf(cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause) {
        const { code } = cause;
        if (typeof code === "string")
            return code;
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
export function fsError(cause, path, what) {
    const errno = errnoOf(cause);
    switch (errno) {
        case "EACCES":
        case "EPERM":
            return err("PERMISSION_DENIED", `Not allowed to ${what}. On macOS this is usually App Management: grant permission in System Settings, then try again.`, { path, cause });
        case "EROFS":
            return err("READ_ONLY_VOLUME", `Cannot ${what}: the volume is read-only.`, { path, cause });
        default:
            return err("IO_ERROR", `Failed to ${what}.`, { path, cause });
    }
}
//# sourceMappingURL=result.js.map