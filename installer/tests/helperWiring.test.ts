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

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstallFlow } from "../src/app/flow.js";
import type { FlowState } from "../src/app/flow.js";
import { uninstall } from "../src/app/uninstall.js";
import { HELPER_FLAG, HELPER_LABEL, launchAgentPlistPath, readLaunchAgentPlist } from "../src/helper/launchAgent.js";
import { installHelperFor, removeHelperFor } from "../src/main/ports.js";
import type { UnpatchReport } from "../src/patcher/patch.js";
import type { Result } from "../src/patcher/result.js";
import { makeFakeLaunchctl } from "./fixture.js";
import type { FakeLaunchctl } from "./fixture.js";

const UID = 501;
const APP_PATH = "/Applications/Subline.app";

let home: string;
let launchctl: FakeLaunchctl;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "subline-wiring-"));
    launchctl = makeFakeLaunchctl();
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

const wiring = () => ({ appPath: APP_PATH, uid: UID, launchctl });

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

    it("says `not applicable` on Windows rather than failing", async () => {
        // Spec §5's Scheduled Task is not built. A named error here would put a
        // warning screen in front of every Windows user for something that is not
        // wrong with their machine.
        const result = await installHelperFor(wiring(), "win32", home);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.value.applicable).toBe(false);
        expect(result.value.installed).toBe(false);
        expect(existsSync(launchAgentPlistPath(home))).toBe(false);
        expect(launchctl.calls).toEqual([]);
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

    it("is `not applicable` on Windows, which uninstall reads as `no precondition`", async () => {
        const removal = await removeHelperFor(wiring(), "win32", home);
        expect(removal).toEqual({ applicable: false, removed: false, error: null });
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

describe("this suite does not install anything", () => {
    it("leaves the real ~/Library/LaunchAgents without a Subline agent", () => {
        expect(existsSync(launchAgentPlistPath(homedir()))).toBe(false);
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
