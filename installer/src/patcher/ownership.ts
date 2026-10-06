/**
 * Whose Discord is this?
 *
 * Two accounts on one Mac share /Applications/Discord.app. The stub Subline
 * writes into it require()s a loader inside ONE account's home folder
 * (~/Library/Application Support/Subline/mod/patcher.js), and home folders are
 * private (mode 700). So a Discord set up by account A belongs to A: if B's
 * installer or helper patched it again, it would point at B's home and stop
 * Discord starting for A, and A's helper would patch it straight back, every
 * few seconds while both are logged in.
 *
 * The test is deliberately narrow: a loader path inside the folder that holds
 * home folders (/Users on macOS, C:\Users on Windows) but not inside THIS
 * user's home. A developer path elsewhere (/opt, a repo checkout) is not
 * "another account".
 */

export function isOtherAccountLoader(loaderPath: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
    const windows = platform === "win32";
    const sep = windows ? "\\" : "/";
    const norm = (path: string): string => {
        const unified = windows ? path.replace(/\//g, "\\").toLowerCase() : path;
        return unified.length > 1 ? unified.replace(/[\\/]+$/, "") : unified;
    };
    const ownHome = norm(home);
    const loader = norm(loaderPath);
    const cut = ownHome.lastIndexOf(sep);
    if (cut <= 0) return false;
    const homesRoot = ownHome.slice(0, cut);
    if (!loader.startsWith(homesRoot + sep)) return false;
    return !(loader === ownHome || loader.startsWith(ownHome + sep));
}

/* ------------------------------------------------------------------------ *
 * Is this loader OURS?
 *
 * The marker beside app.asar was the only proof of ownership, and on Windows it
 * can go missing while the stub is still ours. Observed 2026-10-04: Vencord's
 * own persistAfterDiscordUpdates (bundled in our patcher.js) copies the OLD
 * app folder's app.asar (our stub) into the NEW app-x.y.z folder when Discord
 * updates and quits, renaming Discord's fresh archive to _app.asar. It copies
 * nothing else, so the new folder has our stub and a good backup but no
 * subline-patch.json. Judged by the marker alone, that is "another client mod",
 * and the helper walked away from it. The stub's own loader path is the better
 * witness: it names the file Discord actually runs.
 * ------------------------------------------------------------------------ */

/** Where every Subline mod bundle lives, as a path suffix (see bundle/layout.ts modBundleDirFor). */
const SUBLINE_LOADER_SUFFIX = "/subline/mod/patcher.js";

export interface LoaderPathContext {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
}

function envLookup(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
    if (!windows) return env[name];
    const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : env[key];
}

/**
 * One spelling for a loader path, so two spellings of the same file compare
 * equal: `~` and `%VAR%` / `$VAR` expanded, every backslash a slash, `.` and
 * `..` folded, no trailing separator, and lowercase where the file system is
 * case-insensitive (Windows, macOS). Never touches the disk.
 */
export function normaliseLoaderPath(path: string, context: LoaderPathContext = {}): string {
    const platform = context.platform ?? process.platform;
    const env = context.env ?? process.env;
    const windows = platform === "win32";
    let s = path.trim();
    const home = context.home ?? (windows ? envLookup(env, "USERPROFILE", true) : env.HOME);
    if (home && (s === "~" || s.startsWith("~/") || s.startsWith("~\\"))) s = home + s.slice(1);
    s = s.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (whole, name: string) => envLookup(env, name, windows) ?? whole);
    if (!windows) s = s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => env[name] ?? whole);
    s = s.replace(/\\/g, "/");
    const unc = s.startsWith("//");
    const parts: string[] = [];
    for (const part of s.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
            else parts.push(part);
            continue;
        }
        parts.push(part);
    }
    const absolute = s.startsWith("/");
    s = (unc ? "//" : absolute ? "/" : "") + parts.join("/");
    return windows || platform === "darwin" ? s.toLowerCase() : s;
}

/** The same file, spelt either way? */
export function sameLoaderPath(a: string, b: string, context: LoaderPathContext = {}): boolean {
    return normaliseLoaderPath(a, context) === normaliseLoaderPath(b, context);
}

/**
 * True when a stub's loader is Subline's own: any `…/Subline/mod/patcher.js`
 * (every Subline bundle lives there on every platform), or one of the loader
 * paths the caller knows to be ours (the installed bundle's).
 */
export function isSublineLoaderPath(
    loaderPath: string | null | undefined,
    ownLoaderPaths: readonly string[] = [],
    context: LoaderPathContext = {}
): boolean {
    if (!loaderPath) return false;
    const normalised = normaliseLoaderPath(loaderPath, context);
    if (normalised.toLowerCase().endsWith(SUBLINE_LOADER_SUFFIX)) return true;
    return ownLoaderPaths.some(own => normaliseLoaderPath(own, context) === normalised);
}
