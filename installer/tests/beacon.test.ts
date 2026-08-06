import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    BEACON_FILENAME, beaconDirFor, beaconPathFor, readBeaconAt, SUPPORTED_BEACON_FORMAT,
    validateBeacon
} from "../src/verify/beacon.js";

const AT = "2026-08-06T10:00:00.000Z";
const BUILD_ID = "1f2e3d4c5b6a7980";
const AT_MS = Date.parse(AT);

/** What the plugin actually writes, in full. */
function beaconDocument(overrides: Record<string, unknown> = {}) {
    return {
        format: SUPPORTED_BEACON_FORMAT,
        product: "subline",
        pluginVersion: "0.1.0",
        buildId: BUILD_ID,
        loadedAt: AT,
        updatedAt: "2026-08-06T10:05:00.000Z",
        lastTranslationAt: "2026-08-06T10:04:00.000Z",
        lastRenderedAt: "2026-08-06T10:04:01.000Z",
        lastEngine: "gemini",
        counts: { approx: 12, upgraded: 3 },
        lastError: null,
        ...overrides
    };
}

let root: string;
let path: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subline-verify-"));
    path = join(root, BEACON_FILENAME);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function writeDocument(value: unknown): void {
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 4));
}

describe("where the reader looks", () => {
    it("looks where the plugin writes, on macOS", () => {
        expect(beaconPathFor("darwin", {}, "/Users/ana"))
            .toBe("/Users/ana/Library/Application Support/Subline/status.json");
    });

    it("looks under %LOCALAPPDATA% on Windows", () => {
        expect(beaconDirFor("win32", { LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" }, "/ignored"))
            .toBe(join("C:\\Users\\ana\\AppData\\Local", "Subline"));
    });

    it("has nowhere to look on a platform we do not support", () => {
        expect(beaconPathFor("linux", {}, "/home/ana")).toBeNull();
        expect(beaconPathFor("win32", {}, "/home/ana")).toBeNull();
    });
});

describe("an absent beacon is a state, not an error", () => {
    it("reports null rather than failing when nothing has been written", () => {
        // The ordinary case immediately after patching: Discord has not started
        // yet. Failing here would make "waiting" look like "broken".
        const read = readBeaconAt(path);
        expect(read.ok).toBe(true);
        expect(read.ok && read.value).toBeNull();
    });
});

describe("a damaged beacon degrades safely", () => {
    it("names the failure for a file caught mid-write", () => {
        // The plugin renames into place, so this should not happen — but a
        // reader that only works because of the writer's discipline is one
        // change away from crashing an installer on a truncated file.
        writeDocument('{"product":"subline","loadedAt":"2026-08-06T10:00');
        const read = readBeaconAt(path);
        expect(read.ok).toBe(false);
        expect(!read.ok && read.error.code).toBe("BEACON_MALFORMED");
    });

    it("refuses a document that parses but is not an object", () => {
        writeDocument('"loaded"');
        expect(readBeaconAt(path).ok).toBe(false);
        writeDocument("[]");
        expect(readBeaconAt(path).ok).toBe(false);
        writeDocument("null");
        expect(readBeaconAt(path).ok).toBe(false);
    });

    it("refuses someone else's status.json in the same folder", () => {
        writeDocument(beaconDocument({ product: "vencord" }));
        const read = readBeaconAt(path);
        expect(!read.ok && read.error.code).toBe("BEACON_MALFORMED");
    });

    it("refuses a format it does not understand instead of guessing at it", () => {
        // A newer plugin may have redefined a field this reader would otherwise
        // read as a confirmation. Refusing costs a green tick; guessing costs
        // the user a working install they are told is fine.
        writeDocument(beaconDocument({ format: SUPPORTED_BEACON_FORMAT + 1 }));
        const read = readBeaconAt(path);
        expect(!read.ok && read.error.code).toBe("BEACON_FORMAT_UNSUPPORTED");
    });

    it("refuses a format-1 beacon, which predates the build identity", () => {
        // Format 1 has no `buildId`, so its "the plugin loaded" cannot be
        // attributed to any particular build. Refusing the document is more
        // honest than reading it and quietly skipping the identity check.
        writeDocument(beaconDocument({ format: 1, buildId: undefined }));
        const read = readBeaconAt(path);
        expect(!read.ok && read.error.code).toBe("BEACON_FORMAT_UNSUPPORTED");
    });

    it("understands format 2, and says so where a change has to be deliberate", () => {
        // PINNED, and pinned on BOTH sides: the plugin's own BEACON_FORMAT
        // carries the same assertion. The contract is duplicated on purpose
        // (see beacon.ts's header), and the drift that duplication risks is one
        // side being bumped alone — which turns every healthy install into
        // "unreadable-beacon" silently. Two pins make that a test failure that
        // names the other side.
        expect(SUPPORTED_BEACON_FORMAT).toBe(2);
    });

    it("refuses a beacon with no usable load timestamp", () => {
        // Without it nothing can be dated to an installation, which is the one
        // question this file exists to answer.
        for (const loadedAt of [undefined, null, "yesterday", 1_754_474_400_000, "2026-08-06"]) {
            writeDocument(beaconDocument({ loadedAt }));
            const read = readBeaconAt(path);
            expect(!read.ok && read.error.code).toBe("BEACON_MALFORMED");
        }
    });

    it("names the failure when the file cannot be read at all", () => {
        mkdirSync(join(root, "unreadable"));
        const locked = join(root, "unreadable", BEACON_FILENAME);
        writeFileSync(locked, JSON.stringify(beaconDocument()));
        chmodSync(locked, 0o000);
        try {
            const read = readBeaconAt(locked);
            // Root can read anything, so accept either the permission error or
            // a successful read — what must never happen is a throw.
            expect(read.ok || read.error.code === "PERMISSION_DENIED").toBe(true);
        } finally {
            chmodSync(locked, 0o600);
        }
    });
});

describe("validateBeacon — what survives, and what is coerced", () => {
    it("turns a complete document into epoch milliseconds", () => {
        const read = readBeaconAt((writeDocument(beaconDocument()), path));
        expect(read.ok).toBe(true);
        expect(read.ok && read.value).toEqual({
            format: SUPPORTED_BEACON_FORMAT,
            pluginVersion: "0.1.0",
            buildId: BUILD_ID,
            loadedAt: AT_MS,
            updatedAt: Date.parse("2026-08-06T10:05:00.000Z"),
            lastTranslationAt: Date.parse("2026-08-06T10:04:00.000Z"),
            lastRenderedAt: Date.parse("2026-08-06T10:04:01.000Z"),
            lastEngine: "gemini",
            counts: { approx: 12, upgraded: 3 },
            lastError: null,
            path
        });
    });

    it("keeps a well-formed error and drops a half-written one", () => {
        const good = validateBeacon(
            beaconDocument({ lastError: { code: "rate-limited", at: AT } }), path
        );
        expect(good.ok && good.value.lastError).toEqual({ code: "rate-limited", at: AT_MS });

        for (const lastError of [
            { code: "rate-limited" },
            { at: AT },
            { code: "something went wrong translating hola", at: AT },
            "rate-limited"
        ]) {
            const partial = validateBeacon(beaconDocument({ lastError }), path);
            expect(partial.ok && partial.value.lastError).toBeNull();
        }
    });

    it("keeps a well-formed build id — the field the confirmation now depends on", () => {
        for (const buildId of [BUILD_ID, "0a80601a", "f".repeat(64)]) {
            const read = validateBeacon(beaconDocument({ buildId }), path);
            expect(read.ok && read.value.buildId).toBe(buildId);
        }
    });

    it("reads a missing or malformed build id as null, never as a wildcard", () => {
        // This file is untrusted input from a user-writable directory. An
        // unconstrained string here would be a free-text field in a document
        // that is not allowed to have one (spec §7 — the plugin reads DMs), and
        // a coerced placeholder would be an identity some build could match.
        for (const buildId of [
            undefined, null, "", 42, {}, ["0a80601a"],
            "0a80601",                          // shorter than any digest we emit
            "0A80601A72BB57F6",                 // uppercase
            "0a80601a-72bb-57f6",               // punctuation
            "1f2e3d4c5b6a7980 and then he said" // a real id with text stapled on
        ]) {
            const read = validateBeacon(beaconDocument({ buildId }), path);
            expect(read.ok && read.value.buildId).toBeNull();
        }
    });

    it("does not discard the whole beacon over a missing identity", () => {
        // "Something loaded but would not say which build" is a state the
        // diagnostics screen wants to report out loud. It costs the
        // confirmation in verifyOnce, not the evidence here.
        const read = validateBeacon(beaconDocument({ buildId: undefined }), path);
        expect(read.ok).toBe(true);
        expect(read.ok && read.value.loadedAt).toBe(AT_MS);
    });

    it("falls back to the load time when updatedAt is missing", () => {
        // Never to "now": an invented recency would make every beacon, however
        // old, look freshly written — which is the false confirmation this
        // whole mechanism exists to prevent.
        const read = validateBeacon(beaconDocument({ updatedAt: undefined }), path);
        expect(read.ok && read.value.updatedAt).toBe(AT_MS);
    });

    it("treats a missing render/translation timestamp as 'never', not as 'now'", () => {
        const read = validateBeacon(
            beaconDocument({ lastRenderedAt: undefined, lastTranslationAt: "soon" }), path
        );
        expect(read.ok && read.value.lastRenderedAt).toBeNull();
        expect(read.ok && read.value.lastTranslationAt).toBeNull();
    });

    it("zeroes counts that are not counts, rather than failing the whole beacon", () => {
        // A damaged count costs a tier distinction. Discarding the beacon over
        // it would cost the load confirmation too, which is worth more.
        const read = validateBeacon(
            beaconDocument({ counts: { approx: "many", upgraded: -3 } }), path
        );
        expect(read.ok && read.value.counts).toEqual({ approx: 0, upgraded: 0 });
    });

    it("survives counts that are missing altogether", () => {
        const read = validateBeacon(beaconDocument({ counts: undefined }), path);
        expect(read.ok && read.value.counts).toEqual({ approx: 0, upgraded: 0 });
    });
});
