/**
 * electron-builder's hooks — the three points where packaging is allowed to
 * refuse.
 *
 * Referenced by path from `package.json`'s `build` block. electron-builder
 * imports this file and looks for a named export matching the hook, so the whole
 * lifecycle lives in one file rather than three shims.
 *
 * ## Why hooks at all
 *
 * A packaging configuration is a set of promises: "the mod bundle will be at
 * `Contents/Resources/mod`", "the app will be signed", "it will be notarized".
 * Every one of them is silent when it does not happen. This project's recurring
 * failure — an install that was present, verified and completely inert — is what
 * a broken promise looks like from the outside, and it is only ever caught by
 * something that goes and LOOKS.
 *
 * So:
 *   beforePack  the bundle we are about to ship is the build this checkout produces
 *   afterPack   it actually arrived inside the app, and still says the same thing
 *   afterSign   the signed app is notarized and carries a stapled ticket
 *
 * ## Raw Node, no compiler
 *
 * electron-builder `import()`s this file directly. Node strips the types from the
 * `.ts` modules it imports, which is why every one of them imports only builtins
 * — the same constraint `src/bundle/spec.ts` documents and for the same reason:
 * the check the build runs and the check the installer runs must be the same
 * code, not two lists of rules that agree today.
 */

import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { computeStamp } from "../../scripts/stampBuild.mjs";
import { inspectBundleDir } from "../src/bundle/spec.ts";
import { assertBundleIdentity, packagedModDir } from "./bundleIdentity.ts";
import { notarizeAndStaple } from "./notarize.ts";

const run = promisify(execFile);

const PACKAGING_DIR = dirname(fileURLToPath(import.meta.url));
const INSTALLER_DIR = dirname(PACKAGING_DIR);

/** The bundle `extraResources` copies. Kept here so the config and the check cannot drift. */
export const SHIPPED_MOD_DIR = join(INSTALLER_DIR, "build", "mod");

function say(message) {
    process.stdout.write(`  [subline] ${message}\n`);
}

/**
 * Before anything is copied: is `build/mod` the build these sources produce?
 *
 * `build/mod` is gitignored and survives branch switches, so a stale one is not
 * a hypothetical. `bundleIdentity.ts` explains exactly what shipping one would
 * do; the short version is that the app would install a bundle whose build id no
 * committed source produces, and every check downstream would pass.
 */
export function beforePack() {
    const stamp = computeStamp();
    const report = assertBundleIdentity({
        bundleDir: SHIPPED_MOD_DIR,
        expectedBuildId: stamp.buildId,
        expectedPluginVersion: stamp.version,
        inspect: inspectBundleDir
    });
    say(`mod bundle ${report.buildId} (plugin ${report.pluginVersion}) agrees with this checkout`);
}

/**
 * After the app directory exists: did the bundle actually land in it?
 *
 * The same check, against the copy inside the app rather than the source. This is
 * the one that catches an `extraResources` entry that stopped matching, a
 * `files` pattern that excluded it, or an arch-specific pack that skipped it —
 * none of which fail the build on their own.
 */
export function afterPack(context) {
    const stamp = computeStamp();
    const modDir = packagedModDir({
        electronPlatformName: context.electronPlatformName,
        appOutDir: context.appOutDir,
        productName: context.packager.appInfo.productFilename
    });
    const report = assertBundleIdentity({
        bundleDir: modDir,
        expectedBuildId: stamp.buildId,
        expectedPluginVersion: stamp.version,
        inspect: inspectBundleDir
    });
    say(`packaged mod bundle at ${modDir} is ${report.buildId}`);
}

/**
 * After the app is signed, before the DMG wraps it: notarize and staple.
 *
 * Here rather than on the DMG alone so the ticket travels with the app itself —
 * see `notarize.ts`. A local build with `SUBLINE_NOTARIZE` unset skips this and
 * says so; the release script is what makes it mandatory.
 */
export async function afterSign(context) {
    if (context.electronPlatformName !== "darwin") return;

    const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const outcome = await notarizeAndStaple({
        path: appPath,
        env: process.env,
        exec: (file, args) => run(file, [...args]),
        log: say,
        archivePathFor: app => `${app}.notarize.zip`,
        cleanup: archive => rmSync(archive, { force: true })
    });
    say(
        outcome.status === "notarized"
            ? `notarized and stapled ${appPath} (${outcome.auth})`
            : `NOT notarized — ${outcome.reason}`
    );
}

export default { beforePack, afterPack, afterSign };
