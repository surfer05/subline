/**
 * The helper, end to end (spec §6).
 *
 * These run the REAL patcher against temp-directory Discord fixtures — real
 * renames on real files — and the REAL beacon reader against a real status file.
 * Only the things that would touch the machine are seams: the clock, the process
 * table, the network, the unpacker and the notifier. Nothing here reads
 * `/Applications`, opens a socket, or registers a LaunchAgent.
 *
 * The two triggers are spec §6's, and the reason there are two is that only one
 * of the failures is repairable by re-patching.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installModBundle } from "../src/app/modInstall.js";
import { inspectModBundle } from "../src/bundle/bundle.js";
import { RELEASE_MANIFEST_FORMAT } from "../src/helper/release.js";
import { runHelperOnce } from "../src/helper/helper.js";
import type { HelperPorts, HelperRunOptions, HelperRunReport } from "../src/helper/helper.js";
import { helperStatePathFor, readHelperState, writeHelperState } from "../src/helper/state.js";
import type { Alert } from "../src/helper/alerts.js";
import { readPendingAlerts } from "../src/helper/alerts.js";
import type { DiscordInstall } from "../src/patcher/locate.js";
import { readMarker } from "../src/patcher/marker.js";
import { patchInstall, verifyPatch } from "../src/patcher/patch.js";
import { err, ok } from "../src/patcher/result.js";
import type { Result } from "../src/patcher/result.js";
import { inspectInstall } from "../src/patcher/state.js";
import { readStub } from "../src/patcher/stub.js";
import { readDiscordVersion } from "../src/patcher/version.js";
import { verifyOnce } from "../src/verify/verify.js";
import { buildOriginalDiscordAsar, makeDiscordFixture, makeModBundleFixture } from "./fixture.js";
import type { Fixture, ModBundleFixture } from "./fixture.js";

const PRODUCT_VERSION = "0.1.0";
const START = Date.parse("2026-08-07T09:00:00.000Z");
const FEED = "https://github.com/subline/subline/releases/latest/download/subline-release.json";
const ARTIFACT = "https://github.com/subline/subline/releases/download/v0.2.0/subline-mod.zip";

/** Small enough that the tests do not wait, real enough that the logic runs. */
const FAST_SETTLE = { quietMs: 1_000, confirmMs: 100, pollMs: 200, maxWaitMs: 2_000 };

interface Harness {
    ports: HelperPorts;
    fixture: Fixture;
    shipped: ModBundleFixture;
    runtimeDir: string;
    productDir: string;
    beaconPath: string;
    /** Everything the log was told, as `event outcome` strings. */
    logged: string[];
    notifications: Alert[];
    /** Set to make the process table say Discord is open. */
    discordOpen: boolean;
    /**
     * When Resources was last written, as an ABSOLUTE instant. Absolute rather
     * than "n ms ago" on purpose: the settle check compares two samples taken a
     * moment apart, and a relative mtime would move between them and look like
     * an update landing when nothing had happened.
     */
    resourcesWrittenAt: number;
    /** Set to make every sample say Resources is being written right now. */
    resourcesAlwaysBusy: boolean;
    /** What the feed serves, or a failure. */
    feed: Result<string>;
    download: Result<Uint8Array>;
    /** The bundle a successful download unpacks to. */
    nextBundle: ModBundleFixture | null;
    unpacked: string[];
    clock: number;
    advance(ms: number): void;
    run(options?: HelperRunOptions): Promise<HelperRunReport>;
    cleanup(): void;
}

function makeHarness(): Harness {
    const root = mkdtempSync(join(tmpdir(), "subline-helper-"));
    const fixture = makeDiscordFixture();
    const shipped = makeModBundleFixture();
    const productDir = join(root, "Subline");
    const runtimeDir = join(productDir, "mod");
    mkdirSync(productDir, { recursive: true });

    const installed = installModBundle({ sourceDir: shipped.dir, destDir: runtimeDir });
    if (!installed.ok) throw new Error(`fixture bundle did not install: ${installed.error.message}`);

    const harness: Partial<Harness> = {
        fixture,
        shipped,
        runtimeDir,
        productDir,
        beaconPath: join(productDir, "status.json"),
        logged: [],
        notifications: [],
        discordOpen: false,
        resourcesWrittenAt: START - 10 * 60_000,
        resourcesAlwaysBusy: false,
        feed: err("NETWORK_ERROR", "no feed configured in this test"),
        download: err("NETWORK_ERROR", "no download configured in this test"),
        nextBundle: null,
        unpacked: [],
        clock: START
    };

    const log = {
        info: (event: string, fields?: Record<string, unknown>) =>
            harness.logged?.push(`${event} ${String(fields?.outcome ?? "")}`.trim()),
        warn: (event: string, fields?: Record<string, unknown>) =>
            harness.logged?.push(`${event} ${String(fields?.outcome ?? "")}`.trim()),
        error: (event: string, fields?: Record<string, unknown>) =>
            harness.logged?.push(`${event} ${String(fields?.outcome ?? "")}`.trim())
    };

    const ports: HelperPorts = {
        platform: "darwin",
        productVersion: PRODUCT_VERSION,
        log,
        now: () => harness.clock ?? START,
        sleep: async (ms: number) => {
            harness.clock = (harness.clock ?? START) + ms;
        },

        productDir,
        modBundleDir: runtimeDir,

        locate: () => ok([fixture.install]),
        inspect: install => inspectInstall(install),
        readMarker: resourcesPath => readMarker(resourcesPath),
        readDiscordVersion: install => readDiscordVersion(install),
        verifyPatch: (install, expected) => verifyPatch(install, expected),
        patch: (install, options) =>
            patchInstall(install, { modBundleDir: options.modBundleDir, productVersion: PRODUCT_VERSION }),

        inspectBundle: dir => inspectModBundle(dir),
        installBundle: sourceDir => installModBundle({ sourceDir, destDir: runtimeDir }),

        discordRunning: async () => harness.discordOpen ?? false,
        mtimeOf: () =>
            harness.resourcesAlwaysBusy === true
                ? (harness.clock ?? START)
                : (harness.resourcesWrittenAt ?? START),

        readState: () => readHelperState(helperStatePathFor(productDir)),
        writeState: state => writeHelperState(helperStatePathFor(productDir), state),

        releaseManifestUrl: FEED,
        fetchText: async () => harness.feed ?? err("NETWORK_ERROR", "unset"),
        fetchBinary: async () => harness.download ?? err("NETWORK_ERROR", "unset"),
        unpack: async () => {
            const next = harness.nextBundle;
            if (next === null || next === undefined) {
                return err("MOD_BUNDLE_INVALID", "the archive contained no bundle");
            }
            harness.unpacked?.push(next.dir);
            return ok(next.dir);
        },
        discardUnpacked: () => undefined,

        verifyBeacon: options => verifyOnce({ ...options, beaconPath: harness.beaconPath as string }),
        notify: async alert => {
            harness.notifications?.push(alert);
        }
    };

    harness.ports = ports;
    harness.advance = (ms: number) => {
        harness.clock = (harness.clock ?? START) + ms;
    };
    harness.run = (options: HelperRunOptions = {}) =>
        runHelperOnce(ports, { settle: FAST_SETTLE, ...options });
    harness.cleanup = () => {
        fixture.cleanup();
        shipped.cleanup();
        harness.nextBundle?.cleanup();
        rmSync(root, { recursive: true, force: true });
    };

    return harness as Harness;
}

/** Patch the fixture for real, so the helper starts from an install it owns. */
function patchForReal(harness: Harness): void {
    const result = patchInstall(harness.fixture.install, {
        modBundleDir: harness.runtimeDir,
        productVersion: PRODUCT_VERSION
    });
    if (!result.ok) throw new Error(`fixture patch failed: ${result.error.message}`);
}

/**
 * What a Discord update leaves behind: a fresh `app.asar`, no backup, no marker,
 * and a new version in `build_info.json`. Exactly the state that removed Vencord
 * from this project's own machine.
 */
function simulateDiscordUpdate(install: DiscordInstall, version: string): void {
    writeFileSync(install.asarPath, buildOriginalDiscordAsar(version));
    if (existsSync(install.backupPath)) unlinkSync(install.backupPath);
    const markerPath = join(install.resourcesPath, "subline-patch.json");
    if (existsSync(markerPath)) unlinkSync(markerPath);
    writeFileSync(install.buildInfoPath, JSON.stringify({ releaseChannel: "stable", version }), "utf8");
}

function writeBeacon(path: string, buildId: string, fields: Record<string, unknown>): void {
    writeFileSync(
        path,
        JSON.stringify({
            product: "subline",
            format: 2,
            pluginVersion: "0.1.0",
            buildId,
            loadedAt: new Date(START).toISOString(),
            updatedAt: new Date(START).toISOString(),
            lastTranslationAt: null,
            lastRenderedAt: null,
            lastEngine: null,
            counts: { approx: 0, upgraded: 0 },
            lastError: null,
            ...fields
        }),
        "utf8"
    );
}

function releaseDocument(buildId: string, bytes: Uint8Array): string {
    return JSON.stringify({
        format: RELEASE_MANIFEST_FORMAT,
        product: "subline",
        buildId,
        pluginVersion: "0.2.0",
        publishedAt: "2026-08-07T00:00:00.000Z",
        artifact: {
            name: "subline-mod.zip",
            url: ARTIFACT,
            bytes: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex")
        }
    });
}

let harness: Harness;

beforeEach(() => {
    harness = makeHarness();
});

afterEach(() => {
    harness.cleanup();
});

/* ------------------------------------------------------------------------ *
 * Trigger A
 * ------------------------------------------------------------------------ */

describe("trigger A — Discord updated and wiped the injection", () => {
    it("does nothing to a healthy install, and records what it saw", async () => {
        patchForReal(harness);
        const report = await harness.run();

        expect(report.managed).toBe(1);
        expect(report.repatched).toEqual([]);
        expect(report.failed).toEqual([]);
        expect(harness.logged).toContain("helper.repatch not-needed");
        expect(readHelperState(helperStatePathFor(harness.productDir)).installs[harness.fixture.install.rootPath])
            .toMatchObject({ discordVersion: "0.0.406" });
    });

    it("re-patches after an update wiped the injection, and says the version changed", async () => {
        patchForReal(harness);
        await harness.run();

        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        harness.advance(60_000);
        const report = await harness.run();

        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        expect(harness.logged).toContain("helper.scan discord-version-changed");

        // The patch is REALLY there: read the stub back out of the archive.
        const stub = readStub(harness.fixture.install.asarPath);
        expect(stub.ok && stub.value?.loaderPath).toBe(join(harness.runtimeDir, "patcher.js"));
        const marker = readMarker(harness.fixture.install.resourcesPath);
        expect(marker.ok && marker.value?.discordVersion).toBe("0.0.407");
        expect(marker.ok && marker.value?.pluginBuildId).toBe(harness.shipped.buildId);
    });

    it("repairs a wiped injection even when Discord's version did not change", async () => {
        // Something other than an update removed it. It is still ours to fix.
        patchForReal(harness);
        await harness.run();

        simulateDiscordUpdate(harness.fixture.install, "0.0.406");
        const report = await harness.run();

        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        expect(harness.logged).not.toContain("helper.scan discord-version-changed");
    });

    it("knows an install is ours from its own memory once the marker is gone", async () => {
        // After an update there is no stub and no marker, so an install checked
        // on its own evidence alone would look like one we had never touched.
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");

        const report = await harness.run();
        expect(report.managed).toBe(1);
        expect(report.repatched).toHaveLength(1);
    });

    it("ignores a Discord Subline has never patched", async () => {
        const report = await harness.run();

        expect(report.found).toBe(1);
        expect(report.managed).toBe(0);
        expect(harness.logged).toContain("helper.scan not-ours");
        // Untouched: still Discord's own archive.
        const stub = readStub(harness.fixture.install.asarPath);
        expect(stub.ok && stub.value).toBeNull();
    });

    it("refuses to patch over another client mod that arrived after us", async () => {
        patchForReal(harness);
        await harness.run();

        // The user installed Vencord themselves.
        const foreign = makeModBundleFixture({ buildId: "aaaabbbbccccdddd" });
        try {
            writeFileSync(
                harness.fixture.install.asarPath,
                (await import("../src/patcher/stub.js")).buildStubAsar(join(foreign.dir, "patcher.js"))
            );
            unlinkSync(join(harness.fixture.install.resourcesPath, "subline-patch.json"));

            const report = await harness.run();
            expect(report.managed).toBe(0);
            expect(report.repatched).toEqual([]);
            expect(harness.logged).toContain("helper.scan foreign-mod");

            const stub = readStub(harness.fixture.install.asarPath);
            expect(stub.ok && stub.value?.loaderPath).toBe(join(foreign.dir, "patcher.js"));
        } finally {
            foreign.cleanup();
        }
    });
});

describe("not racing Discord's own updater", () => {
    it("defers while Discord is running rather than patching underneath it", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        harness.discordOpen = true;

        const report = await harness.run();

        expect(report.repatched).toEqual([]);
        expect(report.deferred).toEqual([harness.fixture.install.rootPath]);
        expect(harness.logged).toContain("helper.repatch deferred");
        // The install is exactly as the updater left it.
        const stub = readStub(harness.fixture.install.asarPath);
        expect(stub.ok && stub.value).toBeNull();
        expect(harness.notifications).toEqual([]);
    });

    it("defers while files under Resources are still being written", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        harness.resourcesAlwaysBusy = true; // being written right now, and staying that way

        const report = await harness.run({ settle: { ...FAST_SETTLE, maxWaitMs: 0 } });

        expect(report.deferred).toEqual([harness.fixture.install.rootPath]);
        expect(readStub(harness.fixture.install.asarPath).ok).toBe(true);
        expect(readStub(harness.fixture.install.asarPath).ok && readStub(harness.fixture.install.asarPath)).toBeTruthy();
    });

    it("repairs it on the NEXT run, once the updater has finished", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        harness.discordOpen = true;
        await harness.run();

        harness.discordOpen = false;
        harness.advance(60 * 60_000);
        const report = await harness.run();

        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
    });
});

describe("when re-patching fails", () => {
    it("leaves Discord usable, says the rollback happened, and tells the user", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        const originalBytes = (await import("node:fs")).readFileSync(harness.fixture.install.asarPath);

        // Corrupt the write between "written" and "verified" — the one seam the
        // patcher exposes for exactly this.
        const failing: HelperPorts = {
            ...harness.ports,
            patch: (install, options) =>
                patchInstall(install, {
                    modBundleDir: options.modBundleDir,
                    productVersion: PRODUCT_VERSION,
                    hooks: { afterWrite: ({ asarPath }) => writeFileSync(asarPath, "not an asar at all") }
                })
        };

        const report = await runHelperOnce(failing, { settle: FAST_SETTLE });

        expect(report.failed).toEqual([harness.fixture.install.rootPath]);
        expect(report.repatched).toEqual([]);

        // DISCORD IS STILL USABLE: its own archive is back, byte for byte.
        const now = (await import("node:fs")).readFileSync(harness.fixture.install.asarPath);
        expect(now.equals(originalBytes)).toBe(true);
        expect(inspectInstall(harness.fixture.install).ok).toBe(true);
        const state = inspectInstall(harness.fixture.install);
        expect(state.ok && state.value.kind).toBe("unpatched");

        // And it was surfaced, not merely logged.
        expect(report.alerts.map(entry => entry.alert.code)).toContain("repatch-failed");
        expect(harness.notifications.map(alert => alert.code)).toContain("repatch-failed");
        expect(readPendingAlerts(harness.productDir).map(entry => entry.code)).toContain("repatch-failed");
    });

    it("does not notify twice for the same unfixable condition", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");

        const failing: HelperPorts = {
            ...harness.ports,
            patch: (install, options) =>
                patchInstall(install, {
                    modBundleDir: options.modBundleDir,
                    productVersion: PRODUCT_VERSION,
                    hooks: { afterWrite: ({ asarPath }) => writeFileSync(asarPath, "not an asar at all") }
                })
        };

        await runHelperOnce(failing, { settle: FAST_SETTLE });
        harness.advance(60 * 60_000);
        await runHelperOnce(failing, { settle: FAST_SETTLE });

        expect(harness.notifications.filter(alert => alert.code === "repatch-failed")).toHaveLength(1);
    });

    it("clears the alert once a later run succeeds", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");

        const failing: HelperPorts = {
            ...harness.ports,
            patch: (install, options) =>
                patchInstall(install, {
                    modBundleDir: options.modBundleDir,
                    productVersion: PRODUCT_VERSION,
                    hooks: { afterWrite: ({ asarPath }) => writeFileSync(asarPath, "not an asar at all") }
                })
        };
        await runHelperOnce(failing, { settle: FAST_SETTLE });
        expect(readPendingAlerts(harness.productDir)).toHaveLength(1);

        harness.advance(60_000);
        await harness.run();

        expect(readPendingAlerts(harness.productDir)).toEqual([]);
    });
});

/* ------------------------------------------------------------------------ *
 * Trigger B
 * ------------------------------------------------------------------------ */

describe("trigger B — a new mod build", () => {
    it("downloads, verifies, installs and re-patches", async () => {
        patchForReal(harness);
        await harness.run();

        const next = makeModBundleFixture({ buildId: "9988776655443322", pluginVersion: "0.2.0" });
        harness.nextBundle = next;
        const bytes = new TextEncoder().encode("a zip of the new bundle");
        harness.feed = ok(releaseDocument(next.buildId, bytes));
        harness.download = ok(bytes);

        const report = await harness.run({ forceUpdateCheck: true });

        expect(report.updateChecked).toBe(true);
        expect(report.updateInstalled).toBe("9988776655443322");
        expect(harness.logged).toContain("helper.update verified");
        expect(harness.logged).toContain("helper.update installed");

        // The runtime bundle really is the new one...
        expect(inspectModBundle(harness.runtimeDir).ok).toBe(true);
        const installed = inspectModBundle(harness.runtimeDir);
        expect(installed.ok && installed.value.buildId).toBe("9988776655443322");

        // ...and Discord was re-patched so the marker names it. Without this,
        // every later verification would read a healthy install as foreign.
        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        const marker = readMarker(harness.fixture.install.resourcesPath);
        expect(marker.ok && marker.value?.pluginBuildId).toBe("9988776655443322");
    });

    it("installs nothing when the download does not match its published checksum", async () => {
        patchForReal(harness);
        await harness.run();

        const next = makeModBundleFixture({ buildId: "9988776655443322" });
        harness.nextBundle = next;
        const published = new TextEncoder().encode("the bytes we published");
        harness.feed = ok(releaseDocument(next.buildId, published));
        // Same length, different content — only the digest catches it.
        harness.download = ok(new TextEncoder().encode("the bytes YOU published"));

        const report = await harness.run({ forceUpdateCheck: true });

        expect(report.updateInstalled).toBeNull();
        expect(harness.unpacked).toEqual([]);
        const installed = inspectModBundle(harness.runtimeDir);
        expect(installed.ok && installed.value.buildId).toBe(harness.shipped.buildId);

        // Never transient: surfaced the FIRST time.
        expect(harness.notifications.map(alert => alert.code)).toEqual(["update-failed"]);
        expect(harness.notifications[0]?.message).toContain("did not match its published checksum");
    });

    it("installs nothing when the archive's bundle is not the build the release claimed", async () => {
        patchForReal(harness);
        await harness.run();

        // The manifest says one build; the bundle inside carries another.
        const next = makeModBundleFixture({ buildId: "0011223344556677" });
        harness.nextBundle = next;
        const bytes = new TextEncoder().encode("a zip");
        harness.feed = ok(releaseDocument("9988776655443322", bytes));
        harness.download = ok(bytes);

        const report = await harness.run({ forceUpdateCheck: true });

        expect(report.updateInstalled).toBeNull();
        const installed = inspectModBundle(harness.runtimeDir);
        expect(installed.ok && installed.value.buildId).toBe(harness.shipped.buildId);
        expect(harness.notifications.map(alert => alert.code)).toEqual(["update-failed"]);
    });

    it("does not cry wolf about a network that is merely down", async () => {
        patchForReal(harness);
        harness.feed = err("NETWORK_ERROR", "offline");

        await harness.run({ forceUpdateCheck: true });
        harness.advance(60 * 60_000);
        await harness.run({ forceUpdateCheck: true });

        // Twice offline is a train journey, not a broken product.
        expect(harness.notifications).toEqual([]);

        harness.advance(60 * 60_000);
        const third = await harness.run({ forceUpdateCheck: true });
        expect(third.alerts.map(entry => entry.alert.code)).toEqual(["update-failed"]);
    });

    it("does nothing at all when the feed offers the build already installed", async () => {
        patchForReal(harness);
        await harness.run();
        harness.feed = ok(releaseDocument(harness.shipped.buildId, new TextEncoder().encode("x")));

        const report = await harness.run({ forceUpdateCheck: true });

        expect(report.updateInstalled).toBeNull();
        expect(harness.logged).toContain("helper.update up-to-date");
        expect(harness.notifications).toEqual([]);
    });

    it("stays off the network between checks", async () => {
        patchForReal(harness);
        harness.feed = ok(releaseDocument(harness.shipped.buildId, new TextEncoder().encode("x")));
        await harness.run({ forceUpdateCheck: true });

        harness.advance(60_000);
        const report = await harness.run({ updateIntervalMs: 6 * 60 * 60_000 });

        expect(report.updateChecked).toBe(false);
        expect(harness.logged).toContain("helper.update throttled");
    });

    it("checks anyway, throttle or not, once health says the mod is broken", async () => {
        // A new build is the ONLY thing that fixes it, so waiting six hours to
        // look would be waiting on the one problem nothing else can touch.
        patchForReal(harness);
        harness.feed = ok(releaseDocument(harness.shipped.buildId, new TextEncoder().encode("x")));
        await harness.run({ forceUpdateCheck: true });

        const statePath = helperStatePathFor(harness.productDir);
        const state = readHelperState(statePath);
        state.health = { lastStatus: "broken", lastObservedAt: START, suspectSince: START, observations: 5 };
        writeHelperState(statePath, state);

        harness.advance(60_000);
        const report = await harness.run({ updateIntervalMs: 6 * 60 * 60_000 });
        expect(report.updateChecked).toBe(true);
    });

    it("is disabled cleanly when no feed is configured, rather than failing every run", async () => {
        patchForReal(harness);
        const report = await runHelperOnce(
            { ...harness.ports, releaseManifestUrl: null },
            { settle: FAST_SETTLE, forceUpdateCheck: true }
        );

        expect(report.updateChecked).toBe(false);
        expect(harness.logged).toContain("helper.update disabled");
        expect(harness.notifications).toEqual([]);
    });

    it("refuses a feed URL that is not one of ours", async () => {
        patchForReal(harness);
        const report = await runHelperOnce(
            { ...harness.ports, releaseManifestUrl: "https://evil.example.com/release.json" },
            { settle: FAST_SETTLE, forceUpdateCheck: true }
        );

        expect(report.updateInstalled).toBeNull();
        expect(harness.notifications.map(alert => alert.code)).toEqual(["update-failed"]);
    });
});

/* ------------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------------ */

describe("the health check", () => {
    it("says QUIET, and warns nobody, for an install with nothing to translate", async () => {
        patchForReal(harness);
        // A working feed serving the build already installed, so nothing but the
        // health judgement can produce a notification here.
        harness.feed = ok(releaseDocument(harness.shipped.buildId, new TextEncoder().encode("x")));
        writeBeacon(harness.beaconPath, harness.shipped.buildId, {});

        // A fortnight of runs on a server that speaks the reader's language.
        let last = await harness.run();
        for (let index = 0; index < 14 * 24; index += 1) {
            harness.advance(60 * 60_000);
            last = await harness.run();
        }

        expect(last.health?.status).toBe("quiet");
        expect(harness.notifications).toEqual([]);
        expect(readPendingAlerts(harness.productDir)).toEqual([]);
    });

    it("says HEALTHY once something has been painted", async () => {
        patchForReal(harness);
        harness.advance(60_000);
        writeBeacon(harness.beaconPath, harness.shipped.buildId, {
            loadedAt: new Date(harness.clock).toISOString(),
            lastTranslationAt: new Date(harness.clock).toISOString(),
            lastRenderedAt: new Date(harness.clock).toISOString(),
            counts: { approx: 3, upgraded: 0 }
        });

        const report = await harness.run();
        expect(report.health?.status).toBe("healthy");
        expect(harness.notifications).toEqual([]);
    });

    it("does not warn on ONE sighting of translating-with-nothing-rendered", async () => {
        patchForReal(harness);
        harness.advance(60_000);
        writeBeacon(harness.beaconPath, harness.shipped.buildId, {
            loadedAt: new Date(harness.clock).toISOString(),
            lastTranslationAt: new Date(harness.clock).toISOString(),
            lastRenderedAt: null,
            counts: { approx: 4, upgraded: 0 }
        });

        const report = await harness.run();
        expect(report.health?.status).toBe("suspect");
        expect(harness.notifications).toEqual([]);
    });

    it("warns once the contradiction is sustained AND there is no newer build to install", async () => {
        patchForReal(harness);
        harness.feed = ok(releaseDocument(harness.shipped.buildId, new TextEncoder().encode("x")));

        for (let index = 0; index < 4; index += 1) {
            harness.advance(3 * 60 * 60_000);
            writeBeacon(harness.beaconPath, harness.shipped.buildId, {
                loadedAt: new Date(harness.clock - 60_000).toISOString(),
                lastTranslationAt: new Date(harness.clock).toISOString(),
                lastRenderedAt: null,
                counts: { approx: 9, upgraded: 0 }
            });
            await harness.run({ forceUpdateCheck: true });
        }

        expect(harness.notifications.map(alert => alert.code)).toEqual(["mod-stale"]);
        expect(harness.notifications[0]?.message).toContain("needs an update that is not available yet");
    });

    it("does NOT warn about a stale mod when a newer build exists — that is the updater's job", async () => {
        patchForReal(harness);
        // The feed offers something newer, so `update-failed` (or a successful
        // install) is the story; two notifications for one problem is how
        // notifications get ignored.
        harness.feed = ok(releaseDocument("9988776655443322", new TextEncoder().encode("x")));
        harness.download = err("NETWORK_ERROR", "the asset host is down");

        for (let index = 0; index < 4; index += 1) {
            harness.advance(3 * 60 * 60_000);
            writeBeacon(harness.beaconPath, harness.shipped.buildId, {
                loadedAt: new Date(harness.clock - 60_000).toISOString(),
                lastTranslationAt: new Date(harness.clock).toISOString(),
                lastRenderedAt: null,
                counts: { approx: 9, upgraded: 0 }
            });
            await harness.run({ forceUpdateCheck: true });
        }

        expect(harness.notifications.map(alert => alert.code)).not.toContain("mod-stale");
        expect(harness.logged).toContain("helper.health broken-update-pending");
    });

    it("forgets its suspicion when a new build lands, because the evidence was about the old one", async () => {
        patchForReal(harness);
        for (let index = 0; index < 2; index += 1) {
            harness.advance(3 * 60 * 60_000);
            writeBeacon(harness.beaconPath, harness.shipped.buildId, {
                loadedAt: new Date(harness.clock - 60_000).toISOString(),
                lastTranslationAt: new Date(harness.clock).toISOString(),
                lastRenderedAt: null,
                counts: { approx: 9, upgraded: 0 }
            });
            await harness.run();
        }
        expect(readHelperState(helperStatePathFor(harness.productDir)).health.observations).toBe(2);

        const next = makeModBundleFixture({ buildId: "9988776655443322" });
        harness.nextBundle = next;
        const bytes = new TextEncoder().encode("a zip");
        harness.feed = ok(releaseDocument(next.buildId, bytes));
        harness.download = ok(bytes);
        harness.advance(60_000);
        await harness.run({ forceUpdateCheck: true });

        const state = readHelperState(helperStatePathFor(harness.productDir));
        expect(state.health.observations).toBe(0);
        expect(state.health.suspectSince).toBeNull();
    });

    it("makes no judgement at all when there is no beacon and no install to compare against", async () => {
        const report = await harness.run();
        expect(report.health).toBeNull();
        expect(harness.logged).toContain("helper.health no-evidence");
    });

    it("does not judge a beacon written by somebody else's copy of the plugin", async () => {
        patchForReal(harness);
        harness.advance(60_000);
        writeBeacon(harness.beaconPath, "aaaabbbbccccdddd", {
            loadedAt: new Date(harness.clock).toISOString(),
            lastTranslationAt: new Date(harness.clock).toISOString(),
            lastRenderedAt: null,
            counts: { approx: 9, upgraded: 0 }
        });

        const report = await harness.run();
        expect(report.health?.status).toBe("unknown");
        expect(report.health?.from).toBe("foreign-beacon");
        expect(harness.notifications).toEqual([]);
    });
});
