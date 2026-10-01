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
