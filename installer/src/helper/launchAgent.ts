/**
 * The macOS LaunchAgent (spec §2, §4, §6).
 *
 * ## It is the app, with a flag — not a second binary
 *
 * `ProgramArguments` is `[<Subline.app>/Contents/MacOS/Subline, "--helper"]`.
 * Spec §2 states the reason and it is not a preference: **on macOS, TCC grants
 * attach to a code-signing identity.** Modifying `Discord.app` needs App
 * Management, which the user grants once, to Subline, during install. A separate
 * helper executable is a different identity, so it would be blocked and would
 * raise its OWN App Management prompt — weeks later, out of nowhere, for a
 * process the user never launched. That is far more confusing than the first
 * prompt, and it arrives at the exact moment the helper is trying to be silent.
 *
 * Running the app with a flag also means the helper's re-patch is performed by
 * the identity that was granted permission to perform it.
 *
 * ## Everything is injected, so no test ever registers an agent
 *
 * `plistPath` is a parameter and `launchctl` is a port. The tests write plists
 * into a temp directory and drive a fake `launchctl`; nothing in this suite may
 * write to `~/Library/LaunchAgents` or spawn `launchctl`, for the same reason
 * nothing writes to `/Applications`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Result } from "../patcher/result.js";
import { err, fsError, ok, rewrap } from "../patcher/result.js";

/** Reverse-DNS, matching the app id in `package.json`'s electron-builder block. */
export const HELPER_LABEL = "com.subline.helper";

/** The argument that turns the app into the helper. Checked in `main.ts`. */
export const HELPER_FLAG = "--helper";

export const LAUNCH_AGENTS_DIR_NAME = "LaunchAgents";

/**
 * Hourly.
 *
 * The work is reading a handful of small files, so the cost is negligible, and
 * the benefit is that a Discord update is repaired within the hour rather than at
 * the next login — which for a machine that sleeps rather than shuts down could
 * be weeks. Network work is throttled separately (see `helper.ts`), so an hourly
 * run does not mean an hourly download check.
 */
export const DEFAULT_INTERVAL_SECONDS = 3600;

export interface LaunchAgentSpec {
    label: string;
    programArguments: readonly string[];
    intervalSeconds: number;
    runAtLoad: boolean;
    /**
     * Paths launchd watches; any change to one starts the helper. Empty means no
     * WatchPaths key at all (the hourly interval and RunAtLoad still apply).
     */
    watchPaths?: readonly string[];
}

/**
 * What launchd watches for one managed Discord: its app.asar AND the Resources
 * directory that holds it.
 *
 * Field evidence (Discord 0.0.413 to 0.0.414): an update replaced app.asar and
 * wiped the patch, and the hourly run repaired it ~15 minutes later (up to 60).
 * Watching the file alone is not enough, because an update REPLACES it (a
 * rename over the old inode), and a watched path that vanishes and reappears is
 * exactly the case to cover; the directory changes on every such swap. launchd
 * rate-limits a job to one start per 10s (ThrottleInterval), so a burst of
 * writes during an update is at most a few runs, and every run waits for the
 * files to settle before writing anything (settle.ts).
 *
 * Sorted and de-duplicated so the same set of installs always renders the same
 * plist: ensureHelperFor compares the rendered text to decide whether the
 * registration is outdated.
 */
export function launchAgentWatchPaths(resourcesPaths: readonly string[]): string[] {
    const out = new Set<string>();
    for (const resources of resourcesPaths) {
        if (typeof resources !== "string" || resources === "") continue;
        out.add(join(resources, "app.asar"));
        out.add(resources);
    }
    return [...out].sort();
}

export function helperProgramArguments(appPath: string, executableName = "Subline"): string[] {
    return [join(appPath, "Contents", "MacOS", executableName), HELPER_FLAG];
}

export function launchAgentPlistPath(home: string, label: string = HELPER_LABEL): string {
    return join(home, "Library", LAUNCH_AGENTS_DIR_NAME, `${label}.plist`);
}

/**
 * The agent Subline installs. One place that knows what it is, so the app, the
 * uninstaller and the tests cannot describe it differently.
 */
export function helperLaunchAgentSpec(
    appPath: string,
    intervalSeconds: number = DEFAULT_INTERVAL_SECONDS,
    executableName = "Subline",
    managedResourcesPaths: readonly string[] = []
): LaunchAgentSpec {
    return {
        label: HELPER_LABEL,
        programArguments: helperProgramArguments(appPath, executableName),
        intervalSeconds,
        watchPaths: launchAgentWatchPaths(managedResourcesPaths),
        // Spec §6: at login AND periodically. `RunAtLoad` is the half that
        // repairs a Discord that updated while the machine was off.
        runAtLoad: true
    };
}

/**
 * XML escaping.
 *
 * An application path is user-controlled — Subline can be dragged anywhere, and
 * `&` and `'` are legal in macOS folder names. An unescaped one produces a plist
 * `launchd` refuses to parse, which would present as "the helper silently never
 * runs": the exact class of failure this whole task exists to eliminate.
 */
function xml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/**
 * Render the plist.
 *
 * `StandardOutPath`/`StandardErrorPath` are deliberately absent. launchd would
 * append to them forever with no rotation, and this helper already writes to the
 * rotating diagnostics log spec §7 requires — a second, unbounded copy of the
 * same lines in a file nobody rotates is how a background agent quietly fills a
 * disk.
 */
export function renderLaunchAgentPlist(spec: LaunchAgentSpec): string {
    const args = spec.programArguments.map(argument => `        <string>${xml(argument)}</string>`).join("\n");
    const watch = spec.watchPaths ?? [];
    const watchBlock = watch.length === 0
        ? ""
        : `    <key>WatchPaths</key>
    <array>
${watch.map(path => `        <string>${xml(path)}</string>`).join("\n")}
    </array>
    <key>ThrottleInterval</key>
    <integer>10</integer>
`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xml(spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <${spec.runAtLoad ? "true" : "false"}/>
    <key>StartInterval</key>
    <integer>${Math.max(1, Math.trunc(spec.intervalSeconds))}</integer>
${watchBlock}    <key>ProcessType</key>
    <string>Background</string>
    <key>LowPriorityIO</key>
    <true/>
</dict>
</plist>
`;
}

/**
 * `launchctl`, as the only thing this module cannot do with the filesystem.
 *
 * Modern `bootstrap`/`bootout` against a `gui/<uid>` domain rather than the
 * deprecated `load -w`: `load` is a no-op on recent macOS in some contexts and
 * reports success anyway, and a registration that silently did not happen is
 * indistinguishable, later, from a helper that ran and found nothing to do.
 */
export interface LaunchctlPort {
    /** `launchctl bootstrap gui/<uid> <plistPath>` */
    bootstrap(plistPath: string, uid: number): Promise<Result<true>>;
    /** `launchctl bootout gui/<uid>/<label>` */
    bootout(label: string, uid: number): Promise<Result<true>>;
    /** `launchctl print gui/<uid>/<label>` — is it registered right now? */
    isLoaded(label: string, uid: number): Promise<boolean>;
}

export interface InstallLaunchAgentOptions {
    plistPath: string;
    spec: LaunchAgentSpec;
    uid: number;
    launchctl: LaunchctlPort;
    platform?: NodeJS.Platform;
}

export interface LaunchAgentReport {
    plistPath: string;
    label: string;
    /** True when a previous registration was replaced. */
    replaced: boolean;
    loaded: boolean;
}

/**
 * Write the plist and register it.
 *
 * Order matters: the existing registration is booted out FIRST. `bootstrap` on an
 * already-registered label fails, and a plist rewritten under a running agent
 * would leave launchd holding the previous arguments until the next login —
 * silently, which is the one thing this helper must never be.
 */
export async function installLaunchAgent(options: InstallLaunchAgentOptions): Promise<Result<LaunchAgentReport>> {
    const platform = options.platform ?? process.platform;
    if (platform !== "darwin") {
        return err<LaunchAgentReport>(
            "HELPER_REGISTRATION_FAILED",
            "LaunchAgents are a macOS mechanism; Windows uses a Scheduled Task instead."
        );
    }

    const { plistPath, spec, uid, launchctl } = options;
    const replaced = await launchctl.isLoaded(spec.label, uid);
    if (replaced) {
        // A failure here is not fatal: `bootout` of something launchd has already
        // forgotten reports failure, and the bootstrap below is the check that
        // matters.
        await launchctl.bootout(spec.label, uid);
    }

    const temp = `${plistPath}.tmp`;
    try {
        mkdirSync(join(plistPath, ".."), { recursive: true });
        writeFileSync(temp, renderLaunchAgentPlist(spec), "utf8");
        renameSync(temp, plistPath);
    } catch (cause) {
        return fsError<LaunchAgentReport>(cause, plistPath, "write the Subline helper's LaunchAgent");
    }

    const bootstrapped = await launchctl.bootstrap(plistPath, uid);
    if (!bootstrapped.ok) {
        // Leave nothing half-registered: a plist on disk with no live agent would
        // load at the NEXT login and hide the failure from this one.
        try {
            rmSync(plistPath, { force: true });
        } catch {
            // Reporting the registration failure matters more than the tidy-up.
        }
        // Carries launchctl's stderr, which is the only thing that says WHY.
        return rewrap<LaunchAgentReport>(bootstrapped.error, {
            code: "HELPER_REGISTRATION_FAILED",
            path: plistPath
        });
    }

    // Registration is CONFIRMED, not assumed — the same standard the patcher
    // holds its own writes to.
    const loaded = await launchctl.isLoaded(spec.label, uid);
    if (!loaded) {
        return err<LaunchAgentReport>(
            "HELPER_REGISTRATION_FAILED",
            "The Subline helper was registered but macOS does not list it, so background updates would not run.",
            { path: plistPath }
        );
    }

    return ok({ plistPath, label: spec.label, replaced, loaded });
}

/**
 * Remove the agent — spec §8 step 3.
 *
 * `ok(false)` means there was nothing registered and no plist, which is the
 * honest answer for an uninstall run twice. Unregistering comes first: deleting
 * the plist under a live agent leaves it running until the next logout, which is
 * an uninstalled product still patching Discord.
 */
export async function removeLaunchAgent(options: {
    plistPath: string;
    label: string;
    uid: number;
    launchctl: LaunchctlPort;
}): Promise<Result<boolean>> {
    const { plistPath, label, uid, launchctl } = options;
    const wasLoaded = await launchctl.isLoaded(label, uid);
    if (wasLoaded) {
        const booted = await launchctl.bootout(label, uid);
        if (!booted.ok) {
            return rewrap<boolean>(booted.error, {
                code: "HELPER_REGISTRATION_FAILED",
                message: `The Subline background helper could not be unregistered (${booted.error.message}), so its file was left in place rather than leaving a running agent with no configuration.`,
                path: plistPath
            });
        }
    }

    const existed = existsSync(plistPath);
    if (existed) {
        try {
            rmSync(plistPath, { force: true });
        } catch (cause) {
            return fsError<boolean>(cause, plistPath, "remove the Subline helper's LaunchAgent");
        }
    }
    return ok(wasLoaded || existed);
}

/** Read a plist back — used by tests and by the app's "is the helper installed?" check. */
export function readLaunchAgentPlist(plistPath: string): string | null {
    try {
        return readFileSync(plistPath, "utf8");
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------------ *
 * Is the running app somewhere the helper can keep using?
 *
 * Audit 2026-10-06 #24. A LaunchAgent registered from Subline.app opened
 * straight off the .dmg (/Volumes/Subline/...) or from a Gatekeeper-
 * translocated copy (.../AppTranslocation/...) runs once and then never again:
 * the disk image is ejected, the translocation goes away, and every later run
 * fails inside launchd where Subline never hears of it. The next Discord update
 * then ends translation with nothing to repair it.
 *
 * "/Volumes/" alone is not proof: an app kept on an external or second disk is
 * a stable place. So a /Volumes path is refused only when a mounted disk image
 * holds it. When the images cannot be listed, it is refused anyway: a helper
 * that dies silently is worse than asking the user to move the app.
 * ------------------------------------------------------------------------ */

/** The mount points of every attached disk image (`hdiutil info -plist`). Injected, so tests never run hdiutil. */
export type DiskImageMounts = () => Promise<Result<readonly string[]>>;

export type TemporaryLocationReason = "translocated" | "disk-image" | "disk-image-unknown";

export type AppLocationVerdict =
    | { temporary: false; reason: null }
    | { temporary: true; reason: TemporaryLocationReason };

/** Every `mount-point` string in `hdiutil info -plist` output. */
export function parseHdiutilMountPoints(plist: string): string[] {
    const mounts: string[] = [];
    const re = /<key>mount-point<\/key>\s*<string>([^<]*)<\/string>/g;
    for (let match = re.exec(plist); match !== null; match = re.exec(plist)) {
        mounts.push((match[1] ?? "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, "\"")
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, "&"));
    }
    return mounts;
}

/** The one test every caller uses: install, the already-set-up repair, the helper's own check, and the flow. */
export async function temporaryAppLocation(appPath: string, diskImageMounts?: DiskImageMounts): Promise<AppLocationVerdict> {
    if (appPath.includes("/AppTranslocation/")) return { temporary: true, reason: "translocated" };
    if (!appPath.startsWith("/Volumes/")) return { temporary: false, reason: null };
    if (diskImageMounts === undefined) return { temporary: true, reason: "disk-image-unknown" };
    let mounts: Result<readonly string[]>;
    try {
        mounts = await diskImageMounts();
    } catch {
        return { temporary: true, reason: "disk-image-unknown" };
    }
    if (!mounts.ok) return { temporary: true, reason: "disk-image-unknown" };
    const onImage = mounts.value.some(mount => {
        const root = mount.replace(/\/+$/, "");
        return root.length > 0 && (appPath === root || appPath.startsWith(`${root}/`));
    });
    return onImage ? { temporary: true, reason: "disk-image" } : { temporary: false, reason: null };
}
