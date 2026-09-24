/**
 * The install flow (spec §3), as an explicit state machine.
 *
 * ## Why a machine, and why every failure is a state
 *
 * Spec §3: "every step below is a screen with a state, because every one of them
 * can fail and each failure needs its own explanation." Spec §7 goes further and
 * requires a NAMED error per failure, not a generic thrown one, because the
 * remedies genuinely differ — App Management has a deep link and a poll, a
 * read-only volume has neither, and BetterDiscord has no remedy we can offer at
 * all.
 *
 * So there is no `throw` in this file. Every outcome, including every disaster,
 * is a `FlowState` with a `step`, a sentence, and the list of things the user
 * may do next. The renderer draws that list; it does not decide it. That is what
 * makes "BetterDiscord offers no way to proceed" a property this module can be
 * TESTED for rather than a button somebody remembered not to add.
 *
 * ## Testable without Electron
 *
 * Everything the flow does to the machine — locating, inspecting, probing
 * permission, listing processes, patching, launching, verifying — arrives
 * through `FlowPorts`. The machine itself does no I/O. A flow that could only be
 * exercised by hand would not be exercised.
 *
 * ## The two orderings that are not arbitrary
 *
 *  1. **Permission is explained before it is attempted** (§4). Discovering App
 *     Management by failing a patch is what turned one step into a dead end
 *     three times during development.
 *  2. **Verification is the last step, and its answer is allowed to be "we
 *     cannot confirm"** (§7). `done` is reached with whatever the beacon
 *     honestly supports. Nothing in this file sets a success flag; it carries
 *     `verifyOnce`'s report, and that module's rule is that only a painted
 *     subtitle confirms.
 */

import type { InstalledModBundle } from "./modInstall.js";
import type { AppManagementReport, AppManagementStatus } from "./appManagement.js";
import { awaitAppManagement } from "./appManagement.js";
import type { QuitReport, RunningProcess } from "./discordProcess.js";
import { findDiscordProcesses, quitDiscord } from "./discordProcess.js";
import { defaultLanguage, endonymOf, languageOptions } from "./language.js";
import type { LanguageOption, SetSublineCodeReport, SetTargetLanguageReport } from "./language.js";
import type { ModBundle } from "../bundle/bundle.js";
import type { DiscordBranch, DiscordInstall } from "../patcher/locate.js";
import type { PatchReport } from "../patcher/patch.js";
import type { PatcherError, Result } from "../patcher/result.js";
import type { InstallState } from "../patcher/state.js";
import type { AwaitVerifyOptions, VerificationReport } from "../verify/verify.js";

/**
 * How long to let macOS finish talking before opening Discord (see `launch`).
 *
 * Long enough that Apple's permission dialog and the background-activity
 * notification are not still arriving when a Discord window appears; short
 * enough that nobody reads it as the installer having hung. Only applied to
 * users who actually went through the permission step.
 */
const SETTLE_BEFORE_LAUNCH_MS = 2_500;


/**
 * Everything a `PatcherError` knows, as log fields.
 *
 * One function rather than a hand-written object at each call site, because the
 * hand-written ones all drifted the same way: they logged `code` and dropped
 * `path` and `cause`. `cause` is where Node's errno lives, so a real Windows
 * install failed with `IO_ERROR` on screen AND `IO_ERROR` in the diagnostics
 * bundle — the log knew no more than the screenshot, and the actual reason took
 * three rounds and a PowerShell probe to find.
 *
 * Every failure log in this file goes through here. Adding a new one that does
 * not is the regression to watch for.
 */
function errorFields(error: PatcherError): Record<string, string | null> {
    return {
        code: error.code,
        message: error.message,
        path: error.path ?? null,
        cause: error.cause ?? null
    };
}

/* ------------------------------------------------------------------------ *
 * States
 * ------------------------------------------------------------------------ */

export type FlowStep =
    /* §3 steps 1–2: what this is, and the informed choice about tiers. */
    | "welcome"
    | "tiers"
    /* §3 step 3–4: find Discord, work out what is already there. */
    | "detecting"
    | "discord-not-found"
    | "choose-install"
    | "mod-bundle-invalid"
    | "broken-install"
    | "betterdiscord-blocked"
    | "mod-conflict"
    /**
     * Already ours, and working. Reached by simply opening the app again — most
     * often right after macOS's App Management prompt makes Subline quit and
     * reopen, which it does whether or not the install already succeeded.
     * Without this the flow walked the whole install again: quit Discord,
     * pick a language, ask for permission, re-patch. All of it pointless, and
     * all of it asking the user to redo work that was already done.
     */
    | "already-installed"
    /* §3 step 5. */
    | "discord-running"
    | "quit-blocked"
    /* §3 step 6 / §3a. */
    | "choose-language"
    /**
     * The quality tier's key, offered once, skippable.
     *
     * Exists because the alternative was Vencord's plugin settings inside
     * Discord — dozens of plugins a Subline user never installed, reached by a
     * path nobody could guess. A setup that ends with the better tier off and
     * no findable way to switch it on has not finished.
     */
    | "choose-code"
    /* §3 step 7 / §4. */
    | "permission-explain"
    | "permission-waiting"
    | "permission-blocked"
    /* §3 step 8. */
    | "patching"
    | "patch-failed"
    /* §3 step 8b: the background helper. */
    | "installing-helper"
    | "helper-failed"
    /* §3 step 9 / §7. */
    | "launching"
    | "launch-failed"
    | "verifying"
    | "done"
    /* The user stopped. Not a failure. */
    | "cancelled";

export type FlowActionType =
    | "next"
    | "cancel"
    | "pick-path"
    | "choose-install"
    | "proceed-over-mod"
    | "quit-discord"
    | "force-quit-discord"
    | "recheck"
    | "set-language"
    | "set-code"
    | "skip-code"
    | "open-permission-settings"
    | "retry"
    | "skip-helper"
    | "skip-launch"
    | "finish";

export type FlowAction =
    | { type: "next" }
    | { type: "cancel" }
    | { type: "pick-path"; path: string }
    | { type: "choose-install"; rootPath: string }
    | { type: "proceed-over-mod" }
    | { type: "quit-discord" }
    | { type: "force-quit-discord" }
    | { type: "recheck" }
    | { type: "set-language"; code: string }
    | { type: "set-code"; code: string }
    | { type: "skip-code" }
    | { type: "open-permission-settings" }
    | { type: "retry" }
    | { type: "skip-helper" }
    | { type: "skip-launch" }
    | { type: "finish" };

export interface FlowState {
    step: FlowStep;
    /** One sentence the UI shows verbatim. */
    detail: string;
    /** Exactly what the user may do from here. The UI renders this; it never invents a button. */
    actions: FlowActionType[];
    /** True while an operation is in flight and the UI should show progress. */
    busy: boolean;
    /** The named failure, when this state is one. */
    error: PatcherError | null;

    /* Per-step payloads. Optional rather than a strict union so the renderer can
     * read them without narrowing on every field it might want to show. */
    installs?: DiscordInstall[];
    install?: DiscordInstall;
    installState?: InstallState;
    /** Which foreign mod was found, for `mod-conflict` / `betterdiscord-blocked`. */
    modName?: string;
    processes?: RunningProcess[];
    quit?: QuitReport;
    languages?: LanguageOption[];
    /** The pre-filled reading language (§3a) — a bare code. */
    language?: string;
    languageEndonym?: string;
    permission?: AppManagementReport;
    permissionStatus?: AppManagementStatus;
    /** Deep link to the exact System Settings pane (§4). */
    permissionSettingsUrl?: string;
    bundle?: ModBundle;
    patch?: PatchReport;
    /** What happened to the background helper (§3 step 8b). */
    helper?: HelperInstallOutcome;
    verification?: VerificationReport;
    searchedPaths?: string[];
}

/**
 * The result of §3 step 8b — installing the thing that keeps the install alive.
 *
 * `applicable: false` is the honest answer on a platform where Subline has no
 * background helper yet. Spec §5's Windows Scheduled Task is not built, and
 * reporting "installed" for something that does not exist there would make the
 * one screen that could tell a user their install will not repair itself say the
 * opposite.
 */
export interface HelperInstallOutcome {
    applicable: boolean;
    /** True when a background agent is registered right now — confirmed, not assumed. */
    installed: boolean;
    label: string | null;
    /** The LaunchAgent plist, for the diagnostics view. */
    path: string | null;
}

/* ------------------------------------------------------------------------ *
 * Ports — every piece of I/O, injected
 * ------------------------------------------------------------------------ */

export interface FlowLogger {
    info(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
    warn(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
    error(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
}

export interface FlowPorts {
    platform: NodeJS.Platform;
    productVersion: string;
    log: FlowLogger;
    now(): number;
    sleep(ms: number): Promise<void>;

    /** Validate the bundle we ship, before anything else is promised. */
    inspectShippedBundle(): Result<ModBundle>;
    /** Copy it to its runtime location and report what is now there. */
    installModBundle(): Result<InstalledModBundle>;

    locate(explicitPaths?: readonly string[]): Result<DiscordInstall[]>;
    inspect(install: DiscordInstall): Result<InstallState>;

    listProcesses(): Promise<readonly RunningProcess[]>;
    requestQuit(branch: DiscordBranch): Promise<void>;
    /** Only ever reached from the explicit force-quit-discord action. */
    forceQuit(branch: DiscordBranch): Promise<void>;

    probePermission(install: DiscordInstall): AppManagementStatus;
    openPermissionSettings(): Promise<void>;
    permissionSettingsUrl: string;

    discordLocale(): string | null;
    systemLocale(): string | null;
    setLanguage(code: string): Result<SetTargetLanguageReport>;
    /** Writes the quality tier's key. Never returns the key itself. */
    setSublineCode(key: string): Result<SetSublineCodeReport>;
    /** Whether the saved settings already hold a Subline code. Decides whether an UPDATE offers the code screen. */
    hasSublineCode(): boolean;

    patch(install: DiscordInstall, options: { modBundleDir: string; overwriteForeignMod: boolean }): Result<PatchReport>;
    /**
     * §3 step 8b. REQUIRED, and that is the entire point of this port existing.
     *
     * Before this, `helper:install` was an IPC handler no flow state ever called,
     * so a real install got no helper at all — and spec §6 says a product with no
     * helper dies quietly the first time Discord updates. A port the flow always
     * calls is the difference between "the feature exists" and "the feature runs".
     */
    installHelper(): Promise<Result<HelperInstallOutcome>>;
    launchDiscord(install: DiscordInstall): Promise<Result<true>>;
    verify(options: AwaitVerifyOptions): Promise<VerificationReport>;

    /** Timings, injected so tests do not wait. */
    permissionPollIntervalMs?: number;
    permissionTimeoutMs?: number;
    quitGracePeriodMs?: number;
    verifyTimeoutMs?: number;
    verifyPollIntervalMs?: number;
}

/* ------------------------------------------------------------------------ */

function state(partial: Partial<FlowState> & { step: FlowStep; detail: string }): FlowState {
    return { actions: [], busy: false, error: null, ...partial };
}

/**
 * The install flow.
 *
 * `send` is the only entry point after `start`, and both return the state that
 * resulted, so a test reads as a transcript of what the user did.
 */
export class InstallFlow {
    private current: FlowState = state({
        step: "welcome",
        detail: "Subline adds a translation underneath messages written in another language, inside the Discord you already use.",
        actions: ["next", "cancel"]
    });

    /** Set by the UI layer; called on every transition. */
    onChange: ((state: FlowState) => void) | null = null;

    /** Answers carried between steps. */
    private chosenInstall: DiscordInstall | null = null;
    private overwriteForeignMod = false;
    private chosenLanguage: string | null = null;
    private installedBundle: InstalledModBundle | null = null;
    private helperOutcome: HelperInstallOutcome | null = null;
    private patchReport: PatchReport | null = null;
    private patchedAt = 0;
    private launchedAt = 0;
    /** The background confirmation, once the last screen is up. See `verify`. */
    private verifying: Promise<FlowState> | null = null;
    /**
     * True once the macOS permission step was actually shown this run.
     *
     * Only those users get the settle pause before Discord is launched (see
     * `launch`). Someone who already had the grant sees no dialogs, so pausing
     * for them would be delay in exchange for nothing.
     */
    private permissionPrompted = false;
    private explicitPaths: string[] = [];

    constructor(private readonly ports: FlowPorts) {}

    get state(): FlowState {
        return this.current;
    }

    private set(next: FlowState): FlowState {
        this.current = next;
        this.ports.log.info("flow.state", {
            step: next.step,
            code: next.error?.code ?? null,
            busy: next.busy
        });
        this.onChange?.(next);
        return next;
    }

    /**
     * Show the first screen — but check for an existing install BEFORE showing
     * it.
     *
     * Reopening the app is the normal way to arrive here: macOS's App
     * Management prompt offers Quit & Reopen, and the helper's own diagnostics
     * bring people back too. Detection used to happen only after Welcome and
     * the two-tiers page, so someone whose Discord was already set up had to
     * read and dismiss two screens of first-run explanation before being told
     * there was nothing to do.
     *
     * Deliberately narrow: it looks for an install that is already OURS and
     * nothing else. Every other outcome — unpatched, a foreign mod, broken —
     * falls through to Welcome, because those users genuinely are at the start
     * of an install and the explanation is for them.
     *
     * Never throws and never blocks on anything but the filesystem: any failure
     * here simply means Welcome, which is exactly where the normal flow would
     * have taken them anyway.
     */
    async start(): Promise<FlowState> {
        try {
            const installs = this.ports.locate(this.explicitPaths);
            if (installs.ok) {
                for (const install of installs.value) {
                    const inspected = this.ports.inspect(install);
                    if (inspected.ok && inspected.value.kind === "patched-by-us") {
                        this.chosenInstall = install;
                        return this.alreadyInstalled(install, inspected.value);
                    }
                }
            }
        } catch (cause) {
            this.ports.log.warn("flow.resume-check-failed", { cause: String(cause) });
        }
        return this.current;
    }

    async send(action: FlowAction): Promise<FlowState> {
        // A button the current state did not offer is ignored rather than
        // obeyed. The UI is generated from `actions`, so this only fires for a
        // stale click or a bug — and "obey it anyway" is how a refusal state
        // acquires an override nobody meant to add.
        if (!this.current.actions.includes(action.type)) {
            this.ports.log.warn("flow.action.rejected", { step: this.current.step, action: action.type });
            return this.current;
        }
        this.ports.log.info("flow.action", { step: this.current.step, action: action.type });
        return this.dispatch(action);
    }

    private async dispatch(action: FlowAction): Promise<FlowState> {
        if (action.type === "cancel") {
            return this.set(state({
                step: "cancelled",
                detail: "Nothing was changed. Discord is exactly as it was.",
                // A way to close, like every other terminal state. It offered
                // NOTHING — the only exit was the window's own title bar, which
                // on a screen that exists to reassure reads as being stuck.
                // Found by the property test that walks every reachable state.
                actions: ["finish"]
            }));
        }

        switch (this.current.step) {
            case "welcome":
                return this.set(state({
                    step: "tiers",
                    detail: "≈ is Google Translate: instant and free. ✦ is an AI that reads the conversation around "
                        + "a message, so slang and replies come out right. You get 3 free ✦ a day. A Subline code "
                        + "makes ✦ automatic.",
                    actions: ["next", "cancel"]
                }));

            case "tiers":
                return this.detect();

            case "discord-not-found":
                if (action.type === "pick-path") {
                    this.explicitPaths = [action.path];
                    return this.detect();
                }
                return this.detect();

            case "choose-install": {
                if (action.type !== "choose-install") return this.current;
                const picked = (this.current.installs ?? []).find(install => install.rootPath === action.rootPath);
                if (picked === undefined) return this.current;
                return this.inspectChosen(picked);
            }

            // Nothing to do but close. Deliberately offers no "install again":
            // re-patching a working install is a write to somebody else's
            // application in exchange for nothing, and the helper already
            // repairs the one case that needs it.
            case "already-installed":
                return this.current;

            case "mod-conflict":
                if (action.type === "proceed-over-mod") {
                    this.overwriteForeignMod = true;
                    this.ports.log.warn("flow.overwrite-foreign-mod", {
                        mod: this.current.modName ?? null
                    });
                    return this.checkRunning();
                }
                return this.current;

            case "broken-install":
            case "mod-bundle-invalid":
                return this.detect();

            // `recheck` here is the whole path out of a refusal: the user goes
            // and uninstalls BetterDiscord, comes back, and presses it. Falling
            // through to the default would leave the only button on the screen
            // doing nothing, which is a dead end wearing a way out.
            case "betterdiscord-blocked":
                return this.chosenInstall === null ? this.detect() : this.inspectChosen(this.chosenInstall);

            case "discord-running":
                if (action.type === "quit-discord") return this.quit();
                return this.checkRunning();

            case "quit-blocked":
                if (action.type === "force-quit-discord") return this.quit(true);
                return this.checkRunning();

            case "choose-language":
                if (action.type !== "set-language") return this.current;
                return this.applyLanguage(action.code);

            case "choose-code":
                if (action.type === "set-code") return this.applyCode(action.code);
                if (action.type === "skip-code") {
                    // Skipping is a real answer, not a failure. Google (≈) still
                    // translates everything; the ✦ AI tier simply stays off
                    // until somebody adds a code.
                    this.ports.log.info("code.skipped");
                    return this.permissionStep();
                }
                return this.current;

            case "permission-explain":
                return this.waitForPermission();

            case "permission-blocked":
                if (action.type === "open-permission-settings") {
                    await this.ports.openPermissionSettings();
                    return this.current;
                }
                return this.waitForPermission();

            case "permission-waiting":
                if (action.type === "open-permission-settings") {
                    await this.ports.openPermissionSettings();
                    return this.current;
                }
                return this.current;

            case "patch-failed":
                // A permission failure that survived the probe goes back to the
                // permission screen rather than retrying the same blocked write.
                if (this.current.error?.code === "PERMISSION_DENIED") return this.explainPermission("blocked");
                return this.patchStep();

            // Discord is ALREADY PATCHED by the time this screen can appear, so
            // retry re-runs only the helper — never the patch. Repeating a
            // successful write to another application because a background agent
            // would not register is a much worse failure than the one being
            // retried.
            case "helper-failed":
                if (action.type === "skip-helper") return this.afterHelper();
                return this.installHelper();

            case "launch-failed":
                if (action.type === "skip-launch") return this.verify();
                return this.launch();

            case "done":
                return this.set(state({
                    step: "done",
                    detail: this.current.detail,
                    actions: [],
                    verification: this.current.verification,
                    patch: this.current.patch,
                    helper: this.current.helper,
                    error: this.current.error
                }));

            default:
                return this.current;
        }
    }

    /* -------------------------------------------------------------------- *
     * §3 steps 3–4: detection
     * -------------------------------------------------------------------- */

    private async detect(): Promise<FlowState> {
        this.set(state({ step: "detecting", detail: "Looking for Discord…", busy: true, actions: [] }));

        // Our own artefact first. Asking for App Management and then failing on
        // a bundle we shipped broken would spend the user's one hard step on
        // our mistake.
        const bundle = this.ports.inspectShippedBundle();
        if (!bundle.ok) {
            this.ports.log.error("bundle.invalid", errorFields(bundle.error));
            return this.set(state({
                step: "mod-bundle-invalid",
                detail: `${bundle.error.message} Re-download Subline.`,
                error: bundle.error,
                actions: ["retry", "cancel"]
            }));
        }

        const located = this.ports.locate(this.explicitPaths.length > 0 ? this.explicitPaths : undefined);
        if (!located.ok || located.value.length === 0) {
            const error: PatcherError = located.ok
                ? { code: "DISCORD_NOT_FOUND", message: "No Discord installation was found." }
                : located.error;
            this.ports.log.warn("discord.not-found", errorFields(error));
            return this.set(state({
                step: "discord-not-found",
                detail: `${error.message} If Discord is installed somewhere unusual, choose it by hand.`,
                error,
                actions: ["pick-path", "retry", "cancel"],
                searchedPaths: [...this.explicitPaths]
            }));
        }

        const installs = located.value;
        if (installs.length > 1) {
            return this.set(state({
                step: "choose-install",
                detail: "More than one Discord is installed. Which one should Subline add translation to?",
                installs,
                actions: ["choose-install", "cancel"]
            }));
        }

        return this.inspectChosen(installs[0] as DiscordInstall);
    }

    private async inspectChosen(install: DiscordInstall): Promise<FlowState> {
        this.chosenInstall = install;
        const inspected = this.ports.inspect(install);
        if (!inspected.ok) {
            return this.set(state({
                step: "broken-install",
                detail: inspected.error.message,
                error: inspected.error,
                install,
                actions: ["retry", "cancel"]
            }));
        }
        const installState = inspected.value;
        this.ports.log.info("discord.state", {
            kind: installState.kind,
            mod: installState.mod ?? null,
            branch: install.branch
        });

        if (installState.kind === "broken") {
            return this.set(state({
                step: "broken-install",
                detail: installState.summary,
                error: { code: "BROKEN_INSTALL", message: installState.summary, path: install.rootPath },
                install,
                installState,
                actions: ["retry", "cancel"]
            }));
        }

        if (installState.kind === "patched-by-other") {
            // §3b: BetterDiscord is a REFUSAL, not a choice. It loads an
            // unpacked resources/app directory which Electron prefers over
            // app.asar, so our patch would apply, verify byte-perfect, and do
            // absolutely nothing. There is no version of proceeding that works,
            // so there is no action here that proceeds.
            if (installState.mod === "betterdiscord") {
                this.ports.log.warn("mod.betterdiscord.refused", { path: install.resourcesPath });
                return this.set(state({
                    step: "betterdiscord-blocked",
                    detail:
                        "BetterDiscord is installed. Subline cannot work alongside it: BetterDiscord replaces the folder "
                        + "Discord loads its code from, so Subline's changes would be installed correctly and then ignored "
                        + "completely. Uninstall BetterDiscord with its own uninstaller first, then run Subline again.",
                    error: {
                        code: "FOREIGN_MOD_PRESENT",
                        message: "BetterDiscord must be uninstalled before Subline can be installed.",
                        path: install.resourcesPath
                    },
                    install,
                    installState,
                    modName: installState.modName ?? "BetterDiscord",
                    // No "proceed anyway". Deliberately. See §3b.
                    actions: ["recheck", "cancel"]
                }));
            }

            // Vencord / Equicord / something unrecognised: detect, explain, let
            // them choose (§1, §3 step 4).
            return this.set(state({
                step: "mod-conflict",
                detail:
                    `${installState.modName ?? "Another client mod"} is already installed in this Discord. `
                    + "If you continue, Subline replaces it, and any plugins and themes you set up there will stop loading. "
                    + "Discord's original files stay backed up either way.",
                install,
                installState,
                modName: installState.modName ?? "another client mod",
                actions: ["proceed-over-mod", "cancel"]
            }));
        }

        if (installState.kind === "patched-by-us") {
            return this.alreadyInstalled(install, installState);
        }

        return this.checkRunning();
    }

    /**
     * Nothing to do — Discord is already set up with this build.
     *
     * Reached two ways, which is why it lives here rather than inline: from
     * `start()` before Welcome is ever shown, and from inspection partway
     * through a run. Sending someone back through quitting Discord, the
     * language picker and the permission step to redo work that is already done
     * is how a one-click installer earns a reputation for being tedious.
     *
     * Deliberately offers no "install again": re-patching a working install is
     * a write to somebody else's application in exchange for nothing, and the
     * helper already repairs the one case that needs it.
     */
    private alreadyInstalled(install: DiscordInstall, installState: InstallState): FlowState | Promise<FlowState> {
        // AN OLDER BUILD IS NOT "ALREADY SET UP". Observed 2026-09-03: a new
        // installer run over an existing install landed on "nothing left to
        // do" while Discord kept running the previous plugin build - with the
        // fixes the new installer existed to deliver. The old reasoning was
        // "the helper handles updates in the background", which is false
        // until the release feed ships (RELEASE_FEED_ENABLED=false): today
        // THIS installer is the only updater there is. Same id: done.
        // Different id: continue as an update - straight to the quit gate,
        // skipping the language step, whose answer is the user's saved setting
        // and must not be asked twice. The code screen is skipped only when a
        // code is already saved — see afterDiscordClosed.
        const installedId = installState.marker?.pluginBuildId ?? null;
        const shipped = this.ports.inspectShippedBundle();
        if (shipped.ok && installedId !== null && shipped.value.buildId !== installedId) {
            this.ports.log.info("flow.update-detected", { from: installedId, to: shipped.value.buildId });
            this.updating = true;
            return this.checkRunning();
        }

        return this.set(state({
            step: "already-installed",
            detail:
                "Subline is installed and Discord is set up to use it. There is nothing left to do. Open Discord "
                + "and messages in other languages will have a translation underneath them. Updates are handled in "
                + "the background.",
            install,
            installState,
            actions: ["finish"]
        }));
    }

    /* -------------------------------------------------------------------- *
     * §3 step 5: Discord must not be running
     * -------------------------------------------------------------------- */

    private async checkRunning(): Promise<FlowState> {
        const install = this.chosenInstall;
        if (install === null) return this.detect();

        const processes = await this.ports.listProcesses();
        const running = findDiscordProcesses(processes, install.branch, this.ports.platform);

        if (running.length > 0) {
            // AN UPDATE NEVER ASKS THE USER TO CLOSE DISCORD, and never closes
            // it for them. The maker's rule, verbatim in spirit: "we do not
            // control when they want to quit." Someone who already has a
            // working Subline is mid-conversation; interrupting that to deliver
            // an improvement they did not ask for is the installer putting its
            // own schedule ahead of theirs.
            //
            // There is a real way to finish on both platforms without the quit
            // gate, which is why this is a skip and not a postponement. macOS
            // lets the archive be renamed underneath a running Discord, so the
            // new build is written now and picked up at the next launch.
            // Windows will not rename a file a live process holds, so the
            // bundle is staged and the background helper re-patches once the
            // user closes Discord in their own time.
            //
            // A FRESH install is unchanged: there is no working translation to
            // protect, and nothing to fall back on if the write cannot happen.
            if (this.updating) {
                this.updatingWithDiscordOpen = true;
                this.ports.log.info("flow.update-under-running-discord", {
                    branch: install.branch,
                    platform: this.ports.platform,
                    processes: running.length
                });
                return this.afterDiscordClosed();
            }

            return this.set(state({
                step: "discord-running",
                detail: "Discord is running and has to close before it can be changed. Subline can ask it to quit for you.",
                install,
                processes: running,
                actions: ["quit-discord", "recheck", "cancel"]
            }));
        }

        this.updatingWithDiscordOpen = false;
        return this.afterDiscordClosed();
    }

    /**
     * Where the flow goes once Discord is closed.
     *
     * A fresh install asks for the language and the code. An UPDATE asks for
     * neither, because the answers are the user's saved settings — with one
     * exception, observed on the first update over a real friend's install:
     * someone who skipped the code the first time has nowhere in the installer
     * to add one later, so the ✦ tier never arrives for them and the only route
     * is a settings pane inside Discord they have never seen. An update whose
     * saved settings hold NO code therefore still offers the code screen (Skip
     * remains a real answer). The language, which IS saved, is never asked twice.
     */
    private afterDiscordClosed(): FlowState | Promise<FlowState> {
        if (!this.updating) return this.languageStep();
        if (!this.ports.hasSublineCode()) {
            this.ports.log.info("flow.update-offers-code", { reason: "no code in saved settings" });
            return this.codeStep();
        }
        // The saved code counts as configured for the rest of this run: the last
        // screen's wording and the background confirmation's expectations are
        // those of a code-holder, not of a keyless install.
        this.codeConfigured = true;
        return this.permissionStep();
    }

    /**
     * Ask Discord to quit, and force it if asking did not work.
     *
     * ONE PRESS. The button says "Quit Discord for me", so closing Discord is
     * what the user has already agreed to — sending them to a second screen to
     * grant permission they just gave is friction, not consent. On Windows the
     * polite request nearly always fails, because closing Discord's window only
     * hides it in the system tray, so that second screen was the common path
     * rather than the rare one.
     *
     * The escalation itself is unchanged: nothing is force-closed that would
     * have closed politely. `escalate: false` is how the caller says "this WAS
     * the forced attempt", so a failure there does not loop.
     */
    private async quit(force = false): Promise<FlowState> {
        const install = this.chosenInstall;
        if (install === null) return this.detect();

        this.set(state({
            step: "discord-running",
            detail: force
                ? "Closing Discord. Its window disappears first, then Subline waits a few quiet seconds to be sure it has fully stopped…"
                : "Asking Discord to close. Its window disappears first, then Subline waits a few quiet seconds to be sure it has fully stopped…",
            busy: true,
            actions: []
        }));
        const report = await quitDiscord({
            branch: install.branch,
            platform: this.ports.platform,
            listProcesses: () => this.ports.listProcesses(),
            requestQuit: () => this.ports.requestQuit(install.branch),
            forceQuit: () => this.ports.forceQuit(install.branch),
            force,
            // One press. The button said "Quit Discord for me", so closing it is
            // what the user already agreed to — see quitDiscord, which owns the
            // escalation now rather than each caller re-deciding it.
            escalate: !force,
            sleep: ms => this.ports.sleep(ms),
            clock: () => this.ports.now(),
            ...(this.ports.quitGracePeriodMs === undefined ? {} : { gracePeriodMs: this.ports.quitGracePeriodMs })
        });
        this.ports.log.info("discord.quit", { outcome: report.outcome, clear: report.clear, forced: report.forced });

        if (report.clear) return this.afterDiscordClosed();

        // Only reached when the forced close ALSO failed, which means something
        // other than a cooperative Discord is holding those files. Offering the
        // button again would invite a press already proven not to work.
        return this.set(state({
            step: "quit-blocked",
            detail: report.summary,
            install,
            quit: report,
            actions: ["recheck", "cancel"]
        }));
    }

    /* -------------------------------------------------------------------- *
     * §3 step 6 / §3a: the reading language
     * -------------------------------------------------------------------- */

    private languageStep(error: PatcherError | null = null): FlowState {
        const code = this.chosenLanguage ?? defaultLanguage({
            discordLocale: this.ports.discordLocale(),
            systemLocale: this.ports.systemLocale()
        });
        const endonym = endonymOf(code) ?? code;
        return this.set(state({
            step: "choose-language",
            detail: `Subline will translate messages into ${endonym}. Change it if that is not the language you read.`,
            languages: languageOptions(),
            language: code,
            languageEndonym: endonym,
            install: this.chosenInstall ?? undefined,
            error,
            actions: ["set-language", "cancel"]
        }));
    }

    private async applyLanguage(code: string): Promise<FlowState> {
        const saved = this.ports.setLanguage(code);
        if (!saved.ok) {
            this.ports.log.error("language.save-failed", errorFields(saved.error));
            return this.languageStep(saved.error);
        }
        this.chosenLanguage = saved.value.code;
        this.ports.log.info("language.saved", { lang: saved.value.code, created: saved.value.created });
        return this.codeStep();
    }

    /* -------------------------------------------------------------------- *
     * The Subline code — optional, offered once
     * -------------------------------------------------------------------- */

    private codeStep(error: PatcherError | null = null): FlowState {
        return this.set(state({
            step: "choose-code",
            // The previous screen already said skipping is fine and a code can
            // be added later; the hint under the field says where. Once each.
            // WHERE THE CODE COMES FROM is the whole question on this screen.
            // Two sources, named plainly. No format hint: a bought code is the
            // store's license key and does not start with slp_; telling a paying
            // customer their code "should start with slp_" is how they conclude
            // it is wrong.
            // The key arrives ONLY by email: Dodo's post-checkout page does not
            // show it. That email is sent as "Dodo Payments" (not "Subline"),
            // subject "Your License Key is Ready - ...", and a real purchase
            // (2026-09-23) landed in Gmail spam. So name the sender and the
            // subject exactly, and say "check spam" in bold.
            detail: "Your code came with Subline. If you bought it, it is in the email from **Dodo Payments**, "
                + "subject \"Your License Key is Ready\". **Check spam.** If a friend set you up, they sent it to you. "
                + "No code? Choose **Continue without a code**.",
            error,
            // NO CANCEL ON THIS SCREEN. A real friend, on the first field
            // install, pressed Cancel here twice meaning "no key for me" and
            // aborted the whole install both times - the log shows the
            // identical mistake ten minutes apart. On a screen whose subject
            // is an optional extra, Cancel reads as "decline the extra", and
            // the decline path this screen actually offers is "Use Google
            // only". Someone who truly wants out can close the window.
            actions: ["set-code", "skip-code"]
        }));
    }

    private async applyCode(code: string): Promise<FlowState> {
        this.codeConfigured = true;
        const saved = this.ports.setSublineCode(code);
        if (!saved.ok) {
            // The code itself is never logged — see setSublineCode. A refusal here
            // is almost always an empty paste or an unwritable settings file, and
            // both are things the user can act on from the message.
            this.ports.log.error("code.save-failed", errorFields(saved.error));
            return this.codeStep(saved.error);
        }
        // LENGTH, never the code. Enough to tell "pasted" from "pasted half".
        this.ports.log.info("code.saved", { codeLength: saved.value.codeLength, created: saved.value.created });
        return this.permissionStep();
    }

    /* -------------------------------------------------------------------- *
     * §3 step 7 / §4: App Management
     * -------------------------------------------------------------------- */

    private async permissionStep(): Promise<FlowState> {
        const install = this.chosenInstall;
        if (install === null) return this.detect();

        const status = this.ports.probePermission(install);
        this.ports.log.info("permission.probe", { status });
        if (status === "granted" || status === "not-required") return this.patchStep();

        // EXPLAIN BEFORE ATTEMPTING (§4). We already know the write would be
        // refused, so the user meets this as a step rather than as a failure.
        return this.explainPermission(status);
    }

    private explainPermission(status: AppManagementStatus): FlowState {
        // Remember that this user saw the permission path, so `launch` knows to
        // let macOS's own interruptions finish before opening Discord on top of
        // them.
        this.permissionPrompted = true;
        return this.set(state({
            step: "permission-explain",
            // THREE NUMBERED LINES, and the words to look for are bold.
            //
            // This screen used to be two paragraphs that explained macOS's own
            // wording before saying what to click. It was accurate and nobody
            // read it: the thing a person has to DO was the fourth clause of
            // the second sentence. Steps first, one action each, with the
            // control named in bold so it can be found by skimming.
            //
            // "Later" survives from the old copy and is a measured claim: on
            // the run that copy was written from, the patch completed while the
            // app was still running. Apple's dialog is about FUTURE
            // modifications, not the one that already happened. Earlier copy
            // said to choose Quit & Reopen, which sent the user through the
            // whole flow again for no reason.
            //
            // The last line is the reassurance the deleted paragraph was really
            // for. Apple's sentence says Subline "will not be able to update or
            // delete other applications"; one short line of ours saying what
            // Subline does touch answers that without reciting it first.
            //
            // The `**` is emphasis for the renderer (src/renderer/emphasis.ts).
            // `state.detail` stays a plain string: this module knows nothing
            // about a DOM, and the tests read it as text.
            detail:
                "Discord can only be changed with your permission.\n\n"
                + "1. Click **Continue**. System Settings opens.\n"
                + "2. Turn **Subline** on under **App Management**.\n"
                + "3. If macOS asks to quit Subline, choose **Later**.\n\n"
                + "Subline only ever changes Discord.",
            permissionStatus: status,
            permissionSettingsUrl: this.ports.permissionSettingsUrl,
            install: this.chosenInstall ?? undefined,
            actions: ["next", "cancel"]
        }));
    }

    private async waitForPermission(): Promise<FlowState> {
        const install = this.chosenInstall;
        if (install === null) return this.detect();

        this.set(state({
            step: "permission-waiting",
            // The pane path is already on screen, as the note under this line
            // (renderer.ts renders it whenever `permissionSettingsUrl` is set),
            // so repeating "Privacy & Security ›" here only buried the toggle
            // name. One sentence, the toggle in bold, and the promise that
            // waiting is all that is being asked.
            detail: "Waiting for you to turn **Subline** on under **App Management**. This screen moves on by itself.",
            busy: true,
            permissionSettingsUrl: this.ports.permissionSettingsUrl,
            actions: ["open-permission-settings", "cancel"]
        }));

        // Open the exact pane for them (§4's deep link), then poll.
        await this.ports.openPermissionSettings();

        const report = await awaitAppManagement({
            probe: () => this.ports.probePermission(install),
            sleep: ms => this.ports.sleep(ms),
            clock: () => this.ports.now(),
            onAttempt: (status, attempt) => this.ports.log.info("permission.attempt", { status, attempt }),
            ...(this.ports.permissionPollIntervalMs === undefined ? {} : { pollIntervalMs: this.ports.permissionPollIntervalMs }),
            ...(this.ports.permissionTimeoutMs === undefined ? {} : { timeoutMs: this.ports.permissionTimeoutMs })
        });
        this.ports.log.info("permission.result", { status: report.status, attempts: report.attempts });

        if (report.permitted) return this.patchStep();

        // NOT a dead end: retry is right there, and nothing has to be redone.
        return this.set(state({
            step: "permission-blocked",
            // The summary is computed (appManagement.ts) and says what macOS is
            // doing, so it leads. What follows is the two things the user needs:
            // the exact toggle and the exact button, both bold, and the fact
            // that retrying costs them nothing they already chose.
            detail:
                `${report.summary} Turn **Subline** on under **App Management**, then press **Try again**. `
                + "Nothing you chose is lost.",
            permission: report,
            permissionStatus: report.status,
            permissionSettingsUrl: this.ports.permissionSettingsUrl,
            error: {
                code: "PERMISSION_DENIED",
                message: report.summary,
                path: install.resourcesPath
            },
            actions: ["open-permission-settings", "retry", "cancel"]
        }));
    }

    /* -------------------------------------------------------------------- *
     * §3 step 8: patch
     * -------------------------------------------------------------------- */

    /**
     * Write the update, or stage it where writing is impossible.
     *
     * One place decides, because three callers used to call `applyPatch`
     * directly and a rule that holds on only two of them is not a rule.
     * Windows cannot rename Discord's archive while Discord holds it open, so
     * an update over a running Discord copies the bundle into place and stops
     * there; everything else patches as it always did.
     */
    private async patchStep(): Promise<FlowState> {
        if (this.updatingWithDiscordOpen && this.ports.platform === "win32") return this.stageUpdate();
        return this.applyPatch();
    }

    /**
     * Windows, updating, Discord open: put the new bundle in place and leave.
     *
     * The patch itself is the one thing that cannot happen here, and it is also
     * the one thing that does not have to happen now. `helper.ts` compares the
     * installed bundle's build id against the marker Discord carries, gets
     * `build-changed`, and re-patches on its own schedule once
     * `requireDiscordClosed` is satisfied. So the write is not skipped, it is
     * handed to the process that can wait, which is the one thing the user
     * should never be asked to do.
     */
    private async stageUpdate(): Promise<FlowState> {
        const install = this.chosenInstall;
        if (install === null) return this.detect();

        this.set(state({ step: "patching", detail: "Getting the update ready…", busy: true, actions: [] }));

        const installed = this.ports.installModBundle();
        if (!installed.ok) {
            this.ports.log.error("bundle.install-failed", errorFields(installed.error));
            return this.failPatch(installed.error);
        }
        this.installedBundle = installed.value;
        this.updateStaged = true;
        this.ports.log.info("bundle.staged", {
            build: installed.value.buildId,
            replaced: installed.value.replaced,
            dir: installed.value.dir,
            reason: "Discord is open on Windows, so the helper applies this after it closes"
        });
        return this.installHelper();
    }

    private async applyPatch(): Promise<FlowState> {
        const install = this.chosenInstall;
        if (install === null) return this.detect();

        this.set(state({ step: "patching", detail: "Adding Subline to Discord…", busy: true, actions: [] }));

        // Discord is checked for at step 5, but the user then picks a language
        // and may grant permission — minutes, in a slow case. Discord is in
        // Startup on most machines and relaunches itself after an update, so by
        // the time we write it can be back. On macOS that costs nothing;
        // Windows refuses to rename a file anything holds open, and the user
        // gets an unexplained write failure instead of the screen that tells
        // them to close Discord. Checking here is cheap; the failure is not.
        const stillRunning = await this.ports.listProcesses();
        if (findDiscordProcesses(stillRunning, install.branch, this.ports.platform).length > 0) {
            // An UPDATE must not bounce back to the quit screen, whether Discord
            // was open all along or came back while the user was reading. On
            // macOS the write works anyway, so this is a note and not a detour;
            // on Windows it cannot, so the bundle is staged instead.
            if (this.updating) {
                this.updatingWithDiscordOpen = true;
                this.ports.log.info("patch.discord-open-during-update", {
                    branch: install.branch,
                    platform: this.ports.platform
                });
                if (this.ports.platform === "win32") return this.stageUpdate();
            } else {
                this.ports.log.warn("patch.discord-reappeared", { branch: install.branch });
                return this.checkRunning();
            }
        }

        // The bundle goes to its runtime location FIRST, and the patch points at
        // that copy — never at a path inside our own app bundle. See
        // `modInstall.ts`: the wrong path here breaks Discord's ability to start.
        const installed = this.ports.installModBundle();
        if (!installed.ok) {
            this.ports.log.error("bundle.install-failed", errorFields(installed.error));
            return this.failPatch(installed.error);
        }
        this.installedBundle = installed.value;
        this.ports.log.info("bundle.installed", {
            build: installed.value.buildId,
            replaced: installed.value.replaced,
            dir: installed.value.dir
        });

        const patched = this.ports.patch(install, {
            modBundleDir: installed.value.dir,
            overwriteForeignMod: this.overwriteForeignMod
        });
        if (!patched.ok) {
            this.ports.log.error("patch.failed", errorFields(patched.error));
            return this.failPatch(patched.error);
        }

        this.patchReport = patched.value;
        this.patchedAt = this.ports.now();
        this.ports.log.info("patch.ok", {
            build: patched.value.pluginBuildId,
            discord: patched.value.discordVersion ?? null,
            alreadyPatched: patched.value.alreadyPatched,
            replacedMod: patched.value.replacedMod ?? null
        });
        return this.installHelper();
    }

    /* -------------------------------------------------------------------- *
     * §3 step 8b: the background helper
     * -------------------------------------------------------------------- */

    /**
     * Install the LaunchAgent, between patching and launching.
     *
     * **The ordering is not arbitrary.** After the patch, because there is no
     * point registering a re-patcher for an install that does not exist and the
     * agent would fire once at load against nothing. Before the launch and the
     * verification, because those two steps can take minutes of a user watching
     * Discord start — and a step placed after the last screen is a step that gets
     * skipped by everyone who closes the window when they see the tick.
     *
     * A failure here is NOT fatal and does not roll anything back. Translation
     * works; what is missing is the repair after Discord's next update. So the
     * screen says exactly that and offers to carry on, because refusing to finish
     * an install that is working would be a worse answer than a named warning.
     */
    private async installHelper(): Promise<FlowState> {
        this.set(state({
            step: "installing-helper",
            detail: "Setting Subline up to repair itself after Discord updates…",
            busy: true,
            actions: []
        }));

        const result = await this.ports.installHelper();
        if (!result.ok) {
            this.ports.log.error("helper.install-failed", errorFields(result.error));
            return this.set(state({
                step: "helper-failed",
                detail:
                    `${result.error.message} Translation itself is installed and will work. What is missing is the `
                    + "background check that puts Subline back after Discord updates itself. Without it, translation "
                    + "will stop working at some point and you would need to run Subline again to restore it.",
                error: result.error,
                install: this.chosenInstall ?? undefined,
                actions: ["retry", "skip-helper", "cancel"]
            }));
        }

        this.helperOutcome = result.value;
        this.ports.log.info("helper.installed", {
            applicable: result.value.applicable,
            installed: result.value.installed,
            label: result.value.label
        });
        return this.afterHelper();
    }

    /**
     * Launch and verify, unless Discord is already open under an update.
     *
     * There is nothing to launch, and a verification would read the beacon the
     * OLD build is still writing and report a foreign build: a working install
     * told it is somebody else's. Silence is the honest answer until the user
     * opens Discord themselves.
     */
    private afterHelper(): FlowState | Promise<FlowState> {
        if (this.updatingWithDiscordOpen) return this.finishWithoutLaunch();
        return this.launch();
    }

    private finishWithoutLaunch(): FlowState {
        return this.set(state({
            step: "done",
            detail: this.updateStaged
                ? "Update ready. It finishes on its own after you close Discord, and starts the next time you open it."
                    + "\n\nNo need to close Discord now."
                : "Update installed. It starts the next time you open Discord.\n\nNo need to close Discord now.",
            install: this.chosenInstall ?? undefined,
            patch: this.patchReport ?? undefined,
            bundle: this.installedBundle ?? undefined,
            helper: this.helperOutcome ?? undefined,
            actions: ["finish"]
        }));
    }

    private failPatch(error: PatcherError): FlowState {
        // VERIFICATION_FAILED means the patcher already rolled Discord back. The
        // user must be told that, or "the install failed" reads as "my Discord
        // is now broken" — which is the state they would then try to fix by
        // hand, on a Discord that is already fine.
        const rolledBack = error.code === "VERIFICATION_FAILED";
        const detail = rolledBack
            ? `${error.message} Discord has been put back exactly as it was, so nothing is broken. Please report this.`
            : error.message;
        return this.set(state({
            step: "patch-failed",
            detail,
            error,
            install: this.chosenInstall ?? undefined,
            actions: ["retry", "cancel"]
        }));
    }

    /* -------------------------------------------------------------------- *
     * §3 step 9 / §7: launch and verify honestly
     * -------------------------------------------------------------------- */

    private async launch(): Promise<FlowState> {
        const install = this.chosenInstall;
        if (install === null) return this.detect();

        // Let macOS finish talking before opening a window on top of it.
        //
        // A real run produced three interruptions at once: Apple's "cannot
        // update or delete other applications" dialog, the background-activity
        // notification from registering the LaunchAgent, and Discord
        // relaunching. Individually each is fine; simultaneously they read as a
        // machine doing things to itself, which is the last impression a tool
        // that modifies another app should give.
        //
        // Only for users who actually went through the permission step —
        // someone who already had the grant sees no dialogs, so a pause would
        // cost them time for nothing. Awaited through `ports.sleep`, which is
        // the injected clock, so this is deterministic in tests rather than a
        // real delay.
        if (this.permissionPrompted) {
            this.set(state({
                step: "launching",
                detail: "Finishing up. macOS may still be showing you a prompt. Discord opens in a moment.",
                busy: true,
                actions: []
            }));
            await this.ports.sleep(SETTLE_BEFORE_LAUNCH_MS);
        }

        this.set(state({ step: "launching", detail: "Starting Discord…", busy: true, actions: [] }));
        const launched = await this.ports.launchDiscord(install);
        this.launchedAt = this.ports.now();

        if (!launched.ok) {
            this.ports.log.warn("discord.launch-failed", errorFields(launched.error));
            return this.set(state({
                step: "launch-failed",
                detail:
                    `${launched.error.message} Subline is installed. Open Discord yourself and Subline will check whether `
                    + "translation is working.",
                error: launched.error,
                install,
                actions: ["retry", "skip-launch", "cancel"]
            }));
        }
        return this.verify();
    }

    /** Set when the user pasted a key during install; decides verify's advice. */
    private codeConfigured = false;

    /**
     * This run is an update over an existing install. Language and key steps
     * are skipped (their answers are the user's saved settings), and verify's
     * advice treats the engine configuration as the user's standing choice.
     */
    private updating = false;

    /**
     * This update found Discord open, and is finishing without touching it.
     * Set on an update only: it is what suppresses the quit gate, the launch
     * and the verification, none of which a fresh install may skip.
     */
    private updatingWithDiscordOpen = false;

    /**
     * The bundle is in place but Discord has not been patched with it yet
     * (Windows, Discord open). Decides which of the two last sentences is true.
     */
    private updateStaged = false;

    private async verify(): Promise<FlowState> {
        const patch = this.patchReport;
        if (patch === null) return this.detect();

        // NO WAITING SCREEN. Discord is opening in front of the user, and a
        // spinner beside it read as "something is still wrong" for as long as
        // it spun — which was until a message in another language happened to
        // arrive, up to the timeout. So the last screen shows at once, in
        // plain words, and the confirmation lands in the background: a green
        // tick when a translation is actually seen, a warning when something is
        // wrong, and nothing at all for "no foreign message has come by yet".
        const done = this.set(state({
            step: "done",
            detail: this.plainDoneDetail(),
            patch,
            bundle: this.installedBundle ?? undefined,
            // Carried to the last screen so "installed, but it will not repair
            // itself" is visible where the user actually looks, rather than only
            // in the log.
            helper: this.helperOutcome ?? undefined,
            actions: ["finish"]
        }));

        this.verifying = this.ports.verify({
            // The build id comes from the patch we just made, so a beacon
            // written by somebody else's copy of the plugin cannot confirm this
            // install. Never a guess, in either direction.
            expectedBuildId: patch.pluginBuildId,
            expectUpgrade: this.codeConfigured,
            patchedAt: this.patchedAt,
            launchedAt: this.launchedAt,
            sleep: ms => this.ports.sleep(ms),
            clock: () => this.ports.now(),
            ...(this.ports.verifyTimeoutMs === undefined ? {} : { timeoutMs: this.ports.verifyTimeoutMs }),
            ...(this.ports.verifyPollIntervalMs === undefined ? {} : { pollIntervalMs: this.ports.verifyPollIntervalMs })
        }).then(report => {
            this.ports.log.info("verify.result", {
                status: report.status,
                confirmed: report.confirmed,
                loaded: report.loaded,
                identity: report.identity,
                tier: report.tier,
                errorCode: report.errorCode ?? null
            });
            // Only while the user is still on the last screen. A run that moved
            // on (Cancel, Uninstall, a restart) keeps whatever it is showing.
            if (this.current.step !== "done") return this.current;
            return this.set(state({
                ...this.current,
                // The report's own sentence, unedited, whenever it has something
                // to say: `verifyOnce` is the module that decides what may be
                // claimed, and rewording it here is exactly how a "could not
                // confirm" becomes a green tick. "Nothing arrived yet" is not
                // news, so the plain sentence stays.
                detail: report.status === "loaded-idle" ? this.current.detail : report.summary,
                verification: report
            }));
        });

        return done;
    }

    /**
     * Resolves once the background confirmation has reported, with the state it
     * left behind — or at once with the current state when none is running.
     */
    settled(): Promise<FlowState> {
        return this.verifying ?? Promise.resolve(this.current);
    }

    private plainDoneDetail(): string {
        return "Subline is installed and Discord is opening. Messages in other languages get a translation "
            + "underneath them."
            + (this.codeConfigured ? " With your code, the ✦ line follows a few seconds after the ≈ line." : "")
            + " You can close this window.";
    }
}

/**
 * Did this run end in a state a user would call success?
 *
 * Reads `confirmed` and nothing else. Not `step === "done"` — `done` is reached
 * by every honest outcome including "installed, but we could not confirm it is
 * working", and treating arrival at the last screen as success is precisely the
 * false confidence spec §7 was written about.
 */
export function isConfirmedSuccess(state: FlowState): boolean {
    return state.step === "done" && state.verification?.confirmed === true;
}
