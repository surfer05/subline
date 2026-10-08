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
import { appManagementSummary, awaitAppManagement, isLoggedAttempt } from "./appManagement.js";
import type { QuitReport, RunningProcess } from "./discordProcess.js";
import { findDiscordProcesses, quitDiscord } from "./discordProcess.js";
import {
    type ActivationRelay, ACTIVATION_POLL_MS, activationPollDelay, AUTOMATIC_PRODUCT_ID, installBearer, isDodoCheckoutUrl, looksLikeCoupon, promoCode, type RedeemAnswer,
    staticAutomaticCheckoutUrl, staticCheckoutAllowed, type StatusAnswer, WAITING_HINT_AFTER_MS
} from "./activation.js";
import { CODE_SCREEN_COPY, RESET_HELP_URL } from "./codeScreen.js";
import { defaultLanguage, endonymOf, languageOptions } from "./language.js";
import type { EnsureRelayEngineReport, LanguageOption, SetSublineCodeReport, SetTargetLanguageReport } from "./language.js";
import type { ModBundle } from "../bundle/bundle.js";
import { compareVersions } from "../patcher/compareVersions.js";
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

/** The tiers screen: the two paid plans. `**` is bold. */
export const TIERS_DETAIL =
    "≈ is Google Translate, under every message. ✦ is an AI that reads the conversation, so slang and "
    + "replies come out right. **Automatic** gives you ≈ for $4.99, once. **AI** adds ✦ for $1.99 a month.";


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
    /**
     * Discord carries Subline, but pointing at ANOTHER Mac account's copy of
     * it. Patching it again from this account would point it here and break
     * Discord for the other account (it cannot read this home folder). So this
     * is a refusal with a recheck, like BetterDiscord.
     */
    | "other-account"
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
    /** The purchase is open in the browser; the flow asks the relay until it lands. */
    | "activation-waiting"
    /** A saved code could not be checked because the relay did not answer. */
    | "activation-check-failed"
    /** A typed code checked out (without linking); the user says "Use it" before it is linked. */
    | "confirm-code"
    /* §3 step 7 / §4. */
    | "permission-explain"
    /** One waiting screen, no timeout: it lasts until the grant or a Cancel. */
    | "permission-waiting"
    /**
     * The permission CHECK itself kept failing (not "macOS is still blocking
     * us", which is just waiting). The only error the permission step has.
     */
    | "permission-failed"
    /** macOS: Subline runs off the .dmg or a translocated copy; asked to move first (audit #24). */
    | "move-to-applications"
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
    | "cancelled"
    /** Something threw that nobody expected (app/failure.ts). Done is the only action. */
    | "failed";

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
    | "buy-automatic"
    | "use-code"
    | "back"
    | "open-permission-settings"
    | "move-to-applications"
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
    | { type: "buy-automatic" }
    | { type: "use-code" }
    | { type: "back" }
    | { type: "open-permission-settings" }
    | { type: "move-to-applications" }
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
    /** A help link drawn under the detail line (the computer-limit reset). Opened through shell:open. */
    helpUrl?: string;
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

/** What `ensureHelper` found and did. */
export interface HelperEnsureReport {
    /** `unchanged`: already runs this app. `repaired`: re-registered. `skipped`: nothing to check here. */
    action: "unchanged" | "repaired" | "skipped";
    /** Why it was re-registered or skipped: `missing`, `points-elsewhere`, `not-loaded`, ... */
    reason: string | null;
    /** The executable the registration named before, when it could be read. */
    registered: string | null;
    /** The executable it should name: the one running now. */
    expected: string | null;
}

/* ------------------------------------------------------------------------ *
 * Ports — every piece of I/O, injected
 * ------------------------------------------------------------------------ */

export interface FlowLogger {
    info(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
    warn(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
    error(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
}

/** patch-failed lines that replace the raw error (audit 2026-10-06 #13, #16). */
export const PATCH_FAILED_COPY = {
    scanning: "Another program, often antivirus, is still scanning Discord's files. Wait a few seconds and press Try again.",
    reinstall: "Reinstall Discord from discord.com, then run Subline again."
} as const;

/** The move-to-Applications screen (audit 2026-10-06 #24). Plain sentences, no dashes. */
export const MOVE_COPY = {
    title: "Move Subline to Applications first",
    body: "Subline is running from the disk image. It can only keep Discord repaired from your Applications folder. "
        + "Move it there, then open it again.",
    moving: "Moving Subline to your Applications folder. It opens again from there.",
    moveFailed: "Subline could not move itself. Drag Subline from the disk image into your Applications folder, "
        + "then open it from there.",
    helperOff: "Background repair is off because Subline is running from the disk image. Move Subline to your "
        + "Applications folder and open it from there."
} as const;

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
    /** Why the last probe came back `unknown` (errno and message), for the error screen. */
    lastPermissionProbeError?(): string | null;
    openPermissionSettings(): Promise<void>;
    permissionSettingsUrl: string;

    discordLocale(): string | null;
    systemLocale(): string | null;
    setLanguage(code: string): Result<SetTargetLanguageReport>;
    /** Writes the quality tier's key. Never returns the key itself. */
    setSublineCode(key: string): Result<SetSublineCodeReport>;
    /** Whether the saved settings already hold a Subline code. Decides whether an UPDATE offers the code screen. */
    hasSublineCode(): boolean;
    /** With a code saved, select the relay engine if something else is selected. Never touches the code. */
    ensureRelayEngine(): Result<EnsureRelayEngineReport>;

    /* Activation (the paid gate). Nothing is patched until the relay says this install has Automatic. */
    /** The saved code, to check with the relay. Never logged. */
    savedSublineCode(): string | null;
    /** The install id already in the settings, or null. Read only. */
    savedInstallId(): string | null;
    /** A code the reader cleared in Subline's settings, never saved again; null for none. Read only. */
    clearedCode(): string | null;
    /**
     * Whether the settings show Subline was used here before (language.ts
     * readPriorUse). Such a machine is an update: patched without the paid
     * gate, and never given a new install id. Read only.
     */
    priorSublineUse(): boolean;
    /** The install id, created and written into the settings if there is none. */
    ensureInstallId(): Result<string>;
    /** The relay: checkout, status, redeem. */
    relay: ActivationRelay;
    /** Open a checkout URL in the browser. */
    openCheckout(url: string): Promise<void>;
    /** How often to ask whether a purchase has landed. Injected so tests do not wait. */
    activationPollIntervalMs?: number;
    /** The Automatic product id for the static link. Defaults to activation.ts; injected by tests. */
    automaticProductId?: string;

    patch(install: DiscordInstall, options: { modBundleDir: string; overwriteForeignMod: boolean }): Result<PatchReport>;
    /**
     * Remember a Discord this run patched (patched-installs.json), so Uninstall
     * and the helper find it again even when it is not where detection looks
     * (a hand-picked PTB, Canary or unusual folder). Never fails the install.
     */
    rememberPatchedInstall?(install: DiscordInstall, patched?: { discordVersion: string | null; buildId: string }): void;
    /**
     * True when a loader path lives in ANOTHER user's home folder: the Discord
     * was set up by another account on this computer.
     */
    isOtherAccountLoader?(loaderPath: string): boolean;
    /**
     * §3 step 8b. REQUIRED, and that is the entire point of this port existing.
     *
     * Before this, `helper:install` was an IPC handler no flow state ever called,
     * so a real install got no helper at all — and spec §6 says a product with no
     * helper dies quietly the first time Discord updates. A port the flow always
     * calls is the difference between "the feature exists" and "the feature runs".
     */
    installHelper(): Promise<Result<HelperInstallOutcome>>;
    /**
     * Make sure the registered helper runs THIS app, and re-register it if not.
     *
     * Field evidence: a LaunchAgent pointing at an app path that no longer
     * existed, and "Subline is already set up" leaving it that way, so the
     * helper could never run. Called on every launch that reaches that screen.
     */
    ensureHelper(): Promise<Result<HelperEnsureReport>>;
    /**
     * macOS: is Subline running from somewhere the helper can keep using?
     * Not from the mounted .dmg or a Gatekeeper-translocated copy: a helper
     * registered there runs once and then never again (audit 2026-10-06 #24).
     * Absent: always stable (Windows, tests that do not care).
     */
    appLocation?(): Promise<Result<{ stable: boolean; path: string; reason: string | null }>>;
    /** Electron's app.moveToApplicationsFolder(). True: the move worked and the app is relaunching. */
    moveToApplications?(): Promise<Result<boolean>>;
    launchDiscord(install: DiscordInstall): Promise<Result<true>>;
    verify(options: AwaitVerifyOptions): Promise<VerificationReport>;

    /**
     * Read the Subline bundle a patched Discord loads (the folder its loader
     * lives in), for the version it carries (audit 2026-10-06 #12). An error
     * means "cannot say", never a reason to block.
     */
    inspectInstalledBundle?(dir: string): Result<ModBundle>;
    /**
     * Write the marker beside our stub when the stub already loads this
     * bundle (patch.ts adoptPatch). Writes nothing in app.asar, so it works
     * while Discord runs on Windows (audit 2026-10-06 #11).
     */
    adoptPatch?(install: DiscordInstall, modBundleDir: string): Result<{ pluginBuildId: string; discordVersion: string | null }>;
    /**
     * The reading language chosen on an earlier run that stopped before
     * activation (field test I6), or null. Kept outside Vencord's settings,
     * so an abandoned run never looks like earlier Subline use.
     */
    pendingLanguage?(): string | null;
    rememberPendingLanguage?(code: string): void;
    clearPendingLanguage?(): void;

    /** Timings, injected so tests do not wait. */
    permissionPollIntervalMs?: number;
    permissionSlowPollIntervalMs?: number;
    permissionSlowAfterMs?: number;
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

    /**
     * Set by abort(): the flow is finished, whatever it was waiting for. Every
     * write below (bundle, patch, helper, launch, saved code) checks it first,
     * so a poll or a probe answer already in flight cannot act on Discord after
     * the user pressed Uninstall.
     */
    private aborted = false;
    /** Every dispatch still running, so abort() can wait for the ones that write. */
    private readonly inflight = new Set<Promise<FlowState>>();

    /**
     * Stop this flow for good, and resolve once nothing it started is still
     * running.
     *
     * Field worst case: the user is on "Turn on Subline" or "Finish paying in
     * your browser" and presses the footer Uninstall. Without this, the
     * flow's poll kept going, and the grant they gave FOR the uninstall (or
     * the payment landing) started a patch and a helper registration
     * interleaved with the uninstall's own restore. Moving to a terminal state
     * ends both polls (they watch for the screen to change); the flag stops any
     * answer already in flight from writing.
     */
    async abort(): Promise<void> {
        if (!this.aborted) {
            this.aborted = true;
            this.onChange = null;
            this.current = state({ step: "cancelled", detail: "Stopped.", actions: [] });
            this.ports.log.info("flow.aborted", {});
        }
        await Promise.allSettled([...this.inflight]);
    }

    /**
     * Busy, with nothing to press, while a relay call or a process check that
     * a user action started is in flight. Keeps the step (and its heading).
     *
     * THIS IS THE SERIALIZER. send() refuses any action the current state does
     * not offer, so a double click, an Enter plus a click, or a second press
     * after a slow answer is refused instead of running the whole chain twice
     * (two redeems, two patches, two helper registrations, two Discord launches).
     */
    private hold(detail?: string): void {
        this.set({ ...this.current, detail: detail ?? this.current.detail, busy: true, actions: [], error: null });
    }

    private set(next: FlowState): FlowState {
        if (this.aborted) return this.current;
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
        const running = this.resume();
        this.inflight.add(running);
        void running.finally(() => this.inflight.delete(running)).catch(() => {});
        return running;
    }

    private async resume(): Promise<FlowState> {
        try {
            const installs = this.ports.locate(this.explicitPaths);
            if (installs.ok) {
                for (const install of installs.value) {
                    const inspected = this.ports.inspect(install);
                    if (inspected.ok && inspected.value.kind === "patched-by-us" && !this.otherAccount(inspected.value)) {
                        this.chosenInstall = install;
                        return this.alreadyInstalled(install, inspected.value);
                    }
                }
                const resumed = await this.resumeActivation(installs.value);
                if (resumed !== null) return resumed;
            }
        } catch (cause) {
            this.ports.log.warn("flow.resume-check-failed", { cause: String(cause) });
        }
        return this.current;
    }

    /**
     * A RESTART MID-CHECKOUT (field test 2026-10-08, I6). The language was
     * chosen, the browser was paying, and the computer restarted: the next
     * run started again at Welcome. With a language chosen on an earlier run,
     * no code saved and exactly one Discord that is not Subline's yet, carry
     * on at "Activate Subline". A saved install id is asked about first, so a
     * purchase that landed meanwhile is found without a second press.
     */
    private async resumeActivation(installs: readonly DiscordInstall[]): Promise<FlowState | null> {
        const language = this.ports.pendingLanguage?.() ?? null;
        if (language === null || this.ports.hasSublineCode() || this.ports.priorSublineUse()) return null;
        if (installs.length !== 1) return null;
        const install = installs[0] as DiscordInstall;
        const inspected = this.ports.inspect(install);
        if (!inspected.ok || inspected.value.kind !== "unpatched") return null;
        if (!this.ports.inspectShippedBundle().ok) return null;
        this.chosenInstall = install;
        this.chosenLanguage = language;
        this.languagePending = true;
        this.ports.log.info("flow.resume-activation", { lang: language });
        return this.codeStepUnlessSaved();
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
        const running = this.dispatch(action);
        this.inflight.add(running);
        void running.finally(() => this.inflight.delete(running)).catch(() => {});
        return running;
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
                    // Paid only: Automatic once, AI on top. `**` is bold.
                    detail: TIERS_DETAIL,
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
                // inspectChosen can await (the helper check, the process list)
                // before it shows anything: nothing to press twice meanwhile.
                this.hold();
                return this.inspectChosen(picked);
            }

            case "other-account":
                return this.chosenInstall === null ? this.detect() : this.inspectChosen(this.chosenInstall);

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
                    return this.beforeQuit();
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
                this.hold();
                return this.checkRunning();

            case "quit-blocked":
                if (action.type === "force-quit-discord") return this.quit(true);
                this.hold();
                return this.checkRunning();

            case "choose-language":
                if (action.type !== "set-language") return this.current;
                return this.applyLanguage(action.code);

            // THE PAID GATE. The only ways past this screen are a purchase that
            // the relay confirms and a code the relay confirms. There is no
            // skip: nothing is patched for an install without Automatic.
            case "choose-code":
                if (action.type === "set-code") return this.applyCode(action.code);
                if (action.type === "buy-automatic") return this.buyAutomatic();
                return this.current;

            case "confirm-code":
                if (action.type === "use-code") return this.useConfirmedCode();
                if (action.type === "back") {
                    this.pendingCode = null;
                    return this.codeStep();
                }
                return this.current;

            case "activation-waiting":
                // Back stops the poll (it watches for the screen to change) and
                // returns to the choice. The checkout stays open in the browser;
                // a purchase finished later is found the next time the flow asks.
                if (action.type === "back") return this.codeStep();
                // Try again: a fresh checkout. The relay answers
                // purchase_pending when a payment is already on its way, so
                // this never sells twice (field test I7).
                if (action.type === "retry") return this.buyAutomatic();
                return this.current;

            case "activation-check-failed":
                return this.ports.hasSublineCode() ? this.checkSavedCode() : this.checkSavedInstall();

            case "permission-explain":
                return this.waitForPermission();

            case "permission-failed":
                // A Discord this account cannot write is not waiting for a
                // toggle: Try again checks again, it does not reopen Settings.
                if (this.current.permissionStatus === "not-writable") return this.permissionStep();
                return this.waitForPermission();

            case "move-to-applications":
                if (action.type === "move-to-applications") return this.moveToApplications();
                // Try again: the same check, so it cannot loop past a disk image.
                return this.permissionStep();

            case "permission-waiting":
                if (action.type === "open-permission-settings") {
                    await this.ports.openPermissionSettings();
                    return this.current;
                }
                return this.current;

            case "patch-failed":
                // A permission failure that survived the probe goes back to the
                // permission screen rather than retrying the same blocked write.
                // macOS ONLY: App Management does not exist anywhere else, and
                // on Windows that screen opened an x-apple: link into a "get an
                // app to open this" prompt. Elsewhere, patch again: applyPatch
                // checks for a running Discord first and sends the user to the
                // close-Discord screen when one is back.
                if (this.current.error?.code === "PERMISSION_DENIED" && this.ports.platform === "darwin") {
                    return this.explainPermission("blocked");
                }
                // The Discord that was chosen is gone: find Discord again.
                if (this.current.error?.code === "DISCORD_MOVED") return this.detect();
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

        // AN INTERRUPTED PATCH (audit 2026-10-06 #26, #44): app.asar gone,
        // Discord's original in _app.asar. Discord cannot start like this, and
        // the patch itself now finishes it (patchInstall puts the original back
        // first, then patches). So it takes the normal install path, Discord
        // quit gate included, instead of a screen whose only button re-checked
        // the same state. A _app.asar that is not Discord's original is still
        // refused there, by name.
        if (installState.kind === "broken" && installState.reason === "asar-missing-backup-present") {
            this.ports.log.warn("flow.resume-interrupted-patch", { path: install.rootPath });
            return this.beforeQuit();
        }

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

        return this.beforeQuit();
    }

    /**
     * Everything that is asked BEFORE Discord is closed: the reading language
     * and activation. Order: find Discord, language, activate, quit Discord,
     * patch. Discord is only closed once the install is activated, so someone
     * who stops at the paid screen (or buys in a browser for a while) keeps a
     * working Discord the whole time.
     *
     * A machine whose settings show Subline was used before is an UPDATE (see
     * `priorSublineUse`): no language question and no new install id. It
     * still needs activation when no code is saved (see `updateGate`).
     */
    private beforeQuit(): FlowState | Promise<FlowState> {
        if (this.ports.priorSublineUse()) {
            this.priorUse = true;
            this.ports.log.info("flow.prior-use", { reason: "settings show Subline was used here before" });
            return this.updateGate();
        }
        return this.languageStep();
    }

    /**
     * THE PAID GATE ON AN UPDATE (field test 2026-10-08, I2).
     *
     * An update used to skip activation entirely, on the theory that the
     * plugin settles it inside Discord. On a machine with no saved code that
     * installed a product that then said "Not activated" in Discord, with no
     * screen in the installer to fix it. Now:
     *
     *   - a saved code: carry on as before. The relay is NOT asked here, so an
     *     update offline still updates (the plugin checks the code itself);
     *   - no code: the same gate as a fresh install. A saved install id is
     *     asked about first (an early user, or a purchase made from Discord,
     *     is let through by the relay); otherwise "Activate Subline".
     *
     * The language is never asked again: it is the user's saved setting.
     */
    private updateGate(): FlowState | Promise<FlowState> {
        if (this.ports.hasSublineCode()) {
            // An update re-asserts the engine once Discord is closed (afterDiscordClosed).
            if (!this.updating) this.useSavedCode();
            return this.checkRunning();
        }
        this.ports.log.info("flow.update-needs-activation", { savedInstallId: this.ports.savedInstallId() !== null });
        return this.codeStepUnlessSaved();
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
    /** Patched by Subline, but for another account on this computer (see "other-account"). */
    private otherAccount(installState: InstallState): boolean {
        const loader = installState.marker?.loaderPath ?? installState.loaderPath;
        return loader !== null && loader !== undefined && this.ports.isOtherAccountLoader?.(loader) === true;
    }

    private alreadyInstalled(install: DiscordInstall, installState: InstallState): FlowState | Promise<FlowState> {
        // NEVER "already set up" for a Discord another account set up. Its
        // loader lives in that account's home folder, which this account
        // cannot read; patching it again from here would point it at THIS
        // home folder and stop Discord starting for the other account.
        if (this.otherAccount(installState)) {
            this.ports.log.warn("flow.other-account", { path: install.rootPath });
            return this.set(state({
                step: "other-account",
                detail: "Another account on this Mac set up Subline for this Discord. Only that account can change it.",
                install,
                installState,
                actions: ["recheck", "cancel"]
            }));
        }
        // REMEMBERED, ONCE, after the other-account check (audit #15): a
        // Discord patched before patched-installs.json existed, or one only
        // ever updated, is found again by Uninstall and the helper. Upserted
        // by stable id, so a second write is harmless.
        this.remember(install);
        // AN OLDER INSTALLER IS NOT AN UPDATE (audit #12). Compared by the
        // plugin version of the bundle Discord actually loads, never by the
        // marker (a feed update rewrites the marker with an older product
        // version). An unreadable bundle means "cannot say": the update goes
        // ahead, since it is also the repair for a missing Subline folder.
        const newer = this.newerInstalled(installState);
        if (newer !== null) return newer;
        // AN OLDER BUILD IS NOT "ALREADY SET UP". Observed 2026-09-03: a new
        // installer run over an existing install landed on "nothing left to
        // do" while Discord kept running the previous plugin build - with the
        // fixes the new installer existed to deliver. The old reasoning was
        // "the helper handles updates in the background", which is false
        // until the release feed ships (RELEASE_FEED_ENABLED=false): today
        // THIS installer is the only updater there is. Same id: done.
        // Different id: continue as an update - straight to the quit gate,
        // skipping the language step, whose answer is the user's saved setting
        // and must not be asked twice. The activation screen is skipped only
        // when a code is saved or the relay confirms this install (updateGate).
        // ANOTHER MOD'S resources/app IN FRONT OF OUR STUB (audit #9): Subline
        // is installed and Discord ignores it. Never "already set up".
        if (installState.warnings.includes("shadowed-by-unpacked-app")) {
            const mod = installState.shadowedBy === "betterdiscord" ? "BetterDiscord" : "Another client mod";
            this.ports.log.warn("flow.shadowed", { path: install.rootPath, mod });
            return this.set(state({
                step: "betterdiscord-blocked",
                detail:
                    `Subline is installed, but ${mod} was installed after it and loads in front of it, so Discord ignores Subline. `
                    + `Remove ${mod === "BetterDiscord" ? "BetterDiscord" : "that mod"} with its own uninstaller, or uninstall Subline.`,
                error: {
                    code: "FOREIGN_MOD_PRESENT",
                    message: installState.summary,
                    path: install.resourcesPath
                },
                install,
                installState,
                modName: mod,
                actions: ["recheck", "cancel"]
            }));
        }
        // SUBLINE'S FILES ARE GONE (audit #4): the stub fails open, so Discord
        // starts without translation. Continue as an update, which puts the
        // files back and rewrites the stub.
        if (installState.warnings.includes("loader-missing")) {
            this.ports.log.warn("flow.loader-missing", { path: install.rootPath, loader: installState.loaderPath ?? null });
            this.updating = true;
            return this.updateGate();
        }
        // AN OLDER STUB FORM (audit #4): continue as an update; Discord is
        // closed before the patch, so the stub is rewritten safely.
        if (installState.stubForm !== undefined && installState.stubForm !== null && installState.stubForm !== "current") {
            this.ports.log.info("flow.stub-outdated", { path: install.rootPath, form: installState.stubForm });
            this.updating = true;
            return this.updateGate();
        }
        // OUR STUB WITHOUT OUR MARKER (Windows: a Discord update copied the
        // stub into a new app folder and left the marker behind). Not "already
        // set up": continue as an update, whose patch rewrites the marker.
        if (installState.warnings.includes("marker-missing") || installState.warnings.includes("marker-mismatch") || installState.warnings.includes("marker-stale")) {
            this.ports.log.info("flow.marker-rewrite", { path: install.rootPath, warnings: installState.warnings.join(",") });
            this.updating = true;
            return this.updateGate();
        }

        const installedId = installState.marker?.pluginBuildId ?? null;
        const shipped = this.ports.inspectShippedBundle();
        if (shipped.ok && installedId !== null && shipped.value.buildId !== installedId) {
            this.ports.log.info("flow.update-detected", { from: installedId, to: shipped.value.buildId });
            this.updating = true;
            return this.updateGate();
        }

        // "Already set up" must include the thing that KEEPS it set up. Field
        // evidence: the LaunchAgent named an app path that no longer existed,
        // this screen said all was well, and the helper could never run.
        return this.ensureHelper().then(helper => this.set(state({
            step: "already-installed",
            detail:
                "Subline is installed and Discord is set up to use it. There is nothing left to do. Open Discord "
                + "and messages in other languages will have a translation underneath them. "
                + (helper === "ok"
                    ? "Updates are handled in the background."
                    : helper === "temporary-location"
                        ? MOVE_COPY.helperOff
                        : "Background updates could not be turned on. Open Subline again later to retry."),
            install,
            installState,
            actions: ["finish"]
        })));
    }

    /** Remember this Discord for Uninstall and the helper. Never fails the install. */
    private remember(install: DiscordInstall, patched?: { discordVersion: string | null; buildId: string }): void {
        try {
            this.ports.rememberPatchedInstall?.(install, patched);
        } catch (cause) {
            this.ports.log.warn("patch.remember-failed", { cause: String(cause) });
        }
    }

    /** The "newer Subline already installed" screen, or null when this installer is not older. */
    private newerInstalled(installState: InstallState): FlowState | null {
        const loader = installState.marker?.loaderPath ?? installState.loaderPath;
        if (loader === null || loader === undefined || this.ports.inspectInstalledBundle === undefined) return null;
        const shipped = this.ports.inspectShippedBundle();
        if (!shipped.ok || shipped.value.pluginVersion === null) return null;
        const dir = loader.replace(/[\\/][^\\/]+$/, "");
        let installed: Result<ModBundle>;
        try {
            installed = this.ports.inspectInstalledBundle(dir);
        } catch (cause) {
            this.ports.log.warn("flow.installed-bundle-unreadable", { dir, cause: String(cause) });
            return null;
        }
        if (!installed.ok || installed.value.pluginVersion === null) {
            this.ports.log.info("flow.installed-bundle-unreadable", { dir, code: installed.ok ? "no-version" : installed.error.code });
            return null;
        }
        if (compareVersions(shipped.value.pluginVersion, installed.value.pluginVersion) >= 0) return null;
        this.ports.log.warn("flow.newer-installed", {
            installed: installed.value.pluginVersion,
            shipped: shipped.value.pluginVersion
        });
        const detail = `A newer Subline (${installed.value.pluginVersion}) is already installed. This installer is older (${shipped.value.pluginVersion}). `
            + (this.ports.platform === "win32"
                ? "Get the latest Subline from subline.page and run it."
                : "Nothing was changed. Get the latest Subline from subline.page.");
        return this.set(state({
            step: "already-installed",
            detail,
            install: installState.install,
            installState,
            actions: ["finish"]
        }));
    }

    /**
     * Re-point the helper at this app if it points anywhere else. "ok" when it
     * is in place. A copy run off the .dmg is "temporary-location": the helper
     * was not re-pointed at it, so background repair is not working from here
     * (audit 2026-10-06 #24), and the screen must not say it is.
     */
    private async ensureHelper(): Promise<"ok" | "failed" | "temporary-location"> {
        try {
            const result = await this.ports.ensureHelper();
            if (!result.ok) {
                this.ports.log.error("helper.ensure-failed", errorFields(result.error));
                return "failed";
            }
            this.ports.log.info("helper.ensure", {
                action: result.value.action,
                reason: result.value.reason,
                registered: result.value.registered,
                expected: result.value.expected
            });
            if (result.value.action === "skipped" && result.value.reason === "running-from-temporary-location") {
                return "temporary-location";
            }
            return "ok";
        } catch (cause) {
            this.ports.log.error("helper.ensure-failed", { cause: String(cause) });
            return "failed";
        }
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
                // Windows: closing Discord's window only hides it, behind the ^
                // near the clock (field test 2026-10-08), so say where it is.
                detail: this.ports.platform === "win32"
                    ? "Discord is still open in the background, behind the ^ near the clock. It has to close before "
                      + "Subline can change it. Subline can quit it for you."
                    : "Discord is running and has to close before it can be changed. Subline can ask it to quit for you.",
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
        // Language and activation were settled before Discord was closed (see
        // beforeQuit and updateGate). An early user updating by hand is let
        // through by the relay, which knows the plugin's own install id.
        if (this.updating && this.ports.hasSublineCode()) this.useSavedCode();
        if (this.updating || this.priorUse) {
            this.ports.log.info("flow.update-continues", { withCode: this.ports.hasSublineCode(), priorUse: this.priorUse });
        }
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

    /**
     * The language is REMEMBERED here and written once the install is
     * activated (see `activated`). Written now, it would make an abandoned
     * run look like earlier Subline use (readPriorUse) and let the next run
     * past the paid screen.
     */
    private async applyLanguage(code: string): Promise<FlowState> {
        this.chosenLanguage = code;
        this.languagePending = true;
        this.ports.log.info("language.chosen", { lang: code });
        try {
            this.ports.rememberPendingLanguage?.(code);
        } catch (cause) {
            this.ports.log.warn("language.pending-save-failed", { cause: String(cause) });
        }
        return this.codeStepUnlessSaved();
    }

    /**
     * Activation confirmed. Save the language chosen on this run, then close
     * Discord and patch.
     */
    private activated(): FlowState | Promise<FlowState> {
        if (this.languagePending && this.chosenLanguage !== null) {
            const saved = this.ports.setLanguage(this.chosenLanguage);
            if (!saved.ok) {
                this.ports.log.error("language.save-failed", errorFields(saved.error));
                return this.languageStep(saved.error);
            }
            this.languagePending = false;
            this.chosenLanguage = saved.value.code;
            try {
                this.ports.clearPendingLanguage?.();
            } catch (cause) {
                this.ports.log.warn("language.pending-clear-failed", { cause: String(cause) });
            }
            this.ports.log.info("language.saved", { lang: saved.value.code, created: saved.value.created });
        }
        return this.checkRunning();
    }

    /**
     * The code screen, unless a code is already saved.
     *
     * A SAVED CODE IS NEVER ASKED FOR AGAIN. Field evidence (0.1.6): a Discord
     * update removed the patch, so the next run was a fresh install as far as
     * the flow could tell (no marker, so not `updating`), and it walked the user
     * from the language screen to an empty "Your Subline code" field although
     * Vencord's settings still held their code. The flow only consulted the
     * saved code on the update path. Changing a code later stays where it has
     * always been: the plugin's settings inside Discord.
     */
    private codeStepUnlessSaved(): FlowState | Promise<FlowState> {
        if (this.ports.hasSublineCode()) {
            this.ports.log.info("flow.code-already-saved", { reason: "code in saved settings" });
            return this.checkSavedCode();
        }
        // No code, but an install id already in the settings (the plugin writes
        // it): the relay may already know this install as activated (an early
        // user, or a purchase made from Discord). Ask before offering to sell.
        if (this.ports.savedInstallId() !== null) return this.checkSavedInstall();
        return this.codeStep();
    }

    /**
     * Treat the saved code as this run's code, and make sure it is used.
     *
     * The code screen is skipped, so `setSublineCode` (which also selects the
     * relay engine) does not run. A code with another engine selected would
     * change nothing, so the engine is re-asserted. The code is never touched.
     * A failure here is logged, not shown: translation still works on the
     * engine that is selected, and the code can be re-entered in Discord.
     */
    private useSavedCode(): void {
        const engine = this.ports.ensureRelayEngine();
        if (!engine.ok) {
            this.ports.log.warn("code.engine-reassert-failed", errorFields(engine.error));
            return;
        }
        if (engine.value.changed) this.ports.log.info("code.engine-reasserted", { previous: engine.value.previous });
    }

    /* -------------------------------------------------------------------- *
     * Activation: Automatic, bought here or unlocked with a code
     * -------------------------------------------------------------------- */

    private codeStep(error: PatcherError | null = null): FlowState {
        // AT THE COMPUTER LIMIT the code is fine, it is just on 3 computers.
        // Selling a second Automatic would not help, so there is no Buy: only
        // the field (another code) and a link to ask for a reset.
        const atLimit = error?.message === CODE_SCREEN_COPY.errDeviceLimit;
        return this.set(state({
            step: "choose-code",
            // Two ways forward, and no skip: buy Automatic, or enter a code.
            // Every string on this screen is in codeScreen.ts. An error REPLACES
            // the line: the error box below is collapsed diagnostics, and "That
            // code doesn't exist." must be read, not expanded.
            detail: error?.message ?? CODE_SCREEN_COPY.detail,
            error,
            // NO CANCEL ON THIS SCREEN (field lesson: Cancel here read as
            // "decline the extra" and aborted whole installs). Someone who
            // truly wants out can close the window; nothing has been changed.
            actions: atLimit ? ["set-code"] : ["buy-automatic", "set-code"],
            ...(atLimit ? { helpUrl: RESET_HELP_URL } : {})
        }));
    }

    /**
     * An error for the activation screen: the copy the user reads, plus the
     * cause for the log. With no cause it is the relay's ANSWER (a wrong or
     * claimed code, a limit): CODE_REFUSED, which shows only the line, never
     * the "What went wrong" box (field test I5). With a cause (the relay
     * could not be reached) the box stays, so the errno can be copied.
     */
    private activationError(message: string, cause?: string): PatcherError {
        return cause === undefined
            ? { code: "CODE_REFUSED", message }
            : { code: "IO_ERROR", message, cause };
    }

    /**
     * Save a code the relay has confirmed, and carry on to the permission step.
     * A code the settings refuse to take stays on the activation screen.
     */
    private async saveConfirmedCode(code: string | null, ai: boolean): Promise<FlowState> {
        if (this.aborted) return this.current;
        this.aiEntitled = ai;
        if (code !== null) {
            const saved = this.ports.setSublineCode(code);
            if (!saved.ok) {
                this.ports.log.error("code.save-failed", errorFields(saved.error));
                return this.codeStep(saved.error);
            }
            // LENGTH, never the code.
            this.ports.log.info("code.saved", { codeLength: saved.value.codeLength, created: saved.value.created });
        }
        this.ports.log.info("activation.confirmed", { withCode: code !== null, ai });
        return this.activated();
    }

    /** What a status answer about a code means for the activation screen. */
    private statusError(answer: StatusAnswer): PatcherError {
        switch (answer.kind) {
            case "device_limit": return this.activationError(CODE_SCREEN_COPY.errDeviceLimit);
            case "invalid": return this.activationError(CODE_SCREEN_COPY.errNotFound);
            case "unreachable": return this.activationError(CODE_SCREEN_COPY.errUnreachable, answer.cause);
            default: return this.activationError(CODE_SCREEN_COPY.errNotActive);
        }
    }

    private redeemError(answer: Exclude<RedeemAnswer, { kind: "ok" }>, code: string): PatcherError {
        switch (answer.kind) {
            case "not_found": return this.activationError(looksLikeCoupon(code)
                ? `${CODE_SCREEN_COPY.errNotFound} ${CODE_SCREEN_COPY.errCoupon}`
                : CODE_SCREEN_COPY.errNotFound);
            case "claimed": return this.activationError(CODE_SCREEN_COPY.errClaimed);
            case "already": return this.activationError(CODE_SCREEN_COPY.errAlready);
            case "rate_limited": return this.activationError(CODE_SCREEN_COPY.errRateLimited);
            case "net_limited": return this.activationError(CODE_SCREEN_COPY.errNetLimited);
            case "unreachable": return this.activationError(CODE_SCREEN_COPY.errUnreachable, answer.cause);
        }
    }

    /**
     * "I have a code". A promo code is redeemed for this install; anything else
     * is a license key or a Subline code, checked with the relay before it is
     * saved. Nothing continues on an error.
     */
    private async applyCode(raw: string): Promise<FlowState> {
        const typed = raw.trim();
        if (typed === "") return this.codeStep(this.activationError(CODE_SCREEN_COPY.errEmpty));
        const id = this.ports.ensureInstallId();
        if (!id.ok) {
            this.ports.log.error("activation.install-id-failed", errorFields(id.error));
            return this.codeStep(id.error);
        }
        // Nothing on this screen can be pressed again until the relay answers
        // (see hold). A second press used to redeem the promo a second time.
        this.hold(CODE_SCREEN_COPY.checking);
        const promo = promoCode(typed);
        if (promo !== null) {
            const redeemed = await this.ports.relay.redeem(id.value, promo);
            this.ports.log.info("activation.redeem", { result: redeemed.kind });
            if (this.aborted) return this.current;
            // "already": this install already has Automatic. Usually it is OUR
            // OWN earlier redeem whose answer was lost (a slow network past the
            // 10 s timeout, then Save again). Ask the relay what this install
            // has, exactly as Buy does on already_owned, instead of leaving
            // the user on "Already yours." with no way forward.
            if (redeemed.kind === "already") return this.alreadyActivated(id.value);
            if (redeemed.kind !== "ok") return this.codeStep(this.redeemError(redeemed, promo));
            return this.saveConfirmedCode(redeemed.code, false);
        }
        // CHECK FIRST, LINK LATER. A check-only status judges the code without
        // tying this computer to it, so a mistyped or borrowed code never uses
        // up one of its 3 computers. Only "Use it" links it (useConfirmedCode).
        const answer = await this.ports.relay.status(typed, id.value, { check: true });
        if (this.aborted) return this.current;
        const works = answer.kind === "ok" && (answer.check ? answer.check.valid && answer.check.automatic : answer.automatic);
        this.ports.log.info("activation.code-check", { result: answer.kind, works });
        if (works) {
            this.pendingCode = typed;
            return this.set(state({
                step: "confirm-code",
                detail: CODE_SCREEN_COPY.confirm,
                actions: ["use-code", "back"]
            }));
        }
        if (answer.kind === "ok") return this.codeStep(this.activationError(CODE_SCREEN_COPY.errNotActive));
        return this.codeStep(this.statusError(answer));
    }

    /** "Use it": now the code is linked to this computer (a normal status). */
    private async useConfirmedCode(): Promise<FlowState> {
        const code = this.pendingCode;
        if (code === null) return this.codeStep();
        const id = this.ports.ensureInstallId();
        if (!id.ok) {
            this.ports.log.error("activation.install-id-failed", errorFields(id.error));
            return this.codeStep(id.error);
        }
        this.hold(CODE_SCREEN_COPY.checking);
        const answer = await this.ports.relay.status(code, id.value);
        this.ports.log.info("activation.code-linked", { result: answer.kind, automatic: answer.kind === "ok" ? answer.automatic : null });
        if (answer.kind === "ok" && answer.automatic) {
            this.pendingCode = null;
            return this.saveConfirmedCode(code, answer.ai);
        }
        return this.codeStep(this.statusError(answer));
    }

    /**
     * "Buy for $4.99": a relay checkout for this install, opened in the
     * browser (the static link when the relay could not make one), then the
     * relay is asked every few seconds until the purchase lands. No timeout:
     * the screen waits until the purchase or Back, like the permission wait.
     */
    private async buyAutomatic(): Promise<FlowState> {
        const id = this.ports.ensureInstallId();
        if (!id.ok) {
            this.ports.log.error("activation.install-id-failed", errorFields(id.error));
            return this.codeStep(id.error);
        }
        this.set(state({ step: "choose-code", detail: CODE_SCREEN_COPY.openingCheckout, busy: true, actions: [] }));
        const checkout = await this.ports.relay.checkout(id.value);
        if (this.aborted) return this.current;
        // null: nothing to open, only wait (a payment is already on its way).
        let url: string | null;
        if (checkout.kind === "ok" && isDodoCheckoutUrl(checkout.url)) {
            url = checkout.url;
        } else if (checkout.kind === "purchase_pending") {
            // A payment from this computer is still being confirmed. Selling
            // again would charge twice: open nothing and wait for it.
            this.ports.log.info("activation.purchase-pending", {});
            url = null;
        } else if (checkout.kind === "already_owned") {
            // This install already has Automatic: ask the relay again rather
            // than sell it twice.
            this.ports.log.info("activation.already-owned", {});
            return this.alreadyActivated(id.value);
        } else if (checkout.kind === "network" && staticCheckoutAllowed(this.productId())) {
            // The relay could not be reached at all: the static link still
            // links the purchase to this install (metadata_install).
            this.ports.log.warn("activation.checkout-fallback", { cause: checkout.cause });
            url = staticAutomaticCheckoutUrl(id.value, this.productId());
        } else {
            // The relay said buying is not possible, or the static link would
            // be a dead page. Open NOTHING: never leave someone on a 404.
            const cause = "cause" in checkout ? checkout.cause : "not a Dodo URL";
            this.ports.log.warn("activation.checkout-unavailable", { kind: checkout.kind, cause });
            return this.codeStep(this.activationError(
                checkout.kind === "network" ? CODE_SCREEN_COPY.errUnreachable : CODE_SCREEN_COPY.errBuyUnavailable,
                cause
            ));
        }

        const waitingDetail = url === null
            ? CODE_SCREEN_COPY.purchasePending
            : `${CODE_SCREEN_COPY.waiting}\n\n${CODE_SCREEN_COPY.vpn}`;
        // Try again reopens the checkout; Back returns to the choice.
        const waitingActions: FlowActionType[] = url === null ? ["back"] : ["retry", "back"];
        let waiting = this.set(state({
            step: "activation-waiting",
            detail: waitingDetail,
            busy: true,
            actions: waitingActions
        }));
        const startedAt = this.ports.now();
        let hinted = false;
        if (url !== null) {
            try {
                await this.ports.openCheckout(url);
            } catch (cause) {
                this.ports.log.warn("activation.open-failed", { cause: String(cause) });
            }
        }

        const every = this.ports.activationPollIntervalMs ?? ACTIVATION_POLL_MS;
        let attempts = 0;
        while (this.current === waiting) {
            // Asked at once, then every few seconds for half an hour, then
            // every 5 minutes, and never after 48 hours (activationPollDelay).
            // A purchase already made (the browser was quicker than this
            // screen) lands without a wait.
            if (attempts > 0) {
                const delay = activationPollDelay(this.ports.now() - startedAt, every);
                if (delay === null) {
                    // An installer left open on this screen must not ask the
                    // relay forever (see ACTIVATION_POLL_FOR_MS). Back to the
                    // choice, saying what is true: reopening finds the purchase.
                    this.ports.log.info("activation.poll-stopped", { attempts, waitedMs: this.ports.now() - startedAt });
                    return this.codeStep(this.activationError(CODE_SCREEN_COPY.errWaitingStopped, "stopped polling after 48h"));
                }
                // In slices of at most ACTIVATION_POLL_MS, so Back or an abort
                // during the 5 minute phase stops the loop within seconds.
                const until = this.ports.now() + delay;
                while (this.current === waiting && this.ports.now() < until) {
                    await this.ports.sleep(Math.min(ACTIVATION_POLL_MS, until - this.ports.now()));
                }
            }
            if (this.current !== waiting) break;
            // After 10 minutes: say that a finished payment still lands later.
            if (!hinted && this.ports.now() - startedAt >= WAITING_HINT_AFTER_MS) {
                hinted = true;
                waiting = this.set(state({
                    step: "activation-waiting",
                    detail: `${waitingDetail}\n\n${CODE_SCREEN_COPY.waitingLate}`,
                    busy: true,
                    actions: waitingActions
                }));
            }
            const answer = await this.ports.relay.status(installBearer(id.value), id.value);
            attempts += 1;
            if (answer.kind === "ok" && answer.automatic) {
                if (this.current !== waiting) break;
                this.ports.log.info("activation.purchase-landed", { attempts });
                return this.saveConfirmedCode(answer.code, answer.ai);
            }
            // Logged when it is not the plain "not yet", and never the id.
            if (answer.kind !== "ok") this.ports.log.warn("activation.poll", { result: answer.kind, attempts });
        }
        return this.current;
    }

    /**
     * A code is already saved: the relay must confirm it before anything is
     * patched. Unreachable relay: say so and wait for Try again, never continue.
     */
    private async checkSavedCode(): Promise<FlowState> {
        const code = this.ports.savedSublineCode();
        if (code === null) return this.codeStep();
        const id = this.ports.ensureInstallId();
        if (!id.ok) {
            this.ports.log.error("activation.install-id-failed", errorFields(id.error));
            return this.codeStep(id.error);
        }
        this.hold(CODE_SCREEN_COPY.checking);
        const answer = await this.ports.relay.status(code, id.value);
        if (this.aborted) return this.current;
        this.ports.log.info("activation.saved-code-check", { result: answer.kind, automatic: answer.kind === "ok" ? answer.automatic : null });
        if (answer.kind === "unreachable") return this.checkFailed(answer.cause);
        if (answer.kind === "ok" && answer.automatic) {
            this.aiEntitled = answer.ai;
            this.useSavedCode();
            return this.activated();
        }
        return this.codeStep(this.statusError(answer));
    }

    /** No code, but an install id the relay may already know as activated. */
    private async checkSavedInstall(): Promise<FlowState> {
        const id = this.ports.savedInstallId();
        if (id === null) return this.codeStep();
        this.hold(CODE_SCREEN_COPY.checkingPurchase);
        const answer = await this.ports.relay.status(installBearer(id), id);
        if (this.aborted) return this.current;
        this.ports.log.info("activation.install-check", { result: answer.kind, automatic: answer.kind === "ok" ? answer.automatic : null });
        if (answer.kind === "unreachable") return this.checkFailed(answer.cause);
        // The relay can hand back a code the reader cleared in Subline's
        // settings (it keeps a purchase linked to the install for 30 days).
        // Clearing was their decision: never save it again and never skip the
        // activation screen on its strength.
        if (answer.kind === "ok" && answer.code !== null && answer.code === this.ports.clearedCode()) {
            this.ports.log.info("activation.cleared-code-ignored", {});
            return this.codeStep();
        }
        if (answer.kind === "ok" && answer.automatic) return this.saveConfirmedCode(answer.code, answer.ai);
        return this.codeStep();
    }

    /**
     * The relay said this install already has Automatic (checkout 409
     * already_owned, or redeem "already"). Ask it what this install has and
     * carry on with that. "Already yours." only when the relay does not
     * confirm Automatic after all.
     */
    private async alreadyActivated(installId: string): Promise<FlowState> {
        this.hold(CODE_SCREEN_COPY.checkingPurchase);
        const answer = await this.ports.relay.status(installBearer(installId), installId);
        this.ports.log.info("activation.already-check", { result: answer.kind, automatic: answer.kind === "ok" ? answer.automatic : null });
        if (this.aborted) return this.current;
        if (answer.kind === "unreachable") return this.codeStep(this.activationError(CODE_SCREEN_COPY.errUnreachable, answer.cause));
        if (answer.kind === "ok" && answer.automatic) {
            // Never bring back a code the reader cleared (see checkSavedInstall):
            // carry on, but do not save it again.
            if (answer.code !== null && answer.code === this.ports.clearedCode()) {
                this.ports.log.info("activation.cleared-code-ignored", {});
                return this.saveConfirmedCode(null, answer.ai);
            }
            return this.saveConfirmedCode(answer.code, answer.ai);
        }
        return this.codeStep(this.activationError(CODE_SCREEN_COPY.errAlready));
    }

    private productId(): string {
        return this.ports.automaticProductId ?? AUTOMATIC_PRODUCT_ID;
    }

    private checkFailed(cause: string): FlowState {
        this.ports.log.warn("activation.check-unreachable", { cause });
        return this.set(state({
            step: "activation-check-failed",
            detail: CODE_SCREEN_COPY.errUnreachable,
            error: this.activationError(CODE_SCREEN_COPY.errUnreachable, cause),
            actions: ["retry", "cancel"]
        }));
    }

    /* -------------------------------------------------------------------- *
     * §3 step 7 / §4: App Management
     * -------------------------------------------------------------------- */

    private async permissionStep(): Promise<FlowState> {
        const install = this.chosenInstall;
        if (install === null) return this.detect();

        // BEFORE ANYTHING IS WRITTEN (audit 2026-10-06 #24): Subline run off the
        // .dmg or a translocated copy would register a helper that dies when
        // the disk image is ejected. Discord stays untouched until it moves.
        const moved = await this.checkAppLocation();
        if (moved !== null) return moved;

        const status = this.ports.probePermission(install);
        this.ports.log.info("permission.probe", { status });
        if (status === "granted" || status === "not-required") return this.patchStep();
        if (status === "not-writable") return this.notWritable(install);

        // EXPLAIN BEFORE ATTEMPTING (§4). We already know the write would be
        // refused, so the user meets this as a step rather than as a failure.
        return this.explainPermission(status);
    }

    /**
     * The write was refused with EACCES: file ownership, not App Management.
     * Turning Subline on in System Settings cannot fix that, so there is no
     * wait (it used to poll forever on "Turn on Subline"). Try again checks again.
     */
    private notWritable(install: DiscordInstall): FlowState {
        const message = appManagementSummary("not-writable");
        const cause = this.ports.lastPermissionProbeError?.() ?? undefined;
        this.ports.log.error("permission.not-writable", { path: install.resourcesPath, cause: cause ?? null });
        return this.set(state({
            step: "permission-failed",
            detail: message,
            permissionStatus: "not-writable",
            error: {
                code: "NOT_WRITABLE",
                message,
                path: install.resourcesPath,
                ...(cause === undefined ? {} : { cause })
            },
            install,
            actions: ["retry", "cancel"]
        }));
    }

    /** macOS only. The move screen, or null when Subline runs from a place the helper can keep using. */
    private async checkAppLocation(): Promise<FlowState | null> {
        if (this.ports.platform !== "darwin" || this.ports.appLocation === undefined) return null;
        let location: Result<{ stable: boolean; path: string; reason: string | null }>;
        try {
            location = await this.ports.appLocation();
        } catch (cause) {
            this.ports.log.warn("flow.app-location-unknown", { cause: String(cause) });
            return null;
        }
        if (!location.ok) {
            // The check itself failed. The helper registration runs the same
            // check and refuses on its own, so the install is not blocked here.
            this.ports.log.warn("flow.app-location-unknown", errorFields(location.error));
            return null;
        }
        if (location.value.stable) return null;
        this.ports.log.warn("flow.app-location-temporary", { path: location.value.path, reason: location.value.reason });
        return this.set(state({
            step: "move-to-applications",
            detail: MOVE_COPY.body,
            actions: ["move-to-applications", "retry", "cancel"]
        }));
    }

    private async moveToApplications(): Promise<FlowState> {
        let moved: Result<boolean>;
        try {
            moved = this.ports.moveToApplications === undefined
                ? { ok: true, value: false }
                : await this.ports.moveToApplications();
        } catch (cause) {
            moved = { ok: false, error: { code: "IO_ERROR", message: String(cause) } };
        }
        if (moved.ok && moved.value) {
            // Electron quits this copy and opens the one in Applications.
            this.ports.log.info("flow.moved-to-applications");
            return this.set(state({ step: "move-to-applications", detail: MOVE_COPY.moving, busy: true, actions: [] }));
        }
        this.ports.log.warn("flow.move-to-applications-failed", moved.ok ? { moved: false } : errorFields(moved.error));
        return this.set(state({
            step: "move-to-applications",
            detail: MOVE_COPY.moveFailed,
            actions: ["move-to-applications", "retry", "cancel"]
        }));
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

        const waiting = this.set(state({
            step: "permission-waiting",
            // ONE waiting screen, and it waits for as long as it takes. The
            // pane path is already on screen as the note under this line
            // (renderer.ts renders it whenever `permissionSettingsUrl` is set).
            // "Later" is measured: field log 2026-09-24, the user chose Later
            // and the very next probe returned granted.
            detail: "In the window that just opened, turn on **Subline**. If macOS asks to quit, choose **Later**. "
                + "Subline carries on by itself.",
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
            // Cancel moves the flow off this screen; the poll stops at its next
            // tick and never patches after a Cancel.
            isCancelled: () => this.current !== waiting,
            onAttempt: (status, attempt) => {
                if (isLoggedAttempt(attempt)) this.ports.log.info("permission.attempt", { status, attempt });
            },
            ...(this.ports.permissionPollIntervalMs === undefined ? {} : { pollIntervalMs: this.ports.permissionPollIntervalMs }),
            ...(this.ports.permissionSlowPollIntervalMs === undefined ? {} : { slowPollIntervalMs: this.ports.permissionSlowPollIntervalMs }),
            ...(this.ports.permissionSlowAfterMs === undefined ? {} : { slowAfterMs: this.ports.permissionSlowAfterMs })
        });
        this.ports.log.info("permission.result", {
            status: report.status,
            attempts: report.attempts,
            cancelled: report.cancelled,
            failed: report.failed
        });

        // Also when the screen changed under a probe that said granted: a
        // Cancel pressed during the last probe must still mean no patch.
        if (report.cancelled || this.current !== waiting || this.aborted) return this.current;
        if (report.permitted) return this.patchStep();
        if (report.status === "not-writable") return this.notWritable(install);

        // The only way here: the CHECK kept failing for a reason that is not
        // a permission refusal. That is a real failure with a real cause, so
        // it gets an error screen and keeps its diagnostics.
        const cause = this.ports.lastPermissionProbeError?.() ?? undefined;
        this.ports.log.error("permission.check-failed", { attempts: report.attempts, cause: cause ?? null });
        return this.set(state({
            step: "permission-failed",
            detail: `${report.summary} Press **Try again**. Nothing you chose is lost.`,
            permission: report,
            permissionStatus: report.status,
            error: {
                code: "IO_ERROR",
                message: report.summary,
                path: install.resourcesPath,
                ...(cause === undefined ? {} : { cause })
            },
            actions: ["retry", "cancel"]
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
        if (this.aborted) return this.current;
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
        this.remember(install);
        // THE MARKER NOW, NOT AFTER DISCORD CLOSES (audit #11). When Discord's
        // stub already loads this bundle, the update is only a marker rewrite,
        // which Windows allows while Discord runs. Without it the helper waited
        // for a quit and, 30 minutes later, said "Discord updated, quit
        // Discord", which was not true. Anything else (a stub that loads
        // another Subline path, a damaged one) stays staged for the helper.
        const adopted = this.adopt(install, installed.value.dir);
        this.updateStaged = !adopted;
        this.ports.log.info("bundle.staged", {
            build: installed.value.buildId,
            replaced: installed.value.replaced,
            dir: installed.value.dir,
            markerWritten: adopted,
            reason: adopted
                ? "Discord is open on Windows; the stub already loads this bundle, so only the marker was written"
                : "Discord is open on Windows, so the helper applies this after it closes"
        });
        return this.installHelper();
    }

    /** adoptPatch through its port. True when the marker now names this build. Never fails the update. */
    private adopt(install: DiscordInstall, modBundleDir: string): boolean {
        if (this.ports.adoptPatch === undefined) return false;
        try {
            const adopted = this.ports.adoptPatch(install, modBundleDir);
            if (!adopted.ok) {
                this.ports.log.info("bundle.adopt-skipped", errorFields(adopted.error));
                return false;
            }
            this.ports.log.info("bundle.adopted", { build: adopted.value.pluginBuildId });
            return true;
        } catch (cause) {
            this.ports.log.warn("bundle.adopt-skipped", { cause: String(cause) });
            return false;
        }
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
        // The one await before the writes: an abort (Uninstall) that landed
        // meanwhile means nothing below may run.
        if (this.aborted) return this.current;
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

        // DISCORD MAY HAVE MOVED (audit #23). On Windows, Discord's updater
        // lays down a new app-1.0.x folder while Discord runs, and the user may
        // have spent minutes paying or granting permission since detection.
        // Discord is closed now (checked just above), so the folder it will run
        // next is settled: patch that one, never a folder it has left.
        const target = this.relocate(install);
        if (!target.ok) return this.failPatch(target.error);
        if (target.value !== install) {
            const moved = this.ports.inspect(target.value);
            if (!moved.ok || (moved.value.kind !== "unpatched" && moved.value.kind !== "patched-by-us")) {
                return this.inspectChosen(target.value);
            }
        }
        const patchTarget = target.value;

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

        const patched = this.ports.patch(patchTarget, {
            modBundleDir: installed.value.dir,
            overwriteForeignMod: this.overwriteForeignMod
        });
        if (!patched.ok) {
            this.ports.log.error("patch.failed", errorFields(patched.error));
            return this.failPatch(patched.error);
        }

        this.patchReport = patched.value;
        this.patchedAt = this.ports.now();
        // BEFORE the helper is registered: macOS starts it at once, and its
        // first run must already know this Discord is ours.
        this.remember(patchTarget, {
            discordVersion: patched.value.discordVersion,
            buildId: patched.value.pluginBuildId
        });
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
    /**
     * The install to patch now: the same Discord (stable id) as the one
     * chosen, as it is on disk now. Unchanged when nothing moved or the
     * search cannot say; DISCORD_MOVED when that Discord is gone.
     */
    private relocate(install: DiscordInstall): Result<DiscordInstall> {
        let located: Result<DiscordInstall[]>;
        try {
            located = this.ports.locate(this.explicitPaths.length > 0 ? this.explicitPaths : undefined);
        } catch (cause) {
            this.ports.log.warn("patch.relocate-failed", { cause: String(cause) });
            return { ok: true, value: install };
        }
        if (!located.ok) {
            this.ports.log.warn("patch.relocate-failed", errorFields(located.error));
            return { ok: true, value: install };
        }
        const same = located.value.find(candidate => candidate.stableId === install.stableId);
        if (same === undefined) {
            // A hand-picked folder outside the search can be missing from it;
            // only a folder that is really gone is refused.
            if (located.value.some(candidate => candidate.rootPath === install.rootPath)) return { ok: true, value: install };
            if (install.fromExplicitPath) return { ok: true, value: install };
            this.ports.log.error("patch.target-gone", { path: install.rootPath, stableId: install.stableId });
            return {
                ok: false,
                error: {
                    code: "DISCORD_MOVED",
                    message: "Discord changed while Subline was waiting, so Subline did not change anything. Press Try again.",
                    path: install.rootPath
                }
            };
        }
        if (same.rootPath !== install.rootPath) {
            this.ports.log.info("patch.target-moved", { from: install.rootPath, to: same.rootPath });
            this.chosenInstall = same;
            return { ok: true, value: same };
        }
        return { ok: true, value: install };
    }

    private async installHelper(): Promise<FlowState> {
        if (this.aborted) return this.current;
        this.set(state({
            step: "installing-helper",
            detail: "Setting Subline up to repair itself after Discord updates…",
            busy: true,
            actions: []
        }));

        const result = await this.ports.installHelper();
        if (this.aborted) return this.current;
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
        // A damaged backup another tool left is not ours to report: name the
        // remedy (audit #13). A file held open right after Discord was seen
        // closed is a scan, usually antivirus (audit #16), not Discord.
        const backupDamaged = error.code === "BACKUP_CORRUPT"
            || (rolledBack && this.chosenInstall !== null && error.path === this.chosenInstall.backupPath);
        const detail = backupDamaged
            ? `${error.message}${rolledBack ? ` Discord has been put back as it was. ${PATCH_FAILED_COPY.reinstall}` : ""}`
            : rolledBack
                ? `${error.message} Discord has been put back exactly as it was, so nothing is broken. Please report this.`
                : error.code === "FILE_IN_USE" && !this.updatingWithDiscordOpen
                    ? PATCH_FAILED_COPY.scanning
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

        if (this.aborted) return this.current;
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

    /** The relay said this install also has AI (✦). Decides what the last screen expects. */
    private aiEntitled = false;
    /** A typed code that checked out, waiting for "Use it". Never logged. */
    private pendingCode: string | null = null;
    /** The language was chosen on this run and is written once activated. */
    private languagePending = false;
    /** The settings show Subline was used here before: an update, not gated. */
    private priorUse = false;

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
            expectUpgrade: this.aiEntitled,
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
            + (this.aiEntitled ? " The ✦ line follows a few seconds after the ≈ line." : "")
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
