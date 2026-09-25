/**
 * Remove the unpacked app copies a release leaves behind.
 *
 * ## The failure this exists to prevent
 *
 * electron-builder builds each target by first writing a complete, runnable app
 * next to the archive it wraps: `release/mac/Subline.app`,
 * `release/mac-arm64/Subline.app`, `release/win-unpacked/`. Spotlight indexes
 * them like any other app, so typing "Subline" offers a stale build from the
 * release folder, and a user opened one by mistake.
 *
 * ## Why delete, and not build into a `.noindex` directory
 *
 * Nothing in `scripts/release.mjs` reads the unpacked app after the DMGs exist:
 * the app is notarized and stapled by `packaging/hooks.mjs` DURING
 * electron-builder, before the DMG wraps it; every later step (DMG
 * notarization, the manifest, the checksums) reads only the `.dmg`, `.zip` and
 * `.exe` files. So deleting at the end loses nothing, and it keeps `release/`
 * and every path in docs/RELEASING.md and the printed `gh release create`
 * command exactly as they were. Moving the output to a `.noindex` directory
 * would have changed all of those. (`pnpm pack:dir`, whose whole point is the
 * unpacked app, builds into `release/unpacked.noindex` instead, which Spotlight
 * skips.)
 *
 * It removes DIRECTORIES only, and only directly inside `outDir`, and only when
 * at least one distributable exists: a release that produced nothing to ship
 * keeps its unpacked output for diagnosis.
 *
 * Imports only Node builtins: loaded by raw Node from the release script.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** The files a release ships. Everything else in `release/` that is a directory is scratch. */
export const DISTRIBUTABLE = /\.(dmg|zip|exe)$/;

export interface UnpackedRemoval {
    /** Directory names removed, in the order found. */
    removed: string[];
    /** Why nothing was removed, when nothing was. */
    skipped: string | null;
}

export function removeUnpackedOutputs(outDir: string): UnpackedRemoval {
    const entries = readdirSync(outDir);
    const shippable = entries.filter(name => DISTRIBUTABLE.test(name) && statSync(join(outDir, name)).isFile());
    if (shippable.length === 0) {
        return { removed: [], skipped: "no .dmg, .zip or .exe was produced, so the unpacked output is kept for diagnosis" };
    }

    const removed: string[] = [];
    for (const name of entries) {
        const path = join(outDir, name);
        if (!statSync(path).isDirectory()) continue;
        rmSync(path, { recursive: true, force: true });
        removed.push(name);
    }
    return { removed, skipped: null };
}
