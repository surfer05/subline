/**
 * update-failed must not become a daily notification for the life of the
 * install (audit 2026-10-06 #33). A feed that is gone for good (a corporate
 * proxy, a blocked host) or a manifest this helper can never read is not
 * news every day; the second case also needs its own remedy, because
 * opening this Subline cannot fix it.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installModBundle } from "../src/app/modInstall.js";
import { inspectModBundle } from "../src/bundle/bundle.js";
import type { Alert } from "../src/helper/alerts.js";
import type { HelperPorts, HelperRunReport } from "../src/helper/helper.js";
import { runHelperOnce } from "../src/helper/helper.js";
import { RELEASE_MANIFEST_FORMAT } from "../src/helper/release.js";
import { helperStatePathFor, readHelperState, writeHelperState } from "../src/helper/state.js";
import { err, ok } from "../src/patcher/result.js";
import type { Result } from "../src/patcher/result.js";
import { makeModBundleFixture } from "./fixture.js";

const FEED = "https://github.com/subline/subline/releases/latest/download/subline-release.json";
const SIX_HOURS = 6 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 1, 0, 0, 0);

interface Harness {
    clock: number;
    feed: () => Result<string>;
    notifications: Alert[];
    updateDecisions: string[];
    run(): Promise<HelperRunReport>;
}

let root: string;
let harness: Harness;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subline-update-alerts-"));
    const productDir = join(root, "Subline");
    const runtimeDir = join(productDir, "mod");
    mkdirSync(productDir, { recursive: true });
    const shipped = makeModBundleFixture();
    const installed = installModBundle({ sourceDir: shipped.dir, destDir: runtimeDir });
    if (!installed.ok) throw new Error(installed.error.message);

    const h: Harness = {
        clock: START,
        feed: () => err("NETWORK_ERROR", "offline"),
        notifications: [],
        updateDecisions: [],
        run: async () => runHelperOnce(ports, {})
    };
    const log = {
        info: (event: string, fields?: Record<string, unknown>) => {
            if (event === "helper.update") h.updateDecisions.push(String(fields?.outcome ?? ""));
        },
        warn: () => {},
        error: () => {}
    };
    const ports: HelperPorts = {
        platform: "darwin",
        productVersion: "0.1.0",
        log,
        now: () => h.clock,
        sleep: async ms => { h.clock += ms; },
        productDir,
        modBundleDir: runtimeDir,
        // No Discord at all: only trigger B is under test here.
        locate: () => ok([]),
        inspect: () => err("NOT_A_DISCORD_INSTALL", "unused"),
        readMarker: () => ok(null),
        readDiscordVersion: () => err("IO_ERROR", "unused"),
        verifyPatch: () => err("VERIFICATION_FAILED", "unused"),
        patch: () => err("IO_ERROR", "unused"),
        inspectBundle: dir => inspectModBundle(dir),
        installBundle: () => err("IO_ERROR", "unused"),
        discordRunning: async () => false,
        mtimeOf: () => null,
        readState: () => readHelperState(helperStatePathFor(productDir)),
        writeState: state => writeHelperState(helperStatePathFor(productDir), state),
        releaseManifestUrl: FEED,
        fetchText: async () => h.feed(),
        fetchBinary: async () => err("NETWORK_ERROR", "unused"),
        unpack: async () => err("MOD_BUNDLE_INVALID", "unused"),
        discardUnpacked: () => undefined,
        verifyBeacon: () => { throw new Error("no beacon in this test"); },
        notify: async alert => { h.notifications.push(alert); }
    };
    harness = h;
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

async function runEverySixHours(runs: number): Promise<void> {
    for (let i = 0; i < runs; i += 1) {
        await harness.run();
        harness.clock += SIX_HOURS;
    }
}

const updateFailed = (): Alert[] => harness.notifications.filter(alert => alert.code === "update-failed");

describe("update-failed cadence (audit 2026-10-06 #33)", () => {
    it("a feed that is down for ten days notifies twice, and logs every failure", async () => {
        harness.feed = () => err("NETWORK_ERROR", "offline");
        await runEverySixHours(40);
        expect(updateFailed()).toHaveLength(2);
        expect(harness.updateDecisions.filter(outcome => outcome === "failed")).toHaveLength(40);
    });

    it("a captive portal that flips between refused and an HTML page still notifies at most twice", async () => {
        let call = 0;
        harness.feed = () => (call++ % 2 === 0
            ? err("NETWORK_ERROR", "offline")
            : ok("<!doctype html><html><body>Sign in to the network</body></html>"));
        await runEverySixHours(40);
        expect(updateFailed().length).toBeLessThanOrEqual(2);
        // An HTML page is a malformed feed, not a format this Subline is too old for.
        expect(updateFailed().every(alert => !alert.message.includes("subline.page"))).toBe(true);
    });

    it("a manifest format this Subline cannot read says so on the first run, and names the site", async () => {
        harness.feed = () => ok(JSON.stringify({
            product: "subline",
            format: RELEASE_MANIFEST_FORMAT + 1,
            buildId: "0011223344556677",
            pluginVersion: "9.9.9"
        }));
        await harness.run();
        expect(updateFailed()).toHaveLength(1);
        expect(updateFailed()[0]?.message).toBe(
            "This Subline can no longer read its update feed. Get the new Subline from subline.page."
        );
        expect(updateFailed()[0]?.detail.code).toBe("RELEASE_FORMAT_UNSUPPORTED");
    });
});
