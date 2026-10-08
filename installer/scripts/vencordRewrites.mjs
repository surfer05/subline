/**
 * Source rewrites applied to the pinned Vencord checkout before it is built.
 *
 * Each rewrite is ANCHORED: the text it replaces must appear exactly once, or
 * the build fails. A pin bump that moves the code then stops the build instead
 * of silently shipping without the change.
 *
 * Pure functions over source text, so a test can run them on the pinned file
 * without a checkout or a network.
 */

/** Replace `from` with `to`, requiring exactly one occurrence of `from`. */
export function rewriteExactlyOnce(source, from, to, { file, what }) {
    const seen = source.split(from).length - 1;
    if (seen !== 1) {
        throw new Error(
            `Cannot rewrite ${file}: expected exactly one ${what}, found ${seen}. `
            + "The pinned Vencord commit has changed this code; re-derive the anchor against the new source and rebuild."
        );
    }
    return source.replace(from, () => to);
}

export const PERSIST_FILE = "src/main/persistAfterDiscordUpdates.ts";

const PERSIST_IMPORT = `import { copyFileSync, existsSync, readdirSync, renameSync } from "original-fs";`;
const PERSIST_IMPORT_WITH_RW = `import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "original-fs";`;

/** The two lines upstream runs on a Windows host update. The marker block goes right after them. */
export const PERSIST_ANCHOR = "        renameSync(newAppAsar, newAppAsarBackup);\n        copyFileSync(oldVencordAsar, newAppAsar);\n";

/**
 * Plain JavaScript (no type syntax), so a test can execute it as is. Free
 * names: existsSync, readFileSync, writeFileSync, join, oldResources,
 * resources, newAppAsarBackup, console.
 *
 * WHY: upstream copies the OLD folder's app.asar (Subline's stub) into the NEW
 * app-x.y.z folder and nothing else, so the new folder had no
 * subline-patch.json and Subline's helper and uninstall did not know it as
 * Subline's (field logs 2026-09 and 2026-10). The marker is not copied
 * verbatim: discordVersion, backupPath and patchedAt describe the folder it
 * sits in, so they are rewritten for the new one. Its own try, so a marker
 * failure never undoes or blocks the stub copy that keeps Discord translating.
 */
export const MARKER_CARRY_BLOCK = [
    "        // Subline: carry the ownership marker into the new app folder.",
    "        try {",
    "            const sublineOldMarker = join(oldResources, \"subline-patch.json\");",
    "            if (existsSync(sublineOldMarker)) {",
    "                const sublineMarker = JSON.parse(readFileSync(sublineOldMarker, \"utf8\"));",
    "                if (sublineMarker !== null && typeof sublineMarker === \"object\" && sublineMarker.product === \"subline\") {",
    "                    try {",
    "                        const sublineVersion = JSON.parse(readFileSync(join(resources, \"build_info.json\"), \"utf8\")).version;",
    "                        if (typeof sublineVersion === \"string\") sublineMarker.discordVersion = sublineVersion;",
    "                    } catch { }",
    "                    sublineMarker.backupPath = newAppAsarBackup;",
    "                    sublineMarker.patchedAt = new Date().toISOString();",
    "                    writeFileSync(join(resources, \"subline-patch.json\"), JSON.stringify(sublineMarker, null, 4) + \"\\n\", \"utf8\");",
    "                }",
    "            }",
    "        } catch (sublineErr) {",
    "            console.error(\"[Subline] Could not carry the patch marker to the new Discord folder\", sublineErr);",
    "        }",
    ""
].join("\n");

/** The import the quit hook needs, added after upstream's events import. */
export const EVENTS_IMPORT = `import EventEmitter from "events";\n`;
export const SPAWN_IMPORT = `import { spawn as sublineSpawn } from "child_process";\n`;

/** Upstream's before-quit line. The quit hook goes right after it, inside the same platform block. */
export const BEFORE_QUIT_ANCHOR = "    app.on(\"before-quit\", patchLatest);\n";

/**
 * Start Subline's background helper as Discord REALLY quits, on Windows
 * (audit 2026-10-06 #28). A repair that needs app.asar written waits for
 * Discord to be closed; the helper only looked every 5 minutes, so a quit
 * and reopen inside that gap was never caught and the same "quit Discord"
 * notice came back day after day.
 *
 * will-quit fires on a real quit only (closing the window to the tray is
 * not one). It writes discord-quit.json in Subline's folder (only when that
 * folder exists: Subline is installed for this account), so the helper knows
 * Discord is on its way out and waits up to 30 s for it to finish exiting,
 * then runs `schtasks /Run` on the helper task: a fixed command, detached and
 * hidden, so Discord's quit is never held up. A task that is not there, or
 * a run already going (IgnoreNew), is a no-op. Its own try: it can never
 * stop Discord quitting.
 *
 * Plain JavaScript (no type syntax). Free names: app, existsSync,
 * writeFileSync, join, sublineSpawn, process, console.
 */
export const QUIT_HOOK_BLOCK = [
    "",
    "    // Subline: start the background helper as Discord really quits (Windows).",
    "    if (process.platform === \"win32\") app.on(\"will-quit\", () => {",
    "        try {",
    "            const sublineLocal = process.env.LOCALAPPDATA;",
    "            if (!sublineLocal) return;",
    "            const sublineDir = join(sublineLocal, \"Subline\");",
    "            if (!existsSync(sublineDir)) return;",
    "            writeFileSync(join(sublineDir, \"discord-quit.json\"), JSON.stringify({ at: Date.now(), pid: process.pid }) + \"\\n\", \"utf8\");",
    "            sublineSpawn(\"schtasks.exe\", [\"/Run\", \"/TN\", \"\\\\Subline\\\\Helper\"], { detached: true, stdio: \"ignore\", windowsHide: true }).unref();",
    "        } catch (sublineErr) {",
    "            console.error(\"[Subline] Could not start the background helper on quit\", sublineErr);",
    "        }",
    "    });",
    ""
].join("\n");

/** persistAfterDiscordUpdates.ts with the marker carried across a host update, and the quit hook. */
export function carryMarkerOnHostUpdate(source) {
    let out = rewriteExactlyOnce(source, PERSIST_IMPORT, PERSIST_IMPORT_WITH_RW, {
        file: PERSIST_FILE,
        what: "original-fs import line"
    });
    out = rewriteExactlyOnce(out, PERSIST_ANCHOR, PERSIST_ANCHOR + MARKER_CARRY_BLOCK, {
        file: PERSIST_FILE,
        what: "host-update rename and copy block"
    });
    out = rewriteExactlyOnce(out, EVENTS_IMPORT, EVENTS_IMPORT + SPAWN_IMPORT, {
        file: PERSIST_FILE,
        what: "events import line"
    });
    out = rewriteExactlyOnce(out, BEFORE_QUIT_ANCHOR, BEFORE_QUIT_ANCHOR + QUIT_HOOK_BLOCK, {
        file: PERSIST_FILE,
        what: "before-quit line"
    });
    return out;
}
