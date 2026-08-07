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
let impl;
try {
    // Electron only. Not in package.json, and must never be — resolving it is
    // the runtime test for "are we inside Electron".
    impl = require("original-fs");
}
catch {
    impl = nodeFs;
}
/** True when the unpatched module was available, i.e. we are inside Electron. */
export const usingOriginalFs = impl !== nodeFs;
export const { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } = impl;
//# sourceMappingURL=realFs.js.map