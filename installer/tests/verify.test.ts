import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BEACON_FILENAME, SUPPORTED_BEACON_FORMAT } from "../src/verify/beacon.js";
import {
    awaitVerification, DEFAULT_VERIFY_TIMEOUT_MS, verifyOnce
} from "../src/verify/verify.js";

/**
 * A whole install's timeline, in epoch milliseconds. Everything below is
 * expressed relative to these, because "did the beacon come from THIS install"
 * is the question the module exists to answer and a bare timestamp cannot be
 * read against it.
 */
const PATCHED_AT = Date.parse("2026-08-06T12:00:00.000Z");
const LAUNCHED_AT = Date.parse("2026-08-06T12:00:10.000Z");
const NOW = Date.parse("2026-08-06T12:00:40.000Z");
/** Past the point where waiting longer is honest. */
const LATER = LAUNCHED_AT + DEFAULT_VERIFY_TIMEOUT_MS + 1_000;

/**
 * The build id the installer patched in, and one belonging to some other
 * build of the same plugin. Written out here rather than imported from the
 * plugin: this reader validates a FILE, and the file may have been written by a
 * build the installer has never seen.
 */
const OUR_BUILD = "1f2e3d4c5b6a7980";
const OTHER_BUILD = "99887766554433221100aabb";

const iso = (ms: number) => new Date(ms).toISOString();

let root: string;
let beaconPath: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subline-verify-"));
    beaconPath = join(root, BEACON_FILENAME);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/**
 * Write a beacon as the plugin would. Defaults describe the commonest healthy
 * state: loaded just after launch, translating, painting subtitles.
 */
function writeBeacon(overrides: Record<string, unknown> = {}): void {
    writeFileSync(beaconPath, JSON.stringify({
        format: SUPPORTED_BEACON_FORMAT,
        product: "subline",
        pluginVersion: "0.1.0",
        buildId: OUR_BUILD,
        loadedAt: iso(LAUNCHED_AT + 3_000),
        updatedAt: iso(LAUNCHED_AT + 20_000),
        lastTranslationAt: iso(LAUNCHED_AT + 18_000),
        lastRenderedAt: iso(LAUNCHED_AT + 19_000),
        lastEngine: "google",
        counts: { approx: 4, upgraded: 0 },
        lastError: null,
        ...overrides
    }, null, 4));
}

function verify(overrides: Record<string, unknown> = {}) {
    return verifyOnce({
        expectedBuildId: OUR_BUILD,
        patchedAt: PATCHED_AT,
        launchedAt: LAUNCHED_AT,
        now: NOW,
        beaconPath,
        ...overrides
    });
}

describe("only a painted subtitle confirms an install", () => {
    it("confirms when the plugin reports it rendered a translation after launch", () => {
        // Spec §7 step 4, the strongest available signal — and the ONLY thing
        // in this module that sets `confirmed`.
        writeBeacon();
        const result = verify();
        expect(result.status).toBe("translating-approx");
        expect(result.confirmed).toBe(true);
        expect(result.loaded).toBe(true);
    });

    it("reports the ✦ tier separately when an LLM upgrade has appeared", () => {
        // The distinction that would have caught this project's lost week: a
        // ≈-only install and a fully working one are otherwise identical.
        writeBeacon({ counts: { approx: 9, upgraded: 2 }, lastEngine: "gemini" });
        const result = verify();
        expect(result.status).toBe("translating-upgraded");
        expect(result.tier).toBe("upgraded");
        expect(result.confirmed).toBe(true);
    });

    it("still confirms a Google-only install, and says the ✦ upgrade is missing", () => {
        // Working is working. The user is reading their messages; the quality
        // tier being down is a real problem but not a failed install, and
        // conflating the two would send them to reinstall for nothing.
        writeBeacon({ lastError: { code: "rate-limited", at: iso(LAUNCHED_AT + 15_000) } });
        const result = verify();
        expect(result.confirmed).toBe(true);
        expect(result.errorCode).toBe("rate-limited");
        expect(result.summary).toContain("✦");
    });

    it("does NOT confirm on a translation that was produced but never painted", () => {
        // Spec §6: after a Discord frontend change the mod "loads and silently
        // renders nothing", and no amount of re-patching fixes it. Every other
        // signal — patched, launched, loaded, translating — is healthy here.
        writeBeacon({ lastRenderedAt: null });
        const result = verify();
        expect(result.status).toBe("translating-not-rendering");
        expect(result.confirmed).toBe(false);
        expect(result.loaded).toBe(true);
        // Waiting cannot fix it, so it must not tell the user to wait.
        expect(result.pending).toBe(false);
        expect(result.summary).toContain("needs an update");
    });
});

describe("staleness outranks presence", () => {
    it("refuses a beacon from a previous install, however healthy it looks", () => {
        // THE test this module exists for. Everything in this file says
        // "working" — loaded, translated, rendered, four translations — and all
        // of it happened a week before we patched.
        const lastWeek = LAUNCHED_AT - 7 * 24 * 60 * 60 * 1_000;
        writeBeacon({
            loadedAt: iso(lastWeek),
            updatedAt: iso(lastWeek + 60_000),
            lastTranslationAt: iso(lastWeek + 50_000),
            lastRenderedAt: iso(lastWeek + 55_000),
            counts: { approx: 900, upgraded: 120 }
        });

        const result = verify({ now: LATER });

        expect(result.status).toBe("stale-beacon");
        expect(result.confirmed).toBe(false);
        expect(result.stale).toBe(true);
        expect(result.loaded).toBe(false);
    });

    it("refuses a beacon that loaded between the patch and the launch", () => {
        // A Discord that was already running when we patched: it loaded the
        // OLD code. This is the near-miss a naive "is there a recent beacon?"
        // check gets wrong, and it is not exotic — spec §3 step 5 exists
        // because Discord is usually running when the installer starts.
        writeBeacon({ loadedAt: iso(PATCHED_AT + 1_000) });
        expect(verify({ now: LATER }).status).toBe("stale-beacon");
    });

    it("uses the LATER of patch and launch as the reference", () => {
        // A load that happened AFTER the launch but BEFORE the patch: that
        // Discord cannot be running the code we just wrote. Reading launchedAt
        // alone would accept it. Taking the later of the two can only make this
        // reader harder to convince, which is the safe direction.
        const earlyLaunch = PATCHED_AT - 60_000;
        writeBeacon({
            loadedAt: iso(PATCHED_AT - 30_000),
            lastRenderedAt: iso(PATCHED_AT - 25_000),
            lastTranslationAt: iso(PATCHED_AT - 26_000)
        });
        expect(verify({ launchedAt: earlyLaunch, now: LATER }).status).toBe("stale-beacon");
    });

    it("does not confirm on a render that predates this launch", () => {
        // The subtler half: the plugin loaded for THIS launch, but the only
        // painted subtitle it reports is from the previous session's file.
        writeBeacon({ lastRenderedAt: iso(LAUNCHED_AT - 60_000), lastTranslationAt: null });
        const result = verify({ now: LATER });
        expect(result.confirmed).toBe(false);
        expect(result.status).toBe("loaded-idle");
    });

    it("does not treat an error from before this launch as this launch's problem", () => {
        writeBeacon({
            lastRenderedAt: null,
            lastTranslationAt: null,
            lastError: { code: "auth-rejected", at: iso(LAUNCHED_AT - 300_000) }
        });
        const result = verify({ now: LATER });
        expect(result.status).toBe("loaded-idle");
        expect(result.errorCode).toBeNull();
    });

    it("tolerates a load a moment before the recorded launch, within the skew allowance", () => {
        // The two clocks are the same one, but the file's timestamps are
        // millisecond-truncated ISO strings and a real launch instant is not.
        // Without an allowance a perfectly good install fails on rounding.
        writeBeacon({ loadedAt: iso(LAUNCHED_AT - 500) });
        expect(verify().confirmed).toBe(true);
    });
});

describe("identity outranks recency", () => {
    // THE HOLE THIS CLOSES. `patchInstall` refuses foreign mods, so the normal
    // flow does not reach here — but "the beacon says a vcTranslate loaded"
    // and "the beacon says OUR vcTranslate loaded" are different sentences, and
    // the beacon is the one signal this project trusts. Every beacon below is
    // fresh, well-timed and reports painted subtitles: healthy on every axis
    // except whose build wrote it.

    it("refuses a beacon written by a different build of the same plugin", () => {
        // Someone's pre-existing Vencord install running their own copy. Our
        // patch could be doing nothing at all and this file would look like this.
        writeBeacon({ buildId: OTHER_BUILD });

        const result = verify({ now: LATER });

        expect(result.status).toBe("foreign-beacon");
        expect(result.confirmed).toBe(false);
        expect(result.loaded).toBe(false);
        expect(result.identity).toBe("mismatch");
        expect(result.beacon?.lastRenderedAt).not.toBeNull();  // it really does look healthy
    });

    it("refuses a beacon that carries no identity at all", () => {
        // An older build, or a hand-built userplugin. Absence is not a pass:
        // the reader must never fill in an identity it was not given.
        writeBeacon({ buildId: undefined });

        const result = verify({ now: LATER });

        expect(result.status).toBe("unidentified-beacon");
        expect(result.confirmed).toBe(false);
        expect(result.identity).toBe("absent");
    });

    it("confirms when the identity is the one we patched in", () => {
        // The permissive half, and it has to be asserted: a gate that refused
        // everything would be safe and useless.
        writeBeacon({ buildId: OUR_BUILD });
        const result = verify();
        expect(result.identity).toBe("match");
        expect(result.confirmed).toBe(true);
    });

    it("keeps waiting on a foreign beacon while there is still time", () => {
        // The commonest way to see one: the OTHER install reported in first and
        // ours has not started yet. Inside the window that is a wait, not a
        // verdict — but it is never a confirmation.
        writeBeacon({ buildId: OTHER_BUILD });
        const result = verify();
        expect(result.pending).toBe(true);
        expect(result.confirmed).toBe(false);
        expect(result.summary).toContain("Waiting");
    });

    it("tells the user what to do about a foreign install, once waiting is over", () => {
        writeBeacon({ buildId: OTHER_BUILD });
        const result = verify({ now: LATER });
        expect(result.summary).toContain("different copy");
        expect(result.summary).not.toContain("Waiting");
    });

    it("refuses an identity that is close but not equal", () => {
        // A prefix, a suffix, and a differing final character: the comparison is
        // equality, never containment.
        for (const buildId of [
            OUR_BUILD.slice(0, -1),
            `${OUR_BUILD}0`,
            `${OUR_BUILD.slice(0, -1)}1`
        ]) {
            writeBeacon({ buildId });
            expect(verify({ now: LATER }).confirmed).toBe(false);
        }
    });

    it("refuses a beacon whose identity is not a build id at all", () => {
        // Hand-edited or corrupt. The reader constrains the field on the way in,
        // so anything that is not a hex digest arrives as "no identity".
        for (const buildId of ["", "not-a-build", "0A80601A72BB57F6", 42, null, { id: OUR_BUILD }]) {
            writeBeacon({ buildId });
            const result = verify({ now: LATER });
            expect(result.status).toBe("unidentified-beacon");
            expect(result.confirmed).toBe(false);
        }
    });

    it("cannot be satisfied by an expectation that is not itself a build id", () => {
        // There is no value of expectedBuildId that means "skip the check". A
        // caller who passes a placeholder gets refused, not a free pass —
        // including the placeholder that a malformed beacon would carry too.
        for (const expectedBuildId of ["", "unknown", "*", "0A80601A72BB57F6"]) {
            writeBeacon({ buildId: OUR_BUILD });
            expect(verify({ now: LATER, expectedBuildId }).confirmed).toBe(false);
            writeBeacon({ buildId: expectedBuildId });
            expect(verify({ now: LATER, expectedBuildId }).confirmed).toBe(false);
        }
    });

    it("reports staleness ahead of identity when a beacon is both", () => {
        // Order matters only for the message. A previous Subline install's
        // beacon carries OUR id and is still worthless, and "quit Discord and
        // reopen it" is better advice than "remove your other install".
        const lastWeek = LAUNCHED_AT - 7 * 24 * 60 * 60 * 1_000;
        writeBeacon({ buildId: OUR_BUILD, loadedAt: iso(lastWeek), lastRenderedAt: iso(lastWeek + 5_000) });
        expect(verify({ now: LATER }).status).toBe("stale-beacon");
    });

    it("does not confirm a foreign beacon at any point in the timeline", () => {
        // The invariant: nothing about waiting longer, or less, turns someone
        // else's plugin into ours.
        writeBeacon({ buildId: OTHER_BUILD });
        for (const now of [PATCHED_AT, LAUNCHED_AT, NOW, LATER, LATER * 2]) {
            expect(verify({ now }).confirmed).toBe(false);
        }
    });

    it("stops polling a foreign beacon once the window closes", async () => {
        // awaitVerification uses `pending`, so the foreign branch has to answer
        // it correctly or the installer waits out 90 seconds and then reports
        // the same thing it already knew.
        writeBeacon({ buildId: OTHER_BUILD });
        let clock = NOW;
        const result = await awaitVerification({
            expectedBuildId: OUR_BUILD,
            patchedAt: PATCHED_AT,
            launchedAt: LAUNCHED_AT,
            beaconPath,
            clock: () => clock,
            sleep: async ms => { clock += ms; }
        });

        expect(result.status).toBe("foreign-beacon");
        expect(result.confirmed).toBe(false);
        expect(clock).toBeGreaterThanOrEqual(LAUNCHED_AT + DEFAULT_VERIFY_TIMEOUT_MS);
    });

    it("confirms once OUR build replaces the foreign beacon mid-poll", async () => {
        // The real sequence on a machine with a pre-existing install: their
        // plugin reports first, ours reports after Discord finishes loading.
        writeBeacon({ buildId: OTHER_BUILD });
        let clock = NOW;
        let polls = 0;
        const result = await awaitVerification({
            expectedBuildId: OUR_BUILD,
            patchedAt: PATCHED_AT,
            launchedAt: LAUNCHED_AT,
            beaconPath,
            clock: () => clock,
            sleep: async ms => {
                clock += ms;
                polls += 1;
                if (polls === 2) writeBeacon({ buildId: OUR_BUILD });
            }
        });

        expect(result.confirmed).toBe(true);
        expect(polls).toBe(2);
    });
});

describe("'could not confirm' is a first-class result", () => {
    it("waits, rather than failing, while Discord is still starting", () => {
        const result = verify();  // no beacon written at all
        expect(result.status).toBe("not-loaded");
        expect(result.confirmed).toBe(false);
        expect(result.pending).toBe(true);
        expect(result.summary).toContain("Waiting");
    });

    it("says so honestly once the plugin has had long enough and never reported", () => {
        // The dead install. Spec §3b's BetterDiscord case lands exactly here:
        // our patch verified byte-perfect and none of our code ever ran.
        const result = verify({ now: LATER });
        expect(result.status).toBe("not-loaded");
        expect(result.confirmed).toBe(false);
        expect(result.pending).toBe(false);
        expect(result.summary).toContain("cannot confirm");
        expect(result.summary).not.toContain("Waiting");
    });

    it("treats 'nothing to translate yet' as a non-failing outcome of its own", () => {
        // Someone opens Discord to a channel where everyone speaks their
        // language. That install is fine. It is not CONFIRMED, and the two must
        // not be collapsed in either direction.
        writeBeacon({ lastTranslationAt: null, lastRenderedAt: null, counts: { approx: 0, upgraded: 0 } });
        const result = verify({ now: LATER });
        expect(result.status).toBe("loaded-idle");
        expect(result.loaded).toBe(true);
        expect(result.confirmed).toBe(false);
        expect(result.summary).not.toContain("cannot confirm");
    });

    it("distinguishes 'loaded and erroring' from 'loaded and idle'", () => {
        writeBeacon({
            lastTranslationAt: null,
            lastRenderedAt: null,
            counts: { approx: 0, upgraded: 0 },
            lastError: { code: "auth-rejected", at: iso(LAUNCHED_AT + 5_000) }
        });
        const result = verify({ now: LATER });
        expect(result.status).toBe("loaded-erroring");
        expect(result.errorCode).toBe("auth-rejected");
        expect(result.confirmed).toBe(false);
    });

    it("cannot confirm from an unreadable beacon, and does not call the install broken", () => {
        writeFileSync(beaconPath, '{"product":"subline","loadedAt":"2026-08');
        const result = verify({ now: LATER });
        expect(result.status).toBe("unreadable-beacon");
        expect(result.confirmed).toBe(false);
        expect(result.problem?.code).toBe("BEACON_MALFORMED");
    });

    it("keeps polling on an unreadable beacon while there is still time", () => {
        // A file caught mid-write is the commonest cause, and the next read
        // usually succeeds.
        writeFileSync(beaconPath, "{half");
        expect(verify().pending).toBe(true);
    });

    it("never confirms anything without a beacon, whatever the timings say", () => {
        // The invariant behind every branch above: no beacon, no green tick.
        for (const now of [PATCHED_AT, LAUNCHED_AT, NOW, LATER, LATER * 2]) {
            expect(verify({ now }).confirmed).toBe(false);
        }
    });
});

describe("awaitVerification", () => {
    it("returns as soon as the install is confirmed, without waiting out the timeout", async () => {
        let clock = NOW;
        let polls = 0;
        const result = await awaitVerification({
            expectedBuildId: OUR_BUILD,
            patchedAt: PATCHED_AT,
            launchedAt: LAUNCHED_AT,
            beaconPath,
            clock: () => clock,
            sleep: async ms => {
                clock += ms;
                polls += 1;
                // Discord finishes starting and the plugin reports in.
                if (polls === 3) writeBeacon();
            }
        });

        expect(result.confirmed).toBe(true);
        expect(polls).toBe(3);
    });

    it("gives up honestly when nothing ever reports in", async () => {
        let clock = NOW;
        const result = await awaitVerification({
            expectedBuildId: OUR_BUILD,
            patchedAt: PATCHED_AT,
            launchedAt: LAUNCHED_AT,
            beaconPath,
            clock: () => clock,
            sleep: async ms => { clock += ms; }
        });

        expect(result.confirmed).toBe(false);
        expect(result.status).toBe("not-loaded");
        expect(clock).toBeGreaterThanOrEqual(LAUNCHED_AT + DEFAULT_VERIFY_TIMEOUT_MS);
    });

    it("stops immediately on a state waiting cannot improve", async () => {
        // "Translating but rendering nothing" needs a new build, not patience.
        // Polling it for 90 seconds would delay the only useful advice.
        writeBeacon({ lastRenderedAt: null });
        let polls = 0;
        const result = await awaitVerification({
            expectedBuildId: OUR_BUILD,
            patchedAt: PATCHED_AT,
            launchedAt: LAUNCHED_AT,
            beaconPath,
            clock: () => NOW,
            sleep: async () => { polls += 1; }
        });

        expect(result.status).toBe("translating-not-rendering");
        expect(polls).toBe(0);
    });

    it("keeps waiting through an idle-but-loaded state, in case a message arrives", async () => {
        // Idle is not a failure, but it is also not the answer yet: a foreign
        // message may still land inside the window.
        writeBeacon({ lastTranslationAt: null, lastRenderedAt: null, counts: { approx: 0, upgraded: 0 } });
        let clock = NOW;
        let polls = 0;
        const result = await awaitVerification({
            expectedBuildId: OUR_BUILD,
            patchedAt: PATCHED_AT,
            launchedAt: LAUNCHED_AT,
            beaconPath,
            clock: () => clock,
            sleep: async ms => {
                clock += ms;
                polls += 1;
                if (polls === 2) writeBeacon();
            }
        });

        expect(result.confirmed).toBe(true);
        expect(polls).toBe(2);
    });
});
