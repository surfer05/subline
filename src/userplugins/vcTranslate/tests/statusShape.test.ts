import { describe, expect, it } from "vitest";

import {
    BEACON_ERROR_CODES, BEACON_FORMAT, sanitizeBeacon, tierForEngine, type StatusBeacon
} from "../statusShape";
import { ENGINE_CAPS, type EngineId } from "../types";
import { ENGINE_RANK } from "../upgrade";

const AT = "2026-08-06T10:00:00.000Z";

/** A beacon with every field populated and valid. */
function fullBeacon(): StatusBeacon {
    return {
        format: BEACON_FORMAT,
        product: "subline",
        pluginVersion: "0.1.0",
        loadedAt: AT,
        updatedAt: "2026-08-06T10:05:00.000Z",
        lastTranslationAt: "2026-08-06T10:04:00.000Z",
        lastRenderedAt: "2026-08-06T10:04:01.000Z",
        lastEngine: "gemini",
        counts: { approx: 12, upgraded: 3 },
        lastError: { code: "rate-limited", at: "2026-08-06T10:03:00.000Z" }
    };
}

describe("the beacon never carries message text", () => {
    // SPEC §7, and the reason the sanitiser exists at all: "this tool reads
    // private messages including DMs. A plaintext log of other people's
    // conversations on disk is a liability the moment a stranger installs
    // this." The guarantee cannot be "the renderer is careful" — a renderer
    // bug, or a field added carelessly later, would put DM content in a file
    // any process on the machine can read. So the WRITER rebuilds the object
    // and drops anything it does not recognise.
    const SECRET = "meet me at the usual place at nine";

    it("drops unrecognised keys instead of copying them through", () => {
        const smuggled = {
            ...fullBeacon(),
            messageText: SECRET,
            lastMessage: { author: "ana", text: SECRET },
            recentMessages: [SECRET]
        };

        const clean = sanitizeBeacon(smuggled);

        expect(clean).not.toBeNull();
        expect(JSON.stringify(clean)).not.toContain(SECRET);
        expect(Object.keys(clean!)).toEqual([
            "format", "product", "pluginVersion", "loadedAt", "updatedAt",
            "lastTranslationAt", "lastRenderedAt", "lastEngine", "counts", "lastError"
        ]);
    });

    it("refuses free text in the error slot — the code vocabulary is closed", () => {
        // The single most dangerous field, because an engine's error string is
        // the one place remote text already flows through. Reduced to a code
        // on the renderer side AND rejected here if it is anything else.
        const beacon = sanitizeBeacon({
            ...fullBeacon(),
            lastError: { code: `failed to translate "${SECRET}"`, at: AT }
        });

        expect(beacon!.lastError).toBeNull();
        expect(JSON.stringify(beacon)).not.toContain(SECRET);
    });

    it("refuses free text in the version and engine slots too", () => {
        const beacon = sanitizeBeacon({
            ...fullBeacon(),
            pluginVersion: SECRET,
            lastEngine: SECRET
        });

        expect(beacon!.pluginVersion).toBe("unknown");
        expect(beacon!.lastEngine).toBeNull();
        expect(JSON.stringify(beacon)).not.toContain(SECRET);
    });

    it("refuses free text in every timestamp slot", () => {
        // Timestamps are the remaining strings, so they are pinned to exactly
        // what Date#toISOString() emits rather than "looks date-ish".
        const beacon = sanitizeBeacon({
            ...fullBeacon(),
            updatedAt: SECRET,
            lastTranslationAt: SECRET,
            lastRenderedAt: `${AT} — ${SECRET}`
        });

        expect(beacon!.lastTranslationAt).toBeNull();
        expect(beacon!.lastRenderedAt).toBeNull();
        expect(JSON.stringify(beacon)).not.toContain(SECRET);
    });

    it("refuses a beacon whose only anchor is unusable", () => {
        // loadedAt is what the installer compares against its own launch time.
        // Without it the file cannot answer the question it exists for, so it
        // is not written at all — better no beacon than one that reads as a
        // confirmation because a reader defaulted a missing timestamp.
        expect(sanitizeBeacon({ ...fullBeacon(), loadedAt: undefined })).toBeNull();
        expect(sanitizeBeacon({ ...fullBeacon(), loadedAt: "yesterday" })).toBeNull();
        expect(sanitizeBeacon({ ...fullBeacon(), loadedAt: 1_754_474_400_000 })).toBeNull();
    });
});

describe("sanitizeBeacon — what it keeps", () => {
    it("round-trips a fully populated beacon unchanged", () => {
        expect(sanitizeBeacon(fullBeacon())).toEqual(fullBeacon());
    });

    it("keeps every error code in the vocabulary", () => {
        for (const code of BEACON_ERROR_CODES) {
            const beacon = sanitizeBeacon({ ...fullBeacon(), lastError: { code, at: AT } });
            expect(beacon!.lastError).toEqual({ code, at: AT });
        }
    });

    it("keeps every engine id the plugin actually has", () => {
        // Read off ENGINE_CAPS rather than a literal list, exactly as store.ts
        // validates `via`: a fourth engine must not silently become
        // unreportable.
        for (const engine of Object.keys(ENGINE_CAPS) as EngineId[]) {
            expect(sanitizeBeacon({ ...fullBeacon(), lastEngine: engine })!.lastEngine).toBe(engine);
        }
    });

    it("states its own format rather than echoing the caller's", () => {
        // A caller cannot label an old shape as a new one, which is what makes
        // the reader's format check worth doing.
        expect(sanitizeBeacon({ ...fullBeacon(), format: 99 })!.format).toBe(BEACON_FORMAT);
    });
});

describe("sanitizeBeacon — degrading a damaged beacon instead of failing it", () => {
    it("falls back to loadedAt when updatedAt is unusable", () => {
        // The conservative direction: an invented "now" would make every
        // beacon look freshly written, which is exactly the false confirmation
        // this whole mechanism exists to prevent.
        const beacon = sanitizeBeacon({ ...fullBeacon(), updatedAt: null });
        expect(beacon!.updatedAt).toBe(AT);
    });

    it("zeroes counts that are not counts", () => {
        const beacon = sanitizeBeacon({
            ...fullBeacon(),
            counts: { approx: -4, upgraded: 1.5 }
        });
        expect(beacon!.counts).toEqual({ approx: 0, upgraded: 0 });
    });

    it("survives counts that are not an object at all", () => {
        expect(sanitizeBeacon({ ...fullBeacon(), counts: "lots" })!.counts)
            .toEqual({ approx: 0, upgraded: 0 });
        expect(sanitizeBeacon({ ...fullBeacon(), counts: null })!.counts)
            .toEqual({ approx: 0, upgraded: 0 });
    });

    it("drops a half-written error object rather than inventing the missing half", () => {
        expect(sanitizeBeacon({ ...fullBeacon(), lastError: { code: "rate-limited" } })!.lastError)
            .toBeNull();
        expect(sanitizeBeacon({ ...fullBeacon(), lastError: { at: AT } })!.lastError).toBeNull();
    });

    it("rejects anything that is not an object", () => {
        for (const value of [null, undefined, "beacon", 7, [fullBeacon()]]) {
            expect(sanitizeBeacon(value)).toBeNull();
        }
    });

    it("rejects a document that is not ours", () => {
        // Someone else's status.json in the same directory must never be read
        // as a Subline confirmation.
        expect(sanitizeBeacon({ ...fullBeacon(), product: "vencord" })).toBeNull();
    });
});

describe("tierForEngine", () => {
    it("agrees with ENGINE_RANK for every engine", () => {
        // The tier split IS the ≈/✦ glyph split (see ENGINE_PROVENANCE), and
        // ENGINE_RANK is where that already lives. statusShape.ts keeps its own
        // table because it is bundled into the main process, so this is the
        // pin that stops the two drifting — an engine promoted to context-aware
        // in one and not the other would make the installer report "no ✦
        // upgrades" on a healthy install, or worse, the reverse.
        for (const engine of Object.keys(ENGINE_CAPS) as EngineId[]) {
            expect(tierForEngine(engine)).toBe(ENGINE_RANK[engine] >= 1 ? "upgraded" : "approx");
        }
    });
});
