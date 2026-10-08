/**
 * The background helper (spec §6) — one run.
 *
 * ## It is two things, and shipping only the first would be shipping a corpse
 *
 * **Trigger A — Discord updated and wiped the injection.** Mechanical, always
 * fixable. This is the failure that removed Vencord from this project's own
 * machine mid-session and cost a day of misdiagnosis. Detected by comparing the
 * version we last patched against with what is on disk now, and by asking whether
 * the patch we wrote is still there. Repaired with the *existing* patcher — there
 * is deliberately no second patch path in this file.
 *
 * **Trigger B — a new mod build is published.** Discord ships a new frontend,
 * Vencord's webpack finders stop locating `MessageStore` / `FluxDispatcher`, the
 * mod loads and renders nothing, and **no amount of re-patching fixes it**. It
 * needs new code. So the helper is an updater as well as a re-patcher, or the
 * product dies quietly the first time Discord rewrites its frontend, with no
 * error anywhere.
 *
 * ## Rules this file holds itself to
 *
 * 1. **Never race the updater.** Nothing is written until `awaitDiscordSettled`
 *    says the install has stopped moving. Deferring costs one interval; patching
 *    mid-update costs a Discord that will not start.
 * 2. **Never silently overwrite somebody else's mod.** If an install has become
 *    `patched-by-other` since we patched it, the user installed something. Spec §3
 *    step 4 is "detect, explain, let them choose" — and a background process
 *    cannot ask, so it does nothing and says so in the log.
 * 3. **Never claim more than the evidence.** A patch that verifies is a patch, not
 *    a working install; `health.ts` is a separate judgement with its own, much
 *    more cautious rules.
 * 4. **Silent by default, but not silent about the unfixable.** Both triggers act
 *    without prompting. A failure the helper cannot repair raises an alert, which
 *    reaches a notification and a file the app reads.
 * 5. **Every decision is logged with its reason**, including the decision to do
 *    nothing. This log is the only record of what happened while nobody was
 *    watching, so "we skipped install X because Discord was running" has to be in
 *    it — otherwise a helper that never repairs anything looks exactly like a
 *    helper with nothing to repair.
 */

import type { FlowLogger } from "../app/flow.js";
import type { InstalledModBundle } from "../app/modInstall.js";
import type { ModBundle } from "../bundle/bundle.js";
import type { DiscordInstall } from "../patcher/locate.js";
import type { AdoptReport, PatchIdentity, PatchReport, UnpatchReport } from "../patcher/patch.js";
import type { PatchMarker } from "../patcher/marker.js";
import type { PatcherError, PatcherErrorCode, Result } from "../patcher/result.js";
import { sameLoaderPath } from "../patcher/ownership.js";
import type { InstallState } from "../patcher/state.js";
import type { DiscordBuildInfo } from "../patcher/version.js";
import type { VerificationReport, VerifyOptions } from "../verify/verify.js";
import type { Alert, AlertCode, AlertRaised } from "./alerts.js";
import { raiseAlert, repeatMsFor, resolveAlert } from "./alerts.js";
import type { HealthObservation } from "./health.js";
import { observeHealth } from "./health.js";
import type { ReleaseManifest, ReleaseVerifier } from "./release.js";
import { assertTrustedUrl, DEFAULT_VERIFIERS, isNewerBuild, parseReleaseManifest, verifyDownload } from "./release.js";
import type { SettleOptions } from "./settle.js";
import { awaitDiscordSettled } from "./settle.js";
import type { HelperState } from "./state.js";
import { emptyHelperState } from "./state.js";

/* ------------------------------------------------------------------------ *
 * Ports — every piece of I/O, injected
 * ------------------------------------------------------------------------ */

export interface HelperPorts {
    platform: NodeJS.Platform;
    productVersion: string;
    log: FlowLogger;
    now(): number;
    sleep(ms: number): Promise<void>;

    /** Subline's per-user directory, or `null` on a platform we do not support. */
    productDir: string | null;
    /** Where the installed mod bundle lives. */
    modBundleDir: string | null;

    locate(): Result<DiscordInstall[]>;
    inspect(install: DiscordInstall): Result<InstallState>;
    readMarker(resourcesPath: string): Result<PatchMarker | null>;
    readDiscordVersion(install: DiscordInstall): Result<DiscordBuildInfo>;
    /** The patcher's own standalone health check — reused, never reimplemented. */
    verifyPatch(install: DiscordInstall, expected: PatchIdentity): Result<true>;
    /** `patchInstall`. The one and only way this helper writes to Discord. */
    patch(install: DiscordInstall, options: { modBundleDir: string }): Result<PatchReport>;
    /**
     * `adoptPatch`: write the marker beside OUR stub when it is missing or wrong,
     * touching nothing else (safe while Discord runs). Optional so a port set
     * without it still works: the install then goes through a full patch.
     */
    adopt?(install: DiscordInstall, options: { modBundleDir: string }): Result<AdoptReport>;

    inspectBundle(dir: string): Result<ModBundle>;
    /** Copy a freshly downloaded bundle to the runtime location. */
    installBundle(sourceDir: string): Result<InstalledModBundle>;

    discordRunning(install: DiscordInstall): Promise<boolean>;
    mtimeOf(path: string): number | null;

    readState(): HelperState;
    writeState(state: HelperState): Result<string>;

    /** Where the release manifest lives, or `null` to disable trigger B entirely. */
    releaseManifestUrl: string | null;
    fetchText(url: string): Promise<Result<string>>;
    fetchBinary(url: string): Promise<Result<Uint8Array>>;
    /** Unpack a verified artefact to a scratch directory holding the bundle. */
    unpack(bytes: Uint8Array, artifactName: string): Promise<Result<string>>;
    discardUnpacked(dir: string): void;

    /** `verifyOnce` — the beacon reader, reused. */
    verifyBeacon(options: VerifyOptions): VerificationReport;
    notify(alert: Alert): Promise<void>;

    /**
     * Windows: whether the scheduled task that runs this helper still exists.
     * Uninstall deletes it, but a run already in progress (waiting for Discord
     * to close) used to carry on: patch Discord, write its memory, and even
     * register the task again. Checked before every write. Absent on macOS,
     * where removing the LaunchAgent stops the running job itself.
     */
    stillRegistered?(): Promise<boolean>;
    /** Put back a bundle an interrupted swap left aside (modInstall recoverModBundle). */
    recoverBundle?(dir: string): Result<boolean>;
    /**
     * True when a loader path lives in ANOTHER user's home folder: a Discord
     * set up by another account on this computer, which this helper must
     * never touch (re-patching it to this account's path breaks Discord for
     * the other account, and the two helpers then fight over it).
     */
    isOtherAccountLoader?(loaderPath: string): boolean;
    /**
     * `unpatchInstall`: put Discord's own code back. Used only when Subline
     * cannot run and an older stub would stop Discord starting (the bundle is
     * gone under a pre-0.2.3 stub), or when an interrupted patch could not be
     * finished. Optional: without it those cases are only reported.
     */
    unpatch?(install: DiscordInstall): Result<UnpatchReport>;
    /**
     * Stable ids the INSTALLER's own record names (patched-installs.json,
     * written on every successful patch). Ownership evidence when the
     * helper's memory is empty: a lost helper-state.json, or a Discord update
     * before the helper's first run (audit 2026-10-06 #34, #49).
     */
    rememberedStableIds?(): ReadonlySet<string>;
    /**
     * Windows: another app-x.y.z folder of this install's branch still
     * carries Subline's stub or marker (the folder the user's Discord ran
     * before it updated). Evidence of ownership like the two above.
     */
    siblingCarriesOurMark?(install: DiscordInstall): boolean;
    /** Size of a helper-state.json that exists but does not parse, or null. */
    stateUnreadable?(): number | null;
}

export interface HelperRunOptions {
    settle?: SettleOptions;
    /** How often trigger B goes near the network. */
    updateIntervalMs?: number;
    alertRepeatMs?: number;
    healthMinObservations?: number;
    healthMinWindowMs?: number;
    verifiers?: readonly ReleaseVerifier[];
    /** Check for a new build regardless of the throttle. */
    forceUpdateCheck?: boolean;
}

/** How long a repair may wait on a running Discord before the user is told to quit it (Windows). */
export const QUIT_REQUIRED_AFTER_MS = 30 * 60_000;

/**
 * After the helper asks the user to quit Discord, the runs in this window wait
 * (bounded) for Discord to close instead of looking once (audit #47). The
 * user acts right after the notice, and a quit and reopen inside a 5 minute
 * task interval was otherwise never seen.
 */
export const QUIT_WATCH_WINDOW_MS = 30 * 60_000;
/** Inside a 5 minute task interval and its 10 minute limit, so a scheduled run is never dropped. */
export const QUIT_WATCH_WAIT_MS = 4 * 60_000 + 45_000;
export const QUIT_WATCH_POLL_MS = 10_000;

/** How long a failed rewrite of an older stub form waits before the next try. */
export const STUB_UPGRADE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** What the helper asks a Windows user to do when a running Discord blocks a repair. */
export const QUIT_COPY = {
    discordUpdated:
        "Discord updated. To turn Subline back on, right-click the Discord icon near the clock and choose Quit Discord. "
        + "Leave it closed for a minute while Subline puts itself back, then open Discord again.",
    repairNeeded:
        "Subline needs to repair Discord. Right-click the Discord icon near the clock and choose Quit Discord. "
        + "Leave it closed for a minute while Subline repairs it, then open Discord again."
} as const;

/** Six hours. Trigger A runs hourly; only trigger B touches the network. */
export const DEFAULT_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Errors that will not fix themselves, and are surfaced the first time they
 * happen. Everything else gets `REPATCH_FAILURES_BEFORE_ALERT` attempts first,
 * because a transient IO error while an update is landing is not news.
 */
const IMMEDIATE_PATCH_ALERTS: readonly PatcherErrorCode[] = [
    "ROLLBACK_FAILED",
    "VERIFICATION_FAILED",
    "PERMISSION_DENIED",
    "READ_ONLY_VOLUME",
    "MOD_BUNDLE_INVALID",
    "BROKEN_INSTALL",
    "NOT_WRITABLE"
];

/**
 * The half-patched states where Discord's own archive is gone.
 *
 * `patchInstall` reports these as `BROKEN_INSTALL` — it CANNOT return
 * `BACKUP_MISSING`, which belongs to unpatch, and an earlier version of this file
 * matched on that code and was therefore dead. The distinction earns its place
 * because the remedy differs: an ordinary failed re-patch leaves a working
 * Discord, while these leave one that only Discord's own reinstall can repair
 * (spec §8), and that is a different sentence.
 */
const BACKUP_GONE_REASONS: readonly string[] = ["our-patch-without-backup", "asar-and-backup-missing"];

export const REPATCH_FAILURES_BEFORE_ALERT = 2;
export const UPDATE_FAILURES_BEFORE_ALERT = 3;

/* ------------------------------------------------------------------------ *
 * The run report
 * ------------------------------------------------------------------------ */

export type DecisionKind =
    | "scan"
    | "repatch"
    | "update"
    | "health"
    | "alert";

export interface HelperDecision {
    at: number;
    kind: DecisionKind;
    /** What was done, or not done. */
    outcome: string;
    /** WHY — the half that a log of actions alone always loses. */
    reason: string;
    fields: Record<string, string | number | boolean | null>;
}

export interface HelperRunReport {
    at: number;
    /** Every Discord found. */
    found: number;
    /** Those Subline has patched, and therefore may act on. */
    managed: number;
    repatched: string[];
    /** Not now — Discord open, or an update still landing. Normal, not a failure. */
    deferred: string[];
    failed: string[];
    updateChecked: boolean;
    /** The build id installed by this run, when trigger B fired. */
    updateInstalled: string | null;
    health: HealthObservation | null;
    alerts: AlertRaised[];
    decisions: HelperDecision[];
    summary: string;
    /**
     * Every deferral this run made is the same as the previous run's (same
     * install, same reason). The log keeps one line for such a run.
     */
    repeatDeferral?: boolean;
    /**
     * Every Discord this run skipped (not ours) is the same set, for the same
     * reasons, as the previous run's. False when the set changed. Undefined
     * when nothing was skipped.
     */
    repeatUnmanaged?: boolean;
    /** Windows: the helper's task was removed (Uninstall) while this run was going. Nothing was written. */
    uninstalled?: boolean;
}

/* ------------------------------------------------------------------------ */

class Run {
    readonly decisions: HelperDecision[] = [];
    readonly alerts: AlertRaised[] = [];
    readonly repatched: string[] = [];
    readonly deferred: string[] = [];
    readonly failed: string[] = [];
    state: HelperState = emptyHelperState();
    /** How many Discords were located, whether or not they are ours. */
    found = 0;
    updateChecked = false;
    updateInstalled: string | null = null;
    health: HealthObservation | null = null;
    /** Set once the helper's registration is found gone: nothing more is written. */
    uninstalled = false;
    /** What this run deferred, as stable keys (see HelperState.lastDeferralKey). */
    readonly deferralKeys: string[] = [];
    /** What this run skipped, as stable keys (see HelperState.lastUnmanagedKey). */
    readonly unmanagedKeys: string[] = [];
    /** The bundle installed right now (after any update this run made). */
    bundle: ModBundle | null = null;

    constructor(
        readonly ports: HelperPorts,
        readonly options: HelperRunOptions
    ) {}

    decide(
        kind: DecisionKind,
        outcome: string,
        reason: string,
        fields: Record<string, string | number | boolean | null> = {}
    ): void {
        const decision: HelperDecision = { at: this.ports.now(), kind, outcome, reason, fields };
        this.decisions.push(decision);
        // The log takes scalars only and caps every string (see `log.ts`), so the
        // reason cannot become a channel for anything it should not carry.
        this.ports.log.info(`helper.${kind}`, { outcome, reason, ...fields });
    }

    async alert(
        code: AlertCode,
        message: string,
        detail: Record<string, string | number | boolean | null>,
        key?: string
    ): Promise<void> {
        const alert: Alert = { code, message, detail, at: this.ports.now(), ...(key === undefined ? {} : { key }) };
        const raised = await raiseAlert(
            this.state,
            alert,
            { notify: a => this.ports.notify(a), productDir: this.ports.productDir, now: () => this.ports.now() },
            this.options.alertRepeatMs ?? repeatMsFor(code)
        );
        this.alerts.push(raised);
        this.decide("alert", code, raised.reason, { notified: raised.notified });
    }

    clear(code: AlertCode): void {
        const cleared = resolveAlert(this.state, code, {
            notify: a => this.ports.notify(a),
            productDir: this.ports.productDir,
            now: () => this.ports.now()
        });
        if (cleared) this.decide("alert", `${code}:resolved`, "the condition no longer holds");
    }

    /**
     * False once the helper's registration is gone (Windows uninstall during
     * this run). Every write checks this first; the answer is remembered.
     */
    async stillRegistered(before: string): Promise<boolean> {
        if (this.uninstalled) return false;
        if (this.ports.stillRegistered === undefined) return true;
        let registered = true;
        try {
            registered = await this.ports.stillRegistered();
        } catch {
            // Cannot tell: carry on as before rather than stop repairing.
            registered = true;
        }
        if (!registered) {
            this.uninstalled = true;
            this.decide("scan", "uninstalled", "the helper's scheduled task is gone, so Subline was removed while this run was going; nothing more is written", { before });
        }
        return registered;
    }
}

/**
 * Do one pass. Called at login and on every interval, and never concurrently
 * with itself (launchd will not start a second copy of a running agent).
 */
export async function runHelperOnce(ports: HelperPorts, options: HelperRunOptions = {}): Promise<HelperRunReport> {
    const run = new Run(ports, options);
    const at = ports.now();
    run.state = ports.readState();
    // A memory that exists and cannot be read is not "Subline was never here".
    const unreadable = ports.stateUnreadable?.() ?? null;
    if (unreadable !== null) {
        run.decide("scan", "state-unreadable", "the helper's memory file exists but could not be read, so this run starts without it", {
            bytes: unreadable
        });
    }

    const bundle = readInstalledBundle(run);
    run.bundle = bundle;
    const managed = collectManaged(run);

    if (managed.length > 0 && bundle !== null) {
        for (const entry of managed) {
            if (run.uninstalled) break;
            await reconcile(run, entry, bundle, "scheduled check");
        }
    }

    if (!run.uninstalled) await maybeUpdate(run, managed, bundle);
    if (!run.uninstalled && run.bundle === null) await handleMissingBundle(run, managed);
    if (!run.uninstalled) await checkHealth(run, managed);

    const deferralKey = run.deferralKeys.length === 0 ? null : [...run.deferralKeys].sort().join(";");
    const repeatDeferral = deferralKey !== null && deferralKey === run.state.lastDeferralKey;
    run.state.lastDeferralKey = deferralKey;
    const unmanagedKey = run.unmanagedKeys.length === 0 ? null : [...run.unmanagedKeys].sort().join(";");
    const repeatUnmanaged = unmanagedKey === null ? undefined : unmanagedKey === run.state.lastUnmanagedKey;
    run.state.lastUnmanagedKey = unmanagedKey;

    // An uninstalled helper writes NOTHING: helper-state.json would recreate
    // Subline's folder and remember the install as ours, which is what let a
    // removed Subline come back.
    if (await run.stillRegistered("state")) {
        run.state.lastRunAt = at;
        const written = ports.writeState(run.state);
        if (!written.ok) {
            // Not fatal, but it makes the NEXT run amnesiac — and an amnesiac run
            // cannot escalate a sustained health problem, so it is worth a line.
            run.decide("scan", "state-not-saved", written.error.message, { code: written.error.code });
        }
    }

    return {
        at,
        found: run.found,
        managed: managed.length,
        repatched: run.repatched,
        deferred: run.deferred,
        failed: run.failed,
        updateChecked: run.updateChecked,
        updateInstalled: run.updateInstalled,
        health: run.health,
        alerts: run.alerts,
        decisions: run.decisions,
        summary: summarize(run, managed.length),
        repeatDeferral,
        ...(repeatUnmanaged === undefined ? {} : { repeatUnmanaged }),
        uninstalled: run.uninstalled
    };
}

/* ------------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------------ */

interface ManagedInstall {
    install: DiscordInstall;
    state: InstallState;
    marker: PatchMarker | null;
    /** Discord's version right now, when readable. */
    version: string | null;
    /** The version we last patched against, from our own memory or the marker. */
    knownVersion: string | null;
}

function readInstalledBundle(run: Run): ModBundle | null {
    const dir = run.ports.modBundleDir;
    if (dir === null) {
        run.decide("scan", "no-bundle-location", "this platform has no known location for the mod bundle");
        return null;
    }
    // An interrupted swap can leave the live bundle aside. Put it back first:
    // Discord's stub requires it, and this helper runs at login.
    const recovered = run.ports.recoverBundle?.(dir);
    if (recovered !== undefined) {
        if (!recovered.ok) {
            run.decide("scan", "bundle-recover-failed", recovered.error.message, { code: recovered.error.code, cause: recovered.error.cause ?? null, path: dir });
        } else if (recovered.value) {
            run.decide("scan", "bundle-recovered", "an interrupted update had left the mod bundle aside; it is back in place", { path: dir });
        }
    }
    const inspected = run.ports.inspectBundle(dir);
    if (!inspected.ok) {
        // Not an early return for the whole run: a broken bundle is precisely
        // what trigger B can replace, so the update check still happens.
        run.decide("scan", "bundle-unusable", inspected.error.message, { code: inspected.error.code, path: dir });
        return null;
    }
    run.clear("bundle-missing");
    run.decide("scan", "bundle-ok", "the installed mod bundle is usable", {
        buildId: inspected.value.buildId,
        pluginVersion: inspected.value.pluginVersion,
        vencord: inspected.value.vencordVersion
    });
    return inspected.value;
}

/**
 * Which Discords this helper may touch.
 *
 * An install counts as ours when it currently carries our patch, OR when our own
 * memory says we patched it. THE SECOND HALF IS THE WHOLE POINT: after Discord
 * updates and wipes the injection, the install carries no marker and no stub, so
 * a check based on the install alone would conclude Subline was never there and
 * do nothing. That is exactly the failure this helper exists to repair.
 *
 * An install that has become another mod's is deliberately NOT ours any more.
 */
function collectManaged(run: Run): ManagedInstall[] {
    const located = run.ports.locate();
    if (!located.ok) {
        run.found = 0;
        run.decide("scan", "no-discord", located.error.message, { code: located.error.code });
        return [];
    }
    run.found = located.value.length;

    const managed: ManagedInstall[] = [];
    let recorded: ReadonlySet<string> | null = null;
    const installerRecord = (): ReadonlySet<string> => {
        if (recorded === null) {
            try {
                recorded = run.ports.rememberedStableIds?.() ?? new Set();
            } catch {
                recorded = new Set();
            }
        }
        return recorded;
    };
    for (const install of located.value) {
        const inspected = run.ports.inspect(install);
        if (!inspected.ok) {
            run.decide("scan", "unreadable-install", inspected.error.message, {
                code: inspected.error.code,
                path: install.rootPath
            });
            continue;
        }
        const state = inspected.value;
        // Keyed by stableId, not rootPath: after a Windows update rootPath is a
        // brand-new versioned folder, and only stableId still matches the memory
        // written when we patched the previous version. (This IS the self-heal.)
        const remembered = run.state.installs[install.stableId];
        const oursNow = state.kind === "patched-by-us";
        // WHO SAYS IT IS OURS (audit #34, #49). The helper's memory first;
        // then the installer's own record, and on Windows a sibling app folder
        // still carrying our stub or marker. Without them a lost memory, or a
        // Discord update before the helper's first run, was "never patched"
        // and the install was abandoned. Uninstall's release outranks them:
        // a Discord the user removed Subline from is never put back.
        const released = run.state.released.includes(install.stableId);
        let witness: "memory" | "installer-record" | "residue" | null = remembered !== undefined ? "memory" : null;
        if (witness === null && !released && !oursNow) {
            if (installerRecord().has(install.stableId)) witness = "installer-record";
            else if (run.ports.siblingCarriesOurMark?.(install) === true) witness = "residue";
        }
        const oursOnce = witness !== null;
        const evidence = evidenceOf(state, oursOnce);
        const skip = (outcome: string, reason: string): void => {
            run.unmanagedKeys.push(`${install.stableId}|${outcome}|${state.kind}|${state.loaderPath ?? ""}`);
            run.decide("scan", outcome, reason, { path: install.rootPath, ...evidence });
        };

        if (!oursNow && released) {
            skip("released", "Subline was removed from this Discord by Uninstall, so it is not put back");
            continue;
        }

        if (!oursNow && !oursOnce) {
            skip("not-ours", "Subline has never patched this install");
            continue;
        }

        const loader = state.marker?.loaderPath ?? state.loaderPath;
        if (state.kind !== "patched-by-other" && loader !== null && loader !== undefined && run.ports.isOtherAccountLoader?.(loader) === true) {
            // Another account on this computer set this Discord up. Its loader
            // is in that account's home; patching it to ours breaks Discord for
            // them, and their helper patches it back. Never touched, never alerted.
            skip("other-account", "another account on this computer set up Subline for this Discord, so this account leaves it alone");
            continue;
        }

        if (state.kind === "patched-by-other") {
            // Someone installed another client mod over us. A background process
            // cannot ask, and spec §3 step 4 forbids deciding for them. The loader
            // and marker go in the log, so a misjudged one can be told apart.
            skip("foreign-mod", "another client mod now owns this install, so Subline will not touch it");
            continue;
        }

        if (witness === "installer-record" || witness === "residue") {
            run.decide("scan", "adopted-from-memory", "the helper had no memory of this Discord, but Subline's own records show it patched it", {
                path: install.rootPath,
                source: witness === "installer-record" ? "patched-installs" : "residue",
                kind: state.kind
            });
        }

        if (state.warnings.includes("marker-missing") || state.warnings.includes("marker-mismatch")) {
            // Our stub without our marker: on Windows, Vencord's host-update
            // repatch copied the stub into a new app folder and left the marker
            // behind. Never abandoned: it is ours, and the marker is rewritten.
            run.decide("scan", "re-adopt", "the stub loads Subline's loader but its marker is missing or wrong, so Subline takes it back", {
                ...evidence,
                path: install.rootPath,
                marker: state.marker === null ? "missing" : "mismatch"
            });
        }

        const marker = run.ports.readMarker(install.resourcesPath);
        const version = run.ports.readDiscordVersion(install);
        managed.push({
            install,
            state,
            marker: marker.ok ? marker.value : null,
            version: version.ok ? version.value.version : null,
            knownVersion: remembered?.discordVersion ?? (marker.ok ? (marker.value?.discordVersion ?? null) : null)
        });
    }
    return managed;
}

/**
 * What decided "ours or not", for the log (audit #43): the next marker loss
 * must be diagnosable from the log alone, not from reading Vencord's source.
 */
function evidenceOf(state: InstallState, remembered: boolean): Record<string, string | number | boolean | null> {
    return {
        kind: state.kind,
        mod: state.mod,
        loader: state.loaderPath,
        marker: state.marker === null ? "missing" : "present",
        markerPresent: state.marker !== null,
        markerLoader: state.marker?.loaderPath ?? null,
        backup: state.hasBackup,
        stub: state.asarIsStub,
        warnings: state.warnings.join(","),
        remembered
    };
}

/* ------------------------------------------------------------------------ *
 * Trigger A — re-patch
 * ------------------------------------------------------------------------ */

type RepatchReason =
    | "none"
    | "marker-missing"
    /** Only the marker is out of date: another folder's, or another build of the same loader. */
    | "marker-stale"
    /** Verified, but an older stub form: rewritten when Discord is closed, never nagged about. */
    | "stub-outdated"
    /** Our stub, with another mod's resources/app in front of it. */
    | "shadowed"
    | "injection-wiped"
    | "build-changed"
    | "patch-damaged"
    | "broken-install";

function decideRepatch(run: Run, entry: ManagedInstall, bundle: ModBundle): { reason: RepatchReason; detail: string } {
    switch (entry.state.kind) {
        case "unpatched":
            return {
                reason: "injection-wiped",
                detail: "Discord no longer carries Subline's loader: an update replaced app.asar"
            };
        case "broken":
            return {
                reason: "broken-install",
                detail: `the install is in a half-patched state (${entry.state.reason ?? "unknown"})`
            };
        case "patched-by-other":
            return { reason: "none", detail: "another mod owns this install" };
        case "patched-by-us": {
            if (entry.state.warnings.includes("shadowed-by-unpacked-app")) {
                return {
                    reason: "shadowed",
                    detail: `${entry.state.shadowedBy ?? "another"} mod's resources/app folder loads in front of Subline's stub`
                };
            }
            if (entry.state.warnings.includes("marker-missing") || entry.state.warnings.includes("marker-mismatch")) {
                return {
                    reason: "marker-missing",
                    detail: "the stub loads Subline's loader but its marker is missing or wrong"
                };
            }
            if (entry.state.warnings.includes("marker-stale")) {
                return { reason: "marker-stale", detail: "the marker describes another folder or Discord version" };
            }
            const verified = run.ports.verifyPatch(entry.install, {
                loaderPath: bundle.loaderPath,
                buildId: bundle.buildId
            });
            if (verified.ok) {
                return entry.state.stubForm === undefined || entry.state.stubForm === null || entry.state.stubForm === "current"
                    ? { reason: "none", detail: "the patch is present and matches the installed bundle" }
                    : { reason: "stub-outdated", detail: `the stub is the ${entry.state.stubForm} form, rewritten once Discord is closed` };
            }
            if (entry.marker?.pluginBuildId !== bundle.buildId) {
                // A Subline update behind the same loader (audit #31): when
                // everything but the marker's build id is right, only the
                // marker changes, and Discord does not have to be quit for it.
                const rest = run.ports.verifyPatch(entry.install, {
                    loaderPath: bundle.loaderPath,
                    buildId: entry.marker?.pluginBuildId ?? ""
                });
                if (rest.ok && entry.state.loaderPath !== null && sameLoaderPath(entry.state.loaderPath, bundle.loaderPath)) {
                    return {
                        reason: "marker-stale",
                        detail: `only the marker's build id is out of date (${entry.marker?.pluginBuildId ?? "none"}, the bundle is ${bundle.buildId})`
                    };
                }
                return {
                    reason: "build-changed",
                    detail: `the install records build ${entry.marker?.pluginBuildId ?? "none"} and the bundle is ${bundle.buildId}`
                };
            }
            return { reason: "patch-damaged", detail: verified.error.message };
        }
    }
}

async function reconcile(run: Run, entry: ManagedInstall, bundle: ModBundle, trigger: string): Promise<void> {
    const { install } = entry;
    const versionChanged =
        entry.version !== null && entry.knownVersion !== null && entry.version !== entry.knownVersion;

    if (versionChanged) {
        run.decide("scan", "discord-version-changed", "Discord has updated since we last patched it", {
            path: install.rootPath,
            from: entry.knownVersion,
            to: entry.version
        });
    }

    let { reason, detail } = decideRepatch(run, entry, bundle);

    // RE-ADOPT first: the marker alone, never app.asar, so a running Discord
    // does not block it. Only when the stub already loads this very bundle;
    // anything else (or a failed adoption) takes the full repair path below.
    if ((reason === "marker-missing" || reason === "marker-stale") && run.ports.adopt !== undefined) {
        const previousBuild = entry.marker?.pluginBuildId ?? null;
        const adopted = run.ports.adopt(install, { modBundleDir: bundle.dir });
        if (adopted.ok) {
            // A write, so the run is reported and logged as one.
            run.repatched.push(install.rootPath);
            run.decide("repatch", "re-adopted", "Subline's own stub was taken back: its marker was rewritten", {
                path: install.rootPath,
                trigger,
                was: adopted.value.warning,
                discord: adopted.value.discordVersion,
                buildId: adopted.value.pluginBuildId
            });
            const after = run.ports.inspect(install);
            const marker = run.ports.readMarker(install.resourcesPath);
            if (after.ok) entry = { ...entry, state: after.value, marker: marker.ok ? marker.value : entry.marker };
            ({ reason, detail } = decideRepatch(run, entry, bundle));
            // A new Subline build reached a running Discord only as a marker
            // write: the running Discord keeps the old build until it is
            // reopened. Said once per build (same key as a full repatch).
            if (previousBuild !== null && previousBuild !== adopted.value.pluginBuildId && await run.ports.discordRunning(install)) {
                const discordVersion = adopted.value.discordVersion ?? entry.version ?? null;
                await run.alert(
                    "restart-required",
                    "Subline updated. Quit and reopen Discord to use the new version.",
                    { discord: discordVersion, buildId: adopted.value.pluginBuildId },
                    `${discordVersion ?? "unknown"}|${adopted.value.pluginBuildId}`
                );
            }
        } else {
            run.decide("repatch", "adopt-refused", adopted.error.message, {
                path: install.rootPath,
                code: adopted.error.code
            });
        }
    }

    if (reason === "shadowed") {
        // Never "not needed" (Discord ignores Subline) and never "foreign"
        // (the stub is ours and uninstall still restores it). Nothing to write:
        // a patch under that folder would verify and do nothing.
        rememberInstall(run, entry, bundle.buildId, false);
        run.decide("repatch", "shadowed", detail, { path: install.rootPath, mod: entry.state.shadowedBy ?? "unknown" });
        const mod = entry.state.shadowedBy === "betterdiscord" ? "BetterDiscord" : "Another client mod";
        await run.alert(
            "shadowed",
            `${mod} was installed over Subline, so Discord now ignores Subline. Remove ${mod === "BetterDiscord" ? "BetterDiscord" : "that mod"}, or uninstall Subline.`,
            { path: install.rootPath, mod: entry.state.shadowedBy ?? "unknown" }
        );
        return;
    }

    if (reason === "none" || reason === "stub-outdated") {
        // Still record what we saw: next run's "changed?" comparison is only as
        // good as the last observation. A verified patch also ends any
        // failure streak (audit #29).
        rememberInstall(run, entry, bundle.buildId, false, true);
        run.decide("repatch", "not-needed", detail, {
            path: install.rootPath,
            discord: entry.version,
            versionChanged
        });

        // The patch is in place and nothing needs writing, so any outstanding
        // "quit and reopen Discord" is answered the moment the stale process is
        // gone — whatever the user actually did, and without asking them to
        // confirm it. Still running means still stale: leave it standing, and
        // raiseAlert's own throttle keeps it from being repeated at them hourly.
        //
        // Deliberately NOT conditioned on the beacon reporting our build. The
        // beacon only speaks once a channel is open and a message arrives, so a
        // reader who restarts Discord and then reads nothing for an hour would
        // keep being told to restart a Discord they already restarted.
        const running = await run.ports.discordRunning(install);
        if (!running) run.clear("restart-required");
        // Nothing waits on a running Discord any more: the patch is in place.
        run.clear("quit-required");
        // A verified patch is proof these ended, however it got there (the
        // app's own install, a reinstall of Discord). They used to stand in
        // alerts.json forever (audit #29).
        run.clear("repatch-failed");
        run.clear("rollback-failed");
        run.clear("backup-missing");
        run.clear("discord-unstartable");
        run.clear("shadowed");
        if (reason === "stub-outdated") await upgradeStub(run, entry, bundle, trigger, running);
        return;
    }

    // NOTHING IS WRITTEN until the install has stopped moving. Racing Discord's
    // updater is the mistake every prior repatcher made once.
    const settled = await awaitDiscordSettled(install, {
        now: () => run.ports.now(),
        sleep: ms => run.ports.sleep(ms),
        discordRunning: target => run.ports.discordRunning(target),
        mtimeOf: path => run.ports.mtimeOf(path),
        readDiscordVersion: target => run.ports.readDiscordVersion(target)
    }, {
        // WINDOWS ONLY. It refuses to rename a file a running process holds
        // open, so the patch genuinely cannot be written while Discord is up.
        // macOS allows it, and waiting there meant self-repair never ran at
        // all for anyone who actually uses Discord — see requireDiscordClosed.
        requireDiscordClosed: run.ports.platform === "win32",
        ...quitWatch(run),
        ...(run.options.settle ?? {})
    });

    if (!settled.settled) {
        run.deferred.push(install.rootPath);
        run.deferralKeys.push(`${install.stableId}|${settled.status}|${reason}`);
        run.decide("repatch", "deferred", settled.reason, {
            path: install.rootPath,
            trigger,
            need: reason,
            settle: settled.status,
            waitedMs: settled.waitedMs
        });
        await noteBlockedByRunningDiscord(run, entry, settled.status === "discord-running", reason);
        return;
    }
    setBlockedSince(run, entry, null);

    // Uninstall may have removed the helper while this run waited for the
    // install to settle. Patching now would put Subline back into a Discord
    // the user just removed it from.
    if (!await run.stillRegistered("repatch")) return;

    const patched = run.ports.patch(install, { modBundleDir: bundle.dir });
    if (patched.ok) {
        run.repatched.push(install.rootPath);
        rememberInstall(run, { ...entry, version: patched.value.discordVersion ?? settled.version }, bundle.buildId, true);
        run.decide("repatch", patched.value.alreadyPatched ? "already-patched" : "repatched", detail, {
            path: install.rootPath,
            trigger,
            need: reason,
            discord: patched.value.discordVersion,
            buildId: patched.value.pluginBuildId
        });
        run.clear("repatch-failed");
        run.clear("rollback-failed");
        run.clear("backup-missing");
        run.clear("discord-unstartable");
        // The user quit Discord as asked: the repair is in, and it starts with
        // the Discord they open next. No second notice for the same event.
        const quitAnswered = run.state.alerts["quit-required"] !== undefined;
        run.clear("quit-required");

        // A repair a running Discord cannot see is not finished from the
        // reader's side. Only when we actually WROTE something (an
        // already-patched install changed nothing to miss) and only while that
        // stale process is still up: if Discord is closed, its next launch
        // reads the new app.asar on its own and there is nothing to say.
        // Saying it anyway is how an alert channel gets trained into noise.
        //
        // EVERY REAL REPAIR IS NEWS ONCE. The key is what was written (Discord
        // version and mod build): a second Discord update the same day, or a
        // new Subline build, notifies even inside the 24h window, while the
        // same pair written again (a write loop) stays quiet.
        if (!patched.value.alreadyPatched && !quitAnswered && await run.ports.discordRunning(install)) {
            const discordVersion = patched.value.discordVersion ?? entry.version ?? null;
            const onlySublineChanged = reason === "build-changed" && !versionChanged;
            await run.alert(
                "restart-required",
                onlySublineChanged
                    ? "Subline updated. Quit and reopen Discord to use the new version."
                    : "Discord updated and Subline has been restored. Quit and reopen Discord to start translating again.",
                {
                    discord: discordVersion,
                    buildId: patched.value.pluginBuildId ?? null
                },
                `${discordVersion ?? "unknown"}|${patched.value.pluginBuildId ?? bundle.buildId}`
            );
        }
        return;
    }

    await handlePatchFailure(run, entry, patched.error, reason, trigger);
}

function rememberInstall(run: Run, entry: ManagedInstall, buildId: string, patchedNow: boolean, verified = false): void {
    const previous = run.state.installs[entry.install.stableId];
    run.state.installs[entry.install.stableId] = {
        discordVersion: entry.version ?? previous?.discordVersion ?? null,
        buildId: patchedNow ? buildId : (entry.marker?.pluginBuildId ?? previous?.buildId ?? null),
        patchedAt: patchedNow ? run.ports.now() : (previous?.patchedAt ?? null),
        failures: patchedNow || verified ? 0 : (previous?.failures ?? 0),
        // Patched, or nothing to patch: nothing is waiting on Discord.
        blockedByRunningSince: null,
        ...(!patchedNow && previous?.stubUpgradeFailedAt != null ? { stubUpgradeFailedAt: previous.stubUpgradeFailedAt } : {})
    };
}

/** Record (or clear) since when this install's repair has waited only on a running Discord. */
function setBlockedSince(run: Run, entry: ManagedInstall, since: number | null): void {
    const previous = run.state.installs[entry.install.stableId];
    if (previous === undefined && since === null) return;
    run.state.installs[entry.install.stableId] = {
        discordVersion: previous?.discordVersion ?? entry.knownVersion,
        buildId: previous?.buildId ?? entry.marker?.pluginBuildId ?? null,
        patchedAt: previous?.patchedAt ?? null,
        failures: previous?.failures ?? 0,
        blockedByRunningSince: since,
        ...(previous?.stubUpgradeFailedAt != null ? { stubUpgradeFailedAt: previous.stubUpgradeFailedAt } : {})
    };
}

/**
 * A repair deferred. When the ONLY thing in the way is a running Discord
 * (Windows), and it has been for 30 minutes, tell the user what to do: a
 * Discord closed to the tray is never quit, and the repair would otherwise
 * wait silently until the next reboot, or forever.
 */
async function noteBlockedByRunningDiscord(run: Run, entry: ManagedInstall, blockedByRunning: boolean, need: RepatchReason): Promise<void> {
    if (!blockedByRunning) {
        setBlockedSince(run, entry, null);
        return;
    }
    const now = run.ports.now();
    const since = run.state.installs[entry.install.stableId]?.blockedByRunningSince ?? now;
    setBlockedSince(run, entry, since);
    if (now - since < QUIT_REQUIRED_AFTER_MS) return;
    // The sentence names the real cause (audit #31): "Discord updated" only
    // when Discord did. A marker-only change never gets here (it is written
    // while Discord runs).
    await run.alert(
        "quit-required",
        need === "injection-wiped" ? QUIT_COPY.discordUpdated : QUIT_COPY.repairNeeded,
        { blockedForMs: now - since, path: entry.install.rootPath, need }
    );
}

/** Settle options for the runs right after the user was asked to quit Discord (Windows). */
function quitWatch(run: Run): { waitForCloseMs?: number; closePollMs?: number } {
    if (run.ports.platform !== "win32") return {};
    const asked = run.state.alerts["quit-required"]?.lastNotifiedAt;
    if (asked === undefined || run.ports.now() - asked > QUIT_WATCH_WINDOW_MS) return {};
    return { waitForCloseMs: QUIT_WATCH_WAIT_MS, closePollMs: QUIT_WATCH_POLL_MS };
}

/**
 * Rewrite an older stub form (audit #4). Only while Discord is CLOSED, on
 * both systems, and never a deferral, a nag or a failure count: the install
 * works as it is, and this is housekeeping.
 */
async function upgradeStub(run: Run, entry: ManagedInstall, bundle: ModBundle, trigger: string, running: boolean): Promise<void> {
    const { install } = entry;
    if (running) {
        run.decide("repatch", "stub-outdated-waiting", "the older stub form is rewritten once Discord is closed", { path: install.rootPath });
        return;
    }
    const failedAt = run.state.installs[install.stableId]?.stubUpgradeFailedAt ?? null;
    if (failedAt !== null && run.ports.now() - failedAt < STUB_UPGRADE_RETRY_MS) {
        run.decide("repatch", "stub-outdated-waiting", "rewriting the older stub form failed recently; it is retried weekly", { path: install.rootPath });
        return;
    }
    const settled = await awaitDiscordSettled(install, {
        now: () => run.ports.now(),
        sleep: ms => run.ports.sleep(ms),
        discordRunning: target => run.ports.discordRunning(target),
        mtimeOf: path => run.ports.mtimeOf(path),
        readDiscordVersion: target => run.ports.readDiscordVersion(target)
    }, { ...(run.options.settle ?? {}), requireDiscordClosed: true });
    if (!settled.settled) {
        run.decide("repatch", "stub-outdated-waiting", settled.reason, { path: install.rootPath, settle: settled.status });
        return;
    }
    if (!await run.stillRegistered("stub-upgrade")) return;
    const patched = run.ports.patch(install, { modBundleDir: bundle.dir });
    if (patched.ok) {
        run.repatched.push(install.rootPath);
        rememberInstall(run, { ...entry, version: patched.value.discordVersion ?? entry.version }, bundle.buildId, true);
        run.decide("repatch", "stub-upgraded", "the older stub form was rewritten while Discord was closed", { path: install.rootPath, trigger });
    } else {
        run.decide("repatch", "stub-upgrade-skipped", patched.error.message, { path: install.rootPath, code: patched.error.code });
        const memory = run.state.installs[install.stableId];
        if (memory !== undefined) memory.stubUpgradeFailedAt = run.ports.now();
    }
}

/**
 * The mod bundle is gone or unusable, and no update replaced it (audit #4).
 * The stub fails open, so Discord starts without Subline: say so at once,
 * naming where the files belong. An OLDER stub form does not fail open (a
 * missing or broken loader stops Discord starting), so while Discord is
 * closed it is restored to Discord's own code. The memory is kept, so the
 * next good bundle patches it again.
 */
async function handleMissingBundle(run: Run, managed: ManagedInstall[]): Promise<void> {
    const ours = managed.filter(entry => entry.state.kind === "patched-by-us" || entry.state.kind === "broken");
    if (ours.length === 0) return;
    const dir = run.ports.modBundleDir ?? "Subline's folder";
    await run.alert(
        "bundle-missing",
        `Subline's files are missing from ${dir}. Open Subline to reinstall them.`,
        { path: dir, installs: ours.length }
    );
    for (const entry of ours) {
        const form = entry.state.stubForm ?? null;
        if (entry.state.kind !== "patched-by-us" || form === null || form === "current") continue;
        const { install } = entry;
        const settled = await awaitDiscordSettled(install, {
            now: () => run.ports.now(),
            sleep: ms => run.ports.sleep(ms),
            discordRunning: target => run.ports.discordRunning(target),
            mtimeOf: path => run.ports.mtimeOf(path),
            readDiscordVersion: target => run.ports.readDiscordVersion(target)
        }, { ...(run.options.settle ?? {}), requireDiscordClosed: true });
        if (!settled.settled) {
            run.decide("repatch", "unsafe-stub-waiting", settled.reason, { path: install.rootPath, form, settle: settled.status });
            continue;
        }
        if (run.ports.unpatch === undefined || !await run.stillRegistered("unsafe-stub")) continue;
        const restored = run.ports.unpatch(install);
        if (restored.ok) {
            // Remembered, so the next good bundle puts Subline back.
            if (run.state.installs[install.stableId] === undefined) rememberInstall(run, entry, entry.marker?.pluginBuildId ?? "", false);
            run.decide("repatch", "unsafe-stub-restored", "Subline's files are gone and this older stub would stop Discord starting, so Discord's own code was put back", {
                path: install.rootPath,
                form
            });
        } else {
            run.decide("repatch", "unsafe-stub-restore-failed", restored.error.message, { path: install.rootPath, code: restored.error.code });
        }
    }
}

/**
 * A failed re-patch.
 *
 * `patchInstall` rolls back on every failure path, so Discord is as it was — but
 * "as it was" after an update means UNPATCHED, which is a working Discord with no
 * translation. That is the honest state to be in, and the one thing that must be
 * confirmed rather than assumed, so the install is re-inspected and the result
 * logged either way.
 */
async function handlePatchFailure(
    run: Run,
    entry: ManagedInstall,
    error: PatcherError,
    need: RepatchReason,
    trigger: string
): Promise<void> {
    const { install } = entry;
    run.failed.push(install.rootPath);

    const previous = run.state.installs[install.stableId];
    const failures = (previous?.failures ?? 0) + 1;
    run.state.installs[install.stableId] = {
        discordVersion: entry.version ?? previous?.discordVersion ?? null,
        buildId: previous?.buildId ?? null,
        patchedAt: previous?.patchedAt ?? null,
        failures,
        blockedByRunningSince: null,
        ...(previous?.stubUpgradeFailedAt != null ? { stubUpgradeFailedAt: previous.stubUpgradeFailedAt } : {})
    };

    // OBSERVED, not assumed. `patchInstall` rolls back on every failure path, but
    // "Discord still starts" is the one claim worth checking rather than trusting,
    // and it is the thing anyone reading this log afterwards most needs to know.
    let after = run.ports.inspect(install);
    // "Discord cannot start" outranks "put the patch back" (audit #44): an
    // interrupted patch the repair could not finish gets Discord's own code
    // back first.
    if (after.ok && after.value.kind === "broken" && after.value.reason === "asar-missing-backup-present" && run.ports.unpatch !== undefined) {
        const restored = run.ports.unpatch(install);
        run.decide("repatch", restored.ok ? "original-restored" : "original-restore-failed",
            restored.ok ? "Discord's own app.asar was put back so it can start" : restored.error.message,
            { path: install.rootPath, ...(restored.ok ? {} : { code: restored.error.code }) });
        after = run.ports.inspect(install);
    }
    const startable = after.ok && after.value.kind !== "broken";
    const brokenReason = after.ok && after.value.kind === "broken" ? (after.value.reason ?? null) : null;
    run.decide("repatch", "failed", error.message, {
        path: install.rootPath,
        trigger,
        need,
        code: error.code,
        failures,
        discordStartable: startable,
        broken: brokenReason
    });

    if (error.code === "ROLLBACK_FAILED") {
        await run.alert(
            "rollback-failed",
            "Subline could not repair Discord after it updated, and could not put Discord's own files back. "
            + "Open Subline to see what to do.",
            { code: error.code, path: install.rootPath }
        );
        return;
    }
    if (brokenReason !== null && BACKUP_GONE_REASONS.includes(brokenReason)) {
        await run.alert(
            "backup-missing",
            "Subline cannot repair Discord because the copy of Discord's original files is gone. "
            + "Open Subline for the fix.",
            { code: error.code, broken: brokenReason, path: install.rootPath }
        );
        return;
    }
    if (!startable) {
        // Never "Discord itself is fine" about a Discord that cannot start.
        await run.alert(
            "discord-unstartable",
            "Discord cannot start until Subline repairs it. Open Subline to repair it.",
            { code: error.code, broken: brokenReason, path: install.rootPath }
        );
        return;
    }
    if (IMMEDIATE_PATCH_ALERTS.includes(error.code) || failures >= REPATCH_FAILURES_BEFORE_ALERT) {
        await run.alert(
            "repatch-failed",
            "Discord updated and Subline could not put its translation back. Discord itself is fine. "
            + "Open Subline to finish.",
            { code: error.code, failures, path: install.rootPath }
        );
    }
}

/* ------------------------------------------------------------------------ *
 * Trigger B — a new mod build
 * ------------------------------------------------------------------------ */

async function maybeUpdate(run: Run, managed: ManagedInstall[], bundle: ModBundle | null): Promise<void> {
    const url = run.ports.releaseManifestUrl;
    if (url === null) {
        run.decide("update", "disabled", "no release feed is configured for this build");
        return;
    }

    const interval = run.options.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
    const last = run.state.lastUpdateCheckAt;
    // A health verdict of `broken` overrides the throttle: a new build is the
    // ONLY thing that fixes it, so waiting six hours to look would be waiting six
    // hours on the one problem we cannot otherwise touch.
    const wasBroken = run.state.health.lastStatus === "broken";
    const bundleUnusable = bundle === null;
    const due =
        (run.options.forceUpdateCheck ?? false)
        || last === null
        || run.ports.now() - last >= interval
        || wasBroken
        || bundleUnusable;

    if (!due) {
        run.decide("update", "throttled", `the last check was ${Math.round((run.ports.now() - (last ?? 0)) / 60_000)}m ago`, {
            intervalMs: interval
        });
        return;
    }

    run.updateChecked = true;
    run.state.lastUpdateCheckAt = run.ports.now();

    const manifest = await fetchManifest(run, url);
    if (manifest === null) return;

    run.state.lastReleaseBuildId = manifest.buildId;
    run.state.lastReleasePluginVersion = manifest.pluginVersion;
    const installedBuildId = bundle?.buildId ?? null;
    const installed = bundle === null ? null : { buildId: bundle.buildId, pluginVersion: bundle.pluginVersion };
    if (installed !== null && installed.buildId === manifest.buildId) {
        run.state.updateFailures = 0;
        run.clear("update-failed");
        run.decide("update", "up-to-date", "the published build is the one already installed", {
            buildId: manifest.buildId
        });
        return;
    }
    if (!isNewerBuild(manifest, installed)) {
        // The feed moves installs FORWARD only (see isNewerBuild). A different
        // but older — or same-version — build on the feed is not an update,
        // and installing it downgraded a real machine on 2026-09-20.
        run.state.updateFailures = 0;
        run.clear("update-failed");
        run.decide("update", "not-newer", "the published build is not newer than the installed one, so it is left alone", {
            installed: installed?.pluginVersion ?? null,
            published: manifest.pluginVersion,
            buildId: manifest.buildId
        });
        return;
    }

    run.decide("update", "available", "the release feed offers a newer build than the installed one", {
        from: installedBuildId,
        to: manifest.buildId,
        pluginVersion: manifest.pluginVersion
    });

    const installedNew = await downloadAndInstall(run, manifest);
    if (installedNew === null) return;

    run.updateInstalled = installedNew.buildId;
    run.bundle = installedNew;
    run.state.updateFailures = 0;
    run.clear("update-failed");
    // The suspicion was evidence about the OLD build, and it is discarded — but
    // NOT here. `checkHealth` re-reads the marker after this run's re-patch, so
    // the beacon still naming the old build reads as `foreign-beacon`, which is
    // "no usable evidence" and clears the counter on its own. An explicit reset
    // as well survived a mutation, because it could not change any outcome the
    // marker re-read did not already produce — and it would be WRONG in the one
    // case it differed, discarding a fresh observation of the new build.
    run.clear("mod-stale");

    // A new bundle behind an unchanged loader path means every install now
    // records the wrong build id, and `verifyOnce` would read every one of them
    // as foreign. Re-patch is not optional here.
    for (const entry of managed) {
        const refreshed = refresh(run, entry);
        if (refreshed !== null) await reconcile(run, refreshed, installedNew, "new mod build");
    }
}

/** Re-read an install after the bundle underneath it changed. */
function refresh(run: Run, entry: ManagedInstall): ManagedInstall | null {
    const inspected = run.ports.inspect(entry.install);
    if (!inspected.ok) return null;
    const marker = run.ports.readMarker(entry.install.resourcesPath);
    return {
        ...entry,
        state: inspected.value,
        marker: marker.ok ? marker.value : null
    };
}

async function fetchManifest(run: Run, url: string): Promise<ReleaseManifest | null> {
    const trusted = assertTrustedUrl(url, "release feed");
    if (!trusted.ok) {
        await failUpdate(run, trusted.error);
        return null;
    }
    const fetched = await run.ports.fetchText(url);
    if (!fetched.ok) {
        await failUpdate(run, fetched.error);
        return null;
    }
    const parsed = parseReleaseManifest(fetched.value, url);
    if (!parsed.ok) {
        await failUpdate(run, parsed.error);
        return null;
    }
    return parsed.value;
}

async function downloadAndInstall(run: Run, manifest: ReleaseManifest): Promise<ModBundle | null> {
    const downloaded = await run.ports.fetchBinary(manifest.artifact.url);
    if (!downloaded.ok) {
        await failUpdate(run, downloaded.error);
        return null;
    }

    const verified = verifyDownload(manifest, downloaded.value, run.options.verifiers ?? DEFAULT_VERIFIERS);
    if (!verified.ok) {
        await failUpdate(run, verified.error);
        return null;
    }
    run.decide("update", "verified", "the download matches the checksum published with it", {
        buildId: manifest.buildId,
        bytes: manifest.artifact.bytes,
        by: verified.value.verifiedBy.join("+")
    });

    const unpacked = await run.ports.unpack(verified.value.bytes, manifest.artifact.name);
    if (!unpacked.ok) {
        await failUpdate(run, unpacked.error);
        return null;
    }

    try {
        // The SECOND, independent check: the archive matched its published
        // digest, and now the bundle inside it must match its own manifest and
        // carry its build id in the renderer that will actually run.
        const inspected = run.ports.inspectBundle(unpacked.value);
        if (!inspected.ok) {
            await failUpdate(run, inspected.error);
            return null;
        }
        if (inspected.value.buildId !== manifest.buildId) {
            await failUpdate(run, {
                code: "RELEASE_UNVERIFIED",
                message: `The release says it ships build ${manifest.buildId} but the bundle inside it is ${inspected.value.buildId}.`
            });
            return null;
        }

        // Uninstall may have removed the helper while this run downloaded.
        if (!await run.stillRegistered("update")) return null;
        const installed = run.ports.installBundle(unpacked.value);
        if (!installed.ok) {
            await failUpdate(run, installed.error);
            return null;
        }
        run.decide("update", "installed", "the new mod build is in place", {
            buildId: installed.value.buildId,
            replaced: installed.value.replaced
        });
        return installed.value;
    } finally {
        run.ports.discardUnpacked(unpacked.value);
    }
}

async function failUpdate(run: Run, error: { code: PatcherErrorCode; message: string }): Promise<void> {
    const failures = run.state.updateFailures + 1;
    run.state.updateFailures = failures;
    run.decide("update", "failed", error.message, { code: error.code, failures });

    // A checksum that does not match is never a flaky network: those bytes are
    // not the published bytes. Everything else gets several attempts, because a
    // laptop that was asleep is not a broken product.
    // A feed in a format this build cannot read never recovers on its own
    // either, and opening this Subline does not help: only a newer one does.
    const tooOld = error.code === "RELEASE_FORMAT_UNSUPPORTED";
    const immediate = error.code === "RELEASE_UNVERIFIED" || tooOld;
    if (immediate || failures >= UPDATE_FAILURES_BEFORE_ALERT) {
        await run.alert(
            "update-failed",
            tooOld
                ? "This Subline can no longer read its update feed. Get the new Subline from subline.page."
                : error.code === "RELEASE_UNVERIFIED"
                ? "Subline downloaded an update that did not match its published checksum, so it was not installed."
                : "Subline has not been able to check for updates. If translation stops working after a Discord "
                  + "update, open Subline.",
            { code: error.code, failures }
        );
    }
}

/* ------------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------------ */

async function checkHealth(run: Run, managed: ManagedInstall[]): Promise<void> {
    // The markers are RE-READ rather than reused from the scan. A re-patch or a
    // new bundle earlier in this same run changes the recorded build id, and
    // judging the beacon against the id we saw BEFORE that would read a healthy
    // install as somebody else's — the exact confusion `subline-patch.json`
    // exists to prevent.
    const current = managed
        .map(entry => {
            const marker = run.ports.readMarker(entry.install.resourcesPath);
            return { ...entry, marker: marker.ok ? marker.value : null };
        })
        .filter(entry => entry.marker?.pluginBuildId != null);

    // The beacon is per-USER, not per-install, so it is judged once against the
    // install we patched most recently — the one whose plugin is running.
    const newest = current.sort((a, b) => patchedAtOf(b) - patchedAtOf(a))[0];

    if (newest === undefined) {
        run.decide("health", "no-evidence", "no install carries a build id to compare a status file against");
        return;
    }

    const expectedBuildId = newest.marker?.pluginBuildId ?? "";
    const patchedAt = patchedAtOf(newest);
    const verification = run.ports.verifyBeacon({
        expectedBuildId,
        patchedAt,
        launchedAt: patchedAt,
        now: run.ports.now(),
        // Zero: this is not a post-install wait, it is a periodic judgement.
        // Nothing here is "still pending" — either the evidence is there or it
        // is not, and pretending to wait would make every run inconclusive.
        timeoutMs: 0
    });

    const observation = observeHealth({
        verification,
        previous: run.state.health,
        now: run.ports.now(),
        ...(run.options.healthMinObservations === undefined ? {} : { minObservations: run.options.healthMinObservations }),
        ...(run.options.healthMinWindowMs === undefined ? {} : { minWindowMs: run.options.healthMinWindowMs })
    });
    run.state.health = observation.memory;
    run.health = observation;

    run.decide("health", observation.status, observation.reason, {
        from: observation.from,
        observations: observation.observations,
        sustainedMs: observation.sustainedMs,
        buildId: expectedBuildId
    });

    if (observation.status === "healthy") run.clear("mod-stale");

    if (!observation.escalated) return;

    // Escalated. Whether this is worth telling the user depends entirely on
    // whether a fix exists: if the feed has a newer build we could not install,
    // `update-failed` already says so, and two notifications for one problem is
    // how notifications get ignored.
    const installedBuildId = run.state.installs[newest.install.stableId]?.buildId ?? expectedBuildId;
    // NEWER, not merely different, and against the bundle installed RIGHT NOW.
    // An inequality held the "needs an update" alert back forever whenever the
    // installed build was newer than the feed's (a dogfood Mac, or an
    // installer newer than the last release), although maybeUpdate would
    // never install the feed's older build: no fix was ever coming.
    const releasedVersion = run.state.lastReleasePluginVersion;
    const feedHasNewer = run.state.lastReleaseBuildId !== null && (releasedVersion === null
        // A memory from before the version was kept: the old judgement, until
        // the next feed check records it.
        ? run.state.lastReleaseBuildId !== installedBuildId
        : isNewerBuild(
        { buildId: run.state.lastReleaseBuildId, pluginVersion: releasedVersion } as ReleaseManifest,
        run.bundle === null
            ? { buildId: installedBuildId, pluginVersion: null }
            : { buildId: run.bundle.buildId, pluginVersion: run.bundle.pluginVersion }
    ));
    if (feedHasNewer) {
        run.decide("health", "broken-update-pending", "a newer build exists and is what the update path is for", {
            installed: installedBuildId,
            published: run.state.lastReleaseBuildId
        });
        return;
    }

    await run.alert(
        "mod-stale",
        "Subline is translating but nothing is reaching Discord's screen. Discord has probably changed and "
        + "Subline needs an update that is not available yet.",
        { buildId: installedBuildId, observations: observation.observations }
    );
}

function patchedAtOf(entry: ManagedInstall): number {
    const parsed = entry.marker?.patchedAt === undefined ? NaN : Date.parse(entry.marker.patchedAt);
    return Number.isFinite(parsed) ? parsed : 0;
}

/* ------------------------------------------------------------------------ */

function summarize(run: Run, managed: number): string {
    if (managed === 0) return "Subline is not installed in any Discord that could be found.";
    const parts: string[] = [];
    if (run.repatched.length > 0) parts.push(`re-patched ${run.repatched.length}`);
    if (run.deferred.length > 0) parts.push(`deferred ${run.deferred.length}`);
    if (run.failed.length > 0) parts.push(`failed ${run.failed.length}`);
    if (run.updateInstalled !== null) parts.push(`installed build ${run.updateInstalled}`);
    if (run.health !== null) parts.push(`health ${run.health.status}`);
    return parts.length === 0 ? "Nothing needed doing." : parts.join(", ");
}
