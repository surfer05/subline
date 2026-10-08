/**
 * The install flow, driven end to end without Electron.
 *
 * The happy path gets one test. Everything else here is a failure state,
 * because the happy path is the one thing that gets exercised by hand anyway.
 */

import { describe, expect, it } from "vitest";

import type { CheckoutAnswer, RedeemAnswer, StatusAnswer } from "../src/app/activation.js";
import type { AppManagementStatus } from "../src/app/appManagement.js";
import { ACTION_LABELS, IS_PRIMARY } from "../src/app/actions.js";
import { CODE_SCREEN_COPY, RESET_HELP_URL } from "../src/app/codeScreen.js";
import { InstallFlow, isConfirmedSuccess } from "../src/app/flow.js";
import type { FlowPorts, FlowState, FlowStep, HelperEnsureReport, HelperInstallOutcome } from "../src/app/flow.js";
import type { InstalledModBundle } from "../src/app/modInstall.js";
import type { ModBundle } from "../src/bundle/bundle.js";
import type { DiscordInstall } from "../src/patcher/locate.js";
import type { PatchReport } from "../src/patcher/patch.js";
import type { PatcherError, PatcherErrorCode, Result } from "../src/patcher/result.js";
import type { InstallState, InstallStateKind, KnownMod } from "../src/patcher/state.js";
import type { VerificationReport, VerificationStatus } from "../src/verify/verify.js";

/* ------------------------------------------------------------------------ *
 * A scriptable set of ports
 * ------------------------------------------------------------------------ */

const INSTALL: DiscordInstall = {
    branch: "stable",
    rootPath: "/Applications/Discord.app",
    stableId: "/Applications/Discord.app",
    resourcesPath: "/Applications/Discord.app/Contents/Resources",
    asarPath: "/Applications/Discord.app/Contents/Resources/app.asar",
    backupPath: "/Applications/Discord.app/Contents/Resources/_app.asar",
    buildInfoPath: "/Applications/Discord.app/Contents/Resources/build_info.json",
    fromExplicitPath: false
};

const PTB_INSTALL: DiscordInstall = { ...INSTALL, branch: "ptb", rootPath: "/Applications/Discord PTB.app" };

const RUNTIME_MOD_DIR = "/Users/x/Library/Application Support/Subline/mod";
const BUILD_ID = "1f2e3d4c5b6a7980";

const BUNDLE: ModBundle = {
    dir: RUNTIME_MOD_DIR,
    loaderPath: `${RUNTIME_MOD_DIR}/patcher.js`,
    buildId: BUILD_ID,
    pluginVersion: "0.1.0",
    vencordCommit: "1a8c3b71bbfaeb195a7f402458b6b68b0ccea7ef",
    vencordVersion: "1.15.0",
    builtAt: "2026-08-06T12:00:00.000Z",
    manifest: {} as ModBundle["manifest"]
};

function installState(kind: InstallStateKind, mod: KnownMod | null = null): InstallState {
    return {
        kind,
        install: INSTALL,
        mod,
        modName: mod === null ? null : mod === "betterdiscord" ? "BetterDiscord" : mod === "vencord" ? "Vencord" : "Equicord",
        loaderPath: mod === null ? null : "/somewhere/patcher.js",
        asarIsStub: mod !== null,
        hasBackup: true,
        marker: null,
        reason: kind === "broken" ? "asar-and-backup-missing" : null,
        warnings: [],
        summary: kind === "broken"
            ? "Discord's app.asar and its backup are both missing. Reinstall Discord to repair it."
            : "state summary"
    };
}

function patchReport(): PatchReport {
    return {
        install: INSTALL,
        loaderPath: BUNDLE.loaderPath,
        pluginBuildId: BUILD_ID,
        backupPath: INSTALL.backupPath,
        markerPath: `${INSTALL.resourcesPath}/subline-patch.json`,
        backupCreated: true,
        alreadyPatched: false,
        replacedMod: null,
        discordVersion: "0.0.406",
        previousState: "unpatched",
        bundle: BUNDLE
    };
}

function verification(overrides: Partial<VerificationReport> = {}): VerificationReport {
    const status: VerificationStatus = overrides.status ?? "translating-approx";
    return {
        status,
        confirmed: false,
        loaded: false,
        pending: false,
        stale: false,
        identity: "match",
        tier: "none",
        errorCode: null,
        beacon: null,
        problem: null,
        summary: "summary from verifyOnce",
        ...overrides
    };
}

function fail(code: PatcherErrorCode, message = "something went wrong"): PatcherError {
    return { code, message };
}

interface Script {
    /** The settings show Subline was used here before (priorSublineUse). */
    priorUse?: boolean;
    /** Stands in for the real Dodo product id (the source holds the placeholder). */
    automaticProductId?: string;
    bundle?: Result<ModBundle>;
    /** One answer, or one per call (the last repeats). */
    installs?: Result<DiscordInstall[]> | Array<Result<DiscordInstall[]>>;
    /** The bundle a patched Discord loads (audit #12). Absent: the port is not wired. */
    installedBundle?: Result<ModBundle>;
    /** adoptPatch's answer (audit #11). Absent: the port is not wired. */
    adopt?: Result<{ pluginBuildId: string; discordVersion: string | null }>;
    /** A language chosen on an earlier run that stopped before activation (I6). */
    pendingLanguage?: string | null;
    inspect?: Result<InstallState> | ((install: DiscordInstall) => Result<InstallState>);
    processes?: Array<Array<{ pid: number; command: string }>>;
    requestQuit?: () => Promise<void>;
    forceQuit?: () => Promise<void>;
    permission?: AppManagementStatus[];
    installBundle?: Result<InstalledModBundle>;
    patch?: Result<PatchReport> | (() => Result<PatchReport>);
    installHelper?: Array<Result<HelperInstallOutcome>>;
    ensureHelper?: Result<HelperEnsureReport>;
    permissionProbeError?: string | null;
    launch?: Result<true>;
    verify?: VerificationReport;
    discordLocale?: string | null;
    setLanguage?: Result<{ path: string; code: string; previous: string | null; created: boolean }>;
    setSublineCode?: Result<{ path: string; created: boolean; codeLength: number }>;
    /** Whether the saved settings already hold a code (an UPDATE consults this). */
    hasSublineCode?: boolean;
    ensureRelayEngine?: Result<{ changed: boolean; previous: string | null }>;
    platform?: NodeJS.Platform;
    /** The saved code, when a test needs its value. Defaults from hasSublineCode. */
    savedCode?: string | null;
    /** An install id already in the settings. */
    savedInstallId?: string | null;
    clearedCode?: string | null;
    ensureInstallId?: Result<string>;
    /** The relay. Status may be scripted per call (the last entry repeats). */
    relayStatus?: StatusAnswer | StatusAnswer[];
    relayCheckout?: CheckoutAnswer;
    relayRedeem?: RedeemAnswer;
}

/** A relay that says this install is activated, with ✦. */
const ACTIVE: StatusAnswer = { kind: "ok", automatic: true, ai: true, code: null };
const TEST_INSTALL_ID = "0123456789abcdef0123456789abcdef";
const SESSION_URL = "https://checkout.dodopayments.com/session/cks_test";

interface Harness {
    flow: InstallFlow;
    ports: FlowPorts;
    logged: Array<{ level: string; event: string; fields: Record<string, unknown> }>;
    settingsOpened: number;
    patchCalls: Array<{ modBundleDir: string; overwriteForeignMod: boolean }>;
    languageWrites: string[];
    codeWrites: string[];
    /** How many times the flow asked for the relay engine to be re-selected. */
    engineReasserts: number;
    verifyCalls: Array<{ expectedBuildId: string; patchedAt: number; launchedAt: number }>;
    /** How many times the mod bundle was copied to its runtime location. */
    bundleInstalls: number;
    helperInstalls: number;
    helperEnsures: number;
    launched: number;
    /** The step names, in order, every transition passed through. */
    steps: FlowStep[];
    /** Every relay call, in order. */
    relayCalls: Array<{ kind: "checkout" | "status" | "redeem"; credential?: string; installId: string; code?: string; check?: boolean }>;
    /** URLs opened in the browser. */
    opened: string[];
    installIdWrites: number;
    /** Every rememberPatchedInstall call, by rootPath. */
    remembered: string[];
    adoptCalls: number;
    pendingWrites: string[];
    pendingClears: number;
    /** The install each patch call targeted. */
    patchTargets: string[];
    launchedTargets: string[];
}

function harness(script: Script = {}): Harness {
    let t = 1_000;
    let processCall = 0;
    let permissionCall = 0;
    let patchCall = 0;

    let helperCall = 0;

    const h: Harness = {
        logged: [],
        settingsOpened: 0,
        patchCalls: [],
        languageWrites: [],
        codeWrites: [],
        engineReasserts: 0,
        verifyCalls: [],
        bundleInstalls: 0,
        helperInstalls: 0,
        helperEnsures: 0,
        launched: 0,
        steps: [],
        relayCalls: [],
        opened: [],
        installIdWrites: 0,
        remembered: [],
        adoptCalls: 0,
        pendingWrites: [],
        pendingClears: 0,
        patchTargets: [],
        launchedTargets: []
    } as unknown as Harness;
    let locateCall = 0;
    let statusCall = 0;

    const record = (level: string) => (event: string, fields: Record<string, unknown> = {}) => {
        h.logged.push({ level, event, fields });
    };

    const ports: FlowPorts = {
        platform: script.platform ?? "darwin",
        productVersion: "0.1.0",
        log: { info: record("info"), warn: record("warn"), error: record("error") } as FlowPorts["log"],
        now: () => t,
        sleep: async (ms: number) => { t += ms; },

        inspectShippedBundle: () => script.bundle ?? { ok: true, value: BUNDLE },
        installModBundle: () => {
            h.bundleInstalls += 1;
            return script.installBundle ?? { ok: true, value: { ...BUNDLE, replaced: false } };
        },

        locate: () => {
            const scripted = script.installs ?? { ok: true, value: [INSTALL] };
            if (!Array.isArray(scripted)) return scripted;
            return scripted[Math.min(locateCall++, scripted.length - 1)] as Result<DiscordInstall[]>;
        },
        ...(script.installedBundle === undefined ? {} : { inspectInstalledBundle: () => script.installedBundle as Result<ModBundle> }),
        ...(script.adopt === undefined ? {} : {
            adoptPatch: () => {
                h.adoptCalls += 1;
                return script.adopt as Result<{ pluginBuildId: string; discordVersion: string | null }>;
            }
        }),
        ...(script.pendingLanguage === undefined ? {} : {
            pendingLanguage: () => script.pendingLanguage ?? null,
            rememberPendingLanguage: (code: string) => { h.pendingWrites.push(code); },
            clearPendingLanguage: () => { h.pendingClears += 1; }
        }),
        rememberPatchedInstall: (install: DiscordInstall) => { h.remembered.push(install.rootPath); },
        inspect: (install: DiscordInstall) => {
            if (typeof script.inspect === "function") return script.inspect(install);
            return script.inspect ?? { ok: true, value: installState("unpatched") };
        },

        listProcesses: async () => {
            const tables = script.processes ?? [[]];
            const index = Math.min(processCall++, tables.length - 1);
            return tables[index] ?? [];
        },
        requestQuit: script.requestQuit ?? (async () => {}),
        forceQuit: script.forceQuit ?? (async () => {}),

        probePermission: () => {
            const statuses = script.permission ?? ["granted"];
            const index = Math.min(permissionCall++, statuses.length - 1);
            return statuses[index] as AppManagementStatus;
        },
        lastPermissionProbeError: () => script.permissionProbeError ?? null,
        openPermissionSettings: async () => { h.settingsOpened += 1; },
        permissionSettingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles",

        discordLocale: () => (script.discordLocale === undefined ? "tr" : script.discordLocale),
        systemLocale: () => "en-GB",
        hasSublineCode: () => script.hasSublineCode ?? (script.savedCode != null),
        savedSublineCode: () => script.savedCode !== undefined ? script.savedCode : (script.hasSublineCode ? "slp_savedcode" : null),
        savedInstallId: () => script.savedInstallId ?? null,
        clearedCode: () => script.clearedCode ?? null,
        priorSublineUse: () => script.priorUse ?? false,
        ensureInstallId: () => {
            h.installIdWrites += 1;
            return script.ensureInstallId ?? { ok: true, value: script.savedInstallId ?? TEST_INSTALL_ID };
        },
        relay: {
            checkout: async (installId: string) => {
                h.relayCalls.push({ kind: "checkout", installId });
                return script.relayCheckout ?? { kind: "ok", url: SESSION_URL };
            },
            status: async (credential: string, installId: string, options?: { check?: boolean }) => {
                // A real macrotask per answer, like a network call: a poll that
                // never lands must not starve the timers a test waits on.
                await new Promise(resolve => setImmediate(resolve));
                h.relayCalls.push({ kind: "status", credential, installId, ...(options?.check ? { check: true } : {}) });
                const scripted = script.relayStatus ?? ACTIVE;
                if (!Array.isArray(scripted)) return scripted;
                return scripted[Math.min(statusCall++, scripted.length - 1)] as StatusAnswer;
            },
            redeem: async (installId: string, code: string) => {
                h.relayCalls.push({ kind: "redeem", installId, code });
                return script.relayRedeem ?? { kind: "ok", code: "slp_promominted" };
            }
        },
        openCheckout: async (url: string) => { h.opened.push(url); },
        activationPollIntervalMs: 5,
        ...(script.automaticProductId !== undefined ? { automaticProductId: script.automaticProductId } : {}),
        ensureRelayEngine: () => {
            h.engineReasserts += 1;
            return script.ensureRelayEngine ?? { ok: true, value: { changed: false, previous: "relay" } };
        },
        setSublineCode: (code: string) => {
            h.codeWrites.push(code);
            return script.setSublineCode ?? {
                ok: true,
                value: { path: "/settings.json", created: false, codeLength: code.trim().length }
            };
        },
        setLanguage: (code: string) => {
            h.languageWrites.push(code);
            return script.setLanguage ?? {
                ok: true,
                value: { path: "/settings.json", code: code.split("-")[0] ?? code, previous: null, created: true }
            };
        },

        patch: (install, options) => {
            h.patchCalls.push(options);
            h.patchTargets.push(install.rootPath);
            patchCall += 1;
            if (typeof script.patch === "function") return script.patch();
            return script.patch ?? { ok: true, value: patchReport() };
        },
        installHelper: async () => {
            h.helperInstalls += 1;
            const scripted = script.installHelper;
            if (scripted === undefined) {
                return { ok: true, value: { applicable: true, installed: true, label: "com.subline.helper", path: "/Users/x/Library/LaunchAgents/com.subline.helper.plist" } };
            }
            const index = Math.min(helperCall++, scripted.length - 1);
            return scripted[index] as Result<HelperInstallOutcome>;
        },
        ensureHelper: async () => {
            h.helperEnsures += 1;
            return script.ensureHelper ?? {
                ok: true,
                value: { action: "unchanged", reason: null, registered: "/Applications/Subline.app/Contents/MacOS/Subline", expected: "/Applications/Subline.app/Contents/MacOS/Subline" }
            };
        },
        launchDiscord: async (install: DiscordInstall) => {
            h.launched += 1;
            h.launchedTargets.push(install.rootPath);
            t += 500;
            return script.launch ?? { ok: true, value: true };
        },
        verify: async options => {
            h.verifyCalls.push({
                expectedBuildId: options.expectedBuildId,
                patchedAt: options.patchedAt,
                launchedAt: options.launchedAt
            });
            return script.verify ?? verification({ confirmed: true, loaded: true, tier: "approx" });
        },

        permissionPollIntervalMs: 10,
        permissionSlowPollIntervalMs: 30,
        permissionSlowAfterMs: 1_200,
        quitGracePeriodMs: 100,
        verifyTimeoutMs: 100,
        verifyPollIntervalMs: 10
    };

    h.ports = ports;
    h.flow = new InstallFlow(ports);
    h.flow.onChange = next => { h.steps.push(next.step); };
    void patchCall;
    return h;
}

/**
 * Walk to the quit gate: welcome, tiers, detection, language, activation.
 * Discord is only closed once the install is activated (flow.ts beforeQuit).
 */
async function toQuitGate(h: Harness): Promise<FlowState> {
    await toDetection(h);
    await h.flow.send({ type: "set-language", code: "tr" });
    return h.flow.send({ type: "buy-automatic" });
}

/** Walk welcome → tiers → detection. */
async function toDetection(h: Harness): Promise<FlowState> {
    await h.flow.send({ type: "next" });
    return h.flow.send({ type: "next" });
}

/* ------------------------------------------------------------------------ *
 * The happy path
 * ------------------------------------------------------------------------ */


/**
 * Choose a language and move past the optional key step.
 *
 * The key step sits between the language and the patch, so almost every test
 * that used to go straight from `set-language` to patching now has one more
 * state to cross. Routed through here rather than repeated inline, so adding
 * another optional step later is one edit and not forty.
 */
async function setLanguage(
    flow: { send: (a: any) => Promise<any>; settled?: () => Promise<any> },
    code = "tr"
): Promise<any> {
    const next = await flow.send({ type: "set-language", code });
    // Paid only: the activation screen is crossed by buying (the scripted
    // relay confirms the purchase at once).
    const after = next.step === "choose-code" ? await flow.send({ type: "buy-automatic" }) : next;
    // The last screen shows at once and the confirmation lands in the
    // background, so tests read the SETTLED state: what the user finally sees.
    return after.step === "done" && flow.settled ? flow.settled() : after;
}

describe("the happy path", () => {
    it("walks welcome → tiers → language → patch → verify → confirmed", async () => {
        const h = harness();
        // `start()` is async because it checks for an existing install BEFORE
        // showing anything — a Discord already set up must not be made to read
        // two screens of first-run explanation first.
        expect((await h.flow.start()).step).toBe("welcome");
        expect((await h.flow.send({ type: "next" })).step).toBe("tiers");

        const language = await h.flow.send({ type: "next" });
        expect(language.step).toBe("choose-language");

        const done = await setLanguage(h.flow, "tr");
        expect(done.step).toBe("done");
        expect(isConfirmedSuccess(done)).toBe(true);
        expect(h.launched).toBe(1);
    });

    it("explains the two paid plans on the tiers screen, word for word, with no free plan", async () => {
        const h = harness();
        await h.flow.start();
        const tiers = await h.flow.send({ type: "next" });

        expect(tiers.step).toBe("tiers");
        expect(tiers.detail).toBe(
            "≈ is Google Translate, under every message. ✦ is an AI that reads the conversation, so slang and "
            + "replies come out right. **Automatic** gives you ≈ for $4.99, once. **AI** adds ✦ for $1.99 a month."
        );
        expect(tiers.detail).not.toMatch(/free|trial|7 days/i);
    });

    it("patches against the RUNTIME bundle directory, never a path inside the app", async () => {
        const h = harness();
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        expect(h.patchCalls).toEqual([{ modBundleDir: RUNTIME_MOD_DIR, overwriteForeignMod: false }]);
    });

    it("hands verification the build id from the patch it just made", async () => {
        const h = harness();
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        expect(h.verifyCalls).toHaveLength(1);
        expect(h.verifyCalls[0]?.expectedBuildId).toBe(BUILD_ID);
        expect(h.verifyCalls[0]?.launchedAt).toBeGreaterThanOrEqual(h.verifyCalls[0]?.patchedAt ?? 0);
    });

    it("skips the permission screen entirely on Windows", async () => {
        const h = harness({ platform: "win32", permission: ["not-required"] });
        await toDetection(h);
        const done = await setLanguage(h.flow, "en");
        expect(done.step).toBe("done");
        expect(h.settingsOpened).toBe(0);
    });
});

/* ------------------------------------------------------------------------ *
 * §3a — the language step
 * ------------------------------------------------------------------------ */

describe("the language step", () => {
    it("pre-fills from Discord's locale and names it in its own language", async () => {
        const h = harness({ discordLocale: "tr-TR" });
        const state = await toDetection(h);
        expect(state.step).toBe("choose-language");
        expect(state.language).toBe("tr");
        expect(state.languageEndonym).toBe("Türkçe");
        expect(state.detail).toContain("Türkçe");
        expect(state.detail).not.toContain("Turkish");
    });

    it("falls back to the system locale when Discord has none", async () => {
        const h = harness({ discordLocale: null });
        const state = await toDetection(h);
        expect(state.language).toBe("en");
    });

    it("offers every language by endonym, all bare codes", async () => {
        const h = harness();
        const state = await toDetection(h);
        expect(state.languages?.length ?? 0).toBeGreaterThan(50);
        expect(state.languages?.find(option => option.code === "ja")?.endonym).toBe("日本語");
        for (const option of state.languages ?? []) expect(option.code).not.toContain("-");
    });

    it("stores the bare code when the user picks a region-qualified one", async () => {
        const h = harness();
        await toDetection(h);
        await setLanguage(h.flow, "pt-BR");
        expect(h.languageWrites).toEqual(["pt-BR"]);
        // The port normalizes; the flow records what came back, not what went in.
        expect(h.logged.some(entry => entry.event === "language.saved" && entry.fields.lang === "pt")).toBe(true);
    });

    it("stays on the language screen with a named error when the setting cannot be saved", async () => {
        const h = harness({
            setLanguage: { ok: false, error: fail("IO_ERROR", "Vencord's settings file could not be read as JSON") }
        });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(state.step).toBe("choose-language");
        expect(state.error?.code).toBe("IO_ERROR");
        expect(h.patchCalls).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------------ *
 * Failure: Discord not found
 * ------------------------------------------------------------------------ */

describe("Discord not found", () => {
    it("offers a manual path picker rather than dying", async () => {
        const h = harness({ installs: { ok: false, error: fail("DISCORD_NOT_FOUND", "No Discord installation was found.") } });
        const state = await toDetection(h);
        expect(state.step).toBe("discord-not-found");
        expect(state.error?.code).toBe("DISCORD_NOT_FOUND");
        expect(state.actions).toContain("pick-path");
    });

    it("treats an empty list as not-found, not as a silent success", async () => {
        const h = harness({ installs: { ok: true, value: [] } });
        const state = await toDetection(h);
        expect(state.step).toBe("discord-not-found");
        expect(state.error?.code).toBe("DISCORD_NOT_FOUND");
    });

    it("retries detection with the path the user picked", async () => {
        let attempt = 0;
        const h = harness();
        h.ports.locate = (explicit?: readonly string[]) => {
            attempt += 1;
            if (attempt === 1) return { ok: false, error: fail("DISCORD_NOT_FOUND", "not found") };
            expect(explicit).toEqual(["/Volumes/Games/Discord.app"]);
            return { ok: true, value: [INSTALL] };
        };
        await toDetection(h);
        const state = await h.flow.send({ type: "pick-path", path: "/Volumes/Games/Discord.app" });
        expect(state.step).toBe("choose-language");
    });

    it("reports a path that is not a Discord install with its own named error", async () => {
        const h = harness({ installs: { ok: false, error: fail("NOT_A_DISCORD_INSTALL", "/tmp/x is not a Discord installation.") } });
        const state = await toDetection(h);
        expect(state.step).toBe("discord-not-found");
        expect(state.error?.code).toBe("NOT_A_DISCORD_INSTALL");
    });
});

describe("more than one Discord", () => {
    it("asks which one rather than guessing", async () => {
        const h = harness({ installs: { ok: true, value: [INSTALL, PTB_INSTALL] } });
        const state = await toDetection(h);
        expect(state.step).toBe("choose-install");
        expect(state.installs).toHaveLength(2);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("continues with the one that was chosen", async () => {
        const h = harness({ installs: { ok: true, value: [INSTALL, PTB_INSTALL] } });
        await toDetection(h);
        const state = await h.flow.send({ type: "choose-install", rootPath: PTB_INSTALL.rootPath });
        expect(state.step).toBe("choose-language");
    });
});

/* ------------------------------------------------------------------------ *
 * §3b — BetterDiscord is a refusal, with no override
 * ------------------------------------------------------------------------ */

describe("BetterDiscord", () => {
    it("refuses, and offers NO way to proceed", async () => {
        const h = harness({ inspect: { ok: true, value: installState("patched-by-other", "betterdiscord") } });
        const state = await toDetection(h);

        expect(state.step).toBe("betterdiscord-blocked");
        // THE test for §3b. There is no proceed-anyway, at any price.
        expect(state.actions).not.toContain("proceed-over-mod");
        expect(state.actions).not.toContain("next");
        expect(state.actions).toEqual(["recheck", "cancel"]);
    });

    it("explains that patching would appear to work and do nothing", async () => {
        const h = harness({ inspect: { ok: true, value: installState("patched-by-other", "betterdiscord") } });
        const state = await toDetection(h);
        expect(state.detail).toContain("Uninstall BetterDiscord");
        expect(state.detail).toContain("ignored");
    });

    it("cannot be forced past by sending proceed-over-mod anyway", async () => {
        const h = harness({ inspect: { ok: true, value: installState("patched-by-other", "betterdiscord") } });
        await toDetection(h);
        const state = await h.flow.send({ type: "proceed-over-mod" });
        expect(state.step).toBe("betterdiscord-blocked");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("moves on once BetterDiscord has actually been removed", async () => {
        let checks = 0;
        const h = harness({
            inspect: () =>
                ++checks === 1
                    ? { ok: true, value: installState("patched-by-other", "betterdiscord") }
                    : { ok: true, value: installState("unpatched") }
        });
        await toDetection(h);
        const state = await h.flow.send({ type: "recheck" });
        expect(state.step).toBe("choose-language");
    });
});

/* ------------------------------------------------------------------------ *
 * Already ours — reopening must not mean reinstalling
 * ------------------------------------------------------------------------ */

describe("a Discord we already patched", () => {
    it("is recognised before Welcome, not two screens later", async () => {
        // Reported from a real reopen: the user still had to read and dismiss
        // Welcome and the two-tiers explanation before being told there was
        // nothing to do. Detection ran at `detecting`, which is two Continue
        // clicks in — so first-run explanation was shown to someone who was not
        // on their first run.
        const h = harness({ inspect: { ok: true, value: installState("patched-by-us", "subline") } });

        const first = await h.flow.start();

        expect(first.step).toBe("already-installed");
        expect(h.patchCalls).toHaveLength(0);
    });

    // OBSERVED 2026-09-03: a NEW installer run over an existing install landed
    // on "already set up" while Discord kept running the previous plugin
    // build - with the fixes the new installer existed to deliver. "Updates
    // are handled in the background" is false until the release feed ships;
    // today the installer is the only updater there is. A different build id
    // is an update, not a no-op.
    it("updates when the installed build differs from the shipped one", async () => {
        const marker = { pluginBuildId: "0000000000000000" } as unknown as InstallState["marker"];
        const st = { ...installState("patched-by-us", "subline"), marker };
        // A code is already saved, so this update has nothing to ask.
        const h = harness({ inspect: { ok: true, value: st }, hasSublineCode: true });

        // Record every transition, so the skip assertions below are REAL -
        // an assertion over a list nothing populates proves nothing.
        const seen: string[] = [];
        h.flow.onChange = st => seen.push(st.step);

        const first = await h.flow.start();
        // Not "already-installed": the flow proceeds. Discord is closed in
        // this harness, so it heads for the patch pipeline directly - and the
        // language and key steps must NOT appear: their answers are the
        // user's saved settings and asking twice is how an update gets
        // abandoned halfway.
        expect(first.step).not.toBe("already-installed");
        expect(seen).not.toContain("already-installed");
        expect(seen).not.toContain("choose-language");
        expect(seen).not.toContain("choose-code");
        expect(h.patchCalls.length).toBeGreaterThan(0);
        // An update is not gated and asks the relay nothing: the plugin
        // settles activation inside Discord. The saved code is kept in use.
        expect(first.step).toBe("done");
        expect(h.relayCalls).toEqual([]);
        expect(h.engineReasserts).toBeGreaterThan(0);
    });

    // FIELD BUG 2026-10-04 (Windows): Discord's update left our stub in a new
    // folder without our marker. That install is ours, but "already set up"
    // would leave the marker missing; it continues as an update, whose patch
    // rewrites it.
    it("our stub with its marker missing is not 'already set up': it continues to the patch", async () => {
        const st = { ...installState("patched-by-us", "subline"), marker: null, warnings: ["marker-missing" as const] };
        const h = harness({ inspect: { ok: true, value: st }, hasSublineCode: true });
        const first = await h.flow.start();
        expect(first.step).not.toBe("already-installed");
        expect(h.patchCalls.length).toBeGreaterThan(0);
    });

    // I2 (field test 2026-10-08). An update with no saved code used to skip
    // activation and install a Subline that said "Not activated" in Discord,
    // with no screen anywhere in the installer to fix it. Same gate as a
    // fresh install now; the language is still never asked twice.
    it("an update with NO saved code and no known purchase shows Activate Subline, and patches nothing", async () => {
        const marker = { pluginBuildId: "0000000000000000" } as unknown as InstallState["marker"];
        const st = { ...installState("patched-by-us", "subline"), marker };
        const h = harness({ inspect: { ok: true, value: st }, hasSublineCode: false, savedInstallId: null });
        const seen: string[] = [];
        h.flow.onChange = st => seen.push(st.step);

        const after = await h.flow.start();
        expect(after.step).toBe("choose-code");
        expect(after.actions).toEqual(["buy-automatic", "set-code"]);
        expect(seen).not.toContain("choose-language");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("an update with NO saved code continues without the screen when the relay confirms this install", async () => {
        const marker = { pluginBuildId: "0000000000000000" } as unknown as InstallState["marker"];
        const st = { ...installState("patched-by-us", "subline"), marker };
        const h = harness({
            inspect: { ok: true, value: st },
            hasSublineCode: false,
            savedInstallId: "fedcba9876543210fedcba9876543210",
            relayStatus: { kind: "ok", automatic: true, ai: false, code: "slp_early" }
        });
        const seen: string[] = [];
        h.flow.onChange = st => seen.push(st.step);

        const after = await h.flow.start();
        expect(h.relayCalls[0]?.kind).toBe("status");
        expect(seen).not.toContain("choose-code");
        expect(seen).not.toContain("choose-language");
        expect(h.codeWrites).toEqual(["slp_early"]);
        expect(h.patchCalls).toHaveLength(1);
        expect(after.step).toBe("done");
    });

    it("an update with NO saved code and the relay unreachable waits on Try again, and patches nothing", async () => {
        const marker = { pluginBuildId: "0000000000000000" } as unknown as InstallState["marker"];
        const st = { ...installState("patched-by-us", "subline"), marker };
        const h = harness({
            inspect: { ok: true, value: st },
            hasSublineCode: false,
            savedInstallId: "fedcba9876543210fedcba9876543210",
            relayStatus: { kind: "unreachable", cause: "fetch failed" }
        });
        const after = await h.flow.start();
        expect(after.step).toBe("activation-check-failed");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("our stub with its marker missing and NO saved code also shows Activate Subline", async () => {
        const st = { ...installState("patched-by-us", "subline"), marker: null, warnings: ["marker-missing" as const] };
        const h = harness({ inspect: { ok: true, value: st }, hasSublineCode: false, savedInstallId: null });
        const after = await h.flow.start();
        expect(after.step).toBe("choose-code");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("an update with a saved code and the relay offline still updates: the relay is not asked", async () => {
        const marker = { pluginBuildId: "0000000000000000" } as unknown as InstallState["marker"];
        const st = { ...installState("patched-by-us", "subline"), marker };
        const h = harness({ inspect: { ok: true, value: st }, hasSublineCode: true, relayStatus: { kind: "unreachable", cause: "offline" } });
        const seen: string[] = [];
        h.flow.onChange = st => seen.push(st.step);
        const state = await h.flow.start();
        expect(seen).not.toContain("choose-code");
        expect(seen).not.toContain("activation-check-failed");
        expect(h.relayCalls).toEqual([]);
        expect(h.patchCalls).toHaveLength(1);
        expect(state.step).toBe("done");
    });

    it("an update with a saved code is not gated either: the plugin checks the code inside Discord", async () => {
        const marker = { pluginBuildId: "0000000000000000" } as unknown as InstallState["marker"];
        const st = { ...installState("patched-by-us", "subline"), marker };
        const h = harness({ inspect: { ok: true, value: st }, hasSublineCode: true, relayStatus: { kind: "invalid" } });
        const seen: string[] = [];
        h.flow.onChange = st => seen.push(st.step);
        const state = await h.flow.start();
        expect(seen).not.toContain("choose-code");
        expect(h.relayCalls).toEqual([]);
        expect(h.installIdWrites).toBe(0);
        expect(h.patchCalls).toHaveLength(1);
        expect(state.step).toBe("done");
    });

    it("still says already-set-up when the installed build IS the shipped build", async () => {
        const marker = { pluginBuildId: BUILD_ID } as unknown as InstallState["marker"];
        const st = { ...installState("patched-by-us", "subline"), marker };
        const h = harness({ inspect: { ok: true, value: st } });

        const first = await h.flow.start();
        expect(first.step).toBe("already-installed");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("still shows Welcome when there is nothing installed yet", async () => {
        // The narrowness matters: only an install that is already OURS skips
        // the explanation. Everyone else is genuinely at the start.
        const h = harness({ inspect: { ok: true, value: installState("unpatched") } });
        expect((await h.flow.start()).step).toBe("welcome");
    });

    it("still shows Welcome when another mod is installed", async () => {
        const h = harness({ inspect: { ok: true, value: installState("patched-by-other", "vencord") } });
        expect((await h.flow.start()).step).toBe("welcome");
    });

    it("says so and stops, instead of walking the whole install again", async () => {
        // Found by running the real app. macOS's App Management prompt offers
        // "Quit & Reopen" — and offers it whether or not the install already
        // succeeded. Reopening therefore sent the user back through quitting
        // Discord, the language picker and the permission step to redo work
        // that was already done. `patched-by-us` had no branch at all: it fell
        // through to checkRunning() with every other outcome.
        const h = harness({ inspect: { ok: true, value: installState("patched-by-us", "subline") } });
        const state = await toDetection(h);

        expect(state.step).toBe("already-installed");
        expect(h.patchCalls).toHaveLength(0);
        expect(state.actions).toEqual(["finish"]);
    });

    it("checks the helper registration on the way to already-set-up, and logs it", async () => {
        const h = harness({ inspect: { ok: true, value: installState("patched-by-us", "subline") } });
        const state = await h.flow.start();

        expect(state.step).toBe("already-installed");
        expect(h.helperEnsures).toBe(1);
        expect(state.detail).toContain("Updates are handled in the background.");
        expect(h.logged.find(line => line.event === "helper.ensure")?.fields).toMatchObject({ action: "unchanged" });
    });

    it("logs a repair, with where the helper pointed and where it points now", async () => {
        const h = harness({
            inspect: { ok: true, value: installState("patched-by-us", "subline") },
            ensureHelper: {
                ok: true,
                value: {
                    action: "repaired",
                    reason: "points-elsewhere",
                    registered: "/Users/x/Downloads/Subline.app/Contents/MacOS/Subline",
                    expected: "/Applications/Subline.app/Contents/MacOS/Subline"
                }
            }
        });
        await h.flow.start();
        expect(h.logged.find(line => line.event === "helper.ensure")?.fields).toEqual({
            action: "repaired",
            reason: "points-elsewhere",
            registered: "/Users/x/Downloads/Subline.app/Contents/MacOS/Subline",
            expected: "/Applications/Subline.app/Contents/MacOS/Subline"
        });
    });

    it("says so, and still shows the screen, when the helper cannot be repaired", async () => {
        const h = harness({
            inspect: { ok: true, value: installState("patched-by-us", "subline") },
            ensureHelper: { ok: false, error: fail("HELPER_REGISTRATION_FAILED", "launchctl refused.") }
        });
        const state = await h.flow.start();
        expect(state.step).toBe("already-installed");
        expect(state.detail).toContain("Background updates could not be turned on.");
        expect(state.detail).not.toContain("—");
        expect(h.logged.some(line => line.event === "helper.ensure-failed" && line.level === "error")).toBe(true);
    });

    it("never re-patches a working install", async () => {
        // Re-applying a good patch is a write to somebody else's application in
        // exchange for nothing, and the helper already repairs the one case
        // that needs it. So there is no action here that patches.
        const h = harness({ inspect: { ok: true, value: installState("patched-by-us", "subline") } });
        await toDetection(h);

        const after = await h.flow.send({ type: "finish" });
        expect(h.patchCalls).toHaveLength(0);
        expect(after.step).toBe("already-installed");
    });
});

/* ------------------------------------------------------------------------ *
 * Vencord / Equicord — detect, explain, let them choose
 * ------------------------------------------------------------------------ */

describe("an existing Vencord install", () => {
    it("explains what would happen and offers a choice", async () => {
        const h = harness({ inspect: { ok: true, value: installState("patched-by-other", "vencord") } });
        const state = await toDetection(h);
        expect(state.step).toBe("mod-conflict");
        expect(state.modName).toBe("Vencord");
        expect(state.detail).toContain("Vencord");
        expect(state.detail).toContain("stop loading");
        expect(state.actions).toEqual(["proceed-over-mod", "cancel"]);
    });

    it("does not patch unless the user says so", async () => {
        const h = harness({ inspect: { ok: true, value: installState("patched-by-other", "vencord") } });
        await toDetection(h);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("passes overwriteForeignMod only after the user agreed", async () => {
        const h = harness({ inspect: { ok: true, value: installState("patched-by-other", "equicord") } });
        await toDetection(h);
        await h.flow.send({ type: "proceed-over-mod" });
        await setLanguage(h.flow, "tr");
        expect(h.patchCalls[0]?.overwriteForeignMod).toBe(true);
    });

    it("cancelling changes nothing", async () => {
        const h = harness({ inspect: { ok: true, value: installState("patched-by-other", "vencord") } });
        await toDetection(h);
        const state = await h.flow.send({ type: "cancel" });
        expect(state.step).toBe("cancelled");
        expect(state.detail).toContain("Discord is exactly as it was");
        expect(h.patchCalls).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------------ *
 * Broken install / our own broken bundle
 * ------------------------------------------------------------------------ */

describe("a broken Discord install", () => {
    it("reports it with its own state and does not patch on top", async () => {
        const h = harness({ inspect: { ok: true, value: installState("broken") } });
        const state = await toDetection(h);
        expect(state.step).toBe("broken-install");
        expect(state.error?.code).toBe("BROKEN_INSTALL");
        expect(state.detail).toContain("Reinstall Discord");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("reports an unreadable install path as broken rather than throwing", async () => {
        const h = harness({ inspect: { ok: false, error: fail("NOT_A_DISCORD_INSTALL", "not a Discord installation") } });
        const state = await toDetection(h);
        expect(state.step).toBe("broken-install");
    });
});

describe("our own mod bundle being broken", () => {
    it("is caught before the user is asked for anything", async () => {
        const h = harness({ bundle: { ok: false, error: fail("MOD_BUNDLE_INVALID", "The Subline mod bundle is not usable: renderer.js missing.") } });
        const state = await toDetection(h);
        expect(state.step).toBe("mod-bundle-invalid");
        expect(state.detail).toContain("Re-download Subline");
        expect(h.settingsOpened).toBe(0);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("is also caught if the copy into place fails later", async () => {
        const h = harness({
            installBundle: { ok: false, error: fail("MOD_BUNDLE_INVALID", "The Subline mod did not survive being copied.") }
        });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(state.step).toBe("patch-failed");
        expect(state.error?.code).toBe("MOD_BUNDLE_INVALID");
        expect(h.patchCalls).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------------ *
 * §3 step 5 — Discord running
 * ------------------------------------------------------------------------ */

const DISCORD_PROCESS = { pid: 100, command: "/Applications/Discord.app/Contents/MacOS/Discord" };

describe("Discord running", () => {
    it("offers to quit it rather than patching underneath it", async () => {
        const h = harness({ processes: [[DISCORD_PROCESS]] });
        const state = await toQuitGate(h);
        expect(state.step).toBe("discord-running");
        expect(state.actions).toContain("quit-discord");
        expect(state.processes).toHaveLength(1);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("continues once Discord has quit", async () => {
        const h = harness({ processes: [[DISCORD_PROCESS], [DISCORD_PROCESS], []] });
        await toQuitGate(h);
        const state = await h.flow.send({ type: "quit-discord" });
        expect(state.step).not.toBe("discord-running");
        expect(h.patchCalls).toHaveLength(1);
    });

    it("forces the close in the SAME press when asking does not work", async () => {
        // CHANGED: this used to assert a second button and `forced === 0`. The
        // button says "Quit Discord for me", so closing Discord is what the user
        // already agreed to — a second screen to grant permission they just
        // gave is friction, not consent. On Windows the polite request nearly
        // always fails (closing the window only hides Discord in the tray), so
        // that second screen was the common path, not the rare one.
        let forced = 0;
        const h = harness({ forceQuit: async () => { forced += 1; } });
        let call = 0;
        // Present through the polite attempt, gone once it has been forced.
        h.ports.listProcesses = async () => (++call <= 5 ? [DISCORD_PROCESS] : []);
        await toQuitGate(h);

        const state = await h.flow.send({ type: "quit-discord" });
        expect(forced).toBe(1);
        expect(state.step).not.toBe("discord-running");
        expect(h.patchCalls).toHaveLength(1);
    });

    it("asks before forcing — a Discord that quits politely is never killed", async () => {
        // The escalation is unchanged in substance: force is a fallback, not
        // the first move.
        let forced = 0;
        const h = harness({
            processes: [[DISCORD_PROCESS], [DISCORD_PROCESS], []],
            forceQuit: async () => { forced += 1; }
        });
        await toQuitGate(h);

        const state = await h.flow.send({ type: "quit-discord" });
        expect(state.step).not.toBe("discord-running");
        expect(h.patchCalls).toHaveLength(1);
        expect(forced).toBe(0);
    });

    it("stops after the forced close also fails, rather than looping", async () => {
        let forced = 0;
        const h = harness({ processes: [[DISCORD_PROCESS]], forceQuit: async () => { forced += 1; } });
        await toQuitGate(h);

        const state = await h.flow.send({ type: "quit-discord" });
        expect(state.step).toBe("quit-blocked");
        expect(state.quit?.forced).toBe(true);
        // Tried once. Something other than a cooperative Discord is holding
        // those files, and a button proven not to work is a dead end wearing a
        // way out.
        expect(forced).toBe(1);
        expect(state.actions).toEqual(["recheck", "cancel"]);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("recovers when the user quits Discord themselves", async () => {
        // Present until the blocked screen is reached, then gone — the user
        // quit it by hand while looking at it. A flag rather than a call count,
        // because the number of polls is an implementation detail and pinning
        // it made this test fail for a change that did not affect it.
        let stillRunning = true;
        const h = harness();
        h.ports.listProcesses = async () => (stillRunning ? [DISCORD_PROCESS] : []);
        await toQuitGate(h);

        const blocked = await h.flow.send({ type: "quit-discord" });
        expect(blocked.step).toBe("quit-blocked");

        stillRunning = false;
        const state = await h.flow.send({ type: "recheck" });
        expect(state.step).not.toBe("discord-running");
        expect(h.patchCalls).toHaveLength(1);
    });

    it("escalates when the quit request itself fails, rather than stopping there", async () => {
        // CHANGED: this used to assert the run ended on `quit-failed`. A refused
        // request is exactly the case where the forced close is worth trying —
        // stopping at the refusal is what left Windows users at a dead end.
        let forced = 0;
        const h = harness({
            processes: [[DISCORD_PROCESS]],
            requestQuit: async () => { throw new Error("osascript refused"); },
            forceQuit: async () => { forced += 1; }
        });
        await toQuitGate(h);
        const state = await h.flow.send({ type: "quit-discord" });

        expect(forced).toBe(1);
        expect(state.step).toBe("quit-blocked");
        expect(state.quit?.forced).toBe(true);
    });

    it("ignores a Discord helper process — it is not the app", async () => {
        const helper = {
            pid: 101,
            command: "/Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer)"
        };
        const h = harness({ processes: [[helper]] });
        const state = await toQuitGate(h);
        expect(state.step).not.toBe("discord-running");
        expect(h.patchCalls).toHaveLength(1);
    });

    it("catches a Discord that came back while the user was choosing a language", async () => {
        // Clear at step 5, running again by the time we write. Discord is in
        // Startup on most Windows machines and relaunches itself after an
        // update, and picking a language is not instant.
        const h = harness({ processes: [[], [DISCORD_PROCESS]] });
        const language = await toDetection(h);
        expect(language.step).toBe("choose-language");

        const state = await setLanguage(h.flow, "tr");
        // Back to the screen that explains what to do — not a write failure
        // that surfaces as an unexplained IO error on Windows.
        expect(state.step).toBe("discord-running");
        expect(h.patchCalls).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------------ *
 * An update never asks the user to close Discord
 * ------------------------------------------------------------------------ */

const WINDOWS_DISCORD_PROCESS = {
    pid: 200,
    command: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.9044\\Discord.exe"
};

/** An install of ours carrying an older build id, which is what makes a run an update. */
function updatedInstallState(): InstallState {
    const marker = { pluginBuildId: "0000000000000000" } as unknown as InstallState["marker"];
    return { ...installState("patched-by-us", "subline"), marker };
}

describe("an update while Discord is running", () => {
    /**
     * The product rule, from the maker: an update must never ask the user to
     * quit Discord and must never quit it for them. "We do not control when
     * they want to quit." Someone updating already has a working Subline, and
     * interrupting their conversation to deliver an improvement they did not
     * ask for is the installer putting its schedule ahead of theirs.
     */
    it("macOS: applies it under the running Discord, with no quit screen and no launch", async () => {
        let quitRequests = 0;
        let forced = 0;
        const h = harness({
            platform: "darwin",
            inspect: { ok: true, value: updatedInstallState() },
            hasSublineCode: true,
            processes: [[DISCORD_PROCESS]],
            requestQuit: async () => { quitRequests += 1; },
            forceQuit: async () => { forced += 1; }
        });
        const seen: FlowStep[] = [];
        h.flow.onChange = next => seen.push(next.step);

        const done = await h.flow.start();

        // The screen that asks is never reached, so the buttons that close
        // Discord are never even on offer.
        expect(seen).not.toContain("discord-running");
        expect(seen).not.toContain("quit-blocked");
        expect(quitRequests).toBe(0);
        expect(forced).toBe(0);

        // macOS lets the archive be renamed underneath a live Discord, so the
        // new build really is installed now.
        expect(h.patchCalls).toHaveLength(1);
        expect(h.helperInstalls).toBe(1);

        // Nothing to launch, and verifying would read the OLD build's beacon
        // and report a working install as somebody else's copy.
        expect(h.launched).toBe(0);
        expect(h.verifyCalls).toEqual([]);

        expect(done.step).toBe("done");
        expect(done.detail).toContain("next time you open Discord");
        expect(done.detail).toContain("No need to close Discord now");
        expect(done.actions).toEqual(["finish"]);
    });

    /**
     * Windows will not rename a file a running process holds open, so the
     * patch genuinely cannot happen now. It does not have to: `helper.ts`
     * compares the installed bundle against the marker Discord carries, gets
     * `build-changed`, and re-patches once `requireDiscordClosed` is satisfied.
     */
    it("Windows: stages the bundle and leaves the patch to the helper", async () => {
        let quitRequests = 0;
        let forced = 0;
        const h = harness({
            platform: "win32",
            permission: ["not-required"],
            inspect: { ok: true, value: updatedInstallState() },
            hasSublineCode: true,
            processes: [[WINDOWS_DISCORD_PROCESS]],
            requestQuit: async () => { quitRequests += 1; },
            forceQuit: async () => { forced += 1; }
        });
        const seen: FlowStep[] = [];
        h.flow.onChange = next => seen.push(next.step);

        const done = await h.flow.start();

        expect(seen).not.toContain("discord-running");
        expect(quitRequests).toBe(0);
        expect(forced).toBe(0);

        // The bundle IS in place. That is what the helper acts on.
        expect(h.bundleInstalls).toBe(1);
        expect(h.patchCalls).toHaveLength(0);
        expect(h.helperInstalls).toBe(1);

        expect(h.launched).toBe(0);
        expect(h.verifyCalls).toEqual([]);

        expect(done.step).toBe("done");
        expect(done.detail).toContain("finishes on its own after you close Discord");
        expect(done.detail).toContain("No need to close Discord now");
        expect(done.actions).toEqual(["finish"]);
    });

    it("still launches and verifies when Discord is closed", async () => {
        // The skip belongs to a running Discord alone. With nothing open there
        // is something to launch and a beacon the new build will write, so the
        // update finishes exactly as it always did.
        const h = harness({
            inspect: { ok: true, value: updatedInstallState() },
            hasSublineCode: true,
            processes: [[]]
        });

        const done = await h.flow.start();
        const settled = await h.flow.settled();

        expect(done.step).toBe("done");
        expect(h.patchCalls).toHaveLength(1);
        expect(h.launched).toBe(1);
        expect(h.verifyCalls).toHaveLength(1);
        expect(settled.detail).not.toContain("No need to close Discord now");
    });

    it("a FRESH install with Discord running still asks, because it has nothing to fall back on", async () => {
        const h = harness({ inspect: { ok: true, value: installState("unpatched") }, processes: [[DISCORD_PROCESS]] });
        const state = await toQuitGate(h);
        expect(state.step).toBe("discord-running");
        expect(state.actions).toContain("quit-discord");
        expect(h.patchCalls).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------------ *
 * §4 — App Management
 * ------------------------------------------------------------------------ */

describe("the order: find Discord, language, activate, quit Discord, patch", () => {
    it("asks for the language and activation BEFORE closing Discord, and closes it only once activated", async () => {
        const h = harness({ processes: [[DISCORD_PROCESS]] });
        const language = await toDetection(h);
        expect(language.step).toBe("choose-language");
        const code = await h.flow.send({ type: "set-language", code: "tr" });
        expect(code.step).toBe("choose-code");
        // Discord is still open and nothing has been asked of it.
        expect(h.steps).not.toContain("discord-running");
        const running = await h.flow.send({ type: "buy-automatic" });
        expect(running.step).toBe("discord-running");
        const order = h.steps.filter(st => ["choose-language", "choose-code", "activation-waiting", "discord-running", "patching"].includes(st));
        expect(order.indexOf("choose-language")).toBeLessThan(order.indexOf("choose-code"));
        expect(order.indexOf("choose-code")).toBeLessThan(order.indexOf("discord-running"));
        expect(h.patchCalls).toHaveLength(0);
    });

    it("never asks Discord to quit while the user is on the paid screen", async () => {
        let quitRequests = 0;
        const h = harness({ processes: [[DISCORD_PROCESS]], requestQuit: async () => { quitRequests += 1; } });
        await toDetection(h);
        await h.flow.send({ type: "set-language", code: "tr" });
        expect(h.flow.state.actions).not.toContain("quit-discord");
        expect(quitRequests).toBe(0);
    });

    it("writes the reading language only once the install is activated", async () => {
        const h = harness({ relayStatus: { kind: "ok", automatic: false, ai: false, code: null } });
        await toDetection(h);
        await h.flow.send({ type: "set-language", code: "tr" });
        // Stopped at the paid screen: an abandoned run leaves no language behind,
        // so it can never look like earlier Subline use next time.
        expect(h.languageWrites).toEqual([]);
        const redeemed = await h.flow.send({ type: "set-code", code: "MYSRV" });
        expect(h.languageWrites).toEqual(["tr"]);
        expect(redeemed.step).toBe("done");
    });

    it("a language that cannot be saved after activation goes back to the language screen, unpatched", async () => {
        const h = harness({ setLanguage: { ok: false, error: fail("IO_ERROR", "settings are read-only") } });
        await toDetection(h);
        await h.flow.send({ type: "set-language", code: "tr" });
        const state = await h.flow.send({ type: "buy-automatic" });
        expect(state.step).toBe("choose-language");
        expect(state.error?.code).toBe("IO_ERROR");
        expect(h.patchCalls).toHaveLength(0);
    });
});

describe("a machine that used Subline before (treated as an update)", () => {
    // I2: no code saved means the same gate as a fresh install, without the
    // language step (its answer is saved) and without a new install id.
    it("with no code and no known purchase, shows Activate Subline and patches nothing", async () => {
        const h = harness({ priorUse: true, relayStatus: { kind: "ok", automatic: false, ai: false, code: null } });
        const state = await toDetection(h);
        expect(state.step).toBe("choose-code");
        expect(h.steps).not.toContain("choose-language");
        expect(h.installIdWrites).toBe(0);
        expect(h.languageWrites).toEqual([]);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("with no code but an install id the relay confirms, is patched without the screen or the language step", async () => {
        const h = harness({
            priorUse: true,
            savedInstallId: "fedcba9876543210fedcba9876543210",
            relayStatus: { kind: "ok", automatic: true, ai: false, code: null }
        });
        const state = await toDetection(h);
        const settled = state.step === "done" ? await h.flow.settled() : state;
        expect(h.steps).not.toContain("choose-language");
        expect(h.steps).not.toContain("choose-code");
        expect(h.installIdWrites).toBe(0);
        expect(h.patchCalls).toHaveLength(1);
        expect(settled.step).toBe("done");
    });

    it("keeps a saved code in use (the relay engine is re-selected), never rewritten", async () => {
        const h = harness({ priorUse: true, hasSublineCode: true });
        await toDetection(h);
        expect(h.engineReasserts).toBeGreaterThan(0);
        expect(h.codeWrites).toEqual([]);
        expect(h.relayCalls).toEqual([]);
    });

    it("still asks Discord to quit on a fresh patch (it is not a running-Discord update)", async () => {
        const h = harness({ priorUse: true, hasSublineCode: true, processes: [[DISCORD_PROCESS]] });
        const state = await toDetection(h);
        expect(state.step).toBe("discord-running");
        expect(h.steps).not.toContain("choose-code");
    });

    // I3: on Windows a "closed" Discord hides behind the ^ near the clock.
    it("Windows: the close-Discord screen says where Discord is", async () => {
        const h = harness({ priorUse: true, hasSublineCode: true, platform: "win32", processes: [[WINDOWS_DISCORD_PROCESS]] });
        const state = await toDetection(h);
        expect(state.step).toBe("discord-running");
        expect(state.detail).toContain("Discord is still open in the background, behind the ^ near the clock.");
        expect(state.actions[0]).toBe("quit-discord");
    });

    it("Mac: the close-Discord screen keeps Mac wording", async () => {
        const h = harness({ priorUse: true, hasSublineCode: true, processes: [[DISCORD_PROCESS]] });
        const state = await toDetection(h);
        expect(state.detail).not.toMatch(/\^|clock|tray/);
    });
});

describe("the activation screen (paid only)", () => {
    async function toCodeStep(h: Harness) {
        await toDetection(h);
        return h.flow.send({ type: "set-language", code: "tr" });
    }

    it("is offered after the language, before anything is patched, with no skip and no cancel", async () => {
        const h = harness();
        const state = await toCodeStep(h);
        expect(state.step).toBe("choose-code");
        expect(state.actions).toEqual(["buy-automatic", "set-code"]);
        expect(state.detail).toBe(CODE_SCREEN_COPY.detail);
        expect(state.detail).not.toMatch(/free|trial/i);
        expect(IS_PRIMARY["buy-automatic"]).toBe(true);
        expect(IS_PRIMARY["set-code"]).toBe(false);
        expect(h.patchCalls).toHaveLength(0);
        expect(h.relayCalls).toEqual([]);
    });

    it("never patches while the purchase has not landed, and stops asking on Back", async () => {
        const h = harness({ relayStatus: { kind: "ok", automatic: false, ai: false, code: null } });
        await toCodeStep(h);
        const pending = h.flow.send({ type: "buy-automatic" });
        // Let the poll run a few times.
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await new Promise(r => setTimeout(r, 5));
        expect(h.flow.state.step).toBe("activation-waiting");
        // Try again reopens the checkout; Back returns to the choice (I7).
        expect(h.flow.state.actions).toEqual(["retry", "back"]);
        expect(h.patchCalls).toHaveLength(0);
        const back = await h.flow.send({ type: "back" });
        expect(back.step).toBe("choose-code");
        const ended = await pending;
        expect(ended.step).toBe("choose-code");
        const asked = h.relayCalls.length;
        await new Promise(r => setTimeout(r, 5));
        expect(h.relayCalls.length).toBe(asked);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("Buy Automatic: a relay checkout for this install, opened, then polled until it lands; the code is saved", async () => {
        const h = harness({
            relayStatus: [
                { kind: "ok", automatic: false, ai: false, code: null },
                { kind: "unreachable", cause: "HTTP 503" },
                { kind: "ok", automatic: true, ai: false, code: "LICENSE-KEY-1" }
            ]
        });
        await toCodeStep(h);
        const done = await h.flow.send({ type: "buy-automatic" });
        expect(h.relayCalls[0]).toEqual({ kind: "checkout", installId: TEST_INSTALL_ID });
        expect(h.opened).toEqual([SESSION_URL]);
        const polls = h.relayCalls.filter(c => c.kind === "status");
        expect(polls).toHaveLength(3);
        for (const p of polls) {
            expect(p.credential).toBe(`free_${TEST_INSTALL_ID}`);
            expect(p.installId).toBe(TEST_INSTALL_ID);
        }
        expect(h.steps).toContain("activation-waiting");
        expect(h.codeWrites).toEqual(["LICENSE-KEY-1"]);
        expect(h.patchCalls.length).toBeGreaterThan(0);
        expect((await h.flow.settled()).step).toBe("done");
        // Automatic without AI: the last screen does not promise ✦.
        expect(done.detail).not.toContain("✦");
    });

    it("falls back to the static checkout link, tied to this install, only when the relay cannot be reached", async () => {
        const h = harness({ relayCheckout: { kind: "network", cause: "fetch failed" }, automaticProductId: "pdt_Real123" });
        await toCodeStep(h);
        await h.flow.send({ type: "buy-automatic" });
        expect(h.opened).toHaveLength(1);
        const url = new URL(h.opened[0]!);
        expect(url.origin + url.pathname).toBe("https://checkout.dodopayments.com/buy/pdt_Real123");
        expect(url.searchParams.get("metadata_install")).toMatch(/^[0-9a-f]{16}$/);
        expect(url.searchParams.get("redirect_url")).toBe("https://subline.page/?from=installer");
    });

    it("never opens the static link while the product id is the placeholder: says the relay is unreachable", async () => {
        const h = harness({ relayCheckout: { kind: "network", cause: "fetch failed" }, automaticProductId: "pdt_AUTOMATIC_" + "PENDING" });
        await toCodeStep(h);
        const state = await h.flow.send({ type: "buy-automatic" });
        expect(h.opened).toEqual([]);
        expect(state.step).toBe("choose-code");
        expect(state.detail).toBe(CODE_SCREEN_COPY.errUnreachable);
    });

    it("checkout unavailable (503): says buying is not available, opens nothing, never the static link", async () => {
        const h = harness({ relayCheckout: { kind: "unavailable", cause: "HTTP 503 checkout unavailable" }, automaticProductId: "pdt_Real123" });
        await toCodeStep(h);
        const state = await h.flow.send({ type: "buy-automatic" });
        expect(h.opened).toEqual([]);
        expect(state.step).toBe("choose-code");
        expect(state.detail).toBe("Buying isn't available yet. Use a code, or try again later.");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("already owned (409): asks the relay again and carries on when it confirms Automatic", async () => {
        const h = harness({ relayCheckout: { kind: "already_owned" }, relayStatus: { kind: "ok", automatic: true, ai: false, code: "slp_owned" } });
        await toCodeStep(h);
        const state = await h.flow.send({ type: "buy-automatic" });
        expect(h.opened).toEqual([]);
        expect(h.relayCalls.map(c => c.kind)).toEqual(["checkout", "status"]);
        expect(h.codeWrites).toEqual(["slp_owned"]);
        expect(state.step).toBe("done");
    });

    it("a payment still being confirmed (409 purchase_pending): opens nothing and waits for it", async () => {
        const script: { relayStatus: any } = { relayStatus: { kind: "ok", automatic: false, ai: false, code: null } };
        const h = harness({ relayCheckout: { kind: "purchase_pending" }, automaticProductId: "pdt_Real123", ...script });
        h.ports.activationPollIntervalMs = 1;
        await toCodeStep(h);
        const pending = h.flow.send({ type: "buy-automatic" });
        for (let i = 0; i < 50 && h.flow.state.step !== "activation-waiting"; i++) await new Promise(r => setTimeout(r, 1));
        expect(h.flow.state.step).toBe("activation-waiting");
        expect(h.flow.state.detail).toBe("Your payment is still being confirmed. It switches on by itself.");
        expect(h.opened).toEqual([]);
        await h.flow.send({ type: "back" });
        await pending;
    });

    it("a checkout URL that is not Dodo's is never opened", async () => {
        const h = harness({ relayCheckout: { kind: "ok", url: "https://evil.example/pay" }, automaticProductId: "pdt_Real123" });
        await toCodeStep(h);
        const state = await h.flow.send({ type: "buy-automatic" });
        expect(h.opened).toEqual([]);
        expect(state.step).toBe("choose-code");
    });

    it("after 10 minutes on the finish-paying screen, says a finished payment still lands later", async () => {
        const h = harness({ relayStatus: { kind: "ok", automatic: false, ai: false, code: null } });
        h.ports.activationPollIntervalMs = 60_000;
        await toCodeStep(h);
        const pending = h.flow.send({ type: "buy-automatic" });
        for (let i = 0; i < 200 && !String(h.flow.state.detail).includes("Paid already"); i++) {
            await new Promise(r => setTimeout(r, 1));
        }
        expect(h.flow.state.step).toBe("activation-waiting");
        expect(h.flow.state.detail).toBe("Subline carries on by itself when it's done.\n\nUsing a VPN? Turn it off only while you pay. Discord can stay on.\n\nPaid already? It can take a few minutes. Close this and reopen Subline later.");
        await h.flow.send({ type: "back" });
        await pending;
    });

    it("the finish-paying hint appears only once 10 minutes have passed", async () => {
        const h = harness({ relayStatus: { kind: "ok", automatic: false, ai: false, code: null } });
        h.ports.activationPollIntervalMs = 30_000;
        await toCodeStep(h);
        const startedAt = h.ports.now();
        const pending = h.flow.send({ type: "buy-automatic" });
        let hintAt: number | null = null;
        const details: string[] = [];
        h.flow.onChange = st => {
            details.push(st.detail);
            if (hintAt === null && st.detail.includes("Paid already")) hintAt = h.ports.now();
        };
        for (let i = 0; i < 500 && hintAt === null; i++) await new Promise(r => setTimeout(r, 1));
        expect(hintAt).not.toBeNull();
        expect(hintAt! - startedAt).toBeGreaterThanOrEqual(10 * 60_000);
        expect(hintAt! - startedAt).toBeLessThan(10 * 60_000 + 30_000 + 1);
        await h.flow.send({ type: "back" });
        await pending;
    });

    it("a promo code is redeemed for this install and the minted code is saved", async () => {
        const h = harness();
        await toCodeStep(h);
        const state = await h.flow.send({ type: "set-code", code: "  myserver1 " });
        expect(h.relayCalls).toEqual([{ kind: "redeem", installId: TEST_INSTALL_ID, code: "MYSERVER1" }]);
        expect(h.codeWrites).toEqual(["slp_promominted"]);
        expect(state.step).toBe("done");
    });

    const redeemErrors: Array<[RedeemAnswer, string]> = [
        [{ kind: "not_found" }, CODE_SCREEN_COPY.errNotFound],
        [{ kind: "claimed" }, CODE_SCREEN_COPY.errClaimed],
        [{ kind: "rate_limited" }, CODE_SCREEN_COPY.errRateLimited],
        [{ kind: "net_limited" }, CODE_SCREEN_COPY.errNetLimited],
        [{ kind: "unreachable", cause: "fetch failed" }, CODE_SCREEN_COPY.errUnreachable]
    ];
    for (const [answer, message] of redeemErrors) {
        it(`a promo code answered "${answer.kind}" stays on the screen with its message, unpatched`, async () => {
            const h = harness({ relayRedeem: answer });
            await toCodeStep(h);
            const state = await h.flow.send({ type: "set-code", code: "MYSRV" });
            expect(state.step).toBe("choose-code");
            expect(state.error?.message).toBe(message);
            // Read on the screen, not hidden in the diagnostics.
            expect(state.detail).toBe(message);
            expect(h.codeWrites).toEqual([]);
            expect(h.patchCalls).toHaveLength(0);
        });
    }

    it("a brief outage on redeem: the retry message, then the same code works on the next try", async () => {
        const script: { relayRedeem?: RedeemAnswer } = { relayRedeem: { kind: "unreachable", cause: "fetch failed" } };
        const h = harness(script);
        await toCodeStep(h);
        const first = await h.flow.send({ type: "set-code", code: "MYSERVER" });
        expect(first.step).toBe("choose-code");
        expect(first.detail).toBe("Can't reach Subline right now. Try again in a minute.");
        expect(h.patchCalls).toHaveLength(0);
        delete script.relayRedeem;
        const second = await h.flow.send({ type: "set-code", code: "MYSERVER" });
        expect(h.codeWrites).toEqual(["slp_promominted"]);
        expect(second.step).toBe("done");
    });

    it("the exact copy for redeem errors is the owner's", () => {
        expect(CODE_SCREEN_COPY.errClaimed).toBe("This code has been fully claimed.");
        expect(CODE_SCREEN_COPY.errNotFound).toBe("That code doesn't exist.");
        expect(CODE_SCREEN_COPY.errAlready).toBe("Already yours.");
        expect(CODE_SCREEN_COPY.errUnreachable).toBe("Can't reach Subline right now. Try again in a minute.");
        expect(CODE_SCREEN_COPY.errDeviceLimit).toBe("This code is on 3 computers already. It frees up after 30 days unused, or email support@subline.page for a reset.");
        expect(CODE_SCREEN_COPY.errEmpty).toBe("Type or paste a code first.");
        // The confirm step reads the same as the plugin's confirm window.
        expect(CODE_SCREEN_COPY.confirmTitle).toBe("Use this code?");
        expect(CODE_SCREEN_COPY.confirm).toBe("It works on up to 3 computers.");
        expect(CODE_SCREEN_COPY.useIt).toBe("Use it");
        expect(CODE_SCREEN_COPY.errBuyUnavailable).toBe("Buying isn't available yet. Use a code, or try again later.");
        expect(CODE_SCREEN_COPY.errCoupon).toBe("If it's a coupon, it's for AI Monthly. Get Automatic first, then add AI in Discord and enter the coupon on the payment page.");
        expect(CODE_SCREEN_COPY.waitingLate).toBe("Paid already? It can take a few minutes. Close this and reopen Subline later.");
    });

    it("a license key is checked WITHOUT linking, confirmed by the user, then linked and saved", async () => {
        const h = harness({
            relayStatus: [
                { kind: "ok", automatic: false, ai: false, code: null, check: { valid: true, automatic: true, ai: true } },
                { kind: "ok", automatic: true, ai: true, code: null }
            ]
        });
        await toCodeStep(h);
        const confirm = await h.flow.send({ type: "set-code", code: "slp_abcdefghijklmnop" });
        // Only a check so far: no slot used, nothing saved, nothing patched.
        expect(h.relayCalls).toEqual([{ kind: "status", credential: "slp_abcdefghijklmnop", installId: TEST_INSTALL_ID, check: true }]);
        expect(confirm.step).toBe("confirm-code");
        expect(confirm.detail).toBe("It works on up to 3 computers.");
        expect(confirm.actions).toEqual(["use-code", "back"]);
        expect(h.codeWrites).toEqual([]);
        expect(h.patchCalls).toHaveLength(0);
        const state = await h.flow.send({ type: "use-code" });
        expect(h.relayCalls[1]).toEqual({ kind: "status", credential: "slp_abcdefghijklmnop", installId: TEST_INSTALL_ID });
        expect(h.codeWrites).toEqual(["slp_abcdefghijklmnop"]);
        expect(state.step).toBe("done");
        expect(state.detail).toContain("✦");
    });

    it("Back on the confirm step links nothing and returns to the code screen", async () => {
        const h = harness({ relayStatus: { kind: "ok", automatic: false, ai: false, code: null, check: { valid: true, automatic: true, ai: false } } });
        await toCodeStep(h);
        await h.flow.send({ type: "set-code", code: "slp_abcdefghijklmnop" });
        const back = await h.flow.send({ type: "back" });
        expect(back.step).toBe("choose-code");
        expect(h.relayCalls).toHaveLength(1);
        expect(h.codeWrites).toEqual([]);
    });

    it("a check that says the code is not valid never reaches the confirm step", async () => {
        const h = harness({ relayStatus: { kind: "ok", automatic: false, ai: false, code: null, check: { valid: false, automatic: false, ai: false } } });
        await toCodeStep(h);
        const state = await h.flow.send({ type: "set-code", code: "slp_abcdefghijklmnop" });
        expect(state.step).toBe("choose-code");
        expect(state.detail).toBe(CODE_SCREEN_COPY.errNotActive);
    });

    it("a Dodo coupon typed here is pointed at AI in Discord, not at a payment page that would refuse it", async () => {
        // Coupons are restricted to the AI Monthly product (relay createCoupon),
        // and the only payment page here is Automatic's.
        const h = harness({ relayRedeem: { kind: "not_found" } });
        await toCodeStep(h);
        const state = await h.flow.send({ type: "set-code", code: "ALEXK7Q2M" });
        expect(state.detail).toContain("That code doesn't exist.");
        expect(state.detail).toContain("AI");
        expect(state.detail).toContain("Discord");
        expect(state.detail).not.toBe("That code doesn't exist. Coupons go on the payment page.");
    });

    const statusErrors: Array<[StatusAnswer, string]> = [
        [{ kind: "ok", automatic: false, ai: false, code: null }, CODE_SCREEN_COPY.errNotActive],
        [{ kind: "invalid" }, CODE_SCREEN_COPY.errNotFound],
        [{ kind: "device_limit" }, CODE_SCREEN_COPY.errDeviceLimit],
        [{ kind: "unreachable", cause: "timed out" }, CODE_SCREEN_COPY.errUnreachable]
    ];
    for (const [answer, message] of statusErrors) {
        it(`a license key answered "${answer.kind}${answer.kind === "ok" ? " without Automatic" : ""}" is refused, unpatched`, async () => {
            const h = harness({ relayStatus: answer });
            await toCodeStep(h);
            const state = await h.flow.send({ type: "set-code", code: "ABCD-EFGH-IJKL" });
            expect(state.step).toBe("choose-code");
            expect(state.error?.message).toBe(message);
            // Read on the screen, not hidden in the diagnostics.
            expect(state.detail).toBe(message);
            expect(h.codeWrites).toEqual([]);
            expect(h.patchCalls).toHaveLength(0);
        });
    }

    it("an empty code is refused without asking the relay", async () => {
        const h = harness();
        await toCodeStep(h);
        const state = await h.flow.send({ type: "set-code", code: "   " });
        expect(state.error?.message).toBe(CODE_SCREEN_COPY.errEmpty);
        expect(h.relayCalls).toEqual([]);
    });

    it("a saved code is checked with the relay before it is honoured, never rewritten", async () => {
        const h = harness({ savedCode: "slp_savedcode" });
        const seen: string[] = [];
        h.flow.onChange = st => seen.push(st.step);
        await toDetection(h);
        const next = await h.flow.send({ type: "set-language", code: "tr" });
        expect(h.relayCalls[0]).toEqual({ kind: "status", credential: "slp_savedcode", installId: TEST_INSTALL_ID });
        expect(seen).not.toContain("choose-code");
        expect(h.codeWrites).toEqual([]);
        expect(h.engineReasserts).toBe(1);
        expect(next.step).toBe("done");
        expect(h.logged.some(l => l.event === "flow.code-already-saved")).toBe(true);
    });

    it("a saved code the relay rejects lands on the activation screen, unpatched", async () => {
        const h = harness({ savedCode: "slp_savedcode", relayStatus: { kind: "device_limit" } });
        await toDetection(h);
        const next = await h.flow.send({ type: "set-language", code: "tr" });
        expect(next.step).toBe("choose-code");
        expect(next.error?.message).toBe(CODE_SCREEN_COPY.errDeviceLimit);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("at the computer limit: no Buy, only another code, and a link to ask for a reset", async () => {
        const h = harness({ savedCode: "slp_savedcode", relayStatus: { kind: "device_limit" } });
        await toDetection(h);
        const next = await h.flow.send({ type: "set-language", code: "tr" });
        expect(next.detail).toBe(CODE_SCREEN_COPY.errDeviceLimit);
        expect(next.actions).toEqual(["set-code"]);
        expect(next.helpUrl).toBe("mailto:support@subline.page");
        expect(RESET_HELP_URL).toBe("mailto:support@subline.page");
    });

    it("any other refusal keeps Buy and draws no reset link", async () => {
        const h = harness({ relayStatus: [{ kind: "ok", automatic: false, ai: false, code: null, check: { valid: false, automatic: false, ai: false } }] });
        await toCodeStep(h);
        const next = await h.flow.send({ type: "set-code", code: "slp_abcdefghijklmnop" });
        expect(next.step).toBe("choose-code");
        expect(next.actions).toEqual(["buy-automatic", "set-code"]);
        expect(next.helpUrl).toBeUndefined();
    });

    it("an empty code says so, in the same words as the plugin", async () => {
        const h = harness({});
        await toCodeStep(h);
        const next = await h.flow.send({ type: "set-code", code: "   " });
        expect(next.detail).toBe("Type or paste a code first.");
        expect(h.relayCalls).toEqual([]);
    });

    it("an unreachable relay while checking a saved code: the retry message, never continue", async () => {
        const h = harness({ savedCode: "slp_savedcode", relayStatus: [{ kind: "unreachable", cause: "fetch failed" }, ACTIVE] });
        await toDetection(h);
        const failed = await h.flow.send({ type: "set-language", code: "tr" });
        expect(failed.step).toBe("activation-check-failed");
        expect(failed.detail).toBe(CODE_SCREEN_COPY.errUnreachable);
        expect(failed.actions).toEqual(["retry", "cancel"]);
        expect(h.patchCalls).toHaveLength(0);
        const after = await h.flow.send({ type: "retry" });
        expect(after.step).toBe("done");
        expect(h.patchCalls.length).toBeGreaterThan(0);
    });

    it("an install id already in the settings that the relay knows as activated skips the screen", async () => {
        const h = harness({ savedInstallId: "fedcba9876543210fedcba9876543210", relayStatus: { kind: "ok", automatic: true, ai: false, code: "slp_early" } });
        const seen: string[] = [];
        h.flow.onChange = st => seen.push(st.step);
        await toDetection(h);
        const next = await h.flow.send({ type: "set-language", code: "tr" });
        expect(h.relayCalls[0]).toEqual({ kind: "status", credential: "free_fedcba9876543210fedcba9876543210", installId: "fedcba9876543210fedcba9876543210" });
        expect(seen).not.toContain("choose-code");
        expect(h.codeWrites).toEqual(["slp_early"]);
        expect(next.step).toBe("done");
    });

    it("a reinstall never brings back a code the reader cleared, and shows the activation screen", async () => {
        // The reader cleared their code in Subline's settings, then reinstalled
        // keeping settings: the relay still links the purchase to this install id.
        const h = harness({
            savedInstallId: "fedcba9876543210fedcba9876543210",
            clearedCode: "LICENSE-OLD",
            relayStatus: { kind: "ok", automatic: true, ai: true, code: "LICENSE-OLD" }
        });
        await toDetection(h);
        const next = await h.flow.send({ type: "set-language", code: "tr" });
        expect(next.step).toBe("choose-code");
        expect(h.codeWrites).toEqual([]);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("an install id the relay does not know as activated gets the activation screen", async () => {
        const h = harness({ savedInstallId: "fedcba9876543210fedcba9876543210", relayStatus: { kind: "ok", automatic: false, ai: false, code: null } });
        await toDetection(h);
        const next = await h.flow.send({ type: "set-language", code: "tr" });
        expect(next.step).toBe("choose-code");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("stays on the screen when the code cannot be saved", async () => {
        const h = harness({ setSublineCode: { ok: false, error: fail("IO_ERROR", "settings are read-only") } });
        await toCodeStep(h);
        await h.flow.send({ type: "set-code", code: "slp_x" });
        const state = await h.flow.send({ type: "use-code" });
        expect(state.step).toBe("choose-code");
        expect(state.error?.code).toBe("IO_ERROR");
        expect(state.actions).toEqual(["buy-automatic", "set-code"]);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("an install id that cannot be written stops on the screen, with nothing sent", async () => {
        const h = harness({ ensureInstallId: { ok: false, error: fail("IO_ERROR", "read-only") } });
        await toCodeStep(h);
        const state = await h.flow.send({ type: "buy-automatic" });
        expect(state.step).toBe("choose-code");
        expect(h.relayCalls).toEqual([]);
        expect(h.opened).toEqual([]);
    });

    it("never puts a code in the log", async () => {
        const h = harness();
        await toCodeStep(h);
        await h.flow.send({ type: "set-code", code: "slp_SUPERSECRETVALUE" });
        await h.flow.send({ type: "use-code" });
        const logged = JSON.stringify(h.logged);
        expect(logged).not.toContain("slp_SUPERSECRETVALUE");
        expect(logged).toContain("codeLength");
    });
});

describe("macOS App Management", () => {
    it("explains BEFORE attempting, rather than reporting a failed patch", async () => {
        const h = harness({ permission: ["blocked"] });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");

        expect(state.step).toBe("permission-explain");
        // Nothing was attempted: no patch, and the user has not yet been sent anywhere.
        expect(h.patchCalls).toHaveLength(0);
        expect(h.settingsOpened).toBe(0);
        // UPDATED with the copy: the screen is now three numbered steps with
        // the words to look for in `**bold**` (rendered as <strong> by
        // src/renderer/emphasis.ts). The assertions pin the BOLD words, because
        // the emphasis is the part a skimming user acts on. The old assertions
        // pinned sentences from two paragraphs that pre-empted Apple's "update
        // or delete other applications" wording before ever saying what to
        // click; that explanation went, the instruction stayed.
        expect(state.detail).toContain("**App Management**");
        expect(state.detail).toContain("**Subline**");
        expect(state.detail).toContain("**Continue**");
        // "Later" is still the right button and is still named, in bold now.
        expect(state.detail).toContain("**Later**");
        expect(state.detail).not.toContain("do not need to quit");
    });

    it("carries the exact deep link spec §4 names", async () => {
        const h = harness({ permission: ["blocked"] });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(state.permissionSettingsUrl)
            .toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles");
    });

    it("polls for the grant and continues automatically — no quit, no re-run", async () => {
        const h = harness({ permission: ["blocked", "blocked", "blocked", "granted"] });
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        const state = await h.flow.send({ type: "next" });

        expect(state.step).toBe("done");
        expect(h.settingsOpened).toBe(1);
        expect(h.patchCalls).toHaveLength(1);
    });

    it("lets macOS finish talking before opening Discord on top of it", async () => {
        // A real run produced three interruptions at once: Apple's permission
        // dialog, the background-activity notification from registering the
        // LaunchAgent, and Discord relaunching. Each is fine alone; together
        // they read as the machine doing things to itself.
        const h = harness({ permission: ["blocked", "granted"] });
        await toDetection(h);
        await setLanguage(h.flow, "tr");

        const before = h.ports.now();
        await h.flow.send({ type: "next" });
        const elapsed = h.ports.now() - before;

        // The injected clock only moves when the flow sleeps, so any settle
        // pause is visible here and no real time is spent.
        expect(elapsed).toBeGreaterThanOrEqual(2_500);
        expect(h.launched).toBe(1);
    });

    it("does not pause for someone who already granted permission", async () => {
        // They see none of those dialogs, so a pause would cost them time in
        // exchange for nothing.
        const h = harness({ permission: ["granted"] });
        await toDetection(h);

        const before = h.ports.now();
        await setLanguage(h.flow, "tr");
        const elapsed = h.ports.now() - before;

        expect(elapsed).toBeLessThan(2_500);
        expect(h.launched).toBe(1);
    });

    it("shows ONE waiting screen: Turn on Subline, Later, carries on by itself", async () => {
        const h = harness({ permission: ["blocked", "blocked", "granted"] });
        const seen: FlowState[] = [];
        h.flow.onChange = next => { h.steps.push(next.step); seen.push(next); };
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        await h.flow.send({ type: "next" });

        const waiting = seen.filter(state => state.step === "permission-waiting");
        expect(waiting).toHaveLength(1);
        expect(waiting[0]?.detail).toBe(
            "In the window that just opened, turn on **Subline**. If macOS asks to quit, choose **Later**. "
            + "Subline carries on by itself."
        );
        // "Open it again" and Cancel. No Try again, no primary Open System Settings.
        expect(waiting[0]?.actions).toEqual(["open-permission-settings", "cancel"]);
        expect(waiting.flatMap(state => state.actions).some(action => IS_PRIMARY[action])).toBe(false);
        expect(ACTION_LABELS["open-permission-settings"]).toBe("Open it again");
    });

    it("waits with no timeout: ten minutes of blocked, then the grant, and it carries on", async () => {
        // Field log 2026-09-24: the old 2-minute limit showed an error while
        // the user was still in System Settings.
        let calls = 0;
        const h = harness();
        h.ports.probePermission = () => (++calls > 601 ? "granted" : "blocked");
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        const state = await h.flow.send({ type: "next" });
        const settled = state.step === "done" && h.flow.settled ? await h.flow.settled() : state;

        expect(settled.step).toBe("done");
        expect(h.steps).not.toContain("permission-failed");
        expect(h.settingsOpened).toBe(1);
        expect(h.patchCalls).toHaveLength(1);
    });

    it("logs the first attempt and every 30th, plus the result, not one line per probe", async () => {
        let calls = 0;
        const h = harness();
        h.ports.probePermission = () => (++calls > 95 ? "granted" : "blocked");
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        await h.flow.send({ type: "next" });

        const attempts = h.logged.filter(line => line.event === "permission.attempt").map(line => line.fields.attempt);
        // Probe 1 is the explain screen's own check; the wait's attempts count from its first probe.
        expect(attempts).toEqual([1, 30, 60, 90]);
        const result = h.logged.find(line => line.event === "permission.result");
        expect(result?.fields).toMatchObject({ status: "granted", attempts: 95, cancelled: false, failed: false });
    });

    it("Cancel stops the wait and nothing is patched, even if the grant lands right after", async () => {
        let calls = 0;
        const h = harness();
        h.ports.probePermission = () => {
            calls += 1;
            // Pressed while the 5th probe is running; the 6th would say granted.
            if (calls === 5) void h.flow.send({ type: "cancel" });
            return calls >= 6 ? "granted" : "blocked";
        };
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        const state = await h.flow.send({ type: "next" });

        expect(state.step).toBe("cancelled");
        expect(h.patchCalls).toHaveLength(0);
        expect(calls).toBe(5);
    });

    it("Cancel pressed during the very probe that says granted still means no patch", async () => {
        let calls = 0;
        const h = harness();
        h.ports.probePermission = () => {
            calls += 1;
            if (calls === 4) { void h.flow.send({ type: "cancel" }); return "granted"; }
            return "blocked";
        };
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        const state = await h.flow.send({ type: "next" });

        expect(state.step).toBe("cancelled");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("Open it again re-opens the pane without leaving the waiting screen", async () => {
        let calls = 0;
        const h = harness();
        const during: FlowState[] = [];
        h.ports.probePermission = () => {
            calls += 1;
            if (calls === 3) void h.flow.send({ type: "open-permission-settings" }).then(state => during.push(state));
            return calls >= 6 ? "granted" : "blocked";
        };
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        await h.flow.send({ type: "next" });

        expect(during[0]?.step).toBe("permission-waiting");
        expect(h.settingsOpened).toBe(2);
        expect(h.patchCalls).toHaveLength(1);
    });

    it("a check that keeps failing for another reason is a real error, with its cause and Try again", async () => {
        const h = harness({ permission: ["unknown"], permissionProbeError: "ENOENT: no such file or directory" });
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        const state = await h.flow.send({ type: "next" });

        expect(state.step).toBe("permission-failed");
        expect(state.error?.code).toBe("IO_ERROR");
        expect(state.error?.cause).toBe("ENOENT: no such file or directory");
        expect(state.error?.path).toBe(INSTALL.resourcesPath);
        expect(state.actions).toEqual(["retry", "cancel"]);
        expect(state.detail).toContain("**Try again**");
        expect(h.logged.some(line => line.event === "permission.check-failed")).toBe(true);
    });

    it("Try again after a failed check waits again and carries on once it works", async () => {
        let calls = 0;
        const h = harness({ permissionProbeError: "EIO: i/o error" });
        h.ports.probePermission = () => (++calls > 40 ? "granted" : "unknown");
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        const failed = await h.flow.send({ type: "next" });
        expect(failed.step).toBe("permission-failed");

        const state = await h.flow.send({ type: "retry" });
        const settled = state.step === "done" && h.flow.settled ? await h.flow.settled() : state;
        expect(settled.step).toBe("done");
        // The language was written once. Retrying does not re-ask for anything.
        expect(h.languageWrites).toEqual(["tr"]);
    });

    it("goes back to the permission screen if a patch is refused despite the probe", async () => {
        const h = harness({
            permission: ["granted"],
            patch: { ok: false, error: fail("PERMISSION_DENIED", "Not allowed to replace app.asar.") }
        });
        await toDetection(h);
        const failed = await setLanguage(h.flow, "tr");
        expect(failed.step).toBe("patch-failed");
        expect(failed.error?.code).toBe("PERMISSION_DENIED");

        const state = await h.flow.send({ type: "retry" });
        expect(state.step).toBe("permission-explain");
    });
});

/* ------------------------------------------------------------------------ *
 * §3 step 8 — patch failures
 * ------------------------------------------------------------------------ */

describe("patch failures", () => {
    it("says the rollback happened, so a failed install does not read as a broken Discord", async () => {
        const h = harness({
            patch: { ok: false, error: fail("VERIFICATION_FAILED", "Discord's app.asar did not match after writing it.") }
        });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(state.step).toBe("patch-failed");
        expect(state.error?.code).toBe("VERIFICATION_FAILED");
        expect(state.detail).toContain("put back exactly as it was");
    });

    it("does not claim a rollback for a failure that never wrote anything", async () => {
        const h = harness({ patch: { ok: false, error: fail("READ_ONLY_VOLUME", "Cannot write: the volume is read-only.") } });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(state.error?.code).toBe("READ_ONLY_VOLUME");
        expect(state.detail).not.toContain("put back exactly as it was");
    });

    it("names each distinct failure rather than showing one generic error", async () => {
        const codes: PatcherErrorCode[] = ["READ_ONLY_VOLUME", "IO_ERROR", "BROKEN_INSTALL", "FOREIGN_MOD_PRESENT"];
        for (const code of codes) {
            const h = harness({ patch: { ok: false, error: fail(code, `failure: ${code}`) } });
            await toDetection(h);
            const state = await setLanguage(h.flow, "tr");
            expect(state.step).toBe("patch-failed");
            expect(state.error?.code).toBe(code);
        }
    });

    it("retries the patch itself for a non-permission failure", async () => {
        let attempt = 0;
        const h = harness({
            patch: () => (++attempt === 1
                ? { ok: false, error: fail("IO_ERROR", "transient") }
                : { ok: true, value: patchReport() })
        });
        await toDetection(h);
        const failed = await setLanguage(h.flow, "tr");
        expect(failed.step).toBe("patch-failed");
        const state = await h.flow.send({ type: "retry" });
        expect(state.step).toBe("done");
    });

    it("never reaches done on a failed patch", async () => {
        const h = harness({ patch: { ok: false, error: fail("IO_ERROR", "nope") } });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(state.step).not.toBe("done");
        expect(isConfirmedSuccess(state)).toBe(false);
        expect(h.launched).toBe(0);
    });
});

/* ------------------------------------------------------------------------ *
 * §7 — verification that refuses to lie
 * ------------------------------------------------------------------------ */

describe("verification", () => {
    it("confirms only when a translation actually rendered", async () => {
        const h = harness({ verify: verification({ status: "translating-approx", confirmed: true, loaded: true, tier: "approx" }) });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(isConfirmedSuccess(state)).toBe(true);
    });

    it("does NOT claim success when the mod never reported in", async () => {
        const h = harness({ verify: verification({ status: "not-loaded", summary: "…never reported in from Discord…" }) });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(state.step).toBe("done");
        expect(isConfirmedSuccess(state)).toBe(false);
        expect(state.verification?.status).toBe("not-loaded");
    });

    it("distinguishes 'nothing to translate yet' from 'loaded and erroring'", async () => {
        const idle = harness({ verify: verification({ status: "loaded-idle", loaded: true }) });
        await toDetection(idle);
        const idleState = await setLanguage(idle.flow, "tr");
        expect(idleState.verification?.status).toBe("loaded-idle");
        expect(idleState.verification?.loaded).toBe(true);
        expect(isConfirmedSuccess(idleState)).toBe(false);

        const erroring = harness({ verify: verification({ status: "loaded-erroring", loaded: true, errorCode: "engine-error" }) });
        await toDetection(erroring);
        const erroringState = await setLanguage(erroring.flow, "tr");
        expect(erroringState.verification?.status).toBe("loaded-erroring");
        expect(erroringState.verification?.errorCode).toBe("engine-error");
        expect(isConfirmedSuccess(erroringState)).toBe(false);
    });

    it("does not confirm somebody else's copy of the plugin", async () => {
        const h = harness({ verify: verification({ status: "foreign-beacon", identity: "mismatch" }) });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(isConfirmedSuccess(state)).toBe(false);
        expect(state.verification?.identity).toBe("mismatch");
    });

    it("does not confirm a beacon that names no build at all", async () => {
        const h = harness({ verify: verification({ status: "unidentified-beacon", identity: "absent" }) });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(isConfirmedSuccess(state)).toBe(false);
    });

    it("does not confirm a stale beacon from a previous install", async () => {
        const h = harness({ verify: verification({ status: "stale-beacon", stale: true }) });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(isConfirmedSuccess(state)).toBe(false);
    });

    it("does not confirm a mod that translates but renders nothing", async () => {
        const h = harness({ verify: verification({ status: "translating-not-rendering", loaded: true }) });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(isConfirmedSuccess(state)).toBe(false);
    });

    it("shows verifyOnce's own sentence, unedited", async () => {
        const summary = "Subline is installed, but it never reported in from Discord.";
        const h = harness({ verify: verification({ status: "not-loaded", summary }) });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(state.detail).toBe(summary);
    });

    it("treats reaching the last screen as success only when confirmed is true", async () => {
        for (const confirmed of [true, false]) {
            const h = harness({ verify: verification({ confirmed, loaded: true }) });
            await toDetection(h);
            const state = await setLanguage(h.flow, "tr");
            expect(state.step).toBe("done");
            expect(isConfirmedSuccess(state)).toBe(confirmed);
        }
    });
});

describe("Discord failing to launch", () => {
    it("is its own state, and still lets verification proceed", async () => {
        const h = harness({ launch: { ok: false, error: fail("IO_ERROR", "Could not start Discord.") } });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(state.step).toBe("launch-failed");
        expect(state.detail).toContain("Subline is installed");
        expect(state.actions).toContain("skip-launch");

        const done = await h.flow.send({ type: "skip-launch" });
        expect(done.step).toBe("done");
    });

    it("does not confirm success merely because the patch succeeded", async () => {
        const h = harness({ launch: { ok: false, error: fail("IO_ERROR", "Could not start Discord.") } });
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(isConfirmedSuccess(state)).toBe(false);
    });
});

/* ------------------------------------------------------------------------ *
 * The machine itself
 * ------------------------------------------------------------------------ */

describe("the machine", () => {
    it("ignores an action the current state did not offer", async () => {
        const h = harness();
        const before = h.flow.state;
        const after = await setLanguage(h.flow, "tr");
        expect(after.step).toBe(before.step);
        expect(h.logged.some(entry => entry.event === "flow.action.rejected")).toBe(true);
    });

    it("can be cancelled from every state that offers it, and patches nothing", async () => {
        const h = harness();
        await toDetection(h);
        const state = await h.flow.send({ type: "cancel" });
        expect(state.step).toBe("cancelled");
        // CHANGED: was toEqual([]). A terminal screen with no action at all
        // left the window's title bar as the only exit, which on a screen whose
        // job is reassurance reads as being stuck.
        expect(state.actions).toEqual(["finish"]);
    });

    it("notifies a subscriber on every transition", async () => {
        const h = harness();
        const seen: string[] = [];
        h.flow.onChange = next => seen.push(next.step);
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        expect(seen).toContain("detecting");
        expect(seen).toContain("choose-language");
        expect(seen).toContain("patching");
        // No "verifying" screen any more: the last screen shows at once and the
        // confirmation arrives as a second "done" transition (see settled()).
        expect(seen).not.toContain("verifying");
        expect(seen.filter(step => step === "done").length).toBeGreaterThanOrEqual(2);
    });

    it("logs every state and never logs anything resembling message text", async () => {
        const h = harness();
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        const events = h.logged.map(entry => entry.event);
        expect(events).toContain("flow.state");
        expect(events).toContain("patch.ok");
        expect(events).toContain("verify.result");
        for (const entry of h.logged) {
            for (const key of Object.keys(entry.fields)) {
                expect(["text", "content", "message", "translation"]).not.toContain(key);
            }
        }
    });

    it("shows a busy state while long operations run", async () => {
        const h = harness();
        const seen: FlowState[] = [];
        h.flow.onChange = next => seen.push({ ...next });
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        expect(seen.some(s => s.step === "patching" && s.busy)).toBe(true);
        // The last screen is never busy: confirmation happens in the background,
        // and a spinner next to a Discord that is opening read as "still wrong".
        expect(seen.filter(s => s.step === "done").every(s => !s.busy)).toBe(true);
        expect(seen.at(-1)?.busy).toBe(false);
    });
});

describe("every screen the flow can reach", () => {
    /**
     * Drives the flow into as many states as the scripted ports allow and
     * checks a property of each one, rather than of a table in isolation.
     */
    async function statesReached(): Promise<FlowState[]> {
        const seen: FlowState[] = [];
        const record = (h: Harness) => { for (const s of h.steps) void s; };

        const runs: Array<() => Promise<void>> = [
            async () => { const h = harness(); seen.push(await h.flow.start()); },
            async () => { const h = harness(); seen.push(await toDetection(h)); },
            async () => { const h = harness({ installs: { ok: false, error: fail("DISCORD_NOT_FOUND") } });
                          seen.push(await toDetection(h)); },
            async () => { const h = harness({ inspect: { ok: true, value: installState("patched-by-other", "betterdiscord") } });
                          seen.push(await toDetection(h)); },
            async () => { const h = harness({ inspect: { ok: true, value: installState("patched-by-other", "vencord") } });
                          seen.push(await toDetection(h)); },
            async () => { const h = harness({ processes: [[DISCORD_PROCESS]] });
                          seen.push(await toDetection(h));
                          seen.push(await h.flow.send({ type: "quit-discord" })); },
            async () => { const h = harness(); await toDetection(h);
                          seen.push(await h.flow.send({ type: "set-language", code: "tr" })); },
            async () => { const h = harness({ permission: ["blocked"] }); await toDetection(h);
                          seen.push(await setLanguage(h.flow, "tr")); },
            async () => { const h = harness({ patch: { ok: false, error: fail("IO_ERROR") } });
                          await toDetection(h); seen.push(await setLanguage(h.flow, "tr")); },
            async () => { const h = harness({ installHelper: [{ ok: false, error: fail("HELPER_REGISTRATION_FAILED") }] });
                          await toDetection(h); seen.push(await setLanguage(h.flow, "tr")); },
            async () => { const h = harness({ launch: { ok: false, error: fail("IO_ERROR") } });
                          await toDetection(h); seen.push(await setLanguage(h.flow, "tr")); },
            async () => { const h = harness(); await toDetection(h);
                          seen.push(await setLanguage(h.flow, "tr")); },
            async () => { const h = harness(); seen.push(await h.flow.send({ type: "cancel" })); },
            async () => { const h = harness({ permission: ["unknown"] }); await toDetection(h);
                          await setLanguage(h.flow, "tr"); seen.push(await h.flow.send({ type: "next" })); },
            async () => { const h = harness({ permission: ["blocked", "blocked", "granted"] });
                          h.flow.onChange = state => { if (state.step === "permission-waiting") seen.push(state); };
                          await toDetection(h); await setLanguage(h.flow, "tr"); await h.flow.send({ type: "next" }); }
        ];
        for (const run of runs) await run();
        void record;
        return seen;
    }

    it("offers at most one filled button", async () => {
        // The rule the renderer only stated in a comment. Two primaries on one
        // screen means two recommended actions, which is none.
        for (const state of await statesReached()) {
            const primaries = state.actions.filter(action => IS_PRIMARY[action]);
            expect(primaries.length, `${state.step}: ${primaries.join(", ")}`).toBeLessThanOrEqual(1);
        }
    });

    it("gives every offered action a label", async () => {
        for (const state of await statesReached()) {
            for (const action of state.actions) {
                expect(ACTION_LABELS[action], `${state.step}/${action}`).toBeTruthy();
            }
        }
    });

    it("always leaves a way out", async () => {
        // No screen may be a dead end: every one offers at least one action, and
        // the terminal ones offer the way to close.
        for (const state of await statesReached()) {
            expect(state.actions.length, state.step).toBeGreaterThan(0);
        }
    });
});

/* ------------------------------------------------------------------------ *
 * Worst cases (the 0.2.1 pass): each test fails on the code before its fix.
 * ------------------------------------------------------------------------ */

describe("worst cases", () => {
    async function toCode(h: Harness) {
        await toDetection(h);
        return h.flow.send({ type: "set-language", code: "tr" });
    }
    const NOT_YET: StatusAnswer = { kind: "ok", automatic: false, ai: false, code: null };
    const tick = () => new Promise(resolve => setImmediate(resolve));

    it("an installer left on the finish-paying screen backs off after 30 minutes and stops after 48 hours", async () => {
        const h = harness({ relayStatus: NOT_YET });
        // The real schedule: 5 s, not the harness's 5 ms.
        delete (h.ports as { activationPollIntervalMs?: number }).activationPollIntervalMs;
        const times: number[] = [];
        const status = h.ports.relay.status;
        h.ports.relay.status = async (...args) => { times.push(h.ports.now()); return status(...args); };
        await toCode(h);
        const startedAt = h.ports.now();
        const pending = h.flow.send({ type: "buy-automatic" });
        for (let i = 0; i < 400_000; i++) {
            if (h.flow.state.step !== "activation-waiting" && i > 0) break;
            if (h.ports.now() - startedAt > 50 * 60 * 60_000) break;
            await tick();
        }
        const inFirstTwoHours = times.filter(at => at - startedAt <= 2 * 60 * 60_000).length;
        // One at once, 360 in the fast half hour, then one every 5 minutes:
        // 1 + 360 + 18. It was ~1,441 (every 5 s, forever).
        expect(inFirstTwoHours).toBeLessThanOrEqual(379);
        expect(h.flow.state.step).not.toBe("activation-waiting");
        if (h.flow.state.step === "activation-waiting") await h.flow.send({ type: "back" });
        const ended = await pending;
        expect(ended.step).toBe("choose-code");
        expect(ended.detail).toBe(CODE_SCREEN_COPY.errWaitingStopped);
        expect(ended.actions).toContain("buy-automatic");
        const asked = times.length;
        await tick();
        expect(times.length).toBe(asked);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("a promo answered \"already\" asks the relay what this install has, and carries on when it is Automatic", async () => {
        const h = harness({ relayRedeem: { kind: "already" }, relayStatus: ACTIVE });
        await toCode(h);
        const state = await h.flow.send({ type: "set-code", code: "SERVER1" });
        expect(h.relayCalls.filter(c => c.kind === "status")).toEqual([
            { kind: "status", credential: `free_${TEST_INSTALL_ID}`, installId: TEST_INSTALL_ID }
        ]);
        expect(state.step).not.toBe("choose-code");
        expect(state.step).toBe("done");
    });

    it("a promo answered \"already\" for an install the relay does not confirm still says Already yours.", async () => {
        const h = harness({ relayRedeem: { kind: "already" }, relayStatus: NOT_YET });
        await toCode(h);
        const state = await h.flow.send({ type: "set-code", code: "SERVER1" });
        expect(state.step).toBe("choose-code");
        expect(state.detail).toBe(CODE_SCREEN_COPY.errAlready);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("a double press on Save code sends ONE redeem, and the good path is not painted over", async () => {
        const h = harness({ processes: [[DISCORD_PROCESS]] });
        let release!: (answer: RedeemAnswer) => void;
        let redeems = 0;
        h.ports.relay.redeem = () => { redeems += 1; return new Promise<RedeemAnswer>(resolve => { release = resolve; }); };
        await toCode(h);
        const first = h.flow.send({ type: "set-code", code: "SERVER1" });
        const second = h.flow.send({ type: "set-code", code: "SERVER1" });
        expect(h.flow.state.busy).toBe(true);
        expect(h.flow.state.actions).toEqual([]);
        release({ kind: "ok", code: "slp_promominted" });
        await Promise.all([first, second]);
        expect(redeems).toBe(1);
        expect(h.flow.state.step).toBe("discord-running");
        expect(h.flow.state.detail).not.toBe(CODE_SCREEN_COPY.errAlready);
    });

    it("a double click on Use it runs ONE install: one patch, one helper, one Discord launch", async () => {
        const h = harness({
            relayStatus: [
                { kind: "ok", automatic: false, ai: false, code: null, check: { valid: true, automatic: true, ai: false } },
                { kind: "ok", automatic: true, ai: false, code: null }
            ]
        });
        const status = h.ports.relay.status;
        h.ports.relay.status = async (...args) => {
            await new Promise(resolve => setTimeout(resolve, 5));
            return status(...args);
        };
        await toCode(h);
        await h.flow.send({ type: "set-code", code: "slp_abcdefghijklmnop" });
        await Promise.all([h.flow.send({ type: "use-code" }), h.flow.send({ type: "use-code" })]);
        await h.flow.settled();
        expect(h.patchCalls).toHaveLength(1);
        expect(h.helperInstalls).toBe(1);
        expect(h.launched).toBe(1);
        expect(h.logged.some(l => l.event === "flow.action.rejected" && l.fields.action === "use-code")).toBe(true);
    });

    it("a double click on Buy opens ONE checkout", async () => {
        const h = harness({ relayStatus: NOT_YET });
        const checkout = h.ports.relay.checkout;
        h.ports.relay.checkout = async installId => {
            await new Promise(resolve => setTimeout(resolve, 5));
            return checkout(installId);
        };
        await toCode(h);
        const first = h.flow.send({ type: "buy-automatic" });
        const second = h.flow.send({ type: "buy-automatic" });
        for (let i = 0; i < 200 && h.flow.state.step !== "activation-waiting"; i++) await new Promise(r => setTimeout(r, 1));
        await h.flow.send({ type: "back" });
        await Promise.all([first, second]);
        expect(h.opened).toHaveLength(1);
        expect(h.relayCalls.filter(c => c.kind === "checkout")).toHaveLength(1);
    });

    it("Windows: a PERMISSION_DENIED patch failure never leads to the macOS permission screen", async () => {
        let attempt = 0;
        const h = harness({
            platform: "win32",
            permission: ["not-required"],
            patch: () => (++attempt === 1
                ? { ok: false, error: fail("PERMISSION_DENIED", "Not allowed") }
                : { ok: true, value: patchReport() })
        });
        await toDetection(h);
        const failed = await setLanguage(h.flow, "tr");
        expect(failed.step).toBe("patch-failed");
        const next = await h.flow.send({ type: "retry" });
        expect(next.step).not.toBe("permission-explain");
        expect(h.steps).not.toContain("permission-explain");
        expect(h.settingsOpened).toBe(0);
        expect(attempt).toBe(2);
    });

    it("macOS: a Discord this account cannot write ends on an error with Try again at once, never a wait", async () => {
        let probes = 0;
        const h = harness({ permission: ["not-writable"] });
        const probe = h.ports.probePermission;
        h.ports.probePermission = install => { probes += 1; return probe(install); };
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(state.step).toBe("permission-failed");
        expect(state.actions).toEqual(["retry", "cancel"]);
        expect(state.detail).toContain("Mac account");
        expect(probes).toBe(1);
        expect(h.steps).not.toContain("permission-waiting");
        expect(h.settingsOpened).toBe(0);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("abort() during the permission wait: the grant that arrives next starts no patch and no helper", async () => {
        const h = harness();
        let probes = 0;
        h.ports.probePermission = () => {
            probes += 1;
            if (probes === 3) void h.flow.abort();
            return probes >= 4 ? "granted" : "blocked";
        };
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        expect(h.flow.state.step).toBe("permission-explain");
        const pending = h.flow.send({ type: "next" });
        await pending;
        await h.flow.abort();
        expect(h.patchCalls).toHaveLength(0);
        expect(h.helperInstalls).toBe(0);
        expect(h.flow.state.step).toBe("cancelled");
    });

    it("abort() during the purchase poll: a purchase landing next patches nothing", async () => {
        const h = harness({ relayStatus: [NOT_YET, ACTIVE] });
        let polls = 0;
        const status = h.ports.relay.status;
        h.ports.relay.status = async (...args) => {
            polls += 1;
            if (polls === 1) void h.flow.abort();
            return status(...args);
        };
        await toCode(h);
        await h.flow.send({ type: "buy-automatic" });
        await h.flow.abort();
        expect(h.patchCalls).toHaveLength(0);
        expect(h.codeWrites).toEqual([]);
    });

    it("abort() while the helper is being registered waits for it, and Discord is not launched after", async () => {
        const h = harness();
        let release!: () => void;
        h.ports.installHelper = () => {
            h.helperInstalls += 1;
            return new Promise(resolve => {
                release = () => resolve({ ok: true, value: { applicable: true, installed: true, label: "x", path: "x" } });
            });
        };
        await toDetection(h);
        const pending = h.flow.send({ type: "set-language", code: "tr" }).then(() => h.flow.send({ type: "buy-automatic" }));
        for (let i = 0; i < 200 && h.helperInstalls === 0; i++) await tick();
        expect(h.helperInstalls).toBe(1);
        let aborted = false;
        const abort = h.flow.abort().then(() => { aborted = true; });
        await tick();
        expect(aborted).toBe(false);
        release();
        await abort;
        await pending;
        expect(aborted).toBe(true);
        expect(h.launched).toBe(0);
    });

    it("a Discord another Mac account set up is never \"already set up\", and is not patched from here", async () => {
        const otherLoader = "/Users/other/Library/Application Support/Subline/mod/patcher.js";
        const patched: InstallState = {
            ...installState("patched-by-us"),
            mod: "subline",
            loaderPath: otherLoader,
            marker: { loaderPath: otherLoader, pluginBuildId: BUILD_ID } as InstallState["marker"]
        };
        const h = harness({ inspect: { ok: true, value: patched } });
        h.ports.isOtherAccountLoader = path => path.startsWith("/Users/other/");
        expect((await h.flow.start()).step).toBe("welcome");
        const state = await toDetection(h);
        expect(state.step).toBe("other-account");
        expect(state.actions).toEqual(["recheck", "cancel"]);
        expect(state.detail).toBe("Another account on this Mac set up Subline for this Discord. Only that account can change it.");
        expect(h.patchCalls).toHaveLength(0);
        expect(h.helperEnsures).toBe(0);
    });

    it("remembers every Discord it patches, so Uninstall and the helper can find a hand-picked one", async () => {
        const h = harness();
        const remembered: string[] = [];
        h.ports.rememberPatchedInstall = install => { remembered.push(install.rootPath); };
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        expect(remembered).toEqual([INSTALL.rootPath]);
    });
});

/* ------------------------------------------------------------------------ *
 * Audit 2026-10-06 #24: Subline opened straight off the .dmg (or a
 * translocated copy) registers a helper that dies when the image is ejected.
 * The flow asks for a move to Applications BEFORE anything is written.
 * ------------------------------------------------------------------------ */
describe("running from the disk image", () => {
    const TEMPORARY = { ok: true as const, value: { stable: false, path: "/Volumes/Subline/Subline.app", reason: "disk-image" } };
    const STABLE = { ok: true as const, value: { stable: true, path: "/Applications/Subline.app", reason: null } };

    it("stops on the move screen before anything is patched, and Try again re-checks", async () => {
        const h = harness();
        let answer: Result<{ stable: boolean; path: string; reason: string | null }> = TEMPORARY;
        let checks = 0;
        h.ports.appLocation = async () => { checks++; return answer; };
        await toDetection(h);
        const state = await setLanguage(h.flow, "tr");
        expect(state.step).toBe("move-to-applications");
        expect(state.actions).toEqual(["move-to-applications", "retry", "cancel"]);
        expect(state.detail).toBe(
            "Subline is running from the disk image. It can only keep Discord repaired from your Applications folder. "
            + "Move it there, then open it again."
        );
        expect(state.detail).not.toContain("—");
        expect(h.patchCalls).toHaveLength(0);
        expect(h.helperInstalls).toBe(0);

        // Still on the disk image: the same screen, nothing written, no loop.
        const again = await h.flow.send({ type: "retry" });
        expect(again.step).toBe("move-to-applications");
        expect(h.patchCalls).toHaveLength(0);
        expect(checks).toBe(2);

        answer = STABLE;
        const done = await h.flow.send({ type: "retry" });
        expect(done.step).not.toBe("move-to-applications");
        expect(h.patchCalls).toHaveLength(1);
    });

    it("the move button asks to move the app; a refused move says so and stays", async () => {
        const h = harness();
        h.ports.appLocation = async () => TEMPORARY;
        let moves = 0;
        let moved: Result<boolean> = { ok: true, value: false };
        h.ports.moveToApplications = async () => { moves++; return moved; };
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        const refused = await h.flow.send({ type: "move-to-applications" });
        expect(moves).toBe(1);
        expect(refused.step).toBe("move-to-applications");
        expect(refused.detail).toBe(
            "Subline could not move itself. Drag Subline from the disk image into your Applications folder, then open it from there."
        );
        expect(h.patchCalls).toHaveLength(0);

        moved = { ok: true, value: true };
        const moving = await h.flow.send({ type: "move-to-applications" });
        expect(moves).toBe(2);
        expect(moving.step).toBe("move-to-applications");
        expect(moving.busy).toBe(true);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("is a macOS question only", async () => {
        const h = harness({ platform: "win32" });
        let checks = 0;
        h.ports.appLocation = async () => { checks++; return TEMPORARY; };
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        expect(checks).toBe(0);
        expect(h.patchCalls).toHaveLength(1);
    });

    it("already set up, but run from the disk image: says background repair is off", async () => {
        const h = harness({
            inspect: { ok: true, value: installState("patched-by-us", "subline") },
            ensureHelper: {
                ok: true,
                value: { action: "skipped", reason: "running-from-temporary-location", registered: null, expected: "/Volumes/Subline/Subline.app" }
            }
        });
        const state = await h.flow.start();
        expect(state.step).toBe("already-installed");
        expect(state.detail).not.toContain("Updates are handled in the background.");
        expect(state.detail).toContain(
            "Background repair is off because Subline is running from the disk image. Move Subline to your Applications folder and open it from there."
        );
    });
});

/* ------------------------------------------------------------------------ *
 * Install audit 2026-10-06, ownership family: states the flow must not call
 * "already set up" or "broken" when the install can be repaired.
 * ------------------------------------------------------------------------ */

describe("audit: repairable states are repaired, not reported", () => {
    it("#26/#44: an interrupted patch (app.asar gone, original in _app.asar) takes the install path and is patched", async () => {
        const st = { ...installState("broken"), reason: "asar-missing-backup-present" as const };
        const h = harness({ inspect: { ok: true, value: st }, hasSublineCode: true });
        const seen: string[] = [];
        h.flow.onChange = next => seen.push(next.step);
        const after = await toDetection(h);
        expect(seen).not.toContain("broken-install");
        // The normal install path: a fresh user is asked the language next.
        expect(after.step).toBe("choose-language");
    });

    it("#26/#44: a broken install that cannot be repaired still stops on its own screen", async () => {
        const st = { ...installState("broken"), reason: "our-patch-without-backup" as const };
        const h = harness({ inspect: { ok: true, value: st } });
        const state = await toDetection(h);
        expect(state.step).toBe("broken-install");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("#4: Subline's files missing behind our stub is an update, not 'already set up'", async () => {
        const st = { ...installState("patched-by-us", "subline"), warnings: ["loader-missing" as const] };
        const h = harness({ inspect: { ok: true, value: st }, hasSublineCode: true });
        const first = await h.flow.start();
        expect(first.step).not.toBe("already-installed");
        expect(h.patchCalls.length).toBeGreaterThan(0);
    });

    it("#4: an older stub form is an update, so the stub is rewritten while Discord is closed", async () => {
        const st = { ...installState("patched-by-us", "subline"), stubForm: "legacy" as const };
        const h = harness({ inspect: { ok: true, value: st }, hasSublineCode: true });
        const first = await h.flow.start();
        expect(first.step).not.toBe("already-installed");
        expect(h.patchCalls.length).toBeGreaterThan(0);
    });

    it("#9: our stub shadowed by BetterDiscord shows the blocked screen saying Subline is installed, and patches nothing", async () => {
        const st = { ...installState("patched-by-us", "subline"), warnings: ["shadowed-by-unpacked-app" as const], shadowedBy: "betterdiscord" as const };
        const h = harness({ inspect: { ok: true, value: st }, hasSublineCode: true });
        const first = await h.flow.start();
        expect(first.step).toBe("betterdiscord-blocked");
        expect(first.detail).toContain("Subline is installed");
        expect(first.detail).toContain("uninstall Subline");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("#30: a stale marker is an update (the patch rewrites only the marker)", async () => {
        const st = { ...installState("patched-by-us", "subline"), warnings: ["marker-stale" as const] };
        const h = harness({ inspect: { ok: true, value: st }, hasSublineCode: true });
        const first = await h.flow.start();
        expect(first.step).not.toBe("already-installed");
        expect(h.patchCalls.length).toBeGreaterThan(0);
    });
});

// Audit #49: the helper's first run must already know the Discord is ours.
describe("the helper's memory is seeded before the helper is registered", () => {
    it("rememberPatchedInstall gets the patch's Discord version and build, before installHelper", async () => {
        const h = harness();
        const order: string[] = [];
        let seen: { discordVersion: string | null; buildId: string } | undefined;
        h.ports.rememberPatchedInstall = (_install, patched) => { order.push("remember"); seen = patched; };
        const realInstall = h.ports.installHelper;
        h.ports.installHelper = async () => { order.push("installHelper"); return realInstall(); };
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        expect(order.indexOf("remember")).toBeGreaterThanOrEqual(0);
        expect(order.indexOf("remember")).toBeLessThan(order.indexOf("installHelper"));
        expect(seen?.buildId).toBe(BUILD_ID);
    });
});

/* ------------------------------------------------------------------------ *
 * Part 2 of the 0.2.3 installer fixes (audit 2026-10-06, field test I5-I7)
 * ------------------------------------------------------------------------ */

const WIN_OLD: DiscordInstall = {
    branch: "stable",
    rootPath: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.1",
    stableId: "C:\\Users\\x\\AppData\\Local\\Discord",
    resourcesPath: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.1\\resources",
    asarPath: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.1\\resources\\app.asar",
    backupPath: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.1\\resources\\_app.asar",
    buildInfoPath: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.1\\resources\\build_info.json",
    fromExplicitPath: false
};
const WIN_NEW: DiscordInstall = {
    ...WIN_OLD,
    rootPath: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.2",
    resourcesPath: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.2\\resources",
    asarPath: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.2\\resources\\app.asar",
    backupPath: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.2\\resources\\_app.asar",
    buildInfoPath: "C:\\Users\\x\\AppData\\Local\\Discord\\app-1.0.2\\resources\\build_info.json"
};

describe("a wrong code shows only its sentence (field test I5)", () => {
    it.each([
        ["not_found", CODE_SCREEN_COPY.errNotFound],
        ["claimed", CODE_SCREEN_COPY.errClaimed],
        ["rate_limited", CODE_SCREEN_COPY.errRateLimited],
        ["net_limited", CODE_SCREEN_COPY.errNetLimited]
    ] as const)("promo %s: CODE_REFUSED, no cause", async (kind, line) => {
        const h = harness({ relayRedeem: { kind } as RedeemAnswer });
        await toDetection(h);
        await h.flow.send({ type: "set-language", code: "tr" });
        const refused = await h.flow.send({ type: "set-code", code: "MYSERVER" });
        expect(refused.step).toBe("choose-code");
        expect(refused.detail.startsWith(line)).toBe(true);
        expect(refused.error?.code).toBe("CODE_REFUSED");
        expect(refused.error?.cause).toBeUndefined();
    });

    it("a code at its computer limit is CODE_REFUSED too", async () => {
        const h = harness({ relayStatus: { kind: "device_limit" } });
        await toDetection(h);
        await h.flow.send({ type: "set-language", code: "tr" });
        const refused = await h.flow.send({ type: "set-code", code: "slp_typedcode" });
        expect(refused.error?.code).toBe("CODE_REFUSED");
    });

    it("an unreachable relay keeps its diagnostics (IO_ERROR with the cause)", async () => {
        const h = harness({ relayRedeem: { kind: "unreachable", cause: "ENOTFOUND relay" } as RedeemAnswer });
        await toDetection(h);
        await h.flow.send({ type: "set-language", code: "tr" });
        const failed = await h.flow.send({ type: "set-code", code: "MYSERVER" });
        expect(failed.error?.code).toBe("IO_ERROR");
        expect(failed.error?.cause).toBe("ENOTFOUND relay");
    });
});

describe("a restart mid-checkout resumes at Activate Subline (field test I6)", () => {
    it("language chosen on an earlier run, no code saved: starts on the activation screen", async () => {
        const h = harness({ pendingLanguage: "tr" });
        const first = await h.flow.start();
        expect(first.step).toBe("choose-code");
        // Activation lands, and the language from the earlier run is the one saved.
        const done = await h.flow.send({ type: "buy-automatic" });
        await h.flow.settled();
        expect(done.step).toBe("done");
        expect(h.languageWrites).toEqual(["tr"]);
        expect(h.pendingClears).toBe(1);
    });

    it("a saved install id is asked about first: a purchase that landed meanwhile goes straight on", async () => {
        const h = harness({ pendingLanguage: "de", savedInstallId: TEST_INSTALL_ID });
        const first = await h.flow.start();
        expect(first.step).toBe("done");
        expect(h.languageWrites).toEqual(["de"]);
        expect(h.opened).toEqual([]);
    });

    it("no pending language: Welcome, as before", async () => {
        const h = harness({ pendingLanguage: null });
        expect((await h.flow.start()).step).toBe("welcome");
    });

    it("a code already saved, or two Discords to choose from: Welcome", async () => {
        expect((await harness({ pendingLanguage: "tr", hasSublineCode: true }).flow.start()).step).toBe("welcome");
        expect((await harness({ pendingLanguage: "tr", installs: { ok: true, value: [INSTALL, PTB_INSTALL] } }).flow.start()).step).toBe("welcome");
    });

    it("choosing a language remembers it until it is saved", async () => {
        const h = harness({ pendingLanguage: null, relayStatus: { kind: "ok", automatic: false, ai: false, code: null } });
        await toDetection(h);
        await h.flow.send({ type: "set-language", code: "ja" });
        expect(h.pendingWrites).toEqual(["ja"]);
        expect(h.languageWrites).toEqual([]);
    });
});

describe("the finish-paying screen (field test I7)", () => {
    it("says to turn a VPN off while paying, and Try again opens a new checkout", async () => {
        const h = harness({ relayStatus: { kind: "ok", automatic: false, ai: false, code: null } });
        await toDetection(h);
        await h.flow.send({ type: "set-language", code: "tr" });
        const pending = h.flow.send({ type: "buy-automatic" });
        for (let i = 0; i < 20 && h.flow.state.step !== "activation-waiting"; i++) await new Promise(r => setTimeout(r, 1));
        expect(h.flow.state.detail).toContain("Using a VPN? Turn it off only while you pay. Discord can stay on.");
        expect(h.flow.state.actions).toEqual(["retry", "back"]);
        const again = h.flow.send({ type: "retry" });
        for (let i = 0; i < 20 && h.opened.length < 2; i++) await new Promise(r => setTimeout(r, 1));
        expect(h.relayCalls.filter(call => call.kind === "checkout")).toHaveLength(2);
        expect(h.opened).toHaveLength(2);
        await h.flow.send({ type: "back" });
        await pending;
        await again;
        expect(h.patchCalls).toHaveLength(0);
    });

    it("a payment already on its way offers Back only (nothing to reopen)", async () => {
        const h = harness({ relayCheckout: { kind: "purchase_pending" } as CheckoutAnswer, relayStatus: { kind: "ok", automatic: false, ai: false, code: null } });
        await toDetection(h);
        await h.flow.send({ type: "set-language", code: "tr" });
        const pending = h.flow.send({ type: "buy-automatic" });
        for (let i = 0; i < 20 && h.flow.state.step !== "activation-waiting"; i++) await new Promise(r => setTimeout(r, 1));
        expect(h.flow.state.actions).toEqual(["back"]);
        await h.flow.send({ type: "back" });
        await pending;
    });
});

describe("an older installer over a newer Subline (audit #12)", () => {
    const older: ModBundle = { ...BUNDLE, buildId: "aaaaaaaaaaaaaaaa", pluginVersion: "0.2.0" };
    const newerOnDisk: ModBundle = { ...BUNDLE, buildId: "bbbbbbbbbbbbbbbb", pluginVersion: "0.2.1" };

    it("never downgrades: says so, patches nothing, installs nothing", async () => {
        const h = harness({
            bundle: { ok: true, value: older },
            installedBundle: { ok: true, value: newerOnDisk },
            inspect: { ok: true, value: updatedInstallState() },
            hasSublineCode: true
        });
        const first = await h.flow.start();
        expect(first.step).toBe("already-installed");
        expect(first.detail).toContain("A newer Subline (0.2.1) is already installed.");
        expect(first.actions).toEqual(["finish"]);
        expect(h.patchCalls).toHaveLength(0);
        expect(h.bundleInstalls).toBe(0);
        expect(h.helperInstalls).toBe(0);
        expect(h.helperEnsures).toBe(0);
        expect(h.logged.some(line => line.event === "flow.newer-installed" && line.fields.installed === "0.2.1" && line.fields.shipped === "0.2.0")).toBe(true);
    });

    it("also when the marker is gone (the stub still names the loader)", async () => {
        const state: InstallState = { ...installState("patched-by-us", "subline"), marker: null, warnings: ["marker-missing"] };
        const h = harness({
            bundle: { ok: true, value: older },
            installedBundle: { ok: true, value: newerOnDisk },
            inspect: { ok: true, value: state },
            hasSublineCode: true
        });
        expect((await h.flow.start()).step).toBe("already-installed");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("an unreadable installed bundle is 'cannot say': the update goes ahead", async () => {
        const h = harness({
            bundle: { ok: true, value: older },
            installedBundle: { ok: false, error: fail("MOD_BUNDLE_INVALID") },
            inspect: { ok: true, value: updatedInstallState() },
            hasSublineCode: true
        });
        await h.flow.start();
        await h.flow.settled();
        expect(h.patchCalls).toHaveLength(1);
    });

    it("the same version with another build id (a dogfood build) updates", async () => {
        const h = harness({
            bundle: { ok: true, value: { ...older, pluginVersion: "0.2.1" } },
            installedBundle: { ok: true, value: newerOnDisk },
            inspect: { ok: true, value: updatedInstallState() },
            hasSublineCode: true
        });
        await h.flow.start();
        await h.flow.settled();
        expect(h.patchCalls).toHaveLength(1);
    });
});

describe("every patched Discord is remembered (audit #15)", () => {
    it("already set up: remembered on the way to the screen", async () => {
        const state: InstallState = { ...installState("patched-by-us", "subline"), marker: { pluginBuildId: BUILD_ID } as InstallState["marker"] };
        const h = harness({ inspect: { ok: true, value: state } });
        expect((await h.flow.start()).step).toBe("already-installed");
        expect(h.remembered).toEqual([INSTALL.rootPath]);
    });

    it("another account's Discord is never remembered", async () => {
        const state: InstallState = { ...installState("patched-by-us", "subline"), loaderPath: "/Users/other/Library/Application Support/Subline/mod/patcher.js" };
        const h = harness({ inspect: { ok: true, value: state } });
        h.ports.isOtherAccountLoader = () => true;
        await h.flow.start();
        await toDetection(h);
        expect(h.remembered).toEqual([]);
    });

    it("Windows staged update: remembered, and the marker written at once when the stub already loads this bundle (audit #11)", async () => {
        const h = harness({
            platform: "win32",
            permission: ["not-required"],
            inspect: { ok: true, value: updatedInstallState() },
            hasSublineCode: true,
            processes: [[WINDOWS_DISCORD_PROCESS]],
            adopt: { ok: true, value: { pluginBuildId: BUILD_ID, discordVersion: "1.0.9044" } }
        });
        const done = await h.flow.start();
        expect(h.remembered).toContain(INSTALL.rootPath);
        expect(h.adoptCalls).toBe(1);
        expect(h.patchCalls).toHaveLength(0);
        expect(done.step).toBe("done");
        expect(done.detail).toContain("It starts the next time you open Discord");
        expect(done.detail).not.toContain("after you close Discord");
    });

    it("Windows staged update where the stub loads another Subline path: stays staged, never fails", async () => {
        const h = harness({
            platform: "win32",
            permission: ["not-required"],
            inspect: { ok: true, value: updatedInstallState() },
            hasSublineCode: true,
            processes: [[WINDOWS_DISCORD_PROCESS]],
            adopt: { ok: false, error: fail("NOT_ADOPTABLE") }
        });
        const done = await h.flow.start();
        expect(done.step).toBe("done");
        expect(done.detail).toContain("finishes on its own after you close Discord");
        expect(h.helperInstalls).toBe(1);
    });
});

describe("Discord moved while the installer waited (audit #23)", () => {
    it("patches and launches the folder Discord runs now, same stable id", async () => {
        const h = harness({
            platform: "win32",
            permission: ["not-required"],
            installs: [{ ok: true, value: [WIN_OLD] }, { ok: true, value: [WIN_OLD] }, { ok: true, value: [WIN_NEW] }]
        });
        await h.flow.start();
        await toDetection(h);
        await setLanguage(h.flow);
        expect(h.patchTargets).toEqual([WIN_NEW.rootPath]);
        expect(h.remembered).toContain(WIN_NEW.rootPath);
        expect(h.launchedTargets).toEqual([WIN_NEW.rootPath]);
        expect(h.logged.some(line => line.event === "patch.target-moved")).toBe(true);
    });

    it("that Discord is gone: a named failure, never a patch of the old folder", async () => {
        const h = harness({
            platform: "win32",
            permission: ["not-required"],
            installs: [{ ok: true, value: [WIN_OLD] }, { ok: true, value: [WIN_OLD] }, { ok: true, value: [] }]
        });
        await h.flow.start();
        await toDetection(h);
        const failed = await setLanguage(h.flow);
        expect(failed.step).toBe("patch-failed");
        expect(failed.error?.code).toBe("DISCORD_MOVED");
        expect(h.patchCalls).toHaveLength(0);
        expect(h.bundleInstalls).toBe(0);
    });
});

describe("patch-failed names the remedy (audit #13, #16)", () => {
    it("FILE_IN_USE right after Discord was seen closed: a scan, not Discord", async () => {
        const h = harness({ platform: "win32", permission: ["not-required"], patch: { ok: false, error: fail("FILE_IN_USE", "Cannot install the new app.asar: another program still has Discord's files open.") } });
        await toDetection(h);
        const failed = await setLanguage(h.flow);
        expect(failed.step).toBe("patch-failed");
        expect(failed.detail).toBe("Another program, often antivirus, is still scanning Discord's files. Wait a few seconds and press Try again.");
    });

    it("a verification failure on the backup says reinstall Discord, not 'report this'", async () => {
        const h = harness({ patch: { ok: false, error: { code: "VERIFICATION_FAILED", message: "The preserved _app.asar is not Discord's original archive. Discord was restored to how it was before.", path: INSTALL.backupPath } } });
        await toDetection(h);
        const failed = await setLanguage(h.flow);
        expect(failed.detail).toContain("Reinstall Discord from discord.com, then run Subline again.");
        expect(failed.detail).not.toContain("Please report this");
    });
});
