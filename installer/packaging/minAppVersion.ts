/**
 * The release guard for the plugin's "your Subline app is too old" notice.
 *
 * The plugin shows that notice when the installed app is older than its
 * `MIN_APP_VERSION` (src/userplugins/vcTranslate/appNotice.ts). If a release
 * shipped an app whose own version is below that minimum, EVERY user, the
 * ones who just downloaded it included, would be told to download it again.
 * `pnpm release` refuses that build.
 *
 * Read from the plugin SOURCE, as languageShared.test.ts does, because the
 * installer cannot import plugin files.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const APP_NOTICE_SOURCE = join("src", "userplugins", "vcTranslate", "appNotice.ts");

/** `MIN_APP_VERSION` out of appNotice.ts, or null when it cannot be found. */
export function readMinAppVersion(repoRoot: string): string | null {
    let source: string;
    try {
        source = readFileSync(join(repoRoot, APP_NOTICE_SOURCE), "utf8");
    } catch {
        return null;
    }
    const match = /export const MIN_APP_VERSION\s*=\s*"(\d+(?:\.\d+)*)"/.exec(source);
    return match ? match[1]! : null;
}

/** a >= b, for dotted numeric versions ("0.2" = "0.2.0"). */
export function versionAtLeast(a: string, b: string): boolean {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) return x > y;
    }
    return true;
}

/** Null when the release is fine, else the reason it is not. */
export function minAppVersionProblem(appVersion: string, repoRoot: string): string | null {
    const min = readMinAppVersion(repoRoot);
    if (min === null) return `could not read MIN_APP_VERSION from ${APP_NOTICE_SOURCE}.`;
    if (!versionAtLeast(appVersion, min)) {
        return `the app is ${appVersion} but the plugin's MIN_APP_VERSION is ${min}: every user, new ones included, `
            + "would be told to download Subline again. Bump installer/package.json or lower MIN_APP_VERSION.";
    }
    return null;
}
