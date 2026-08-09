/**
 * The helper's two wirings: installed by the flow, removed by the uninstaller.
 *
 * ## The hole this closes
 *
 * `helper.md` concern 8: *"No flow state installs the agent. `helper:install` is
 * IPC only; §3 step 8b still has no screen. Until the flow calls it, a fresh
 * install has no helper."*
 *
 * That is a failure with no symptom at install time. Translation works, the
 * beacon confirms, the last screen shows a tick — and then Discord updates six
 * weeks later, the injection is wiped, nothing puts it back, and the product is
 * dead with no error anywhere. Spec §6 names exactly this. So the tests that
 * matter here are the ones that hold "the flow really called it", not the ones
 * that check the plist's contents (`launchAgent.test.ts` already does that).
 *
 * ## Nothing is registered on this machine
 *
 * `launchctl` is a fake and `home` is a temp directory, so `launchAgentPlistPath`
 * resolves inside it. The last test in this file is a standing assertion that the
 * real `~/Library/LaunchAgents` has no Subline agent in it.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstallFlow } from "../src/app/flow.js";
import type { FlowState } from "../src/app/flow.js";
import { uninstall } from "../src/app/uninstall.js";
import { HELPER_FLAG, HELPER_LABEL, launchAgentPlistPath, readLaunchAgentPlist } from "../src/helper/launchAgent.js";
import { HELPER_TASK_NAME } from "../src/helper/scheduledTask.js";
import { installHelperFor, removeHelperFor } from "../src/main/ports.js";
import type { UnpatchReport } from "../src/patcher/patch.js";
import type { Result } from "../src/patcher/result.js";
import { makeFakeLaunchctl, makeFakeSchtasks } from "./fixture.js";
import type { FakeLaunchctl, FakeSchtasks } from "./fixture.js";

const UID = 501;
const APP_PATH = "/Applications/Subline.app";
const WINDOWS_EXE = "C:\\Users\\x\\AppData\\Local\\Programs\\Subline\\Subline.exe";

let home: string;
let launchctl: FakeLaunchctl;
let schtasks: FakeSchtasks;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "subline-wiring-"));
    launchctl = makeFakeLaunchctl();
    schtasks = makeFakeSchtasks();
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

const wiring = () => ({ appPath: APP_PATH, uid: UID, launchctl });

/** The Windows equivalent: an exe path, a scheduler, and a directory we own. */
const windowsWiring = () => ({ ...wiring(), executablePath: WINDOWS_EXE, schtasks, workDir: home });

/* ------------------------------------------------------------------------ *
 * installHelperFor
 * ------------------------------------------------------------------------ */

describe("registering the agent", () => {
    it("writes the plist under the given home and registers it", async () => {
        const result = await installHelperFor(wiring(), "darwin", home);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);

        expect(result.value.applicable).toBe(true);
        expect(result.value.installed).toBe(true);
        expect(result.value.label).toBe(HELPER_LABEL);
        expect(result.value.path).toBe(launchAgentPlistPath(home));
        expect(existsSync(launchAgentPlistPath(home))).toBe(true);
    });

    it("registers THE APP with a flag, not a second binary", async () => {
        await installHelperFor(wiring(), "darwin", home);
        const plist = readLaunchAgentPlist(launchAgentPlistPath(home)) ?? "";
        // Spec §2: macOS TCC grants attach to a code-signing identity, so the
        // helper must be the same bundle the user granted App Management to.
        expect(plist).toContain(`${APP_PATH}/Contents/MacOS/Subline`);
        expect(plist).toContain(HELPER_FLAG);
    });

    it("reports `installed` from launchctl's own answer, not from the bootstrap's exit code", async () => {
        // A bootstrap that reports success and registers nothing is
        // indistinguishable later from a helper with nothing to do.
        launchctl.lieAboutLoaded = true;
        const result = await installHelperFor(wiring(), "darwin", home);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected a refusal");
        expect(result.error.code).toBe("HELPER_REGISTRATION_FAILED");
    });

    it("surfaces a launchctl refusal as a named error", async () => {
        launchctl.failBootstrap = true;
        const result = await installHelperFor(wiring(), "darwin", home);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected a refusal");
        expect(result.error.code).toBe("HELPER_REGISTRATION_FAILED");
        // And it left nothing half-registered.
        expect(existsSync(launchAgentPlistPath(home))).toBe(false);
    });

    it("registers a Scheduled Task on Windows", async () => {
        // This used to assert `applicable: false`, on the grounds that the
        // Scheduled Task was not built yet — which made a gap look like a
        // decision. Every Windows install silently had no helper, and would
        // stop translating the first time Discord updated itself into a new
        // app-1.0.xxxx directory, with no marker and no error anywhere.
        const result = await installHelperFor(windowsWiring(), "win32", home);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);

        expect(result.value.applicable).toBe(true);
        expect(result.value.installed).toBe(true);
        expect(result.value.label).toBe(HELPER_TASK_NAME);
        expect(schtasks.registered.has(HELPER_TASK_NAME)).toBe(true);

        // Nothing macOS-shaped happened on the way.
        expect(existsSync(launchAgentPlistPath(home))).toBe(false);
        expect(launchctl.calls).toEqual([]);
    });

    it("registers a task that runs the running executable with the helper flag", async () => {
        await installHelperFor(windowsWiring(), "win32", home);
        const xml = schtasks.lastXml ?? "";
        expect(xml).toContain(`<Command>${WINDOWS_EXE}</Command>`);
        expect(xml).toContain(`<Arguments>${HELPER_FLAG}</Arguments>`);
        // Without the repetition the task runs only at logon, and a machine
        // left on for a fortnight never repairs a Discord that updated on day one.
        expect(xml).toContain("<Interval>PT1H</Interval>");
        // The half that repairs a Discord which updated while the machine was off.
        expect(xml).toContain("<LogonTrigger>");
        expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    });

    it("writes the task XML as UTF-16 with a BOM, matching its own declaration", async () => {
        await installHelperFor(windowsWiring(), "win32", home);
        // The fake decodes UTF-16LE only when it finds the BOM, so a readable
        // document here IS the encoding assertion. `schtasks /XML` rejects UTF-8
        // on several Windows builds with nothing but "the task XML is
        // malformed", and a registration that fails on some machines but not
        // others is the worst kind to be handed.
        expect(schtasks.lastXml).toContain('encoding="UTF-16"');
        expect(schtasks.lastXml).toContain('<Task version="1.2"');
    });

    it("reports failure when Windows does not list the task it just created", async () => {
        schtasks.lieAboutRegistered = true;
        const result = await installHelperFor(windowsWiring(), "win32", home);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected a refusal");
        // Same standard as the LaunchAgent: the query afterwards decides, never
        // the create's own exit code.
        expect(result.error.code).toBe("HELPER_REGISTRATION_FAILED");
    });

    it("fails loudly when the scheduler is not wired up at all", async () => {
        // `applicable: false` here would be a lie — Windows HAS the mechanism —
        // and it is exactly the shape the old bug took.
        const result = await installHelperFor(wiring(), "win32", home);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected a refusal");
        expect(result.error.code).toBe("HELPER_REGISTRATION_FAILED");
    });

    it("leaves no task XML behind after registering", async () => {
        await installHelperFor(windowsWiring(), "win32", home);
        // A stale definition sitting beside a live task is a file whose reader
        // has no way to tell whether it is what is actually registered.
        expect(existsSync(join(home, "subline-helper-task.xml"))).toBe(false);
    });
});

/* ------------------------------------------------------------------------ *
 * removeHelperFor
 * ------------------------------------------------------------------------ */

describe("removing the agent", () => {
    it("unregisters and deletes the plist, and reports it removed", async () => {
        await installHelperFor(wiring(), "darwin", home);
        const removal = await removeHelperFor(wiring(), "darwin", home);

        expect(removal).toEqual({ applicable: true, removed: true, error: null });
        expect(existsSync(launchAgentPlistPath(home))).toBe(false);
        expect(launchctl.loaded.has(HELPER_LABEL)).toBe(false);
    });

    it("is honest when there was nothing to remove", async () => {
        const removal = await removeHelperFor(wiring(), "darwin", home);
        expect(removal).toEqual({ applicable: true, removed: false, error: null });
    });

    it("reports the failure rather than swallowing it, so uninstall can refuse", async () => {
        await installHelperFor(wiring(), "darwin", home);
        launchctl.failBootout = true;
        const removal = await removeHelperFor(wiring(), "darwin", home);

        expect(removal.removed).toBe(false);
        expect(removal.error?.code).toBe("HELPER_REGISTRATION_FAILED");
        // The plist is deliberately LEFT: a running agent with no configuration
        // is worse than a registered one.
        expect(existsSync(launchAgentPlistPath(home))).toBe(true);
    });

    it("deletes the Scheduled Task on Windows", async () => {
        await installHelperFor(windowsWiring(), "win32", home);
        expect(schtasks.registered.has(HELPER_TASK_NAME)).toBe(true);

        const removal = await removeHelperFor(windowsWiring(), "win32", home);
        expect(removal.applicable).toBe(true);
        expect(removal.removed).toBe(true);
        expect(removal.error).toBeNull();
        // An uninstalled product whose task is still scheduled puts Discord
        // straight back at the next interval — the same ordering hazard
        // `uninstall.ts` names for the LaunchAgent.
        expect(schtasks.registered.has(HELPER_TASK_NAME)).toBe(false);
    });

    it("reports `removed: false` on Windows when there was no task, not a failure", async () => {
        // The honest answer for an uninstall run twice.
        const removal = await removeHelperFor(windowsWiring(), "win32", home);
        expect(removal.applicable).toBe(true);
        expect(removal.removed).toBe(false);
        expect(removal.error).toBeNull();
    });

    it("surfaces a scheduler refusal rather than reporting a clean removal", async () => {
        await installHelperFor(windowsWiring(), "win32", home);
        schtasks.failRemove = true;
        const removal = await removeHelperFor(windowsWiring(), "win32", home);
        expect(removal.removed).toBe(false);
        expect(removal.error?.code).toBe("HELPER_REGISTRATION_FAILED");
    });
});

/* ------------------------------------------------------------------------ *
 * The ordering uninstall depends on
 * ------------------------------------------------------------------------ */

describe("uninstall consumes what removeHelperFor produces", () => {
    const log = { info: () => {}, warn: () => {}, error: () => {} };

    function unpatchPorts(): Parameters<typeof uninstall>[0] {
        return {
            unpatch: (): Result<UnpatchReport> => ({
                ok: true,
                value: {
                    install: {
                        branch: "stable",
                        rootPath: "/x",
                        resourcesPath: "/x/r",
                        asarPath: "/x/r/app.asar",
                        backupPath: "/x/r/_app.asar",
                        buildInfoPath: "/x/r/build_info.json",
                        fromExplicitPath: false
                    },
                    restored: true,
                    alreadyClean: false,
                    removedArtifacts: [],
                    previousState: "patched-by-us",
                    summary: "restored"
                }
            }),
            modBundleDir: null,
            productDir: null,
            vencordSettingsPath: null,
            log
        };
    }

    const INSTALL = {
        branch: "stable" as const,
        rootPath: "/x",
        resourcesPath: "/x/r",
        asarPath: "/x/r/app.asar",
        backupPath: "/x/r/_app.asar",
        buildInfoPath: "/x/r/build_info.json",
        fromExplicitPath: false
    };

    it("proceeds when the agent really was unregistered", async () => {
        await installHelperFor(wiring(), "darwin", home);
        const helper = await removeHelperFor(wiring(), "darwin", home);
        const report = uninstall(unpatchPorts(), { installs: [INSTALL], helper });
        expect(report.helperStopped).toBe(true);
        expect(report.discordRestored).toBe(true);
    });

    it("ABORTS with nothing changed when the agent could not be stopped", async () => {
        await installHelperFor(wiring(), "darwin", home);
        launchctl.failBootout = true;
        const helper = await removeHelperFor(wiring(), "darwin", home);

        const report = uninstall(unpatchPorts(), { installs: [INSTALL], helper });
        // Restoring Discord's original archive under a live agent would have the
        // helper put the patch straight back at the next interval — software the
        // user removed, still modifying another application.
        expect(report.helperStopped).toBe(false);
        expect(report.restores).toEqual([]);
        expect(report.discordRestored).toBe(false);
        expect(report.clean).toBe(false);
    });
});

/* ------------------------------------------------------------------------ *
 * The flow actually calls it — concern 8, closed
 * ------------------------------------------------------------------------ */

describe("the install flow installs the helper", () => {
    interface Harness {
        flow: InstallFlow;
        steps: string[];
        helperCalls: number;
        launched: number;
    }

    function harness(script: { helper?: Array<Result<import("../src/app/flow.js").HelperInstallOutcome>> } = {}): Harness {
        const h: Harness = { steps: [], helperCalls: 0, launched: 0 } as unknown as Harness;
        let call = 0;
        const install = INSTALL_FIXTURE;

        const ports = {
            platform: "darwin" as NodeJS.Platform,
            productVersion: "0.1.0",
            log: { info: () => {}, warn: () => {}, error: () => {} },
            now: () => 1000,
            sleep: async () => {},
            inspectShippedBundle: () => ({ ok: true as const, value: BUNDLE }),
            installModBundle: () => ({ ok: true as const, value: { ...BUNDLE, replaced: false } }),
            locate: () => ({ ok: true as const, value: [install] }),
            inspect: () => ({ ok: true as const, value: STATE }),
            listProcesses: async () => [],
            requestQuit: async () => {},
            probePermission: () => "granted" as const,
            openPermissionSettings: async () => {},
            permissionSettingsUrl: "x-apple.systempreferences:",
            discordLocale: () => "en",
            systemLocale: () => "en",
            setLanguage: (code: string) => ({
                ok: true as const,
                value: { path: "/s.json", code, previous: null, created: true }
            }),
            patch: () => ({ ok: true as const, value: PATCH }),
            installHelper: async () => {
                h.helperCalls += 1;
                const scripted = script.helper;
                if (scripted === undefined) {
                    return { ok: true as const, value: { applicable: true, installed: true, label: HELPER_LABEL, path: "/p" } };
                }
                return scripted[Math.min(call++, scripted.length - 1)] as Result<import("../src/app/flow.js").HelperInstallOutcome>;
            },
            launchDiscord: async () => { h.launched += 1; return { ok: true as const, value: true as const }; },
            verify: async () => VERIFICATION,
            verifyTimeoutMs: 10,
            verifyPollIntervalMs: 5
        };

        h.flow = new InstallFlow(ports as unknown as ConstructorParameters<typeof InstallFlow>[0]);
        h.flow.onChange = (state: FlowState) => { h.steps.push(state.step); };
        return h;
    }

    async function toDone(h: Harness): Promise<FlowState> {
        await h.flow.send({ type: "next" });
        await h.flow.send({ type: "next" });
        return h.flow.send({ type: "set-language", code: "en" });
    }

    it("registers it once, between patching and launching", async () => {
        const h = harness();
        const done = await toDone(h);

        expect(h.helperCalls).toBe(1);
        expect(done.step).toBe("done");
        // The ORDER is the assertion. After the patch, because there is nothing
        // to re-patch before it; before the launch, because the launch and the
        // verification are minutes of watching Discord start and a step after the
        // last screen is a step everybody skips.
        const order = h.steps.filter(step => ["patching", "installing-helper", "launching", "done"].includes(step));
        expect(order).toEqual(["patching", "installing-helper", "launching", "done"]);
    });

    it("carries the outcome to the last screen, so `it will not repair itself` is visible", async () => {
        const h = harness();
        const done = await toDone(h);
        expect(done.helper).toEqual({ applicable: true, installed: true, label: HELPER_LABEL, path: "/p" });
    });

    it("stops on a named screen when registration fails, and does NOT launch", async () => {
        const h = harness({
            helper: [{ ok: false, error: { code: "HELPER_REGISTRATION_FAILED", message: "launchctl refused." } }]
        });
        const state = await toDone(h);

        expect(state.step).toBe("helper-failed");
        expect(state.error?.code).toBe("HELPER_REGISTRATION_FAILED");
        expect(h.launched).toBe(0);
        // Translation is installed and works; what is missing is the repair.
        expect(state.detail).toContain("will work");
    });

    it("offers a retry that re-runs ONLY the helper, never the patch", async () => {
        const h = harness({
            helper: [
                { ok: false, error: { code: "HELPER_REGISTRATION_FAILED", message: "launchctl refused." } },
                { ok: true, value: { applicable: true, installed: true, label: HELPER_LABEL, path: "/p" } }
            ]
        });
        const failed = await toDone(h);
        expect(failed.actions).toEqual(["retry", "skip-helper", "cancel"]);

        const done = await h.flow.send({ type: "retry" });
        expect(done.step).toBe("done");
        expect(h.helperCalls).toBe(2);
        // Discord was patched once. Repeating a successful write into another
        // application because a background agent would not register is a worse
        // failure than the one being retried.
        expect(h.steps.filter(step => step === "patching")).toHaveLength(1);
    });

    it("lets the user finish without it, because translation genuinely works", async () => {
        const h = harness({
            helper: [{ ok: false, error: { code: "HELPER_REGISTRATION_FAILED", message: "launchctl refused." } }]
        });
        await toDone(h);
        const done = await h.flow.send({ type: "skip-helper" });

        expect(done.step).toBe("done");
        expect(h.launched).toBe(1);
        // And the last screen does NOT claim a helper that was never installed.
        expect(done.helper).toBeUndefined();
    });

    it("carries on when there is no helper to install on this platform", async () => {
        const h = harness({
            helper: [{ ok: true, value: { applicable: false, installed: false, label: null, path: null } }]
        });
        const done = await toDone(h);
        expect(done.step).toBe("done");
        expect(done.helper?.applicable).toBe(false);
    });
});

/* ------------------------------------------------------------------------ *
 * The standing assertion
 * ------------------------------------------------------------------------ */

/**
 * The real agent's state, sampled at IMPORT — before any test in this file has
 * run. `null` when there is none.
 */
function realAgentFingerprint(): string | null {
    const path = launchAgentPlistPath(homedir());
    if (!existsSync(path)) return null;
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
}
const REAL_AGENT_BEFORE = realAgentFingerprint();

describe("this suite does not install anything", () => {
    it("leaves the real ~/Library/LaunchAgents exactly as it found it", () => {
        // Asserts the suite CHANGED nothing, rather than that no agent exists.
        // Demanding an empty path made the suite fail as soon as the real
        // installer was run on this machine — an assertion about the
        // developer's environment rather than about this code.
        expect(realAgentFingerprint()).toBe(REAL_AGENT_BEFORE);
    });
});

/* ---- fixtures used by the flow harness ---------------------------------- */

const INSTALL_FIXTURE = {
    branch: "stable" as const,
    rootPath: "/Applications/Discord.app",
    resourcesPath: "/Applications/Discord.app/Contents/Resources",
    asarPath: "/Applications/Discord.app/Contents/Resources/app.asar",
    backupPath: "/Applications/Discord.app/Contents/Resources/_app.asar",
    buildInfoPath: "/Applications/Discord.app/Contents/Resources/build_info.json",
    fromExplicitPath: false
};

const BUNDLE = {
    dir: "/mod",
    loaderPath: "/mod/patcher.js",
    buildId: "1f2e3d4c5b6a7980",
    pluginVersion: "0.1.0",
    vencordCommit: "1a8c3b71bbfaeb195a7f402458b6b68b0ccea7ef",
    vencordVersion: "1.15.0",
    builtAt: "2026-08-06T12:00:00.000Z",
    manifest: {}
} as unknown as import("../src/bundle/bundle.js").ModBundle;

const STATE = {
    kind: "unpatched" as const,
    install: INSTALL_FIXTURE,
    mod: null,
    modName: null,
    loaderPath: null,
    asarIsStub: false,
    hasBackup: true,
    marker: null,
    reason: null,
    warnings: [],
    summary: "unpatched"
};

const PATCH = {
    install: INSTALL_FIXTURE,
    loaderPath: "/mod/patcher.js",
    pluginBuildId: "1f2e3d4c5b6a7980",
    backupPath: INSTALL_FIXTURE.backupPath,
    markerPath: `${INSTALL_FIXTURE.resourcesPath}/subline-patch.json`,
    backupCreated: true,
    alreadyPatched: false,
    replacedMod: null,
    discordVersion: "0.0.406",
    previousState: "unpatched" as const,
    bundle: BUNDLE
};

const VERIFICATION = {
    status: "translating-approx" as const,
    confirmed: true,
    loaded: true,
    pending: false,
    stale: false,
    identity: "match" as const,
    tier: "approx" as const,
    errorCode: null,
    beacon: null,
    problem: null,
    summary: "confirmed"
};
