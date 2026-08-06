import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reportStatus } from "../native";
import { statusDirFor, statusPathFor, writeStatusBeacon, writeStatusFile } from "../statusFile";
import { BEACON_FILENAME, BEACON_FORMAT, type StatusBeacon } from "../statusShape";

const AT = "2026-08-06T10:00:00.000Z";

function beacon(overrides: Partial<StatusBeacon> = {}): StatusBeacon {
    return {
        format: BEACON_FORMAT,
        product: "subline",
        pluginVersion: "0.1.0",
        loadedAt: AT,
        updatedAt: AT,
        lastTranslationAt: null,
        lastRenderedAt: null,
        lastEngine: null,
        counts: { approx: 0, upgraded: 0 },
        lastError: null,
        ...overrides
    };
}

/** Vencord injects the IpcMainInvokeEvent; reportStatus never touches it. */
const EV = {} as never;

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subline-beacon-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("where the beacon lives", () => {
    it("uses ~/Library/Application Support/Subline on macOS", () => {
        expect(statusPathFor("darwin", {}, "/Users/ana"))
            .toBe("/Users/ana/Library/Application Support/Subline/status.json");
    });

    it("uses %LOCALAPPDATA%\\Subline on Windows", () => {
        // Spec §5: Windows is per-user under LOCALAPPDATA and needs no UAC.
        // Written now, not later — the point of a per-platform table is that
        // the second platform is a row rather than a redesign.
        expect(statusDirFor("win32", { LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" }, "/ignored"))
            .toBe(join("C:\\Users\\ana\\AppData\\Local", "Subline"));
    });

    it("has no path on Windows without LOCALAPPDATA, rather than guessing one", () => {
        // A guessed path writes a beacon nobody reads, which reads as a dead
        // install. No path at all is the same outcome and costs no litter.
        expect(statusDirFor("win32", {}, "/Users/ana")).toBeNull();
    });

    it("has no path on an unsupported platform", () => {
        expect(statusDirFor("linux", {}, "/home/ana")).toBeNull();
        expect(statusPathFor("linux", {}, "/home/ana")).toBeNull();
    });

    it("puts the file inside the product directory, not beside it", () => {
        const dir = statusDirFor("darwin", {}, "/Users/ana")!;
        expect(statusPathFor("darwin", {}, "/Users/ana")).toBe(join(dir, BEACON_FILENAME));
    });
});

describe("writeStatusFile", () => {
    it("creates the product directory if it does not exist yet", () => {
        // First launch after an install: nothing has ever written here.
        const path = join(root, "Application Support", "Subline", BEACON_FILENAME);
        expect(writeStatusFile(path, beacon())).toBe(true);
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(beacon());
    });

    it("leaves no temp file behind on a successful write", () => {
        // The write is atomic (temp + rename) so a reader never sees a partial
        // document. A leftover temp would be a second file the installer might
        // find and a slow leak next to the one file it should read.
        const dir = join(root, "Subline");
        const path = join(dir, BEACON_FILENAME);
        writeStatusFile(path, beacon());
        expect(readdirSync(dir)).toEqual([BEACON_FILENAME]);
    });

    it("replaces a previous beacon rather than appending to it", () => {
        const path = join(root, BEACON_FILENAME);
        writeStatusFile(path, beacon({ counts: { approx: 1, upgraded: 0 } }));
        writeStatusFile(path, beacon({ counts: { approx: 9, upgraded: 2 } }));
        expect(JSON.parse(readFileSync(path, "utf8")).counts).toEqual({ approx: 9, upgraded: 2 });
    });

    it("reports false instead of throwing when the directory cannot be created", () => {
        // The whole file is on the translation hot path via IPC. A read-only
        // volume, a revoked permission or a full disk must cost the installer
        // its confirmation and cost the reader nothing.
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o500);
        try {
            expect(writeStatusFile(join(locked, "Subline", BEACON_FILENAME), beacon())).toBe(false);
        } finally {
            chmodSync(locked, 0o700);
        }
    });

    it("reports false instead of throwing when the path is not writable", () => {
        // A directory where the beacon should be: every fs call fails.
        const path = join(root, BEACON_FILENAME);
        mkdirSync(path);
        expect(writeStatusFile(path, beacon())).toBe(false);
    });

    it("leaves no temp file behind when the write fails", () => {
        const path = join(root, BEACON_FILENAME);
        mkdirSync(path);
        writeStatusFile(path, beacon());
        expect(readdirSync(root)).toEqual([BEACON_FILENAME]);
    });
});

describe("writeStatusBeacon — the untrusted entry point", () => {
    it("writes a sanitised beacon from a JSON payload", () => {
        const path = join(root, BEACON_FILENAME);
        expect(writeStatusBeacon(JSON.stringify(beacon()), { path })).toBe(true);
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(beacon());
    });

    it("never lets message text reach the disk, whatever the renderer sends", () => {
        // The guarantee has to hold at the WRITER, not at the caller: this is
        // the last point before private conversation would become a file on
        // disk that any process can read (spec §7).
        const secret = "私の秘密のメッセージ";
        const path = join(root, BEACON_FILENAME);

        writeStatusBeacon(
            JSON.stringify({
                ...beacon(),
                text: secret,
                messages: [{ id: "1", author: "ana", content: secret }],
                lastError: { code: secret, at: AT }
            }),
            { path }
        );

        expect(readFileSync(path, "utf8")).not.toContain(secret);
    });

    it("writes nothing at all for malformed JSON", () => {
        const path = join(root, BEACON_FILENAME);
        expect(writeStatusBeacon("{not json", { path })).toBe(false);
        expect(existsSync(path)).toBe(false);
    });

    it("writes nothing at all for a payload that is not one of ours", () => {
        const path = join(root, BEACON_FILENAME);
        expect(writeStatusBeacon(JSON.stringify({ product: "other", loadedAt: AT }), { path })).toBe(false);
        expect(existsSync(path)).toBe(false);
    });

    it("does not clobber a good beacon with a rejected payload", () => {
        // The failure mode that matters: a bad write must not destroy the
        // confirmation an earlier good write already recorded.
        const path = join(root, BEACON_FILENAME);
        writeStatusBeacon(JSON.stringify(beacon({ counts: { approx: 3, upgraded: 1 } })), { path });
        writeStatusBeacon("{not json", { path });
        expect(JSON.parse(readFileSync(path, "utf8")).counts).toEqual({ approx: 3, upgraded: 1 });
    });

    it("reports false when the platform has nowhere to put it", () => {
        expect(writeStatusBeacon(JSON.stringify(beacon()), { platform: "linux", home: root, env: {} }))
            .toBe(false);
    });

    it("resolves the real per-platform path when no explicit path is given", () => {
        // Guards the wiring between writeStatusBeacon and statusPathFor: an
        // explicit `path` is a test affordance, and a test that only ever uses
        // it would never notice the production route being broken.
        expect(writeStatusBeacon(JSON.stringify(beacon()), { platform: "darwin", home: root, env: {} }))
            .toBe(true);
        const written = join(root, "Library", "Application Support", "Subline", BEACON_FILENAME);
        expect(JSON.parse(readFileSync(written, "utf8"))).toEqual(beacon());
    });
});

describe("native.reportStatus — the IPC surface the renderer actually calls", () => {
    // reportStatus deliberately takes NO path/platform argument. Vencord's
    // pluginHelpers are reachable from the renderer, i.e. from Discord's own
    // page, so an argument that chose the destination would be an
    // arbitrary-file-write handed to whatever else runs there. The destination
    // is resolved in the main process and nowhere else — which is why this
    // test redirects the ENVIRONMENT (as a real machine would differ) rather
    // than passing an override.
    let savedHome: string | undefined;
    let savedLocalAppData: string | undefined;

    beforeEach(() => {
        savedHome = process.env.HOME;
        savedLocalAppData = process.env.LOCALAPPDATA;
        process.env.HOME = root;            // os.homedir() on POSIX
        process.env.LOCALAPPDATA = root;    // the Windows row of the same table
    });

    afterEach(() => {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = savedLocalAppData;
    });

    it("is reachable as a native export and writes through to the resolved path", async () => {
        // The renderer cannot write files; Vencord exposes every export of
        // native.ts on VencordNative.pluginHelpers.VcTranslate, which is the
        // mechanism translateBatch already uses. This is that same surface, not
        // a second one.
        const expected = statusPathFor(process.platform);
        expect(expected).not.toBeNull();

        await expect(reportStatus(EV, JSON.stringify(beacon()))).resolves.toBe(true);

        expect(JSON.parse(readFileSync(expected!, "utf8"))).toEqual(beacon());
    });

    it("resolves false rather than rejecting on a payload it cannot use", async () => {
        // It is invoked fire-and-forget from the renderer's hot path. A
        // rejection would surface as an unhandled promise rejection in the
        // user's console for something they can do nothing about.
        await expect(reportStatus(EV, "{not json")).resolves.toBe(false);
        expect(existsSync(statusPathFor(process.platform)!)).toBe(false);
    });
});
