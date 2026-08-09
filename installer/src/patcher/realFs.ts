import { createRequire } from "node:module";
import * as nodeFs from "node:fs";

/**
 * The UNPATCHED filesystem module, for the one job that needs it: reading and
 * writing Discord's `app.asar` as a file full of bytes.
 *
 * WHY THIS EXISTS. Electron monkey-patches `node:fs` so that any path
 * containing `.asar` is treated as a **virtual archive to mount**, not a file
 * to open. That is exactly right for Electron's own bundled resources and
 * exactly wrong for us: our whole job is to rename, rewrite and byte-verify
 * somebody else's asar. Under Electron, `openSync("/Applications/Discord.app/
 * Contents/Resources/app.asar")` therefore fails, and the failure surfaces as
 * an open-syscall error — which the installer then reported to the user as
 * "Discord needs repairing", on a completely healthy install.
 *
 * WORSE THAN A FAILED CALL: A LEAKED HANDLE. Electron's hooks route asar paths
 * through `getOrCreateArchive`, which opens the archive and **caches it, with
 * its file descriptor, for the lifetime of the process**. So a harmless-looking
 * `existsSync(".../app.asar")` does not just answer a question — it takes a
 * permanent handle on Discord's archive. On macOS that costs nothing, because
 * POSIX renames open files happily. On Windows it is fatal: the later
 * `renameSync(app.asar, _app.asar)` fails with a sharing violation, every time,
 * and no retry can ever clear it because nothing releases the cache short of
 * quitting. That was a real shipped failure — the installer held its own target
 * open and blamed the filesystem.
 *
 * The consequence for call sites: it is not enough to use this module for the
 * WRITES. Every read, probe and `existsSync` on an asar path has to come from
 * here too. `tests/realFs.test.ts` enforces that nothing else in `patcher/`
 * imports `node:fs` at all, because "which of these calls touches an asar path"
 * is not a judgement anyone should have to re-make correctly on every edit.
 *
 * WHY NO TEST CAUGHT IT. vitest runs in plain Node, where `node:fs` is not
 * patched, so every unit test passed against the real file while the packaged
 * app could not read it at all. This is a whole class of bug that unit tests
 * structurally cannot see, which is why the call sites below import from here
 * rather than from `node:fs` directly.
 *
 * `original-fs` is Electron's own escape hatch and exists ONLY inside Electron;
 * in plain Node the require throws and we fall back to the ordinary module,
 * which is unpatched anyway. That makes this file a no-op outside Electron and
 * load-bearing inside it.
 *
 * Chosen over the global `process.noAsar = true` deliberately: that flag is
 * action-at-a-distance — anything setting or clearing it elsewhere silently
 * changes behaviour here, and forgetting to restore it would break Electron's
 * own asar handling for the rest of the process.
 */
const require = createRequire(import.meta.url);

let impl: typeof nodeFs;
try {
    // Electron only. Not in package.json, and must never be — resolving it is
    // the runtime test for "are we inside Electron".
    impl = require("original-fs") as typeof nodeFs;
} catch {
    impl = nodeFs;
}

/** True when the unpatched module was available, i.e. we are inside Electron. */
export const usingOriginalFs = impl !== nodeFs;

export const {
    closeSync,
    existsSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync
} = impl;
