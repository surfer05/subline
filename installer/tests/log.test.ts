/**
 * The diagnostics log's job is as much about what it REFUSES to write as about
 * what it writes, so most of these tests are about the refusal.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    DiagnosticsLog,
    formatEntry,
    LOG_FILENAME,
    MAX_FIELD_CHARS,
    redactField,
    redactHome,
    REDACTED_FIELD_KEYS,
    REDACTED_PLACEHOLDER
} from "../src/app/log.js";

let dir: string;
let clockValue: number;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subline-log-"));
    clockValue = Date.UTC(2026, 7, 6, 12, 0, 0);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function makeLog(options: { maxBytes?: number; maxFiles?: number; home?: string } = {}): DiagnosticsLog {
    return new DiagnosticsLog({
        dir,
        clock: () => clockValue,
        home: options.home ?? "/Users/testperson",
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
        ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles })
    });
}

describe("redactField", () => {
    it("blanks every key on the sensitive list, whatever the value is", () => {
        for (const key of REDACTED_FIELD_KEYS) {
            expect(redactField(key, "hello there, this is a private DM")).toBe(REDACTED_PLACEHOLDER);
        }
    });

    it("matches sensitive keys case-insensitively", () => {
        expect(redactField("ApiKey", "AIzaSyDEADBEEF")).toBe(REDACTED_PLACEHOLDER);
        expect(redactField("MESSAGE", "hi")).toBe(REDACTED_PLACEHOLDER);
    });

    it("caps a long value on a key nobody thought to add to the list", () => {
        const smuggled = "x".repeat(MAX_FIELD_CHARS + 500);
        const written = redactField("channelSummary", smuggled);
        expect(written.endsWith("[truncated]")).toBe(true);
        expect(written.length).toBeLessThan(MAX_FIELD_CHARS + 20);
    });

    it("keeps a short value on an ordinary key intact", () => {
        expect(redactField("code", "PERMISSION_DENIED")).toBe("PERMISSION_DENIED");
    });

    it("flattens newlines so one field can never become several log lines", () => {
        expect(redactField("cause", "Error: nope\n    at foo\n    at bar")).toBe("Error: nope     at foo     at bar");
    });

    it("renders nullish as null rather than dropping the field", () => {
        expect(redactField("discordVersion", null)).toBe("null");
        expect(redactField("discordVersion", undefined)).toBe("null");
    });

    it("passes numbers and booleans through", () => {
        expect(redactField("attempt", 3)).toBe("3");
        expect(redactField("granted", false)).toBe("false");
    });
});

describe("formatEntry", () => {
    it("writes a timestamped, levelled, single line", () => {
        const line = formatEntry(Date.UTC(2026, 7, 6, 12, 0, 0), "warn", "patch.rollback", { code: "VERIFICATION_FAILED" });
        expect(line).toBe("2026-08-06T12:00:00.000Z WARN  patch.rollback code=VERIFICATION_FAILED\n");
        expect(line.split("\n").filter(Boolean)).toHaveLength(1);
    });

    it("omits the trailing space when there are no fields", () => {
        expect(formatEntry(0, "info", "flow.start", {})).toBe("1970-01-01T00:00:00.000Z INFO  flow.start\n");
    });
});

describe("DiagnosticsLog", () => {
    it("creates its directory and writes the version header first", () => {
        const nested = join(dir, "deeper", "still");
        const log = new DiagnosticsLog({ dir: nested, clock: () => clockValue, home: "/Users/testperson" });
        log.writeHeader({ productVersion: "0.1.0", discordVersion: "0.0.406", modBuildId: "abcd1234", os: "darwin" });
        const text = readFileSync(join(nested, LOG_FILENAME), "utf8");
        expect(text).toContain("subline.session");
        expect(text).toContain("product=0.1.0");
        expect(text).toContain("discord=0.0.406");
        expect(text).toContain("modBuild=abcd1234");
        expect(text).toContain("os=darwin");
    });

    it("appends entries in order", () => {
        const log = makeLog();
        log.info("flow.step", { step: "detect-discord" });
        clockValue += 1000;
        log.error("patch.failed", { code: "PERMISSION_DENIED" });
        const lines = log.read().trim().split("\n");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("flow.step step=detect-discord");
        expect(lines[1]).toContain("ERROR patch.failed code=PERMISSION_DENIED");
    });

    it("redacts sensitive fields on the way to disk, not just in the copy bundle", () => {
        const log = makeLog();
        log.info("translation.done", { message: "gizli bir mesaj", apiKey: "AIzaSyREAL" });
        const onDisk = log.read();
        expect(onDisk).not.toContain("gizli bir mesaj");
        expect(onDisk).not.toContain("AIzaSyREAL");
        expect(onDisk).toContain(`message=${REDACTED_PLACEHOLDER}`);
    });

    it("returns an empty string before anything is written", () => {
        expect(makeLog().read()).toBe("");
    });

    describe("rotation", () => {
        it("rotates before the write that would overflow, so the active file never exceeds the cap", () => {
            const log = makeLog({ maxBytes: 400 });
            for (let i = 0; i < 20; i += 1) {
                log.info("flow.step", { step: `step-number-${i}`, detail: "some padding text here" });
                expect(log.read().length).toBeLessThanOrEqual(400);
            }
            expect(existsSync(log.rotatedPath(1))).toBe(true);
        });

        it("shifts generations down and drops the oldest beyond maxFiles", () => {
            const log = makeLog({ maxBytes: 200, maxFiles: 2 });
            for (let i = 0; i < 40; i += 1) log.info("flow.step", { step: `padding-value-${i}` });
            expect(existsSync(log.rotatedPath(1))).toBe(true);
            expect(existsSync(log.rotatedPath(2))).toBe(true);
            expect(existsSync(log.rotatedPath(3))).toBe(false);
        });

        it("re-writes the version header into each new file, so the newest one still names the build", () => {
            const log = makeLog({ maxBytes: 300 });
            log.writeHeader({ productVersion: "9.9.9", os: "darwin" });
            for (let i = 0; i < 20; i += 1) log.info("flow.step", { step: `padding-value-${i}` });
            expect(log.read()).toContain("product=9.9.9");
        });

        it("does not write a header into a rotated file when none was ever set", () => {
            const log = makeLog({ maxBytes: 200 });
            for (let i = 0; i < 20; i += 1) log.info("flow.step", { step: `padding-value-${i}` });
            expect(log.read()).not.toContain("subline.session");
        });
    });

    describe("copyBundle", () => {
        it("replaces the home directory with ~ so a pasted report carries no real name", () => {
            const log = makeLog({ home: "/Users/ada.lovelace" });
            log.info("patch.start", { path: "/Users/ada.lovelace/Applications/Discord.app" });
            const bundle = log.copyBundle();
            expect(bundle).not.toContain("ada.lovelace");
            expect(bundle).toContain("~/Applications/Discord.app");
        });

        it("leaves the on-disk log unredacted — it is the user's own machine", () => {
            const log = makeLog({ home: "/Users/ada.lovelace" });
            log.info("patch.start", { path: "/Users/ada.lovelace/Applications/Discord.app" });
            expect(log.read()).toContain("/Users/ada.lovelace/Applications/Discord.app");
        });

        it("includes the previous generation, where the original failure usually is", () => {
            const log = makeLog({ maxBytes: 250 });
            log.error("the.original.failure", { code: "PERMISSION_DENIED" });
            // Stop at the FIRST rotation. Padding past it would push the failure
            // into generation 2, which the bundle legitimately does not carry.
            for (let i = 0; i < 20 && !existsSync(log.rotatedPath(1)); i += 1) {
                log.info("flow.step", { step: `padding-value-${i}` });
            }
            expect(existsSync(log.rotatedPath(1))).toBe(true);
            const bundle = log.copyBundle();
            expect(bundle).toContain("the.original.failure");
            expect(bundle).toContain("--- previous ---");
            expect(bundle).toContain("--- current ---");
        });

        it("omits the separators when there is no previous generation", () => {
            const log = makeLog();
            log.info("flow.step", { step: "welcome" });
            expect(log.copyBundle()).not.toContain("--- previous ---");
        });
    });

    it("keeps appending to a log left behind by an earlier run", () => {
        writeFileSync(join(dir, LOG_FILENAME), "2026-01-01T00:00:00.000Z INFO  earlier.run\n", "utf8");
        const log = makeLog();
        log.info("later.run");
        const text = log.read();
        expect(text).toContain("earlier.run");
        expect(text).toContain("later.run");
    });
});

describe("redactHome", () => {
    it("is a no-op for an empty home, rather than replacing every character", () => {
        expect(redactHome("/Users/x/thing", "")).toBe("/Users/x/thing");
    });
});
