/**
 * The LaunchAgent.
 *
 * NOTHING HERE REGISTERS AN AGENT. `plistPath` is a parameter pointing at a temp
 * directory and `launchctl` is a fake, for exactly the reason nothing in this
 * suite writes to `/Applications`: the machine running the tests is somebody's
 * machine.
 *
 * The property most worth holding is spec §2's: the agent must run THE APP with
 * a flag, not a separate binary, because macOS TCC grants attach to a
 * code-signing identity.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    DEFAULT_INTERVAL_SECONDS, HELPER_FLAG, HELPER_LABEL, helperLaunchAgentSpec, helperProgramArguments,
    installLaunchAgent, launchAgentPlistPath, readLaunchAgentPlist, removeLaunchAgent, renderLaunchAgentPlist
} from "../src/helper/launchAgent.js";
import type { LaunchctlPort } from "../src/helper/launchAgent.js";

const UID = 501;

let dir: string;
let plistPath: string;

interface FakeLaunchctl extends LaunchctlPort {
    calls: string[];
    loaded: Set<string>;
    failBootstrap: boolean;
    failBootout: boolean;
    /** Report the label as absent even after a successful bootstrap. */
    lieAboutLoaded: boolean;
}

function fakeLaunchctl(overrides: Partial<FakeLaunchctl> = {}): FakeLaunchctl {
    const fake: FakeLaunchctl = {
        calls: [],
        loaded: new Set<string>(),
        failBootstrap: false,
        failBootout: false,
        lieAboutLoaded: false,
        async bootstrap(path: string, uid: number) {
            fake.calls.push(`bootstrap gui/${uid} ${path}`);
            if (fake.failBootstrap) {
                return { ok: false, error: { code: "HELPER_REGISTRATION_FAILED", message: "launchctl said no" } };
            }
            if (!fake.lieAboutLoaded) fake.loaded.add(HELPER_LABEL);
            return { ok: true, value: true };
        },
        async bootout(label: string, uid: number) {
            fake.calls.push(`bootout gui/${uid}/${label}`);
            if (fake.failBootout) {
                return { ok: false, error: { code: "HELPER_REGISTRATION_FAILED", message: "launchctl refused" } };
            }
            fake.loaded.delete(label);
            return { ok: true, value: true };
        },
        async isLoaded(label: string) {
            return fake.loaded.has(label);
        },
        ...overrides
    };
    return fake;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subline-agent-"));
    plistPath = join(dir, "LaunchAgents", `${HELPER_LABEL}.plist`);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("what the agent is", () => {
    it("runs THE APP with a flag, not a separate binary — TCC grants follow the signing identity", () => {
        const args = helperProgramArguments("/Applications/Subline.app");
        expect(args).toEqual(["/Applications/Subline.app/Contents/MacOS/Subline", HELPER_FLAG]);
        // The executable is inside the app bundle, which is what makes it the
        // same code-signing identity the App Management grant was given to.
        expect(args[0]).toContain("/Applications/Subline.app/");
    });

    it("runs at login AND periodically, per spec §6", () => {
        const spec = helperLaunchAgentSpec("/Applications/Subline.app");
        expect(spec.runAtLoad).toBe(true);
        expect(spec.intervalSeconds).toBe(DEFAULT_INTERVAL_SECONDS);
        expect(spec.label).toBe(HELPER_LABEL);
    });

    it("puts the plist where launchd looks for user agents", () => {
        expect(launchAgentPlistPath("/Users/someone")).toBe(
            "/Users/someone/Library/LaunchAgents/com.subline.helper.plist"
        );
    });
});

describe("the plist", () => {
    it("states the label, the arguments, RunAtLoad and the interval", () => {
        const plist = renderLaunchAgentPlist(helperLaunchAgentSpec("/Applications/Subline.app", 900));

        expect(plist).toContain("<string>com.subline.helper</string>");
        expect(plist).toContain("<string>/Applications/Subline.app/Contents/MacOS/Subline</string>");
        expect(plist).toContain(`<string>${HELPER_FLAG}</string>`);
        expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
        expect(plist).toContain("<integer>900</integer>");
        expect(plist).toContain("<string>Background</string>");
    });

    it("escapes a path launchd would otherwise refuse to parse", () => {
        // `&` and `'` are legal in macOS folder names, and Subline can be dragged
        // anywhere. An unescaped one produces a plist launchd rejects — which
        // presents as "the helper silently never runs".
        const plist = renderLaunchAgentPlist(
            helperLaunchAgentSpec("/Users/a/Bits & Bobs/O'Brien <test>/Subline.app")
        );

        expect(plist).toContain("Bits &amp; Bobs");
        expect(plist).toContain("O&apos;Brien");
        expect(plist).toContain("&lt;test&gt;");
        expect(plist).not.toContain("Bits & Bobs");
    });

    it("writes no launchd log files, which nothing would ever rotate", () => {
        const plist = renderLaunchAgentPlist(helperLaunchAgentSpec("/Applications/Subline.app"));
        expect(plist).not.toContain("StandardOutPath");
        expect(plist).not.toContain("StandardErrorPath");
    });

    it("never emits a zero or negative interval, which launchd treats as unbounded", () => {
        expect(renderLaunchAgentPlist(helperLaunchAgentSpec("/A.app", 0))).toContain("<integer>1</integer>");
        expect(renderLaunchAgentPlist(helperLaunchAgentSpec("/A.app", -5))).toContain("<integer>1</integer>");
    });
});

describe("installing it", () => {
    it("writes the plist and registers it", async () => {
        const launchctl = fakeLaunchctl();
        const result = await installLaunchAgent({
            plistPath,
            spec: helperLaunchAgentSpec("/Applications/Subline.app"),
            uid: UID,
            launchctl,
            platform: "darwin"
        });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.loaded).toBe(true);
        expect(existsSync(plistPath)).toBe(true);
        expect(readLaunchAgentPlist(plistPath)).toContain(HELPER_FLAG);
        expect(launchctl.calls).toEqual([`bootstrap gui/${UID} ${plistPath}`]);
        // Never into the real one.
        expect(plistPath.startsWith(homedir())).toBe(false);
    });

    it("unregisters an existing agent BEFORE rewriting its plist", async () => {
        // `bootstrap` fails on an already-registered label, and a plist rewritten
        // under a running agent leaves launchd holding the old arguments until
        // the next login.
        const launchctl = fakeLaunchctl();
        launchctl.loaded.add(HELPER_LABEL);

        const result = await installLaunchAgent({
            plistPath,
            spec: helperLaunchAgentSpec("/Applications/Subline.app"),
            uid: UID,
            launchctl,
            platform: "darwin"
        });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.replaced).toBe(true);
        expect(launchctl.calls[0]).toBe(`bootout gui/${UID}/${HELPER_LABEL}`);
        expect(launchctl.calls[1]).toContain("bootstrap");
    });

    it("leaves no plist behind when registration fails, so it cannot load at the NEXT login", async () => {
        const launchctl = fakeLaunchctl();
        launchctl.failBootstrap = true;

        const result = await installLaunchAgent({
            plistPath,
            spec: helperLaunchAgentSpec("/Applications/Subline.app"),
            uid: UID,
            launchctl,
            platform: "darwin"
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("HELPER_REGISTRATION_FAILED");
        expect(existsSync(plistPath)).toBe(false);
    });

    it("CONFIRMS the registration instead of trusting launchctl's exit code", async () => {
        // `launchctl load` is a no-op in some contexts and reports success
        // anyway. A registration that silently did not happen is
        // indistinguishable, later, from a helper with nothing to do.
        const launchctl = fakeLaunchctl();
        launchctl.lieAboutLoaded = true;

        const result = await installLaunchAgent({
            plistPath,
            spec: helperLaunchAgentSpec("/Applications/Subline.app"),
            uid: UID,
            launchctl,
            platform: "darwin"
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("does not list it");
    });

    it("refuses on a platform where LaunchAgents are not the mechanism", async () => {
        const launchctl = fakeLaunchctl();
        const result = await installLaunchAgent({
            plistPath,
            spec: helperLaunchAgentSpec("C:/Subline"),
            uid: UID,
            launchctl,
            platform: "win32"
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("Scheduled Task");
        expect(launchctl.calls).toEqual([]);
        expect(existsSync(plistPath)).toBe(false);
    });
});

describe("removing it (spec §8 step 3)", () => {
    it("unregisters before deleting the plist", async () => {
        const launchctl = fakeLaunchctl();
        await installLaunchAgent({
            plistPath,
            spec: helperLaunchAgentSpec("/Applications/Subline.app"),
            uid: UID,
            launchctl,
            platform: "darwin"
        });
        launchctl.calls.length = 0;

        const result = await removeLaunchAgent({ plistPath, label: HELPER_LABEL, uid: UID, launchctl });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toBe(true);
        expect(launchctl.calls).toEqual([`bootout gui/${UID}/${HELPER_LABEL}`]);
        expect(existsSync(plistPath)).toBe(false);
        expect(launchctl.loaded.has(HELPER_LABEL)).toBe(false);
    });

    it("reports 'nothing to remove' rather than failing when it was never installed", async () => {
        const result = await removeLaunchAgent({
            plistPath,
            label: HELPER_LABEL,
            uid: UID,
            launchctl: fakeLaunchctl()
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toBe(false);
    });

    it("KEEPS the plist when unregistering fails, rather than leaving a live agent with no configuration", async () => {
        const launchctl = fakeLaunchctl();
        await installLaunchAgent({
            plistPath,
            spec: helperLaunchAgentSpec("/Applications/Subline.app"),
            uid: UID,
            launchctl,
            platform: "darwin"
        });
        launchctl.failBootout = true;

        const result = await removeLaunchAgent({ plistPath, label: HELPER_LABEL, uid: UID, launchctl });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("HELPER_REGISTRATION_FAILED");
        // The configuration outlives the failure: a running agent whose plist we
        // deleted is one nothing can describe or remove.
        expect(existsSync(plistPath)).toBe(true);
    });

    it("removes a plist left behind with no live agent", async () => {
        const launchctl = fakeLaunchctl();
        await installLaunchAgent({
            plistPath,
            spec: helperLaunchAgentSpec("/Applications/Subline.app"),
            uid: UID,
            launchctl,
            platform: "darwin"
        });
        launchctl.loaded.clear();

        const result = await removeLaunchAgent({ plistPath, label: HELPER_LABEL, uid: UID, launchctl });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toBe(true);
        expect(existsSync(plistPath)).toBe(false);
    });

    it("reads back nothing for a plist that is not there", () => {
        expect(readLaunchAgentPlist(join(dir, "absent.plist"))).toBeNull();
    });
});

describe("this machine", () => {
    it("has no Subline LaunchAgent, because nothing in this suite installs one", () => {
        // A standing gate, not a formality: every `installLaunchAgent` call above
        // is given a temp `plistPath`, and this is what would catch one that was
        // not.
        expect(existsSync(launchAgentPlistPath(homedir()))).toBe(false);
    });
});
