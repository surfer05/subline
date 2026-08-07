/**
 * The helper's memory between runs.
 *
 * The property that matters: a state file we cannot understand must degrade to
 * "no memory", never to a crash and never to a confident wrong answer. A helper
 * that refused an unfamiliar document would turn "somebody added a field" into
 * "the helper stopped repairing installs".
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    emptyHelperState, HELPER_STATE_FILENAME, HELPER_STATE_FORMAT, helperStatePathFor, parseHelperState,
    readHelperState, writeHelperState
} from "../src/helper/state.js";

let dir: string;
let path: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subline-helper-state-"));
    path = helperStatePathFor(dir);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("helper state", () => {
    it("puts the state file inside Subline's own directory", () => {
        expect(path).toBe(join(dir, HELPER_STATE_FILENAME));
    });

    it("round-trips everything the triggers depend on", () => {
        const state = emptyHelperState();
        state.lastRunAt = 1_700_000_000_000;
        state.lastUpdateCheckAt = 1_700_000_100_000;
        state.lastReleaseBuildId = "1f2e3d4c5b6a7980";
        state.updateFailures = 2;
        state.installs["/Applications/Discord.app"] = {
            discordVersion: "0.0.406",
            buildId: "1f2e3d4c5b6a7980",
            patchedAt: 1_699_000_000_000,
            failures: 1
        };
        state.health = {
            lastStatus: "suspect",
            lastObservedAt: 1_700_000_000_000,
            suspectSince: 1_699_000_000_000,
            observations: 2
        };
        state.alerts["mod-stale"] = { firstAt: 10, lastNotifiedAt: 20, count: 3 };

        expect(writeHelperState(path, state).ok).toBe(true);
        expect(readHelperState(path)).toEqual({ ...state, format: HELPER_STATE_FORMAT });
    });

    it("reads a missing file as no memory rather than failing", () => {
        expect(readHelperState(join(dir, "nothing.json"))).toEqual(emptyHelperState());
    });

    it("reads an unparsable file as no memory rather than throwing", () => {
        writeFileSync(path, "{ not json", "utf8");
        expect(readHelperState(path)).toEqual(emptyHelperState());
    });

    it("reads a file that PARSES but is not an object as no memory", () => {
        // `[1,2,3]` and `"a string"` both survive JSON.parse and would sail past
        // a check that only guarded against a parse error.
        for (const document of ["[1,2,3]", '"a string"', "42", "null", "true"]) {
            writeFileSync(path, document, "utf8");
            expect(readHelperState(path)).toEqual(emptyHelperState());
        }
    });

    it("keeps the fields it understands when the rest of the document is nonsense", () => {
        writeFileSync(
            path,
            JSON.stringify({
                lastRunAt: 5,
                lastUpdateCheckAt: "yesterday",
                updateFailures: -3,
                installs: { "/A": { discordVersion: 406, buildId: "abcdef01", patchedAt: 9, failures: 2 }, "/B": "no" },
                health: { lastStatus: 7, observations: "many" },
                alerts: { good: { firstAt: 1, lastNotifiedAt: 2, count: 3 }, bad: { count: 3 } }
            }),
            "utf8"
        );
        const state = readHelperState(path);

        expect(state.lastRunAt).toBe(5);
        // A string where a number belongs is not a timestamp; it must not become one.
        expect(state.lastUpdateCheckAt).toBeNull();
        expect(state.updateFailures).toBe(0);
        expect(state.installs["/A"]).toEqual({
            discordVersion: null,
            buildId: "abcdef01",
            patchedAt: 9,
            failures: 2
        });
        expect(state.installs["/B"]).toBeUndefined();
        expect(state.health.lastStatus).toBe("unknown");
        expect(state.health.observations).toBe(0);
        // An alert with no timestamps could never be de-duplicated against.
        expect(state.alerts.good).toEqual({ firstAt: 1, lastNotifiedAt: 2, count: 3 });
        expect(state.alerts.bad).toBeUndefined();
    });

    it("writes atomically and leaves no temporary file behind", () => {
        expect(writeHelperState(path, emptyHelperState()).ok).toBe(true);
        expect(existsSync(path)).toBe(true);
        expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
    });

    it("always stamps the format it wrote, whatever the caller passed", () => {
        const state = { ...emptyHelperState(), format: 99 };
        writeHelperState(path, state);
        expect(JSON.parse(readFileSync(path, "utf8")).format).toBe(HELPER_STATE_FORMAT);
    });

    it("reports a named error rather than throwing when the state cannot be written", () => {
        // A directory where the file belongs: the rename cannot land.
        rmSync(dir, { recursive: true, force: true });
        writeFileSync(join(tmpdir(), "unused"), "", "utf8");
        const result = writeHelperState(join("/", "definitely-not-writable-by-tests", "s.json"), emptyHelperState());
        expect(result.ok).toBe(false);
    });

    it("parses directly from text, so no test needs a file to check the shape", () => {
        expect(parseHelperState('{"lastReleaseBuildId":"abcdef01"}').lastReleaseBuildId).toBe("abcdef01");
    });
});
