/**
 * The real ports, composed with the real flow, against temp-directory fixtures.
 *
 * This is as close to "it works" as anything can get without launching Electron:
 * a real mod bundle is copied to a real runtime directory, a real Discord
 * fixture is really patched, and the stub inside the resulting `app.asar` is
 * read back to see which path Discord would actually `require()`.
 *
 * Nothing here touches `/Applications` — the search root is a temp directory.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstallFlow, isConfirmedSuccess } from "../src/app/flow.js";
import { PLUGIN_SETTINGS_KEY } from "../src/app/language.js";
import {
    createFlowPorts,
    listProcesses,
    logDirFor,
    openUrl,
    parseTasklistCsv,
    forceQuit,
    requestQuit,
    uninstallPaths
} from "../src/main/ports.js";
import { readMarker } from "../src/patcher/marker.js";
import { readStub } from "../src/patcher/stub.js";
import { makeDiscordFixture, makeFakeLaunchctl, makeModBundleFixture } from "./fixture.js";
import type { FakeLaunchctl, Fixture, ModBundleFixture } from "./fixture.js";

let discord: Fixture;
let modSource: ModBundleFixture;
let appResources: string;
let home: string;
let calls: Array<{ file: string; args: string[] }>;
let launchctl: FakeLaunchctl;

/**
 * The helper's registration, always faked.
 *
 * `home` is a temp directory, so `launchAgentPlistPath(home)` writes the plist
 * there and never to the real `~/Library/LaunchAgents`; `launchctl` is a fake, so
 * nothing is ever registered with launchd on the machine running this suite.
 */
const helperWiring = () => ({ appPath: "/Applications/Subline.app", uid: 501, launchctl });

beforeEach(() => {
    discord = makeDiscordFixture();
    modSource = makeModBundleFixture();
    // Stand in for `Subline.app/Contents/Resources`, with the bundle at `mod/`.
    appResources = mkdtempSync(join(tmpdir(), "subline-appres-"));
    mkdirSync(join(appResources, "mod"), { recursive: true });
    for (const name of ["patcher.js", "preload.js", "renderer.js", "renderer.css", "SOURCE.txt", "LICENSE", "subline-mod.json"]) {
        const from = join(modSource.dir, name);
        if (existsSync(from)) writeFileSync(join(appResources, "mod", name), readFileSync(from));
    }
    home = mkdtempSync(join(tmpdir(), "subline-home-"));
    calls = [];
    launchctl = makeFakeLaunchctl();
});

afterEach(() => {
    discord.cleanup();
    modSource.cleanup();
    rmSync(appResources, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
});

function ports(overrides: { processesStdout?: string } = {}) {
    return createFlowPorts({
        appResourcesPath: appResources,
        productVersion: "0.1.0",
        log: { info: () => {}, warn: () => {}, error: () => {} },
        platform: "darwin",
        env: {},
        home,
        searchRoots: [discord.root],
        helper: helperWiring(),
        exec: async (file: string, args: string[]) => {
            calls.push({ file, args });
            return { stdout: overrides.processesStdout ?? "" };
        }
    });
}

const RUNTIME_MOD_DIR = () => join(home, "Library", "Application Support", "Subline", "mod");


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

describe("the real ports, end to end", () => {
    it("finds, patches and verifies a temp-directory Discord", async () => {
        const flowPorts = ports();
        // The beacon never appears — this fixture has no Discord to run — so
        // verification must NOT confirm. That is the honest outcome, and it is
        // the one this test asserts.
        flowPorts.verifyTimeoutMs = 10;
        flowPorts.verifyPollIntervalMs = 5;

        const flow = new InstallFlow(flowPorts);
        await flow.send({ type: "next" });
        const language = await flow.send({ type: "next" });
        expect(language.step).toBe("choose-language");

        const done = await setLanguage(flow, "tr");
        expect(done.step).toBe("done");
        expect(isConfirmedSuccess(done)).toBe(false);
        expect(done.verification?.status).toBe("not-loaded");
    });

    it("makes Discord require the RUNTIME bundle, not the path inside the app", async () => {
        const flowPorts = ports();
        flowPorts.verifyTimeoutMs = 10;
        flowPorts.verifyPollIntervalMs = 5;
        const flow = new InstallFlow(flowPorts);
        await flow.send({ type: "next" });
        await flow.send({ type: "next" });
        await setLanguage(flow, "tr");

        const stub = readStub(discord.install.asarPath);
        expect(stub.ok).toBe(true);
        if (!stub.ok || stub.value === null) throw new Error("expected a stub");

        // THE assertion this whole design exists for.
        expect(stub.value.loaderPath).toBe(join(RUNTIME_MOD_DIR(), "patcher.js"));
        expect(stub.value.loaderPath?.startsWith(appResources)).toBe(false);
        expect(existsSync(join(RUNTIME_MOD_DIR(), "patcher.js"))).toBe(true);
    });

    it("records the build id it actually installed in the sidecar", async () => {
        const flowPorts = ports();
        flowPorts.verifyTimeoutMs = 10;
        flowPorts.verifyPollIntervalMs = 5;
        const flow = new InstallFlow(flowPorts);
        await flow.send({ type: "next" });
        await flow.send({ type: "next" });
        await setLanguage(flow, "tr");

        const marker = readMarker(discord.install.resourcesPath);
        expect(marker.ok).toBe(true);
        if (!marker.ok || marker.value === null) throw new Error("expected a marker");
        expect(marker.value.pluginBuildId).toBe(modSource.buildId);
        expect(marker.value.loaderPath).toBe(join(RUNTIME_MOD_DIR(), "patcher.js"));
    });

    it("backs up Discord's original archive rather than destroying it", async () => {
        const flowPorts = ports();
        flowPorts.verifyTimeoutMs = 10;
        flowPorts.verifyPollIntervalMs = 5;
        const flow = new InstallFlow(flowPorts);
        await flow.send({ type: "next" });
        await flow.send({ type: "next" });
        await setLanguage(flow, "tr");

        expect(readFileSync(discord.install.backupPath)).toEqual(discord.originalAsar);
    });

    it("writes the chosen language into Vencord's settings, bare", async () => {
        const flowPorts = ports();
        flowPorts.verifyTimeoutMs = 10;
        flowPorts.verifyPollIntervalMs = 5;
        const flow = new InstallFlow(flowPorts);
        await flow.send({ type: "next" });
        await flow.send({ type: "next" });
        await setLanguage(flow, "pt-BR");

        const settingsPath = join(home, "Library", "Application Support", "Vencord", "settings", "settings.json");
        const written = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(written.plugins[PLUGIN_SETTINGS_KEY].targetLang).toBe("pt");
    });

    it("stops at the running-Discord screen when ps reports Discord", async () => {
        const flowPorts = ports({
            processesStdout: `  100 ${join(discord.install.rootPath, "Contents/MacOS/Discord")}\n`
        });
        const flow = new InstallFlow(flowPorts);
        await flow.send({ type: "next" });
        const state = await flow.send({ type: "next" });
        expect(state.step).toBe("discord-running");
        expect(existsSync(RUNTIME_MOD_DIR())).toBe(false);
    });

    it("reports Discord not found when the search root is empty", async () => {
        const empty = mkdtempSync(join(tmpdir(), "subline-empty-"));
        const flowPorts = createFlowPorts({
            appResourcesPath: appResources,
            productVersion: "0.1.0",
            log: { info: () => {}, warn: () => {}, error: () => {} },
            platform: "darwin",
            env: {},
            home,
            searchRoots: [empty],
            helper: helperWiring(),
            exec: async () => ({ stdout: "" })
        });
        const flow = new InstallFlow(flowPorts);
        await flow.send({ type: "next" });
        const state = await flow.send({ type: "next" });
        expect(state.step).toBe("discord-not-found");
        expect(state.actions).toContain("pick-path");
        rmSync(empty, { recursive: true, force: true });
    });

    it("refuses a BetterDiscord install through the real inspector", async () => {
        const bd = makeDiscordFixture({ withUnpackedAppDir: true });
        try {
            const flowPorts = createFlowPorts({
                appResourcesPath: appResources,
                productVersion: "0.1.0",
                log: { info: () => {}, warn: () => {}, error: () => {} },
                platform: "darwin",
                env: {},
                home,
                searchRoots: [bd.root],
                helper: helperWiring(),
                exec: async () => ({ stdout: "" })
            });
            const flow = new InstallFlow(flowPorts);
            await flow.send({ type: "next" });
            const state = await flow.send({ type: "next" });
            expect(state.step).toBe("betterdiscord-blocked");
            expect(state.actions).not.toContain("proceed-over-mod");
            // And nothing was written anywhere.
            expect(existsSync(RUNTIME_MOD_DIR())).toBe(false);
            expect(readFileSync(bd.install.asarPath)).toEqual(bd.originalAsar);
        } finally {
            bd.cleanup();
        }
    });
});

describe("process listing", () => {
    it("parses tasklist CSV", () => {
        const stdout = '"Discord.exe","4321","Console","1","300,000 K"\n"chrome.exe","99","Console","1","1 K"\n';
        expect(parseTasklistCsv(stdout)).toEqual([
            { pid: 4321, command: "Discord.exe" },
            { pid: 99, command: "chrome.exe" }
        ]);
    });

    it("skips tasklist rows that are not processes", () => {
        expect(parseTasklistCsv('\nINFO: no tasks\n"Discord.exe","x"\n')).toEqual([]);
    });

    it("returns an empty list instead of throwing when ps cannot be run", async () => {
        const found = await listProcesses("darwin", async () => { throw new Error("ps missing"); });
        expect(found).toEqual([]);
    });

    it("asks ps for pid and command on macOS", async () => {
        const seen: string[][] = [];
        await listProcesses("darwin", async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; });
        expect(seen[0]).toEqual(["/bin/ps", "-axo", "pid=,comm="]);
    });
});

describe("requestQuit", () => {
    it("uses AppleScript's quit on macOS — the same thing as the menu item", async () => {
        const seen: string[][] = [];
        await requestQuit("stable", "darwin", async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; });
        expect(seen[0]?.[0]).toBe("/usr/bin/osascript");
        expect(seen[0]?.[2]).toBe('tell application "Discord" to quit');
    });

    it("names the branch's own application on PTB and Canary", async () => {
        const seen: string[] = [];
        for (const branch of ["ptb", "canary"] as const) {
            await requestQuit(branch, "darwin", async (_file, args) => { seen.push(args[1] ?? ""); return { stdout: "" }; });
        }
        expect(seen).toEqual(['tell application "Discord PTB" to quit', 'tell application "Discord Canary" to quit']);
    });

    it("never passes /F on Windows — a forced kill loses whatever was being typed", async () => {
        const seen: string[][] = [];
        await requestQuit("stable", "win32", async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; });
        expect(seen[0]).toEqual(["taskkill", "/IM", "Discord.exe"]);
        expect(seen[0]).not.toContain("/F");
    });
});

describe("forceQuit", () => {
    it("passes /F and /T on Windows", async () => {
        const seen: string[][] = [];
        await forceQuit("stable", "win32", async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; });
        // /T as well as /F: Electron's children all share the image name
        // Discord.exe, and leaving one holding app.asar open defeats the patch
        // this quit exists to make possible.
        expect(seen[0]).toEqual(["taskkill", "/F", "/T", "/IM", "Discord.exe"]);
    });

    it("matches the executable name exactly on macOS", async () => {
        const seen: string[][] = [];
        await forceQuit("stable", "darwin", async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; });
        // -x, not a substring match: pkill without it would also kill a shell
        // that merely has "Discord" in its command line.
        expect(seen[0]).toEqual(["/usr/bin/pkill", "-x", "Discord"]);
    });

    it("targets the branch's own process on PTB and Canary", async () => {
        const seen: string[] = [];
        for (const branch of ["ptb", "canary"] as const) {
            // Only the first call is the branch's own process; the second is the
            // shared DiscordSystemHelper, which has no per-branch name.
            await forceQuit(branch, "win32", async (_file, args) => { seen.push(args.at(-1) ?? ""); return { stdout: "" }; });
        }
        expect(seen).toEqual([
            "DiscordPTB.exe", "DiscordSystemHelper.exe",
            "DiscordCanary.exe", "DiscordSystemHelper.exe"
        ]);
    });

    it("also ends DiscordSystemHelper, which /T does not reach", async () => {
        const seen: string[][] = [];
        await forceQuit("stable", "win32", async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; });
        // It is not a child of Discord.exe, so it survives the tree kill and
        // keeps a handle on the app directory we are about to rename inside.
        expect(seen[1]).toEqual(["taskkill", "/F", "/IM", "DiscordSystemHelper.exe"]);
    });

    it("does not fail the whole quit when the helper is not running", async () => {
        // taskkill exits non-zero for "process not found", and most machines
        // never run this helper at all. Treating that as a failed quit would
        // block installs that had nothing wrong with them.
        await expect(forceQuit("stable", "win32", async (_file, args) =>
            args.includes("DiscordSystemHelper.exe")
                ? Promise.reject(new Error("ERROR: not found"))
                : { stdout: "" })).resolves.toBeUndefined();
    });
});

describe("openUrl", () => {
    it("uses open(1) on macOS", async () => {
        const seen: string[][] = [];
        await openUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles", "darwin",
            async (file, args) => { seen.push([file, ...args]); return { stdout: "" }; });
        expect(seen[0]?.[0]).toBe("/usr/bin/open");
    });
});

describe("paths", () => {
    it("puts logs where spec §4 and §5 say", () => {
        expect(logDirFor("darwin", {}, "/Users/x")).toBe("/Users/x/Library/Logs/Subline");
        expect(logDirFor("win32", { LOCALAPPDATA: "C:\\L" }, "/h")).toContain("Subline");
    });

    it("resolves every path uninstall needs, and nulls them on an unsupported platform", () => {
        const mac = uninstallPaths("darwin", {}, "/Users/x");
        expect(mac.modBundleDir).toBe("/Users/x/Library/Application Support/Subline/mod");
        expect(mac.productDir).toBe("/Users/x/Library/Application Support/Subline");
        expect(mac.vencordSettingsPath).toContain("Vencord");

        const linux = uninstallPaths("linux", {}, "/h");
        expect(linux.modBundleDir).toBeNull();
        expect(linux.productDir).toBeNull();
    });
});
