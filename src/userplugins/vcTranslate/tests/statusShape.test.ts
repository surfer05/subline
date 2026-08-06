import { describe, expect, it } from "vitest";

import { BUILD_ID } from "../buildStamp";
import {
    BEACON_ERROR_CODES, BEACON_FORMAT, isBuildId, sanitizeBeacon, tierForEngine, type StatusBeacon
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
        buildId: BUILD_ID,
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
            "format", "product", "pluginVersion", "buildId", "loadedAt", "updatedAt",
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

    it("refuses free text in the build identity slot", () => {
        // buildId is the newest string in the shape and therefore the newest
        // opportunity to smuggle a conversation into a world-readable file. It
        // is a lowercase hex digest or it is nothing.
        const beacon = sanitizeBeacon({ ...fullBeacon(), buildId: SECRET });

        expect(beacon!.buildId).toBeNull();
        expect(JSON.stringify(beacon)).not.toContain(SECRET);

        // Including the shapes a lazier check would let through: a real id with
        // text stapled to it, and text that begins with hex.
        for (const buildId of [`${BUILD_ID} ${SECRET}`, `0a ${SECRET}`, `${SECRET} ${BUILD_ID}`]) {
            const smuggled = sanitizeBeacon({ ...fullBeacon(), buildId });
            expect(smuggled!.buildId).toBeNull();
            expect(JSON.stringify(smuggled)).not.toContain(SECRET);
        }
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

    it("keeps a well-formed build id, which is the whole point of the field", () => {
        // The permissive half. A field that rejected everything would be safe
        // and useless: the identity has to survive the trip to disk or the
        // installer can never confirm anything.
        expect(sanitizeBeacon(fullBeacon())!.buildId).toBe(BUILD_ID);
        for (const buildId of ["0a80601a", "f".repeat(64), "0123456789abcdef"]) {
            expect(sanitizeBeacon({ ...fullBeacon(), buildId })!.buildId).toBe(buildId);
        }
    });

    it("reports a missing or malformed build id as null rather than a placeholder", () => {
        // "No identity" must stay distinguishable from "some identity" — the
        // installer refuses both, but says different things about them, and a
        // placeholder string would be an identity some other build could match.
        for (const buildId of [undefined, null, "", "0a80601", "0A80601A72BB57F6", 42, {}]) {
            expect(sanitizeBeacon({ ...fullBeacon(), buildId })!.buildId).toBeNull();
        }
    });

    it("does not fall back to pluginVersion when the build id is missing", () => {
        // A version is not an identity: two different builds can both call
        // themselves 0.1.0, which is exactly why buildId exists.
        const beacon = sanitizeBeacon({ ...fullBeacon(), buildId: undefined, pluginVersion: "0.1.0" });
        expect(beacon!.buildId).toBeNull();
        expect(beacon!.pluginVersion).toBe("0.1.0");
    });

    it("states its own format rather than echoing the caller's", () => {
        // A caller cannot label an old shape as a new one, which is what makes
        // the reader's format check worth doing.
        expect(sanitizeBeacon({ ...fullBeacon(), format: 99 })!.format).toBe(BEACON_FORMAT);
    });

    it("declares format 2 — the version in which a beacon carries an identity", () => {
        // PINNED, and pinned on BOTH sides: the installer's reader duplicates
        // this contract deliberately (it reads files written by other builds),
        // and its SUPPORTED_BEACON_FORMAT carries the same assertion. Bumping
        // one alone would make every healthy install read as unreadable, which
        // is safe but silently wrong — so the number is nailed down where a
        // change to it has to be deliberate in two places.
        //
        // Why 2 at all: a format-1 reader does not know `buildId` exists, so it
        // would read ANOTHER build's beacon as a confirmation of ours. Refusing
        // the whole document is the only honest thing an old reader can do.
        expect(BEACON_FORMAT).toBe(2);
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
