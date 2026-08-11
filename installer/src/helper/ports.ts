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

import type { FlowLogger } from "../app/flow.js";
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
import type { Result } from "../patcher/result.js";
import { inspectInstall } from "../patcher/state.js";
import { readDiscordVersion } from "../patcher/version.js";
import { verifyOnce } from "../verify/verify.js";
import type { Alert } from "./alerts.js";
import type { HelperPorts } from "./helper.js";
import type { LaunchctlPort } from "./launchAgent.js";
import type { SchtasksPort } from "./scheduledTask.js";
import { helperStatePathFor, readHelperState, writeHelperState } from "./state.js";
import type { HelperState } from "./state.js";

const run = promisify(execFile);

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

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

export interface RealHelperPortsOptions {
    productVersion: string;
    log: FlowLogger;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    /** Overridable so nothing in a test reads `/Applications`. */
    searchRoots?: readonly string[];
    releaseManifestUrl?: string | null;
    exec?: Exec;
    fetchImpl?: typeof fetch;
}

async function fetchBody(
    url: string,
    fetchImpl: typeof fetch
): Promise<Result<{ bytes: Uint8Array; text(): string }>> {
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
    } catch (cause) {
        return err("NETWORK_ERROR", "Subline could not reach the release feed.", { path: url, cause });
    } finally {
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
export async function unpackArchive(
    bytes: Uint8Array,
    artifactName: string,
    exec: Exec,
    platform: NodeJS.Platform
): Promise<Result<string>> {
    const scratch = mkdtempSync(join(tmpdir(), "subline-update-"));
    const archivePath = join(scratch, artifactName.replace(/[^\w.-]/g, "_"));
    const target = join(scratch, "unpacked");
    try {
        writeFileSync(archivePath, bytes);
        mkdirSync(target, { recursive: true });
        if (platform === "win32") await exec("tar", ["-xf", archivePath, "-C", target]);
        else await exec("/usr/bin/ditto", ["-x", "-k", archivePath, target]);
    } catch (cause) {
        rmSync(scratch, { recursive: true, force: true });
        return fsError<string>(cause, archivePath, "unpack the downloaded Subline mod");
    }

    const found = findBundleRoot(target);
    if (found === null) {
        rmSync(scratch, { recursive: true, force: true });
        return err<string>("MOD_BUNDLE_INVALID", "The downloaded archive contains no Subline mod bundle.", {
            path: target
        });
    }
    return ok(found);
}

/** The directory holding `subline-mod.json`, at the root or one level down. */
export function findBundleRoot(dir: string): string | null {
    try {
        if (statSync(manifestPathFor(dir)).isFile()) return dir;
    } catch {
        // Not at the root; look one level down before giving up.
    }
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return null;
    }
    for (const entry of entries) {
        const candidate = join(dir, entry);
        try {
            if (!statSync(candidate).isDirectory()) continue;
            if (statSync(manifestPathFor(candidate)).isFile()) return candidate;
        } catch {
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
export async function notifyMac(alert: Alert, exec: Exec): Promise<void> {
    const escape = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await exec("/usr/bin/osascript", [
        "-e",
        `display notification "${escape(alert.message)}" with title "Subline"`
    ]);
}

/** `launchctl`, wrapped so the tests never spawn it. */
export function createLaunchctl(exec: Exec = (file, args) => run(file, args)): LaunchctlPort {
    return {
        async bootstrap(plistPath: string, uid: number): Promise<Result<true>> {
            try {
                await exec("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
                return ok(true);
            } catch (cause) {
                return err<true>("HELPER_REGISTRATION_FAILED", "launchctl refused to register the Subline helper.", {
                    path: plistPath,
                    cause
                });
            }
        },
        async bootout(label: string, uid: number): Promise<Result<true>> {
            try {
                await exec("/bin/launchctl", ["bootout", `gui/${uid}/${label}`]);
                return ok(true);
            } catch (cause) {
                return err<true>("HELPER_REGISTRATION_FAILED", "launchctl refused to unregister the Subline helper.", {
                    cause
                });
            }
        },
        async isLoaded(label: string, uid: number): Promise<boolean> {
            try {
                await exec("/bin/launchctl", ["print", `gui/${uid}/${label}`]);
                return true;
            } catch {
                return false;
            }
        }
    };
}

/**
 * The Windows scheduler, as a port.
 *
 * `/F` on both Create and Delete: without it schtasks prompts on stdin, and a
 * background process with no console waits for an answer that can never come.
 * `exists` treats any non-zero exit as absent — schtasks distinguishes "not
 * found" from other failures only in localised text, and guessing at translated
 * strings is how a check silently inverts on a non-English Windows.
 */
export function createSchtasks(exec: Exec = (file, args) => run(file, args)): SchtasksPort {
    return {
        async create(name: string, xmlPath: string): Promise<Result<true>> {
            try {
                await exec("schtasks", ["/Create", "/TN", name, "/XML", xmlPath, "/F"]);
                return ok(true);
            } catch (cause) {
                return err<true>("HELPER_REGISTRATION_FAILED", "Windows refused to register the Subline helper task.", {
                    path: name,
                    cause
                });
            }
        },
        /**
         * Register without an XML document.
         *
         * The fallback for when Task Scheduler refuses the precise definition.
         * It loses StartWhenAvailable and the at-logon run — a machine switched
         * off at the scheduled hour simply waits for the next one — but it uses
         * only flags that every supported Windows accepts, and a helper that
         * repairs Discord an hour late beats no helper at all.
         */
        async createSimple(name: string, command: string): Promise<Result<true>> {
            try {
                await exec("schtasks", ["/Create", "/TN", name, "/TR", command, "/SC", "HOURLY", "/F"]);
                return ok(true);
            } catch (cause) {
                return err<true>("HELPER_REGISTRATION_FAILED", "Windows refused the simplified helper task too.", {
                    path: name,
                    cause
                });
            }
        },
        async remove(name: string): Promise<Result<true>> {
            try {
                await exec("schtasks", ["/Delete", "/TN", name, "/F"]);
                return ok(true);
            } catch (cause) {
                return err<true>("HELPER_REGISTRATION_FAILED", "Windows refused to remove the Subline helper task.", {
                    path: name,
                    cause
                });
            }
        },
        async exists(name: string): Promise<boolean> {
            try {
                await exec("schtasks", ["/Query", "/TN", name]);
                return true;
            } catch {
                return false;
            }
        }
    };
}

export function createHelperPorts(options: RealHelperPortsOptions): HelperPorts {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    const exec: Exec = options.exec ?? ((file, args) => run(file, args));
    const fetchImpl = options.fetchImpl ?? fetch;

    const productDir = productDirFor(platform, env, home);
    const modDir = modBundleDirFor(platform, env, home);
    const statePath = productDir === null ? null : helperStatePathFor(productDir);

    return {
        platform,
        productVersion: options.productVersion,
        log: options.log,
        now: () => Date.now(),
        sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),

        productDir,
        modBundleDir: modDir,

        locate: () =>
            locateDiscordInstalls({
                platform,
                ...(options.searchRoots === undefined ? {} : { searchRoots: options.searchRoots })
            }),
        inspect: install => inspectInstall(install),
        readMarker: resourcesPath => readMarker(resourcesPath),
        readDiscordVersion: install => readDiscordVersion(install),
        verifyPatch: (install, expected) => verifyPatch(install, expected),
        patch: (install, patchOptions) =>
            patchInstall(install, {
                modBundleDir: patchOptions.modBundleDir,
                productVersion: options.productVersion
                // `overwriteForeignMod` is deliberately never passed. A helper
                // that could patch over another mod would do it while nobody was
                // there to consent (spec §3 step 4).
            }),

        inspectBundle: dir => inspectModBundle(dir),
        installBundle: sourceDir =>
            modDir === null
                ? err("MOD_BUNDLE_INVALID", "Subline does not know where to install the mod on this platform.")
                : installModBundle({ sourceDir, destDir: modDir }),

        discordRunning: async install =>
            (await isDiscordRunning({
                branch: install.branch,
                platform,
                listProcesses: () => listProcesses(platform, exec)
            })).length > 0,
        mtimeOf: path => {
            try {
                return statSync(path).mtimeMs;
            } catch {
                return null;
            }
        },

        readState: () => (statePath === null ? emptyState() : readHelperState(statePath)),
        writeState: (state: HelperState) =>
            statePath === null
                ? err<string>("IO_ERROR", "Subline has no per-user directory on this platform.")
                : writeHelperState(statePath, state),

        releaseManifestUrl: options.releaseManifestUrl ?? null,
        fetchText: async url => {
            const body = await fetchBody(url, fetchImpl);
            return body.ok ? ok(body.value.text()) : body;
        },
        fetchBinary: async url => {
            const body = await fetchBody(url, fetchImpl);
            return body.ok ? ok(body.value.bytes) : body;
        },
        unpack: (bytes, artifactName) => unpackArchive(bytes, artifactName, exec, platform),
        discardUnpacked: dir => {
            // The bundle sits inside the scratch root `unpackArchive` made; remove
            // the whole thing rather than leaving the archive behind.
            try {
                rmSync(join(dir, "..", ".."), { recursive: true, force: true });
            } catch {
                // A stranded temp directory is cosmetic and must never mask a real
                // failure in the run that produced it.
            }
        },

        verifyBeacon: verifyOptions => verifyOnce({ ...verifyOptions, platform, env, home }),
        notify: alert => notify(alert, platform, exec, options.log)
    };
}

/**
 * Tell the user something, on whichever platform this is.
 *
 * A failure to notify NEVER fails the run — the helper's job is repairing
 * Discord, and an undelivered message must not undo a completed repair. But it
 * is logged, and that is the whole point: this used to be
 * `platform === "darwin" ? notifyMac(...) : Promise.resolve()`, so on Windows
 * every alert the helper ever raised was discarded by an expression that looked
 * like a platform check and read, in the log, exactly like a successful
 * notification. Nobody would have found that from the outside.
 */
export async function notify(
    alert: Alert,
    platform: NodeJS.Platform,
    exec: Exec,
    log?: FlowLogger
): Promise<void> {
    try {
        if (platform === "darwin") await notifyMac(alert, exec);
        else if (platform === "win32") await notifyWindows(alert, exec);
        else {
            log?.warn("notify.unsupported", { platform, code: alert.code });
            return;
        }
        log?.info("notify.sent", { platform, code: alert.code });
    } catch (cause) {
        log?.warn("notify.failed", {
            platform,
            code: alert.code,
            cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
        });
    }
}

/**
 * A Windows notification.
 *
 * A balloon tip through `System.Windows.Forms`, not a WinRT toast: a toast has
 * to be raised under a registered AppUserModelID, and when it is not, Windows
 * drops it silently rather than erroring — which is the exact failure mode this
 * whole change exists to remove. The balloon has no such requirement.
 *
 * `-NonInteractive -NoProfile` because a background task inherits no console: a
 * PowerShell that decides to prompt, or that runs a user profile script which
 * does, would hang until the task's time limit rather than notify anybody.
 *
 * Quoting is done by REPLACING quotes, not escaping them. Our messages are
 * fixed strings with scalars interpolated (spec §7 — never message text), so
 * nothing is lost, and there is no escaping scheme to get subtly wrong inside a
 * string that is already nested two levels deep.
 */
export async function notifyWindows(alert: Alert, exec: Exec): Promise<void> {
    const safe = alert.message.replace(/['"`$]/g, " ").replace(/\s+/g, " ").trim();
    await exec("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle", "Hidden",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms;"
        + "$n = New-Object System.Windows.Forms.NotifyIcon;"
        + "$n.Icon = [System.Drawing.SystemIcons]::Information;"
        + "$n.Visible = $true;"
        + `$n.ShowBalloonTip(10000, 'Subline', '${safe}', 'Info');`
        // Long enough for the balloon to be seen, short enough that the task's
        // ExecutionTimeLimit is never the thing that ends it.
        + "Start-Sleep -Seconds 8;"
        + "$n.Dispose()"
    ]);
}

function emptyState(): HelperState {
    // `state.ts` owns the shape; a path that cannot be read yields the empty
    // state, which is exactly what "no per-user directory" should produce.
    return readHelperState("");
}
