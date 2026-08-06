/**
 * Where Subline's per-user data lives, and — the decision this file exists for
 * — WHERE THE MOD BUNDLE LIVES AT RUNTIME.
 *
 * ## The bundle does not live inside the app
 *
 * The obvious place is `Subline.app/Contents/Resources/mod/`. It is wrong for
 * three separate reasons, each of which alone would sink it:
 *
 *  1. **Gatekeeper's App Translocation.** A quarantined app run from Downloads
 *     is mounted at a randomised read-only path. The stub we wrote into
 *     `app.asar` is a literal absolute path baked into Discord — it would point
 *     into a mount that disappears when the app quits, and Discord would then
 *     fail to start at all. Not "translation stops working": Discord broken,
 *     with a stub we can no longer explain.
 *  2. **Moving or updating the app.** Dragging Subline.app to a different
 *     folder, or an `electron-updater` replacement, changes that absolute path.
 *     Discord keeps requiring the old one.
 *  3. **Spec §6 needs the mod replaceable on its own.** A Discord frontend
 *     change is fixed by shipping a new *mod*, not a new installer — the helper
 *     downloads a bundle and swaps it in behind an unchanged `loaderPath` (which
 *     is exactly why `patchInstall`'s "already patched" short-circuit compares
 *     build ids and not just paths). A bundle inside a signed, notarized app
 *     cannot be replaced without breaking the app's signature.
 *
 * ## So: a stable per-user directory
 *
 *     macOS    ~/Library/Application Support/Subline/mod/
 *     Windows  %LOCALAPPDATA%\Subline\mod\
 *
 * The same directory the plugin already writes its status beacon into, which
 * keeps "everything Subline owns" in one place for diagnostics and for §8's
 * uninstall. It survives app updates and app moves, it is user-writable so the
 * helper can replace it without a privilege prompt, and the absolute path in the
 * stub stays valid for the life of the account.
 *
 * ## The consequence, stated
 *
 * The bundle now outlives the app that installed it, so **§8's uninstall must
 * delete it** — `removeModBundle` in `bundle.ts` — exactly as it must delete the
 * `subline-patch.json` sidecar (§3c). An uninstall that removes the app and
 * leaves this behind leaves several megabytes of GPL build output orphaned, and
 * leaves a later install reading a bundle nobody chose.
 */
import { homedir } from "node:os";
import { join } from "node:path";
/** The single folder name every Subline artefact lives under, per platform convention. */
export const PRODUCT_DIR_NAME = "Subline";
/** The bundle's own subdirectory, kept apart from settings, logs and the beacon. */
export const MOD_DIR_NAME = "mod";
/**
 * Per-platform data root. A table rather than branches because spec §5 makes
 * Windows a row, not a redesign — and `null` for anything else, because an
 * invented path is worse than an honest "we do not support this platform".
 */
const DIR_BY_PLATFORM = {
    darwin: (_env, home) => join(home, "Library", "Application Support", PRODUCT_DIR_NAME),
    win32: env => (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, PRODUCT_DIR_NAME) : null)
};
export function productDirFor(platform = process.platform, env = process.env, home = homedir()) {
    return DIR_BY_PLATFORM[platform]?.(env, home) ?? null;
}
/** Where the installed mod bundle lives, or `null` on a platform we do not support. */
export function modBundleDirFor(platform = process.platform, env = process.env, home = homedir()) {
    const root = productDirFor(platform, env, home);
    return root === null ? null : join(root, MOD_DIR_NAME);
}
//# sourceMappingURL=layout.js.map