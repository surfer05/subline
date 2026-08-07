/**
 * The real `HelperPorts` — where the helper meets the operating system.
 *
 * Same split as `main/ports.ts`: nothing here makes a decision, and it imports
 * nothing from `electron`, so the whole helper is runnable and testable from a
 * plain Node process. Every hazard the task names — `launchctl`, the network, the
 * filesystem — is a function on an object here, and the tests substitute all
 * three. No test in this suite registers a LaunchAgent, opens a socket, or reads
 * `/Applications`.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { installModBundle } from "../app/modInstall.js";
import { isDiscordRunning } from "../app/discordProcess.js";
import { inspectModBundle } from "../bundle/bundle.js";
import { modBundleDirFor, productDirFor } from "../bundle/layout.js";
import { manifestPathFor } from "../bundle/spec.js";
import { listProcesses } from "../main/ports.js";
import { locateDiscordInstalls } from "../patcher/locate.js";
import { readMarker } from "../patcher/marker.js";
import { patchInstall, verifyPatch } from "../patcher/patch.js";
import { err, fsError, ok } from "../patcher/result.js";
import { inspectInstall } from "../patcher/state.js";
import { readDiscordVersion } from "../patcher/version.js";
import { verifyOnce } from "../verify/verify.js";
import { helperStatePathFor, readHelperState, writeHelperState } from "./state.js";
const run = promisify(execFile);
/** How long a single network call may take before it is a failure, not a wait. */
export const FETCH_TIMEOUT_MS = 30_000;
/**
 * Refuse a body larger than this.
 *
 * A background process downloading an unbounded response into memory is a way to
 * be denied service by a mistake at the other end, and the real bundle is under a
 * megabyte compressed.
 */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
async function fetchBody(url, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
        if (!response.ok) {
            return err("NETWORK_ERROR", `The release feed answered ${response.status}.`, { path: url });
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
            return err("NETWORK_ERROR", `The download is larger than Subline will accept (${buffer.byteLength} bytes).`, {
                path: url
            });
        }
        return ok({ bytes: buffer, text: () => new TextDecoder().decode(buffer) });
    }
    catch (cause) {
        return err("NETWORK_ERROR", "Subline could not reach the release feed.", { path: url, cause });
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Unpack a verified archive.
 *
 * `ditto -x -k` rather than an unzip library: it ships with macOS, it is what
 * Apple's own tooling uses, and one fewer dependency in a process that installs
 * code is worth a `child_process` call. The archive is written to a temp
 * directory and removed by the caller.
 *
 * The bundle is then LOCATED rather than assumed at the root — a GitHub release
 * asset commonly wraps its contents in one directory, and guessing wrong would
 * present as "the downloaded bundle is invalid" for a perfectly good download.
 */
export async function unpackArchive(bytes, artifactName, exec, platform) {
    const scratch = mkdtempSync(join(tmpdir(), "subline-update-"));
    const archivePath = join(scratch, artifactName.replace(/[^\w.-]/g, "_"));
    const target = join(scratch, "unpacked");
    try {
        writeFileSync(archivePath, bytes);
        mkdirSync(target, { recursive: true });
        if (platform === "win32")
            await exec("tar", ["-xf", archivePath, "-C", target]);
        else
            await exec("/usr/bin/ditto", ["-x", "-k", archivePath, target]);
    }
    catch (cause) {
        rmSync(scratch, { recursive: true, force: true });
        return fsError(cause, archivePath, "unpack the downloaded Subline mod");
    }
    const found = findBundleRoot(target);
    if (found === null) {
        rmSync(scratch, { recursive: true, force: true });
        return err("MOD_BUNDLE_INVALID", "The downloaded archive contains no Subline mod bundle.", {
            path: target
        });
    }
    return ok(found);
}
/** The directory holding `subline-mod.json`, at the root or one level down. */
export function findBundleRoot(dir) {
    try {
        if (statSync(manifestPathFor(dir)).isFile())
            return dir;
    }
    catch {
        // Not at the root; look one level down before giving up.
    }
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return null;
    }
    for (const entry of entries) {
        const candidate = join(dir, entry);
        try {
            if (!statSync(candidate).isDirectory())
                continue;
            if (statSync(manifestPathFor(candidate)).isFile())
                return candidate;
        }
        catch {
            continue;
        }
    }
    return null;
}
/**
 * A macOS user notification.
 *
 * AppleScript string escaping is done by hand because there is no parameterised
 * form. Our messages are fixed strings with scalars interpolated (spec §7 — never
 * message text), but a path can still contain a quote, and an unescaped one would
 * turn a notification into an osascript syntax error at the exact moment we are
 * trying to tell somebody something.
 */
export async function notifyMac(alert, exec) {
    const escape = (value) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await exec("/usr/bin/osascript", [
        "-e",
        `display notification "${escape(alert.message)}" with title "Subline"`
    ]);
}
/** `launchctl`, wrapped so the tests never spawn it. */
export function createLaunchctl(exec = (file, args) => run(file, args)) {
    return {
        async bootstrap(plistPath, uid) {
            try {
                await exec("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
                return ok(true);
            }
            catch (cause) {
                return err("HELPER_REGISTRATION_FAILED", "launchctl refused to register the Subline helper.", {
                    path: plistPath,
                    cause
                });
            }
        },
        async bootout(label, uid) {
            try {
                await exec("/bin/launchctl", ["bootout", `gui/${uid}/${label}`]);
                return ok(true);
            }
            catch (cause) {
                return err("HELPER_REGISTRATION_FAILED", "launchctl refused to unregister the Subline helper.", {
                    cause
                });
            }
        },
        async isLoaded(label, uid) {
            try {
                await exec("/bin/launchctl", ["print", `gui/${uid}/${label}`]);
                return true;
            }
            catch {
                return false;
            }
        }
    };
}
export function createHelperPorts(options) {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    const exec = options.exec ?? ((file, args) => run(file, args));
    const fetchImpl = options.fetchImpl ?? fetch;
    const productDir = productDirFor(platform, env, home);
    const modDir = modBundleDirFor(platform, env, home);
    const statePath = productDir === null ? null : helperStatePathFor(productDir);
    return {
        platform,
        productVersion: options.productVersion,
        log: options.log,
        now: () => Date.now(),
        sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
        productDir,
        modBundleDir: modDir,
        locate: () => locateDiscordInstalls({
            platform,
            ...(options.searchRoots === undefined ? {} : { searchRoots: options.searchRoots })
        }),
        inspect: install => inspectInstall(install),
        readMarker: resourcesPath => readMarker(resourcesPath),
        readDiscordVersion: install => readDiscordVersion(install),
        verifyPatch: (install, expected) => verifyPatch(install, expected),
        patch: (install, patchOptions) => patchInstall(install, {
            modBundleDir: patchOptions.modBundleDir,
            productVersion: options.productVersion
            // `overwriteForeignMod` is deliberately never passed. A helper
            // that could patch over another mod would do it while nobody was
            // there to consent (spec §3 step 4).
        }),
        inspectBundle: dir => inspectModBundle(dir),
        installBundle: sourceDir => modDir === null
            ? err("MOD_BUNDLE_INVALID", "Subline does not know where to install the mod on this platform.")
            : installModBundle({ sourceDir, destDir: modDir }),
        discordRunning: async (install) => (await isDiscordRunning({
            branch: install.branch,
            platform,
            listProcesses: () => listProcesses(platform, exec)
        })).length > 0,
        mtimeOf: path => {
            try {
                return statSync(path).mtimeMs;
            }
            catch {
                return null;
            }
        },
        readState: () => (statePath === null ? emptyState() : readHelperState(statePath)),
        writeState: (state) => statePath === null
            ? err("IO_ERROR", "Subline has no per-user directory on this platform.")
            : writeHelperState(statePath, state),
        releaseManifestUrl: options.releaseManifestUrl ?? null,
        fetchText: async (url) => {
            const body = await fetchBody(url, fetchImpl);
            return body.ok ? ok(body.value.text()) : body;
        },
        fetchBinary: async (url) => {
            const body = await fetchBody(url, fetchImpl);
            return body.ok ? ok(body.value.bytes) : body;
        },
        unpack: (bytes, artifactName) => unpackArchive(bytes, artifactName, exec, platform),
        discardUnpacked: dir => {
            // The bundle sits inside the scratch root `unpackArchive` made; remove
            // the whole thing rather than leaving the archive behind.
            try {
                rmSync(join(dir, "..", ".."), { recursive: true, force: true });
            }
            catch {
                // A stranded temp directory is cosmetic and must never mask a real
                // failure in the run that produced it.
            }
        },
        verifyBeacon: verifyOptions => verifyOnce({ ...verifyOptions, platform, env, home }),
        notify: alert => (platform === "darwin" ? notifyMac(alert, exec) : Promise.resolve())
    };
}
function emptyState() {
    // `state.ts` owns the shape; a path that cannot be read yields the empty
    // state, which is exactly what "no per-user directory" should produce.
    return readHelperState("");
}
//# sourceMappingURL=ports.js.map