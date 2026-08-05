import { describe, expect, it } from "vitest";
import { isRealTranslation, mayReplace } from "../upgrade";

const google = { lang: "de", text: "no", via: "google" as const };
const gemini = { lang: "de", text: "nope", via: "gemini" as const };

describe("mayReplace", () => {
    it("writes anything when nothing is stored", () => {
        expect(mayReplace(undefined, google)).toBe(true);
    });

    it("lets the LLM upgrade a Google line", () => {
        expect(mayReplace(google, gemini)).toBe(true);
    });

    it("NEVER lets a late Google result clobber an LLM line", () => {
        // The race this exists for: both tiers translate the same message, and
        // nothing guarantees Google's reply loses. Without this the reader
        // watches a good line degrade into a worse one.
        expect(mayReplace(gemini, google)).toBe(false);
    });

    it("never writes a failure marker over a real translation", () => {
        // A rate-limited quality tier must leave the readable Google line
        // alone. Marking it failed would replace something useful with an
        // error the reader can do nothing about.
        expect(mayReplace(google, { failed: true })).toBe(false);
        expect(mayReplace(google, { deferred: true })).toBe(false);
        expect(mayReplace(gemini, { failed: true })).toBe(false);
    });

    it("never lets a Google SKIP erase an LLM line", () => {
        // The claim runTier makes at the `skipped` write ("a Google skip must
        // never erase an LLM line") and the one case the failure-marker test
        // above does not cover: `skipped` is the marker Google produces for
        // exactly the short/romanized messages the LLM is best at, so it is the
        // one most likely to arrive late on top of a real ✦ line.
        expect(mayReplace(gemini, { skipped: true, via: "google" })).toBe(false);
        expect(mayReplace(gemini, { skipped: true })).toBe(false);
    });

    it("lets a real translation replace any marker", () => {
        expect(mayReplace({ failed: true }, google)).toBe(true);
        expect(mayReplace({ deferred: true }, google)).toBe(true);
        expect(mayReplace({ skipped: true, via: "google" }, gemini)).toBe(true);
    });

    it("lets the same engine refresh its own line", () => {
        // An edited message is re-requested; the new answer must land.
        expect(mayReplace(gemini, { lang: "de", text: "yep", via: "gemini" })).toBe(true);
    });
});

describe("isRealTranslation", () => {
    it("distinguishes a translation from every marker", () => {
        expect(isRealTranslation(google)).toBe(true);
        expect(isRealTranslation({ failed: true })).toBe(false);
        expect(isRealTranslation({ skipped: true })).toBe(false);
        expect(isRealTranslation({ deferred: true })).toBe(false);
        expect(isRealTranslation(undefined)).toBe(false);
    });
});
