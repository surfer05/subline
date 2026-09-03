/**
 * The install flow, driven end to end without Electron.
 *
 * The happy path gets one test. Everything else here is a failure state,
 * because the happy path is the one thing that gets exercised by hand anyway.
 */

import { describe, expect, it } from "vitest";

import type { AppManagementStatus } from "../src/app/appManagement.js";
import { ACTION_LABELS, IS_PRIMARY } from "../src/app/actions.js";
import { InstallFlow, isConfirmedSuccess } from "../src/app/flow.js";
import type { FlowPorts, FlowState, FlowStep, HelperInstallOutcome } from "../src/app/flow.js";
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
    bundle?: Result<ModBundle>;
    installs?: Result<DiscordInstall[]>;
    inspect?: Result<InstallState> | ((install: DiscordInstall) => Result<InstallState>);
    processes?: Array<Array<{ pid: number; command: string }>>;
    requestQuit?: () => Promise<void>;
    forceQuit?: () => Promise<void>;
    permission?: AppManagementStatus[];
    installBundle?: Result<InstalledModBundle>;
    patch?: Result<PatchReport> | (() => Result<PatchReport>);
    installHelper?: Array<Result<HelperInstallOutcome>>;
    launch?: Result<true>;
    verify?: VerificationReport;
    discordLocale?: string | null;
    setLanguage?: Result<{ path: string; code: string; previous: string | null; created: boolean }>;
    setApiKey?: Result<{ path: string; created: boolean; keyLength: number }>;
    platform?: NodeJS.Platform;
}

interface Harness {
    flow: InstallFlow;
    ports: FlowPorts;
    logged: Array<{ level: string; event: string; fields: Record<string, unknown> }>;
    settingsOpened: number;
    patchCalls: Array<{ modBundleDir: string; overwriteForeignMod: boolean }>;
    languageWrites: string[];
    keyWrites: string[];
    verifyCalls: Array<{ expectedBuildId: string; patchedAt: number; launchedAt: number }>;
    helperInstalls: number;
    launched: number;
    /** The step names, in order, every transition passed through. */
    steps: FlowStep[];
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
        keyWrites: [],
        verifyCalls: [],
        helperInstalls: 0,
        launched: 0,
        steps: []
    } as unknown as Harness;

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
        installModBundle: () =>
            script.installBundle ?? { ok: true, value: { ...BUNDLE, replaced: false } },

        locate: () => script.installs ?? { ok: true, value: [INSTALL] },
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
        openPermissionSettings: async () => { h.settingsOpened += 1; },
        permissionSettingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles",

        discordLocale: () => (script.discordLocale === undefined ? "tr" : script.discordLocale),
        systemLocale: () => "en-GB",
        setApiKey: (key: string) => {
            h.keyWrites.push(key);
            return script.setApiKey ?? {
                ok: true,
                value: { path: "/settings.json", created: false, keyLength: key.trim().length }
            };
        },
        setLanguage: (code: string) => {
            h.languageWrites.push(code);
            return script.setLanguage ?? {
                ok: true,
                value: { path: "/settings.json", code: code.split("-")[0] ?? code, previous: null, created: true }
            };
        },

        patch: (_install, options) => {
            h.patchCalls.push(options);
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
        launchDiscord: async () => {
            h.launched += 1;
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
        permissionTimeoutMs: 100,
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
async function setLanguage(flow: { send: (a: any) => Promise<any> }, code = "tr"): Promise<any> {
    const next = await flow.send({ type: "set-language", code });
    return next.step === "choose-key" ? flow.send({ type: "skip-key" }) : next;
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
        const h = harness({ inspect: { ok: true, value: st } });

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
        expect(seen).not.toContain("choose-key");
        expect(h.patchCalls.length).toBeGreaterThan(0);
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
        const state = await toDetection(h);
        expect(state.step).toBe("discord-running");
        expect(state.actions).toContain("quit-discord");
        expect(state.processes).toHaveLength(1);
        expect(h.patchCalls).toHaveLength(0);
    });

    it("continues once Discord has quit", async () => {
        const h = harness({ processes: [[DISCORD_PROCESS], [DISCORD_PROCESS], []] });
        await toDetection(h);
        const state = await h.flow.send({ type: "quit-discord" });
        expect(state.step).toBe("choose-language");
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
        await toDetection(h);

        const state = await h.flow.send({ type: "quit-discord" });
        expect(forced).toBe(1);
        expect(state.step).toBe("choose-language");
    });

    it("asks before forcing — a Discord that quits politely is never killed", async () => {
        // The escalation is unchanged in substance: force is a fallback, not
        // the first move.
        let forced = 0;
        const h = harness({
            processes: [[DISCORD_PROCESS], [DISCORD_PROCESS], []],
            forceQuit: async () => { forced += 1; }
        });
        await toDetection(h);

        const state = await h.flow.send({ type: "quit-discord" });
        expect(state.step).toBe("choose-language");
        expect(forced).toBe(0);
    });

    it("stops after the forced close also fails, rather than looping", async () => {
        let forced = 0;
        const h = harness({ processes: [[DISCORD_PROCESS]], forceQuit: async () => { forced += 1; } });
        await toDetection(h);

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
        await toDetection(h);

        const blocked = await h.flow.send({ type: "quit-discord" });
        expect(blocked.step).toBe("quit-blocked");

        stillRunning = false;
        const state = await h.flow.send({ type: "recheck" });
        expect(state.step).toBe("choose-language");
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
        await toDetection(h);
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
        const state = await toDetection(h);
        expect(state.step).toBe("choose-language");
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
 * §4 — App Management
 * ------------------------------------------------------------------------ */

describe("the optional key step", () => {
    /**
     * The step exists because the alternative was Vencord's plugin settings
     * inside Discord — dozens of plugins a Subline user never installed, by a
     * path nobody could guess. A setup that ends with the better tier off and
     * no findable way to switch it on has not finished.
     */
    async function toKeyStep(h: Harness) {
        await toDetection(h);
        return h.flow.send({ type: "set-language", code: "tr" });
    }

    it("is offered after the language, before anything is patched", async () => {
        const h = harness();
        const state = await toKeyStep(h);
        expect(state.step).toBe("choose-key");
        expect(state.actions).toEqual(["set-key", "skip-key", "cancel"]);
        // Nothing has been written to Discord yet.
        expect(h.patchCalls).toHaveLength(0);
    });

    it("tells the user where to get one", async () => {
        const h = harness();
        const state = await toKeyStep(h);
        // Without this the step is a text box with no way to fill it.
        expect(state.keySignupUrl).toBeDefined();
    });

    it("saves the key and carries on", async () => {
        const h = harness();
        await toKeyStep(h);
        const state = await h.flow.send({ type: "set-key", key: "gsk_abcdefghijklmnop" });

        expect(h.keyWrites).toEqual(["gsk_abcdefghijklmnop"]);
        expect(state.step).toBe("done");
    });

    it("skipping is a normal answer, not a failure", async () => {
        const h = harness();
        await toKeyStep(h);
        const state = await h.flow.send({ type: "skip-key" });

        expect(h.keyWrites).toEqual([]);
        expect(state.step).toBe("done");
        // Google still translates everything, so this is not an error state.
        expect(state.error).toBeNull();
    });

    it("stays on the step when the key cannot be saved", async () => {
        const h = harness({ setApiKey: { ok: false, error: fail("IO_ERROR", "settings are read-only") } });
        await toKeyStep(h);
        const state = await h.flow.send({ type: "set-key", key: "gsk_x" });

        expect(state.step).toBe("choose-key");
        expect(state.error?.code).toBe("IO_ERROR");
        // Still skippable — a failure to store a key must not trap the install.
        expect(state.actions).toContain("skip-key");
        expect(h.patchCalls).toHaveLength(0);
    });

    it("never puts the key in the log", async () => {
        const h = harness();
        await toKeyStep(h);
        await h.flow.send({ type: "set-key", key: "gsk_SUPERSECRETVALUE" });

        const logged = JSON.stringify(h.logged);
        expect(logged).not.toContain("gsk_SUPERSECRETVALUE");
        // The LENGTH is recorded, which is what distinguishes "pasted" from
        // "pasted half of it" without storing a secret.
        expect(logged).toContain("keyLength");
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
        expect(state.detail).toContain("App Management");
        // Pre-empts macOS's own wording. After the toggle, macOS says Subline
        // cannot "update or delete other applications" until it is quit, and
        // offers Quit & Reopen, because the grant does not reach a running
        // process. A user who has not been warned reads that as malware asking
        // to delete their apps; naming it first makes it an expected step.
        //
        // The previous assertion pinned "do not need to" — from copy promising
        // no quit or restart. A real run disproved that promise, so the promise
        // and the test holding it both had to go.
        expect(state.detail).toContain("choose Later");
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

    it("does not die when the grant never arrives — it offers retry", async () => {
        const h = harness({ permission: ["blocked"] });
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        const state = await h.flow.send({ type: "next" });

        expect(state.step).toBe("permission-blocked");
        expect(state.error?.code).toBe("PERMISSION_DENIED");
        expect(state.actions).toContain("retry");
        expect(state.actions).toContain("open-permission-settings");
        expect(state.detail).toContain("Everything else you have chosen is saved");
    });

    it("retries from where it left off, without redoing the language step", async () => {
        let calls = 0;
        const h = harness();
        h.ports.probePermission = () => (++calls > 12 ? "granted" : "blocked");
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        const blocked = await h.flow.send({ type: "next" });
        expect(blocked.step).toBe("permission-blocked");

        const state = await h.flow.send({ type: "retry" });
        expect(state.step).toBe("done");
        // The language was written once, at the language step. Retrying permission
        // does not re-ask for anything.
        expect(h.languageWrites).toEqual(["tr"]);
    });

    it("can re-open System Settings without leaving the waiting screen", async () => {
        const h = harness({ permission: ["blocked"] });
        await toDetection(h);
        await setLanguage(h.flow, "tr");
        await h.flow.send({ type: "next" });
        const state = await h.flow.send({ type: "open-permission-settings" });
        expect(state.step).toBe("permission-blocked");
        expect(h.settingsOpened).toBe(2);
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
        expect(seen).toContain("verifying");
        expect(seen).toContain("done");
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
        expect(seen.some(s => s.step === "verifying" && s.busy)).toBe(true);
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
            async () => { const h = harness(); seen.push(await h.flow.send({ type: "cancel" })); }
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
