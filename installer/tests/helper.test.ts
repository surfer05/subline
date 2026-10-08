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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installModBundle } from "../src/app/modInstall.js";
import { inspectModBundle } from "../src/bundle/bundle.js";
import { RELEASE_MANIFEST_FORMAT } from "../src/helper/release.js";
import { DEFAULT_UPDATE_INTERVAL_MS, runHelperOnce } from "../src/helper/helper.js";
import { isIdleRun } from "../src/helper/quiet.js";
import { MIN_WINDOW_MS } from "../src/helper/health.js";
import type { HelperPorts, HelperRunOptions, HelperRunReport } from "../src/helper/helper.js";
import { helperStatePathFor, readHelperState, releaseHelperInstalls, seedHelperMemory, writeHelperState } from "../src/helper/state.js";
import { createHelperPorts } from "../src/helper/ports.js";
import type { Alert } from "../src/helper/alerts.js";
import { DEFAULT_REPEAT_MS, readPendingAlerts } from "../src/helper/alerts.js";
import type { DiscordInstall } from "../src/patcher/locate.js";
import { readMarker, writeMarker } from "../src/patcher/marker.js";
import { adoptPatch, patchInstall, unpatchInstall, verifyPatch } from "../src/patcher/patch.js";
import { err, ok } from "../src/patcher/result.js";
import type { Result } from "../src/patcher/result.js";
import { inspectInstall } from "../src/patcher/state.js";
import { buildStubAsar, legacyStubIndexSource, readStub, stubIndexSource } from "../src/patcher/stub.js";
import { readDiscordVersion } from "../src/patcher/version.js";
import { verifyOnce } from "../src/verify/verify.js";
import { buildOriginalDiscordAsar, makeDiscordFixture, makeModBundleFixture } from "./fixture.js";
import type { Fixture, ModBundleFixture } from "./fixture.js";

const PRODUCT_VERSION = "0.1.0";
/**
 * The fixture's fake "now". RELATIVE to the real clock, never a fixed instant.
 *
 * These tests drive an injected clock, but `patchInstall` stamps the marker's
 * `patchedAt` with the real `new Date()`, and `verifyOnce` measures the beacon
 * against `max(patchedAt, launchedAt)`. So the beacon's `loadedAt` (written at
 * START) has to sit AFTER real wall-clock time, or every beacon in this file
 * reads as `stale-beacon` and the health assertions collapse to `unknown`.
 *
 * A hardcoded date satisfies that only until real time overtakes it — which is
 * exactly what happened to the previous value (2026-08-07T09:00:00Z) at 09:00
 * UTC on that day, failing four tests with no code change. Anchoring a day
 * ahead of the real clock keeps the ordering the tests were written for and
 * cannot expire.
 */
const START = Date.now() + 24 * 60 * 60 * 1000;
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
     * Which OS the helper believes it is on.
     *
     * Load-bearing since the settle rule diverged: Windows must wait for a
     * closed Discord because it cannot rename an open file; macOS must not,
     * because waiting there means never repairing at all.
     */
    platform: NodeJS.Platform;
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
        platform: "darwin",
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
        get platform() { return harness.platform ?? "darwin"; },
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
        adopt: (install, options) =>
            adoptPatch(install, { modBundleDir: options.modBundleDir, productVersion: PRODUCT_VERSION }),
        unpatch: install => unpatchInstall(install),

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

function releaseDocument(buildId: string, bytes: Uint8Array, pluginVersion = "0.2.0"): string {
    return JSON.stringify({
        format: RELEASE_MANIFEST_FORMAT,
        product: "subline",
        buildId,
        pluginVersion,
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

    it("re-patches across a Windows version bump, where the install's folder path changes", async () => {
        // THE zehra BUG. On Windows a Discord update swaps `…\Discord\app-1.0.<old>`
        // for a NEW `…\app-1.0.<new>` folder, so the install's rootPath changes.
        // The memory of "we patched this" must be keyed by the STABLE identity
        // (the branch dir), not the versioned rootPath — otherwise the updated
        // Discord looks like one we never touched and self-heal never runs.
        harness.platform = "win32";
        const branchId = "C:\\Users\\z\\AppData\\Local\\Discord"; // stable across versions
        harness.fixture.install.stableId = branchId;

        // We patched it before, at an older version (what a healthy run records).
        const statePath = helperStatePathFor(harness.productDir);
        const seeded = readHelperState(statePath);
        seeded.installs[branchId] = {
            discordVersion: "0.0.406",
            buildId: harness.shipped.buildId,
            patchedAt: START,
            failures: 0
        };
        writeHelperState(statePath, seeded);

        // Discord updated: fresh unpatched archive, new version — and the memory
        // is NOT keyed by this install's rootPath, only by its stable identity.
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");

        const report = await harness.run();

        expect(report.managed).toBe(1);
        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        expect(harness.logged).toContain("helper.scan discord-version-changed");
        // Really re-patched: the loader stub is back in the archive.
        const stub = readStub(harness.fixture.install.asarPath);
        expect(stub.ok && stub.value).not.toBeNull();
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

describe("our stub without our marker (Windows field bug, 2026-10-04)", () => {
    // Vencord's host-update repatch, bundled in our patcher.js, copies the old
    // folder's app.asar (our stub) into the new one and leaves the marker behind.
    function dropMarker(): void {
        unlinkSync(join(harness.fixture.install.resourcesPath, "subline-patch.json"));
    }

    it("is re-adopted, never abandoned as another client mod: marker rewritten, app.asar untouched", async () => {
        patchForReal(harness);
        await harness.run();
        dropMarker();
        const before = readFileSync(harness.fixture.install.asarPath);

        const report = await harness.run();
        expect(report.managed).toBe(1);
        expect(harness.logged).not.toContain("helper.scan foreign-mod");
        const scan = report.decisions.find(d => d.kind === "scan" && d.outcome === "re-adopt");
        expect(scan?.fields.marker).toBe("missing");
        expect(scan?.fields.loader).toBe(join(harness.runtimeDir, "patcher.js"));
        expect(report.decisions.some(d => d.kind === "repatch" && d.outcome === "re-adopted")).toBe(true);
        const marker = readMarker(harness.fixture.install.resourcesPath);
        expect(marker.ok && marker.value?.pluginBuildId).toBe(harness.shipped.buildId);
        expect(readFileSync(harness.fixture.install.asarPath).equals(before)).toBe(true);

        // And it stays managed: the next run has nothing to do.
        const again = await harness.run();
        expect(again.decisions.some(d => d.outcome === "re-adopt")).toBe(false);
        expect(again.managed).toBe(1);
    });

    it("on Windows, with Discord running, the marker is still rewritten at once (it never touches app.asar)", async () => {
        patchForReal(harness);
        await harness.run();
        dropMarker();
        harness.platform = "win32";
        harness.discordOpen = true;

        const report = await harness.run();
        expect(report.deferred).toEqual([]);
        expect(report.decisions.some(d => d.kind === "repatch" && d.outcome === "re-adopted")).toBe(true);
        expect(existsSync(join(harness.fixture.install.resourcesPath, "subline-patch.json"))).toBe(true);
    });

    it("without the adopt port it still treats the install as ours and takes the full repair path", async () => {
        patchForReal(harness);
        await harness.run();
        dropMarker();
        (harness.ports as { adopt?: unknown }).adopt = undefined;

        const report = await harness.run();
        expect(report.managed).toBe(1);
        expect(report.repatched).toHaveLength(1);
        expect(readMarker(harness.fixture.install.resourcesPath).ok).toBe(true);
    });

    it("a genuine foreign mod is still left alone, and the log names its loader and whether a marker is there", async () => {
        patchForReal(harness);
        await harness.run();
        const foreign = makeModBundleFixture({ buildId: "aaaabbbbccccdddd" });
        try {
            writeFileSync(
                harness.fixture.install.asarPath,
                (await import("../src/patcher/stub.js")).buildStubAsar(join(foreign.dir, "patcher.js"))
            );
            dropMarker();
            const report = await harness.run();
            expect(report.managed).toBe(0);
            const scan = report.decisions.find(d => d.kind === "scan" && d.outcome === "foreign-mod");
            expect(scan?.fields.loader).toBe(join(foreign.dir, "patcher.js"));
            expect(scan?.fields.marker).toBe("missing");
        } finally {
            foreign.cleanup();
        }
    });
});

describe("not racing Discord's own updater", () => {
    it("repairs a running Discord on macOS, where the rename is allowed", async () => {
        // CHANGED, and this is the whole point of the change. Waiting for
        // Discord to close looked cautious and was fatal: self-repair exists
        // for somebody whose Discord updated underneath them, which is somebody
        // who USES Discord and therefore has it open. Every hourly run on a
        // real Mac deferred for days while the product silently did nothing,
        // with the helper installed, registered and running perfectly.
        //
        // The rename succeeds on macOS; the running Discord keeps the archive
        // it already opened and picks the patch up at its next launch.
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        harness.discordOpen = true;

        const report = await harness.run();

        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        expect(report.deferred).toEqual([]);
        const stub = readStub(harness.fixture.install.asarPath);
        expect(stub.ok && stub.value).not.toBeNull();
    });

    it("still defers on Windows, where the rename would fail", async () => {
        // Windows refuses to rename a file a running process holds open, so
        // there the wait is not caution, it is the only thing that works.
        harness.platform = "win32";
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
        // Windows: the first run cannot touch a running Discord at all, so the
        // repair has to survive until a run that finds it closed.
        harness.platform = "win32";
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

describe("0.2.1: woken by WatchPaths in the middle of an update", () => {
    it("waits through the update with the default settle, then repairs exactly once", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.414");
        // launchd starts the helper while the updater is still writing: every
        // sample says Resources was written "now" for the next 20s.
        const updateEndsAt = harness.clock + 20_000;
        harness.ports.mtimeOf = () => Math.min(harness.clock, updateEndsAt);
        const realPatch = harness.ports.patch;
        let patches = 0;
        harness.ports.patch = (install, options) => {
            patches++;
            // Nothing is written before the update has finished and gone quiet.
            expect(harness.clock).toBeGreaterThanOrEqual(updateEndsAt);
            return realPatch(install, options);
        };

        const report = await harness.run({ settle: {} });

        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        expect(patches).toBe(1);
        expect(report.failed).toEqual([]);
        expect(harness.notifications.filter(n => n.code !== "restart-required")).toEqual([]);
        // Seconds after the update, not a minute.
        expect(harness.clock - updateEndsAt).toBeLessThan(30_000);
    });

    it("a run with nothing to do touches no network and counts as idle", async () => {
        patchForReal(harness);
        await harness.run({ forceUpdateCheck: false });
        let fetches = 0;
        harness.ports.fetchText = async () => { fetches++; return err("NETWORK_ERROR", "should not be called"); };
        harness.ports.fetchBinary = async () => { fetches++; return err("NETWORK_ERROR", "should not be called"); };
        harness.advance(5 * 60_000); // the next 5 minute run

        const report = await harness.run();

        expect(fetches).toBe(0);
        expect(report.updateChecked).toBe(false);
        expect(report.repatched).toEqual([]);
        expect(isIdleRun(report)).toBe(true);
    });
});

describe("after a repair that a running Discord cannot see", () => {
    // THE FAILURE THIS CLOSES, observed 2026-08-28. Discord updated to 0.0.409
    // at 07:29 and the helper re-patched at 07:30 — correctly, in one attempt,
    // with a log line saying so. The user spent the morning believing Subline
    // was broken.
    //
    // It was not broken. app.asar is read by Discord's MAIN process at startup,
    // so a Discord already running when the repair lands can never pick it up —
    // not on Cmd+R, which reloads only the renderer. The files were right and
    // the running process was stale, and NOTHING said so. Every silent update
    // therefore looks exactly like a silent failure, which is why updating felt
    // dangerous even though self-repair worked every time.
    //
    // The remaining gap is genuinely the user's to close: the helper repairs
    // Discord, it does not restart it. That is precisely what alerts.ts is for.
    it("asks for a restart when it repaired a Discord that was open", async () => {
        patchForReal(harness);
        await harness.run();

        simulateDiscordUpdate(harness.fixture.install, "0.0.409");
        harness.discordOpen = true;
        harness.advance(60 * 60_000);
        const report = await harness.run();

        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        const restart = harness.notifications!.find(a => a.code === "restart-required");
        expect(restart, "a repair under a running Discord must be announced").toBeDefined();
        expect(restart!.message).toContain("Quit and reopen Discord");
        // Scalars only, never text — same rule as the log (spec §7).
        expect(restart!.detail).toMatchObject({ discord: "0.0.409" });
    });

    it("stays silent when it repaired a Discord that was closed", async () => {
        // Nothing to tell anyone: the next launch reads the new app.asar on its
        // own. Notifying here would be the "crying wolf" alerts.ts exists to
        // avoid — and an update notice the user cannot act on is worse than
        // none, because it teaches them to dismiss the one that matters.
        patchForReal(harness);
        await harness.run();

        simulateDiscordUpdate(harness.fixture.install, "0.0.409");
        harness.discordOpen = false;
        harness.advance(60 * 60_000);
        const report = await harness.run();

        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        expect(harness.notifications!.map(a => a.code)).not.toContain("restart-required");
    });

    it("clears the request once Discord is no longer running it", async () => {
        // The condition ends the moment that stale process does — whatever the
        // user actually did. An alert that outlives its condition is the same
        // false alarm as one that should never have fired.
        patchForReal(harness);
        await harness.run();

        simulateDiscordUpdate(harness.fixture.install, "0.0.409");
        harness.discordOpen = true;
        harness.advance(60 * 60_000);
        await harness.run();
        expect(harness.notifications!.some(a => a.code === "restart-required")).toBe(true);

        harness.discordOpen = false;
        harness.advance(60 * 60_000);
        const after = await harness.run();

        expect(after.decisions.some(d => d.outcome === "restart-required:resolved")).toBe(true);
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

    it("records that Discord still starts, so the log answers the only question that matters", async () => {
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
        const report = await runHelperOnce(failing, { settle: FAST_SETTLE });

        const failure = report.decisions.find(entry => entry.kind === "repatch" && entry.outcome === "failed");
        expect(failure?.fields.discordStartable).toBe(true);
        expect(failure?.fields.code).toBe("VERIFICATION_FAILED");
        expect(failure?.fields.broken).toBeNull();
    });

    it("raises the LOUD alert when the rollback itself failed", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");

        // The one outcome worse than a failed patch. There is no fixture that
        // provokes a rename failure reliably, so the port supplies the error.
        const failing: HelperPorts = {
            ...harness.ports,
            patch: () => err("ROLLBACK_FAILED", "Patching failed and Discord could not be restored automatically.")
        };
        const report = await runHelperOnce(failing, { settle: FAST_SETTLE });

        expect(report.alerts.map(entry => entry.alert.code)).toEqual(["rollback-failed"]);
        expect(harness.notifications[0]?.message).toContain("could not put Discord's own files back");
    });

    it("names the missing backup rather than giving the generic failure", async () => {
        // §8's hardest case, reached for real: our stub is in place and Discord's
        // own archive is gone, so nothing here can repair it and the user needs a
        // different sentence — reinstall Discord, not "try again".
        patchForReal(harness);
        await harness.run();
        unlinkSync(harness.fixture.install.backupPath);

        const report = await harness.run();

        expect(report.failed).toEqual([harness.fixture.install.rootPath]);
        expect(report.alerts.map(entry => entry.alert.code)).toEqual(["backup-missing"]);
        expect(harness.notifications[0]?.message).toContain("copy of Discord's original files is gone");
        const failure = report.decisions.find(entry => entry.kind === "repatch" && entry.outcome === "failed");
        expect(failure?.fields.code).toBe("BROKEN_INSTALL");
        expect(failure?.fields.broken).toBe("our-patch-without-backup");
        // The other half of the observation, and the half only this case can
        // prove: `discordStartable` has to be able to come back FALSE. Every
        // other failure here leaves a working Discord, so a version that always
        // said "startable" would look right in all of them.
        expect(failure?.fields.discordStartable).toBe(false);
    });

    it("gives an ordinary failure a second chance before telling anybody", async () => {
        // A transient IO error while an update is landing is not news. Two in a
        // row is.
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");

        const failing: HelperPorts = {
            ...harness.ports,
            patch: () => err("IO_ERROR", "Failed to write the new app.asar.")
        };

        const first = await runHelperOnce(failing, { settle: FAST_SETTLE });
        expect(first.failed).toHaveLength(1);
        expect(first.alerts).toEqual([]);
        expect(harness.notifications).toEqual([]);

        harness.advance(60 * 60_000);
        const second = await runHelperOnce(failing, { settle: FAST_SETTLE });
        expect(second.alerts.map(entry => entry.alert.code)).toEqual(["repatch-failed"]);
        expect(second.alerts[0]?.alert.detail.failures).toBe(2);
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

    // Field report (0.1.6): the sentence read "... Discord itself is fine. open
    // Subline to finish." Every sentence starts with a capital. The cadence is
    // at most twice a day while it keeps failing, and silence once fixed.
    it("says 'Open Subline to finish.', repeats after 12 hours while failing, and goes quiet once repaired", async () => {
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
        const repatchNotices = () => harness.notifications.filter(alert => alert.code === "repatch-failed");

        await runHelperOnce(failing, { settle: FAST_SETTLE });
        expect(repatchNotices()).toHaveLength(1);
        expect(repatchNotices()[0]?.message).toContain("Discord itself is fine. Open Subline to finish.");
        expect(repatchNotices()[0]?.message).not.toMatch(/\. [a-z]/);

        harness.advance(11 * 60 * 60_000);
        await runHelperOnce(failing, { settle: FAST_SETTLE });
        expect(repatchNotices()).toHaveLength(1);

        harness.advance(60 * 60_000);
        await runHelperOnce(failing, { settle: FAST_SETTLE });
        expect(repatchNotices()).toHaveLength(2);

        // Repaired: the alert clears and nothing more is said, however long.
        harness.advance(60_000);
        await harness.run();
        expect(readPendingAlerts(harness.productDir)).toEqual([]);
        harness.advance(13 * 60 * 60_000);
        await harness.run();
        harness.advance(13 * 60 * 60_000);
        await harness.run();
        expect(repatchNotices()).toHaveLength(2);
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

    // OBSERVED 2026-09-20, on the maker's own Mac: a freshly installed 0.1.1
    // (feed on) was replaced seven seconds later by the 0.1.0 still published
    // on the feed, and Discord was re-patched with it. The feed moves installs
    // forward only.
    it("never downgrades to an OLDER version published on the feed", async () => {
        patchForReal(harness);
        await harness.run();
        const older = makeModBundleFixture({ buildId: "0000aaaa1111bbbb", pluginVersion: "0.0.9" });
        try {
            harness.feed = ok(releaseDocument(older.buildId, new TextEncoder().encode("x"), "0.0.9"));
            harness.nextBundle = older;

            const report = await harness.run({ forceUpdateCheck: true });

            expect(report.updateInstalled).toBeNull();
            expect(harness.unpacked).toEqual([]);
            expect(harness.logged).toContain("helper.update not-newer");
            expect(harness.notifications).toEqual([]);
            // Discord still carries the build that was installed.
            const marker = readMarker(harness.fixture.install.resourcesPath);
            expect(marker.ok && marker.value?.pluginBuildId).toBe(harness.shipped.buildId);
        } finally {
            older.cleanup();
        }
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

    it("checks anyway, throttle or not, when the installed bundle is unusable", async () => {
        // A broken bundle is exactly what trigger B can replace, so waiting six
        // hours to look would be waiting on the one thing that could fix it. It is
        // also how a half-deleted mod directory repairs itself.
        patchForReal(harness);
        harness.feed = ok(releaseDocument(harness.shipped.buildId, new TextEncoder().encode("x")));
        await harness.run({ forceUpdateCheck: true });

        rmSync(join(harness.runtimeDir, "renderer.js"), { force: true });
        harness.advance(60_000);
        const report = await harness.run({ updateIntervalMs: 6 * 60 * 60_000 });

        expect(report.updateChecked).toBe(true);
        expect(harness.logged).toContain("helper.scan bundle-unusable");
    });

    it("clears the 'needs an update' alert once the update lands", async () => {
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
        expect(readPendingAlerts(harness.productDir).map(entry => entry.code)).toEqual(["mod-stale"]);

        const next = makeModBundleFixture({ buildId: "9988776655443322" });
        harness.nextBundle = next;
        const bytes = new TextEncoder().encode("a zip");
        harness.feed = ok(releaseDocument(next.buildId, bytes));
        harness.download = ok(bytes);
        harness.advance(60_000);
        const report = await harness.run({ forceUpdateCheck: true });

        expect(report.updateInstalled).toBe("9988776655443322");
        expect(readPendingAlerts(harness.productDir)).toEqual([]);
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

        // Hourly runs (the helper's real cadence) on a server that speaks the
        // reader's language, for twice the longest clock the helper keeps: the
        // alert repeat window, the health window and the update interval.
        //
        // NOT a fortnight any more. Every run here is a full pass over REAL
        // files (bundle inspection, patch verification, an atomic state write),
        // about 0.5 ms each when the machine is idle and nothing waits on a
        // timer. 337 of them made this the suite's slowest test by 5x, and
        // under parallel load the synchronous I/O stretched it past the 5 s
        // test timeout. Past the longest clock, extra days exercise nothing new.
        const span = 2 * Math.max(DEFAULT_REPEAT_MS, MIN_WINDOW_MS, DEFAULT_UPDATE_INTERVAL_MS);
        let last = await harness.run();
        for (let elapsed = 0; elapsed < span; elapsed += 60 * 60_000) {
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

/* ------------------------------------------------------------------------ *
 * Worst cases (the 0.2.1 pass): each fails on the code before its fix.
 * ------------------------------------------------------------------------ */

describe("worst cases", () => {
    function countRunningChecks(): { count: () => number } {
        let checks = 0;
        const real = harness.ports.discordRunning;
        harness.ports.discordRunning = async install => { checks += 1; return real(install); };
        return { count: () => checks };
    }

    it("Windows, Discord open after an update: one look per run, and ONE quit-required notice after 30 minutes", async () => {
        harness.platform = "win32";
        patchForReal(harness);
        await harness.run({ settle: {} });
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        harness.discordOpen = true;
        const checks = countRunningChecks();

        const first = await harness.run({ settle: {} });
        expect(first.deferred).toEqual([harness.fixture.install.rootPath]);
        // It was 61 (every 5 s for 5 minutes, every run).
        expect(checks.count()).toBeLessThanOrEqual(2);

        for (let i = 0; i < 7; i++) {
            harness.advance(5 * 60_000);
            await harness.run({ settle: {} });
        }
        const quit = harness.notifications.filter(n => n.code === "quit-required");
        expect(quit).toHaveLength(1);
        expect(quit[0]?.message).toBe(
            "Discord updated. To turn Subline back on, right-click the Discord icon near the clock and choose Quit Discord. "
            + "Leave it closed for a minute while Subline puts itself back, then open Discord again."
        );

        for (let i = 0; i < 10; i++) {
            harness.advance(30 * 60_000);
            await harness.run({ settle: {} });
        }
        expect(harness.notifications.filter(n => n.code === "quit-required")).toHaveLength(1);

        // The user quits Discord: the repair lands, the notice is resolved, and
        // no second "restart" notice follows it.
        harness.discordOpen = false;
        harness.advance(5 * 60_000);
        const repaired = await harness.run({ settle: {} });
        expect(repaired.repatched).toEqual([harness.fixture.install.rootPath]);
        expect(repaired.decisions.some(d => d.outcome === "quit-required:resolved")).toBe(true);
        expect(harness.notifications.map(n => n.code)).not.toContain("restart-required");
    });

    it("an identical deferral run after run is marked as a repeat, so the log keeps one line for it", async () => {
        harness.platform = "win32";
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        harness.discordOpen = true;
        const first = await harness.run();
        expect(first.repeatDeferral).toBe(false);
        harness.advance(5 * 60_000);
        const second = await harness.run();
        expect(second.repeatDeferral).toBe(true);

        const { bufferedLogger, concludeHelperLog } = await import("../src/helper/quiet.js");
        const lines: string[] = [];
        const target = { info: (e: string) => lines.push(e), warn: (e: string) => lines.push(e), error: (e: string) => lines.push(e) };
        const held = bufferedLogger(target);
        held.logger.info("helper.scan", {});
        let headers = 0;
        concludeHelperLog(second, held, target, () => { headers += 1; });
        expect(lines).toEqual(["helper.deferred"]);
        expect(headers).toBe(0);
    });

    it("a second Discord update the same day gets its own restart notice", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.409");
        harness.discordOpen = true;
        await harness.run();
        harness.advance(3 * 60 * 60_000);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.410");
        harness.advance(60 * 60_000);
        await harness.run();

        const restarts = harness.notifications.filter(n => n.code === "restart-required");
        expect(restarts).toHaveLength(2);
        expect(restarts[1]?.detail).toMatchObject({ discord: "0.0.410" });
    });

    it("a new Subline build under a running Discord says Subline updated, not Discord", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.409");
        harness.discordOpen = true;
        await harness.run();
        harness.advance(60 * 60_000);
        harness.shipped.rebuild({ buildId: "5566778899aabbcc", pluginVersion: "0.2.1" });
        const installed = installModBundle({ sourceDir: harness.shipped.dir, destDir: harness.runtimeDir });
        expect(installed.ok).toBe(true);
        await harness.run();

        const restarts = harness.notifications.filter(n => n.code === "restart-required");
        expect(restarts).toHaveLength(2);
        expect(restarts[1]?.message).toBe("Subline updated. Quit and reopen Discord to use the new version.");
    });

    it("the same version and build written again within a day stays quiet", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.409");
        harness.discordOpen = true;
        await harness.run();
        harness.advance(60 * 60_000);
        // Wiped again, same version: the same pair is written a second time.
        simulateDiscordUpdate(harness.fixture.install, "0.0.409");
        const again = await harness.run();
        expect(again.repatched).toEqual([harness.fixture.install.rootPath]);
        expect(harness.notifications.filter(n => n.code === "restart-required")).toHaveLength(1);
    });

    it("Windows: a run whose task was removed (Uninstall) mid-run patches nothing and writes no state", async () => {
        harness.platform = "win32";
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        harness.discordOpen = false;
        const statePath = helperStatePathFor(harness.productDir);
        harness.advance(5 * 60_000);
        const stateBefore = readFileSync(statePath, "utf8");
        let registered = true;
        harness.ports.stillRegistered = async () => registered;
        // The uninstall removes the task while this run waits for Discord to settle.
        const realSleep = harness.ports.sleep;
        harness.ports.sleep = async ms => { registered = false; await realSleep(ms); };
        let patches = 0;
        const realPatch = harness.ports.patch;
        harness.ports.patch = (install, options) => { patches += 1; return realPatch(install, options); };

        const report = await harness.run();
        expect(patches).toBe(0);
        expect(report.repatched).toEqual([]);
        expect(report.uninstalled, JSON.stringify(report.decisions.map(d => d.outcome + ":" + d.reason))).toBe(true);
        // Not rewritten: no lastRunAt, nothing remembered.
        expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
        expect(harness.notifications).toEqual([]);
    });

    it("never touches a Discord another account on this computer set up", async () => {
        patchForReal(harness);
        await harness.run();
        // This account's view: the loader is in another user's home.
        harness.ports.isOtherAccountLoader = path => path.startsWith(harness.runtimeDir);
        harness.shipped.rebuild({ buildId: "5566778899aabbcc", pluginVersion: "0.2.1" });
        installModBundle({ sourceDir: harness.shipped.dir, destDir: harness.runtimeDir });
        const report = await harness.run();
        expect(report.repatched).toEqual([]);
        expect(report.decisions.some(d => d.outcome === "other-account")).toBe(true);
        expect(harness.notifications).toEqual([]);
    });

    it("warns that the mod is stale when the feed only has an OLDER build than the installed one", async () => {
        harness.shipped.rebuild({ buildId: "0a1b2c3d4e5f6a7b", pluginVersion: "0.2.1" });
        expect(installModBundle({ sourceDir: harness.shipped.dir, destDir: harness.runtimeDir }).ok).toBe(true);
        patchForReal(harness);
        harness.feed = ok(releaseDocument("9988776655443322", new TextEncoder().encode("x"), "0.2.0"));

        for (let index = 0; index < 4; index += 1) {
            harness.advance(3 * 60 * 60_000);
            writeBeacon(harness.beaconPath, harness.shipped.buildId, {
                pluginVersion: "0.2.1",
                loadedAt: new Date(harness.clock - 60_000).toISOString(),
                lastTranslationAt: new Date(harness.clock).toISOString(),
                lastRenderedAt: null,
                counts: { approx: 9, upgraded: 0 }
            });
            await harness.run({ forceUpdateCheck: true });
        }

        expect(harness.notifications.map(alert => alert.code)).toContain("mod-stale");
        expect(harness.logged).not.toContain("helper.health broken-update-pending");
    });

    it("puts back a bundle an interrupted swap left aside, before reading it", async () => {
        const { renameSync } = await import("node:fs");
        const { recoverModBundle } = await import("../src/app/modInstall.js");
        patchForReal(harness);
        renameSync(harness.runtimeDir, `${harness.runtimeDir}.subline-old`);
        harness.ports.recoverBundle = dir => recoverModBundle(dir);
        const report = await harness.run();
        expect(report.decisions.some(d => d.outcome === "bundle-recovered")).toBe(true);
        expect(existsSync(join(harness.runtimeDir, "patcher.js"))).toBe(true);
    });
});

/* ------------------------------------------------------------------------ *
 * Install audit 2026-10-06: ownership, discord-updates and helper families.
 * Each case is the finding's worst case, and fails on the code before it.
 * ------------------------------------------------------------------------ */

describe("audit: the helper never abandons, never nags for nothing, and never undoes an uninstall", () => {
    function scriptRunning(answers: boolean[]): { calls: () => number } {
        let calls = 0;
        harness.ports.discordRunning = async () => {
            const answer = answers[Math.min(calls, answers.length - 1)] ?? false;
            calls += 1;
            return answer;
        };
        return { calls: () => calls };
    }
    function stateFile(): string {
        return helperStatePathFor(harness.productDir);
    }

    // Related gap (part 1 brief): a partial uninstall brings the helper back,
    // and its memory still named the Discord just restored.
    it("a Discord Uninstall restored is released: the helper brought back never patches it again", async () => {
        patchForReal(harness);
        await harness.run();
        expect(unpatchInstall(harness.fixture.install).ok).toBe(true);
        expect(releaseHelperInstalls(harness.productDir, [harness.fixture.install.stableId]).ok).toBe(true);

        harness.advance(5 * 60_000);
        const report = await harness.run();
        expect(report.repatched).toEqual([]);
        expect(report.decisions.some(d => d.outcome === "released")).toBe(true);
        const state = inspectInstall(harness.fixture.install);
        expect(state.ok && state.value.kind).toBe("unpatched");
    });

    it("(the bug) without the release, the helper puts Subline straight back", async () => {
        patchForReal(harness);
        await harness.run();
        expect(unpatchInstall(harness.fixture.install).ok).toBe(true);
        harness.advance(5 * 60_000);
        const report = await harness.run();
        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
    });

    it("installing again lifts the release", async () => {
        patchForReal(harness);
        await harness.run();
        releaseHelperInstalls(harness.productDir, [harness.fixture.install.stableId]);
        seedHelperMemory(harness.productDir, harness.fixture.install.stableId, { discordVersion: "0.0.406", buildId: harness.shipped.buildId, patchedAt: START });
        expect(readHelperState(stateFile()).released).toEqual([]);
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        const report = await harness.run();
        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
    });

    // #34 / #49
    it("#34: a lost helper memory plus a Discord update: the installer's record keeps it ours", async () => {
        patchForReal(harness);
        await harness.run();
        rmSync(stateFile());
        harness.ports.rememberedStableIds = () => new Set([harness.fixture.install.stableId]);
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        const report = await harness.run();
        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        expect(harness.logged).not.toContain("helper.scan not-ours");
        expect(report.decisions.find(d => d.outcome === "adopted-from-memory")?.fields.source).toBe("patched-installs");
    });

    it("#49: Discord updates before the helper's first run: the memory the installer seeded keeps it ours", async () => {
        patchForReal(harness);
        expect(seedHelperMemory(harness.productDir, harness.fixture.install.stableId, {
            discordVersion: "0.0.406", buildId: harness.shipped.buildId, patchedAt: START
        }).ok).toBe(true);
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        const report = await harness.run();
        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
    });

    it("#49: seeding keeps every other field of helper-state.json", async () => {
        patchForReal(harness);
        await harness.run();
        const before = readHelperState(stateFile());
        seedHelperMemory(harness.productDir, "C:\\Other\\Discord", { discordVersion: "1", buildId: "b", patchedAt: 1 });
        const after = readHelperState(stateFile());
        expect(after.health).toEqual(before.health);
        expect(after.lastRunAt).toBe(before.lastRunAt);
        expect(Object.keys(after.installs).sort()).toEqual([harness.fixture.install.stableId, "C:\\Other\\Discord"].sort());
    });

    it("#49: a corrupt memory is logged as such, and the record still keeps the install", async () => {
        patchForReal(harness);
        await harness.run();
        writeFileSync(stateFile(), "{ not json", "utf8");
        harness.ports.stateUnreadable = () => 10;
        harness.ports.rememberedStableIds = () => new Set([harness.fixture.install.stableId]);
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        const report = await harness.run();
        expect(report.managed).toBe(1);
        expect(report.decisions.some(d => d.outcome === "state-unreadable")).toBe(true);
        expect(isIdleRun(report)).toBe(false);
    });

    it("#49: residue in a sibling app folder (Windows) keeps it ours with no memory and no record", async () => {
        patchForReal(harness);
        rmSync(stateFile(), { force: true });
        harness.ports.siblingCarriesOurMark = () => true;
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        const report = await harness.run();
        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        expect(report.decisions.find(d => d.outcome === "adopted-from-memory")?.fields.source).toBe("residue");
    });

    it("#49: a record never overrides another mod: a foreign stub stays foreign-mod", async () => {
        patchForReal(harness);
        await harness.run();
        writeFileSync(harness.fixture.install.asarPath, buildStubAsar("/Users/x/Vencord/dist/patcher.js"));
        harness.ports.rememberedStableIds = () => new Set([harness.fixture.install.stableId]);
        const report = await harness.run();
        expect(report.repatched).toEqual([]);
        expect(report.decisions.some(d => d.outcome === "foreign-mod")).toBe(true);
    });

    it("the real port finds Windows residue only in a sibling folder our stub is in", () => {
        const branch = mkdtempSync(join(tmpdir(), "subline-branch-"));
        try {
            const oldRoot = join(branch, "app-1.0.1");
            const newRoot = join(branch, "app-1.0.2");
            for (const root of [oldRoot, newRoot]) mkdirSync(join(root, "resources"), { recursive: true });
            writeFileSync(join(oldRoot, "resources", "app.asar"), buildStubAsar(join(harness.runtimeDir, "patcher.js")));
            writeFileSync(join(oldRoot, "resources", "_app.asar"), buildOriginalDiscordAsar());
            writeFileSync(join(newRoot, "resources", "app.asar"), buildOriginalDiscordAsar("new"));
            const ports = createHelperPorts({ productVersion: "0.2.3", log: harness.ports.log, platform: "win32", env: { LOCALAPPDATA: join(branch, "..") }, home: branch });
            const install: DiscordInstall = {
                branch: "stable", rootPath: newRoot, stableId: branch, resourcesPath: join(newRoot, "resources"),
                asarPath: join(newRoot, "resources", "app.asar"), backupPath: join(newRoot, "resources", "_app.asar"),
                buildInfoPath: join(newRoot, "resources", "build_info.json"), fromExplicitPath: false
            };
            expect(ports.siblingCarriesOurMark?.(install)).toBe(true);
            // Vencord's stub in the old folder is not ours.
            writeFileSync(join(oldRoot, "resources", "app.asar"), buildStubAsar("C:\\Users\\x\\Vencord\\dist\\patcher.js"));
            expect(ports.siblingCarriesOurMark?.(install)).toBe(false);
        } finally {
            rmSync(branch, { recursive: true, force: true });
        }
    });

    // #29
    it("#29: a repair made by the app clears repatch-failed, and the failure streak resets", async () => {
        patchForReal(harness);
        await harness.run();
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        const real = harness.ports.patch;
        harness.ports.patch = () => err("PERMISSION_DENIED", "refused");
        await harness.run();
        harness.advance(60 * 60_000);
        await harness.run();
        expect(readPendingAlerts(harness.productDir).some(a => a.code === "repatch-failed")).toBe(true);
        harness.ports.patch = real;

        expect(patchInstall(harness.fixture.install, { modBundleDir: harness.runtimeDir, productVersion: PRODUCT_VERSION }).ok).toBe(true);
        harness.advance(5 * 60_000);
        const report = await harness.run();
        expect(report.decisions.some(d => d.outcome === "repatch-failed:resolved")).toBe(true);
        expect(readPendingAlerts(harness.productDir)).toEqual([]);
        expect(readHelperState(stateFile()).installs[harness.fixture.install.stableId]?.failures).toBe(0);
    });

    // #31
    for (const platform of ["win32", "darwin"] as const) {
        it(`#31 (${platform}): a Subline update under an open Discord rewrites only the marker; one "Subline updated", no quit nag`, async () => {
            harness.platform = platform;
            patchForReal(harness);
            await harness.run();
            harness.discordOpen = true;
            const asar = readFileSync(harness.fixture.install.asarPath);
            // The same file, not a rewrite with equal bytes: a full patch renames
            // a new file over app.asar (a new inode), which Windows refuses
            // while Discord runs.
            const inode = statSync(harness.fixture.install.asarPath).ino;
            harness.shipped.rebuild({ buildId: "77aa77aa77aa77aa" });
            expect(installModBundle({ sourceDir: harness.shipped.dir, destDir: harness.runtimeDir }).ok).toBe(true);

            for (let i = 0; i < 8; i++) {
                await harness.run();
                if (i === 0) {
                    const marker = readMarker(harness.fixture.install.resourcesPath);
                    expect(marker.ok && marker.value?.pluginBuildId).toBe("77aa77aa77aa77aa");
                }
                harness.advance(5 * 60_000);
            }
            expect(readFileSync(harness.fixture.install.asarPath).equals(asar)).toBe(true);
            expect(statSync(harness.fixture.install.asarPath).ino).toBe(inode);
            expect(harness.notifications.filter(n => n.code === "quit-required")).toEqual([]);
            const restart = harness.notifications.filter(n => n.code === "restart-required");
            expect(restart).toHaveLength(1);
            expect(restart[0]?.message).toBe("Subline updated. Quit and reopen Discord to use the new version.");
        });
    }

    // #30
    it("#30 (Windows, Discord open): a marker carried verbatim from the old folder is re-adopted, no quit nag", async () => {
        harness.platform = "win32";
        patchForReal(harness);
        await harness.run();
        const marker = readMarker(harness.fixture.install.resourcesPath);
        if (!marker.ok || marker.value === null) throw new Error("no marker");
        writeMarker(harness.fixture.install.resourcesPath, {
            ...marker.value, discordVersion: "0.0.405", backupPath: "C:\\old\\app-1.0.1\\resources\\_app.asar", patchedAt: "2026-01-01T00:00:00.000Z"
        });
        harness.discordOpen = true;
        const asar = readFileSync(harness.fixture.install.asarPath);
        for (let i = 0; i < 8; i++) {
            await harness.run();
            harness.advance(5 * 60_000);
        }
        const after = readMarker(harness.fixture.install.resourcesPath);
        expect(after.ok && after.value?.discordVersion).toBe("0.0.406");
        expect(after.ok && after.value?.backupPath).toBe(harness.fixture.install.backupPath);
        expect(readFileSync(harness.fixture.install.asarPath).equals(asar)).toBe(true);
        expect(harness.notifications.filter(n => n.code === "quit-required")).toEqual([]);
    });

    // #4
    it("#4: the bundle deleted while offline raises bundle-missing at once, naming the folder", async () => {
        patchForReal(harness);
        await harness.run();
        rmSync(harness.runtimeDir, { recursive: true, force: true });
        harness.advance(5 * 60_000);
        const report = await harness.run();
        const alert = harness.notifications.find(n => n.code === "bundle-missing");
        expect(alert?.message).toBe(`Subline's files are missing from ${harness.runtimeDir}. Open Subline to reinstall them.`);
        expect(report.alerts.some(a => a.notified)).toBe(true);
    });

    it("#4: the bundle gone under an older stub, Discord closed: Discord's own code is put back, the memory kept", async () => {
        patchForReal(harness);
        await harness.run();
        writeFileSync(harness.fixture.install.asarPath, buildStubAsar(join(harness.runtimeDir, "patcher.js"), legacyStubIndexSource));
        rmSync(harness.runtimeDir, { recursive: true, force: true });
        harness.advance(5 * 60_000);
        const report = await harness.run();
        expect(report.decisions.some(d => d.outcome === "unsafe-stub-restored")).toBe(true);
        expect(readFileSync(harness.fixture.install.asarPath).equals(harness.fixture.originalAsar)).toBe(true);
        expect(readHelperState(stateFile()).installs[harness.fixture.install.stableId]).toBeDefined();
    });

    it("#4: a legacy stub with a good bundle and Discord closed is rewritten to the current form", async () => {
        patchForReal(harness);
        await harness.run();
        writeFileSync(harness.fixture.install.asarPath, buildStubAsar(join(harness.runtimeDir, "patcher.js"), legacyStubIndexSource));
        harness.advance(5 * 60_000);
        const report = await harness.run();
        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        const stub = readStub(harness.fixture.install.asarPath);
        expect(stub.ok && stub.value?.indexSource).toBe(stubIndexSource(join(harness.runtimeDir, "patcher.js")));
    });

    it("#4: a legacy stub with Discord open (Windows) waits quietly: no deferral, no quit nag", async () => {
        harness.platform = "win32";
        patchForReal(harness);
        await harness.run();
        writeFileSync(harness.fixture.install.asarPath, buildStubAsar(join(harness.runtimeDir, "patcher.js"), legacyStubIndexSource));
        harness.discordOpen = true;
        for (let i = 0; i < 10; i++) {
            const report = await harness.run();
            expect(report.deferred).toEqual([]);
            harness.advance(5 * 60_000);
        }
        expect(harness.notifications).toEqual([]);
    });

    // #9
    it("#9: BetterDiscord over our stub: logged shadowed with one alert, never not-needed, never foreign-mod", async () => {
        patchForReal(harness);
        await harness.run();
        mkdirSync(join(harness.fixture.install.resourcesPath, "app"), { recursive: true });
        writeFileSync(join(harness.fixture.install.resourcesPath, "app", "index.js"), 'require("/Users/x/Library/Application Support/BetterDiscord/data/betterdiscord.asar")');
        for (let i = 0; i < 3; i++) {
            const report = await harness.run();
            expect(report.decisions.some(d => d.outcome === "not-needed")).toBe(false);
            expect(report.decisions.some(d => d.outcome === "foreign-mod")).toBe(false);
            expect(report.decisions.some(d => d.outcome === "shadowed")).toBe(true);
            harness.advance(60 * 60_000);
        }
        const shadowed = harness.notifications.filter(n => n.code === "shadowed");
        expect(shadowed).toHaveLength(1);
        expect(shadowed[0]?.message).toBe("BetterDiscord was installed over Subline, so Discord now ignores Subline. Remove BetterDiscord, or uninstall Subline.");
    });

    // #26 / #44
    it("#26/#44: killed between the two renames: the next run finishes the patch, no alert", async () => {
        patchForReal(harness);
        await harness.run();
        unlinkSync(harness.fixture.install.asarPath);
        writeFileSync(join(harness.fixture.install.resourcesPath, ".subline-app.asar.tmp"), "half");
        harness.advance(5 * 60_000);
        const report = await harness.run();
        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        const state = inspectInstall(harness.fixture.install);
        expect(state.ok && state.value.kind).toBe("patched-by-us");
        expect(readFileSync(harness.fixture.install.backupPath).equals(harness.fixture.originalAsar)).toBe(true);
        expect(harness.notifications).toEqual([]);
    });

    it("#44: a Discord that cannot start is never called fine", async () => {
        patchForReal(harness);
        await harness.run();
        unlinkSync(harness.fixture.install.asarPath);
        writeFileSync(harness.fixture.install.backupPath, buildStubAsar("/Users/x/Vencord/dist/patcher.js"));
        harness.advance(5 * 60_000);
        await harness.run();
        const messages = harness.notifications.map(n => n.message);
        expect(messages.some(m => m.includes("Discord itself is fine"))).toBe(false);
        expect(harness.notifications.find(n => n.code === "discord-unstartable")?.message)
            .toBe("Discord cannot start until Subline repairs it. Open Subline to repair it.");
    });

    // #43
    it("#43: a skipped Discord is logged with its evidence, in full once, then as one line", async () => {
        writeFileSync(harness.fixture.install.asarPath, buildStubAsar("/Users/x/Vencord/dist/patcher.js"));
        writeFileSync(harness.fixture.install.backupPath, buildOriginalDiscordAsar());
        const first = await harness.run();
        const skip = first.decisions.find(d => d.outcome === "not-ours");
        expect(skip?.fields).toMatchObject({ markerPresent: false, loader: "/Users/x/Vencord/dist/patcher.js", backup: true, remembered: false });
        expect(isIdleRun(first)).toBe(false);
        harness.advance(5 * 60_000);
        const second = await harness.run();
        expect(second.repeatUnmanaged).toBe(true);
        expect(isIdleRun(second)).toBe(true);
        writeFileSync(harness.fixture.install.asarPath, buildStubAsar("/Users/x/Equicord/dist/patcher.js"));
        harness.advance(5 * 60_000);
        const third = await harness.run();
        expect(third.repeatUnmanaged).toBe(false);
        expect(isIdleRun(third)).toBe(false);
    });

    // #32
    it("#32: a sticky erroring health writes a full entry once, then one line", async () => {
        patchForReal(harness);
        writeBeacon(harness.beaconPath, harness.shipped.buildId, {
            lastError: { at: new Date(START).toISOString(), code: "rate-limited" }
        });
        const first = await harness.run();
        harness.advance(5 * 60_000);
        const second = await harness.run();
        expect(second.health?.status).toBe(first.health?.status);
        if (first.health?.status === "erroring") {
            expect(isIdleRun(first)).toBe(false);
            expect(isIdleRun(second)).toBe(true);
        } else {
            throw new Error(`the fixture beacon read as ${first.health?.status ?? "nothing"}, not erroring`);
        }
    });

    // #47 / #28
    it("#47: right after the quit notice, a quit-and-reopen inside the run is caught and repaired", async () => {
        harness.platform = "win32";
        patchForReal(harness);
        await harness.run({ settle: {} });
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        harness.discordOpen = true;
        for (let i = 0; i < 8; i++) {
            await harness.run({ settle: {} });
            harness.advance(5 * 60_000);
        }
        expect(harness.notifications.filter(n => n.code === "quit-required")).toHaveLength(1);
        // Open for two looks, then quit: within one run.
        scriptRunning([true, true, false]);
        const report = await harness.run({ settle: {} });
        expect(report.repatched).toEqual([harness.fixture.install.rootPath]);
        expect(report.deferred).toEqual([]);
    });

    it("#47: nothing pending, Discord open: at most one look per run (the cheap path stays cheap)", async () => {
        harness.platform = "win32";
        patchForReal(harness);
        await harness.run({ settle: {} });
        const looks = scriptRunning([true]);
        await harness.run({ settle: {} });
        expect(looks.calls()).toBeLessThanOrEqual(1);
    });

    it("#47: more than 30 minutes after the notice, Discord still open: back to one look", async () => {
        harness.platform = "win32";
        patchForReal(harness);
        await harness.run({ settle: {} });
        simulateDiscordUpdate(harness.fixture.install, "0.0.407");
        harness.discordOpen = true;
        for (let i = 0; i < 8; i++) {
            await harness.run({ settle: {} });
            harness.advance(5 * 60_000);
        }
        harness.advance(31 * 60_000);
        const looks = scriptRunning([true]);
        await harness.run({ settle: {} });
        expect(looks.calls()).toBeLessThanOrEqual(2);
    });
});

describe("audit #4: rewriting an older stub is housekeeping", () => {
    it("a refused rewrite is retried weekly, not every run", async () => {
        patchForReal(harness);
        await harness.run();
        writeFileSync(harness.fixture.install.asarPath, buildStubAsar(join(harness.runtimeDir, "patcher.js"), legacyStubIndexSource));
        let attempts = 0;
        harness.ports.patch = () => { attempts += 1; return err("PERMISSION_DENIED", "App Management"); };
        for (let i = 0; i < 12; i++) {
            const report = await harness.run();
            expect(report.failed).toEqual([]);
            harness.advance(60 * 60_000);
        }
        expect(attempts).toBe(1);
        expect(harness.notifications).toEqual([]);
        harness.advance(7 * 24 * 60 * 60_000);
        await harness.run();
        expect(attempts).toBe(2);
    });
});
