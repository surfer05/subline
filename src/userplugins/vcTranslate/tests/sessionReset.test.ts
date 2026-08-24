/**
 * Every piece of in-memory session state is dropped by `stop()`.
 *
 * WHY THIS IS A SOURCE-LEVEL TEST. The coherence of a plugin toggle rests on
 * one 80-line function remembering to clear each module-level binding by hand.
 * It managed nineteen out of twenty-one — and the two it missed were callback
 * lists holding functions from the torn-down session, which `stop()` then
 * called on its way out through the very set it was not clearing.
 *
 * A convention applied nineteen times out of twenty-one looks exactly like one
 * applied twenty-one times. Nothing about the file says otherwise, no test
 * covered it, and the test suite hid it: its own `beforeEach` calls
 * `clearStore()`, so the harness was better isolated than the shipped code.
 *
 * This asserts on the SOURCE rather than on behaviour because the failure is
 * "somebody adds a twenty-second binding and forgets it" — a thing that has no
 * behaviour to observe until it leaks in production, months later, as a subtitle
 * updating from a session that no longer exists.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(join(HERE, "..", "index.tsx"), "utf8");

/** The body of `stop()` — everything a toggle actually runs. */
function stopBody(): string {
    const at = INDEX.indexOf("    stop() {");
    if (at < 0) throw new Error("stop() not found — it was renamed or restructured");
    return INDEX.slice(at, INDEX.indexOf("\n    }", at));
}

/**
 * Module-level bindings that hold mutable state.
 *
 * `let` of any kind, plus `const` bound to a Map/Set — a const Map is every bit
 * as mutable as a let, and both of the leaks were const Sets.
 */
function mutableBindings(): string[] {
    const names: string[] = [];
    for (const line of INDEX.split("\n")) {
        const let_ = /^let ([A-Za-z_$][\w$]*)/.exec(line);
        if (let_) { names.push(let_[1]!); continue; }
        const collection = /^const ([A-Za-z_$][\w$]*)(?:\s*:[^=]+)?\s*=\s*new (?:Map|Set)\b/.exec(line);
        if (collection) names.push(collection[1]!);
    }
    return names;
}

/**
 * Bindings a toggle deliberately does NOT reset, each with its reason.
 *
 * An allow-list, not a filter: adding a name here is a decision someone has to
 * write down, which is the whole difference between this and the convention it
 * replaces.
 */
const DELIBERATELY_KEPT: Record<string, string> = {
    batcherGeneration:
        "Monotonic by design. Zeroing it would let a closure captured before stop() match again "
        + "and resurrect a batcher on a stopped plugin — the increment IS the mechanism.",
    fallbackKind:
        "Always assigned in fallBackToGoogle() before sessionFallback becomes true, and only ever "
        + "read behind that flag, which stop() does reset. Unreachable while stale."
};

describe("stop() drops every piece of session state", () => {
    it("clears each mutable module binding, or says why not", () => {
        const body = stopBody();
        const unhandled = mutableBindings().filter(name => {
            if (name in DELIBERATELY_KEPT) return false;
            // Cleared, nulled, reset, disposed, or emptied — spelling varies by
            // the kind of thing it is, so this asks only whether stop() names it.
            return !new RegExp(`\\b${name}\\b`).test(body);
        });

        expect(unhandled).toEqual([]);
    });

    it("hands the sibling modules their own resets", () => {
        // Each of these owns state stop() cannot reach from here.
        const body = stopBody();
        for (const call of ["__resetCooldowns()", "resetRateGate()", "resetStatusBeacon()", "clearStore()"]) {
            expect(body, call).toContain(call);
        }
    });

    it("empties both callback lists", () => {
        // The two that leaked. Callbacks belonging to a session that has ended
        // must not survive it: stop() itself fires forcedInFlightListeners on
        // the way out, so a stale entry is called during the very teardown that
        // should have removed it.
        const body = stopBody();
        expect(body).toContain("forcedInFlightListeners.clear()");
        // store.ts's listener set is cleared inside clearStore().
        expect(body).toContain("clearStore()");
    });

    it("keeps a written reason for anything it skips", () => {
        for (const [name, reason] of Object.entries(DELIBERATELY_KEPT)) {
            expect(reason.length, name).toBeGreaterThan(40);
        }
    });
});
