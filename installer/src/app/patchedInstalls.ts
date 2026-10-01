/**
 * Every Discord this account's Subline has patched, remembered on disk.
 *
 * Detection only looks where Discord normally lives, and for Stable. A user
 * with only PTB or Canary, or Discord in an unusual folder, picks it by hand,
 * and Subline patches it. Nothing used to record that, so Uninstall found
 * nothing ("There was nothing to remove") and left Discord patched, or found an
 * unrelated clean Stable and deleted the mod bundle the hand-picked Discord
 * still require()s, which stopped it starting. The helper never repaired it
 * after a Discord update either.
 *
 * Its own small file (not the helper's state, which is skipped with
 * "skip-helper" and removed by Uninstall first). Written atomically after every
 * successful patch. Read before anything is deleted.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DiscordBranch, DiscordInstall } from "../patcher/locate.js";
import type { Result } from "../patcher/result.js";
import { fsError, ok } from "../patcher/result.js";

export const PATCHED_INSTALLS_FILENAME = "patched-installs.json";

export interface RememberedInstall {
    rootPath: string;
    /** Survives Discord updates (the branch folder on Windows). See DiscordInstall.stableId. */
    stableId: string;
    branch: DiscordBranch;
}

export function patchedInstallsPathFor(productDir: string): string {
    return join(productDir, PATCHED_INSTALLS_FILENAME);
}

const BRANCHES = new Set(["stable", "ptb", "canary"]);

/** What is on disk, or nothing. Never throws: an unreadable file is an empty memory. */
export function readPatchedInstalls(productDir: string | null): RememberedInstall[] {
    if (productDir === null) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(patchedInstallsPathFor(productDir), "utf8"));
    } catch {
        return [];
    }
    const list = (parsed as { installs?: unknown } | null)?.installs;
    if (!Array.isArray(list)) return [];
    return list.flatMap(entry => {
        if (typeof entry !== "object" || entry === null) return [];
        const { rootPath, stableId, branch } = entry as Record<string, unknown>;
        if (typeof rootPath !== "string" || rootPath === "" || typeof stableId !== "string") return [];
        return [{ rootPath, stableId, branch: (typeof branch === "string" && BRANCHES.has(branch) ? branch : "stable") as DiscordBranch }];
    });
}

/** Add (or update, by stableId) one install. */
export function rememberPatchedInstall(productDir: string | null, install: DiscordInstall): Result<boolean> {
    if (productDir === null) return ok(false);
    const current = readPatchedInstalls(productDir).filter(entry => entry.stableId !== install.stableId);
    const next = [...current, { rootPath: install.rootPath, stableId: install.stableId, branch: install.branch }];
    const path = patchedInstallsPathFor(productDir);
    const temp = `${path}.tmp`;
    try {
        mkdirSync(productDir, { recursive: true });
        writeFileSync(temp, `${JSON.stringify({ format: 1, installs: next }, null, 4)}\n`, "utf8");
        renameSync(temp, path);
    } catch (cause) {
        return fsError<boolean>(cause, path, "remember which Discord Subline changed");
    }
    return ok(true);
}
