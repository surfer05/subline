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
import type { LanguageOption, SetTargetLanguageReport } from "./language.js";
import type { ModBundle } from "../bundle/bundle.js";
import type { DiscordBranch, DiscordInstall } from "../patcher/locate.js";
import type { PatchReport } from "../patcher/patch.js";
import type { PatcherError, Result } from "../patcher/result.js";
import type { InstallState } from "../patcher/state.js";
import type { AwaitVerifyOptions, VerificationReport } from "../verify/verify.js";

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
    /* §3 step 5. */
    | "discord-running"
    | "quit-blocked"
    /* §3 step 6 / §3a. */
    | "choose-language"
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
    | "recheck"
    | "set-language"
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
    | { type: "recheck" }
    | { type: "set-language"; code: string }
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

    probePermission(install: DiscordInstall): AppManagementStatus;
    openPermissionSettings(): Promise<void>;
    permissionSettingsUrl: string;

    discordLocale(): string | null;
    systemLocale(): string | null;
    setLanguage(code: string): Result<SetTargetLanguageReport>;

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

    /** Show the first screen. Present so a caller never has to construct a state. */
    start(): FlowState {
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
                actions: []
            }));
        }

        switch (this.current.step) {
            case "welcome":
                return this.set(state({
                    step: "tiers",
                    detail: "≈ is free, instant, and needs no account. ✦ is better and needs a free Google key — you can set it up now or any time later from settings.",
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
                return this.checkRunning();

            case "choose-language":
                if (action.type !== "set-language") return this.current;
                return this.applyLanguage(action.code);

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
                return this.applyPatch();

            // Discord is ALREADY PATCHED by the time this screen can appear, so
            // retry re-runs only the helper — never the patch. Repeating a
            // successful write to another application because a background agent
            // would not register is a much worse failure than the one being
            // retried.
            case "helper-failed":
                if (action.type === "skip-helper") return this.launch();
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
            this.ports.log.error("bundle.invalid", { code: bundle.error.code, message: bundle.error.message });
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
            this.ports.log.warn("discord.not-found", { code: error.code });
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
                    + "If you continue, Subline replaces it — any plugins and themes you set up there will stop loading. "
                    + "Discord's original files stay backed up either way.",
                install,
                installState,
                modName: installState.modName ?? "another client mod",
                actions: ["proceed-over-mod", "cancel"]
            }));
        }

        return this.checkRunning();
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
            return this.set(state({
                step: "discord-running",
                detail: "Discord is running and has to close before it can be changed. Subline can ask it to quit for you.",
                install,
                processes: running,
                actions: ["quit-discord", "recheck", "cancel"]
            }));
        }

        return this.languageStep();
    }

    private async quit(): Promise<FlowState> {
        const install = this.chosenInstall;
        if (install === null) return this.detect();

        this.set(state({ step: "discord-running", detail: "Asking Discord to quit…", busy: true, actions: [] }));
        const report = await quitDiscord({
            branch: install.branch,
            platform: this.ports.platform,
            listProcesses: () => this.ports.listProcesses(),
            requestQuit: () => this.ports.requestQuit(install.branch),
            sleep: ms => this.ports.sleep(ms),
            clock: () => this.ports.now(),
            ...(this.ports.quitGracePeriodMs === undefined ? {} : { gracePeriodMs: this.ports.quitGracePeriodMs })
        });
        this.ports.log.info("discord.quit", { outcome: report.outcome, clear: report.clear });

        if (report.clear) return this.languageStep();

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
            this.ports.log.error("language.save-failed", { code: saved.error.code });
            return this.languageStep(saved.error);
        }
        this.chosenLanguage = saved.value.code;
        this.ports.log.info("language.saved", { lang: saved.value.code, created: saved.value.created });
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
        if (status === "granted" || status === "not-required") return this.applyPatch();

        // EXPLAIN BEFORE ATTEMPTING (§4). We already know the write would be
        // refused, so the user meets this as a step rather than as a failure.
        return this.explainPermission(status);
    }

    private explainPermission(status: AppManagementStatus): FlowState {
        return this.set(state({
            step: "permission-explain",
            // Describes what Continue DOES, rather than sending the user off to
            // find System Settings themselves — the next step opens the exact
            // pane for them and then polls. Instructions that ignore the button
            // sitting right there are how a one-click installer starts feeling
            // like homework.
            detail:
                "macOS needs your permission before Subline can update Discord. Continue, and Subline will open the "
                + "right settings page for you — switch Subline on under App Management and this window carries on by "
                + "itself. You do not need to quit or restart anything.",
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
            detail: "Waiting for permission. Turn Subline on under Privacy & Security › App Management — this screen will move on by itself.",
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

        if (report.permitted) return this.applyPatch();

        // NOT a dead end: retry is right there, and nothing has to be redone.
        return this.set(state({
            step: "permission-blocked",
            detail:
                `${report.summary} Without it, Subline cannot add translation to Discord — everything else you have `
                + "chosen is saved, so you can grant it and try again at any time.",
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

    private async applyPatch(): Promise<FlowState> {
        const install = this.chosenInstall;
        if (install === null) return this.detect();

        this.set(state({ step: "patching", detail: "Adding Subline to Discord…", busy: true, actions: [] }));

        // The bundle goes to its runtime location FIRST, and the patch points at
        // that copy — never at a path inside our own app bundle. See
        // `modInstall.ts`: the wrong path here breaks Discord's ability to start.
        const installed = this.ports.installModBundle();
        if (!installed.ok) {
            this.ports.log.error("bundle.install-failed", { code: installed.error.code });
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
            this.ports.log.error("patch.failed", { code: patched.error.code, path: patched.error.path ?? null });
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
            this.ports.log.error("helper.install-failed", { code: result.error.code });
            return this.set(state({
                step: "helper-failed",
                detail:
                    `${result.error.message} Translation itself is installed and will work. What is missing is the `
                    + "background check that puts Subline back after Discord updates itself — without it, translation "
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
        return this.launch();
    }

    private failPatch(error: PatcherError): FlowState {
        // VERIFICATION_FAILED means the patcher already rolled Discord back. The
        // user must be told that, or "the install failed" reads as "my Discord
        // is now broken" — which is the state they would then try to fix by
        // hand, on a Discord that is already fine.
        const rolledBack = error.code === "VERIFICATION_FAILED";
        const detail = rolledBack
            ? `${error.message} Discord has been put back exactly as it was, so nothing is broken — please report this.`
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

        this.set(state({ step: "launching", detail: "Starting Discord…", busy: true, actions: [] }));
        const launched = await this.ports.launchDiscord(install);
        this.launchedAt = this.ports.now();

        if (!launched.ok) {
            this.ports.log.warn("discord.launch-failed", { code: launched.error.code });
            return this.set(state({
                step: "launch-failed",
                detail:
                    `${launched.error.message} Subline is installed — open Discord yourself and Subline will check whether `
                    + "translation is working.",
                error: launched.error,
                install,
                actions: ["retry", "skip-launch", "cancel"]
            }));
        }
        return this.verify();
    }

    private async verify(): Promise<FlowState> {
        this.set(state({
            step: "verifying",
            detail: "Checking that translation is actually working. This waits for a message in another language to appear.",
            busy: true,
            actions: []
        }));

        const patch = this.patchReport;
        if (patch === null) return this.detect();

        const report = await this.ports.verify({
            // The build id comes from the patch we just made, so a beacon
            // written by somebody else's copy of the plugin cannot confirm this
            // install. Never a guess, in either direction.
            expectedBuildId: patch.pluginBuildId,
            patchedAt: this.patchedAt,
            launchedAt: this.launchedAt,
            sleep: ms => this.ports.sleep(ms),
            clock: () => this.ports.now(),
            ...(this.ports.verifyTimeoutMs === undefined ? {} : { timeoutMs: this.ports.verifyTimeoutMs }),
            ...(this.ports.verifyPollIntervalMs === undefined ? {} : { pollIntervalMs: this.ports.verifyPollIntervalMs })
        });
        this.ports.log.info("verify.result", {
            status: report.status,
            confirmed: report.confirmed,
            loaded: report.loaded,
            identity: report.identity,
            tier: report.tier,
            errorCode: report.errorCode ?? null
        });

        return this.set(state({
            step: "done",
            // The report's own sentence, unedited. `verifyOnce` is the module
            // that decides what may be claimed, and rewording it here is exactly
            // how a "could not confirm" becomes a green tick.
            detail: report.summary,
            verification: report,
            patch: patch,
            bundle: this.installedBundle ?? undefined,
            // Carried to the last screen so "installed, but it will not repair
            // itself" is visible where the user actually looks, rather than only
            // in the log.
            helper: this.helperOutcome ?? undefined,
            actions: ["finish"]
        }));
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
