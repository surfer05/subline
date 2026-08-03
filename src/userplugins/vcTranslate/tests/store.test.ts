import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearStore, getTranslation, invalidateMessage,
    makeKey, setTranslation, subscribe
} from "../store";

beforeEach(() => clearStore());

describe("makeKey", () => {
    it("distinguishes the target language for the same message", () => {
        expect(makeKey("1", "en")).not.toBe(makeKey("1", "de"));
    });

    it("distinguishes messages", () => {
        expect(makeKey("1", "en")).not.toBe(makeKey("2", "en"));
    });

    it("does not depend on the engine — that is what makes a fallback readable", () => {
        // The key is (message, target language) and nothing else. A
        // translation written while Google was in use must be found by a
        // reader configured for Gemini; keying by engine made that a
        // guaranteed cache miss. There is no engine argument to pass any
        // more, so the property is simply that one call site's key equals
        // another's for the same message and language.
        const written = makeKey("1", "en");
        const read = makeKey("1", "en");
        expect(read).toBe(written);
    });
});

describe("store", () => {
    it("round-trips a translation, including which engine produced it", () => {
        const k = makeKey("1", "en");
        setTranslation(k, { lang: "ja", text: "hello", via: "claude" });
        expect(getTranslation(k)).toEqual({ lang: "ja", text: "hello", via: "claude" });
    });

    it("keeps `via` distinct per entry rather than collapsing to one engine", () => {
        // Two messages in the same channel, same target language, produced by
        // different engines — the exact situation an engine fallback creates.
        setTranslation(makeKey("1", "en"), { lang: "ja", text: "a", via: "google" });
        setTranslation(makeKey("2", "en"), { lang: "ja", text: "b", via: "gemini" });

        expect(getTranslation(makeKey("1", "en"))).toHaveProperty("via", "google");
        expect(getTranslation(makeKey("2", "en"))).toHaveProperty("via", "gemini");
    });

    it("returns undefined for an unknown key", () => {
        expect(getTranslation(makeKey("nope", "en"))).toBeUndefined();
    });

    it("stores a failure marker", () => {
        const k = makeKey("1", "en");
        setTranslation(k, { failed: true });
        expect(getTranslation(k)).toEqual({ failed: true });
    });

    it("stores a skipped marker", () => {
        const k = makeKey("1", "en");
        setTranslation(k, { skipped: true });
        expect(getTranslation(k)).toEqual({ skipped: true });
    });

    it("stores a deferred marker", () => {
        const k = makeKey("1", "en");
        setTranslation(k, { deferred: true });
        expect(getTranslation(k)).toEqual({ deferred: true });
    });

    it("keeps skipped, failed and deferred distinguishable from each other and from a translation", () => {
        // These four are the whole point of the union: the accessory renders a
        // different thing for each, and catch-up retries exactly two of them
        // (failed, deferred) but not the other two (a real translation,
        // skipped).
        setTranslation(makeKey("1", "en"), { skipped: true });
        setTranslation(makeKey("2", "en"), { failed: true });
        setTranslation(makeKey("3", "en"), { lang: "ja", text: "hi", via: "claude" });
        setTranslation(makeKey("4", "en"), { deferred: true });

        expect(getTranslation(makeKey("1", "en"))).not.toHaveProperty("failed");
        expect(getTranslation(makeKey("1", "en"))).not.toHaveProperty("deferred");
        expect(getTranslation(makeKey("2", "en"))).not.toHaveProperty("skipped");
        expect(getTranslation(makeKey("2", "en"))).not.toHaveProperty("deferred");
        expect(getTranslation(makeKey("3", "en"))).not.toHaveProperty("skipped");
        expect(getTranslation(makeKey("3", "en"))).not.toHaveProperty("deferred");
        expect(getTranslation(makeKey("4", "en"))).not.toHaveProperty("failed");
        expect(getTranslation(makeKey("4", "en"))).not.toHaveProperty("skipped");
    });

    it("a deferred entry is a hit, not a miss", () => {
        // Same reasoning as the skipped case: an unwritten id looks identical
        // to one that was never requested. Unlike skipped, catch-up DOES
        // re-request a deferred hit — but it must still be a hit, or the
        // "resolved vs never requested" distinction the whole store exists
        // for collapses for this variant too.
        const k = makeKey("1", "en");
        setTranslation(k, { deferred: true });
        expect(getTranslation(k)).toBeDefined();
    });

    it("a skipped entry is a hit, not a miss", () => {
        // The whole reason the variant exists: an unwritten id looks identical
        // to one that was never requested, so catch-up re-enqueues it forever.
        const k = makeKey("1", "en");
        setTranslation(k, { skipped: true });
        expect(getTranslation(k)).toBeDefined();
    });

    it("evicts the least recently used entry past the cap", () => {
        for (let i = 0; i < 500; i++) {
            setTranslation(makeKey(String(i), "en"), { lang: "ja", text: String(i), via: "claude" });
        }
        // Touch entry 0 so it is no longer least-recently-used.
        getTranslation(makeKey("0", "en"));
        setTranslation(makeKey("500", "en"), { lang: "ja", text: "500", via: "claude" });

        expect(getTranslation(makeKey("0", "en"))).toBeDefined();
        expect(getTranslation(makeKey("1", "en"))).toBeUndefined();
    });

    it("invalidates every entry for a message regardless of language", () => {
        setTranslation(makeKey("7", "en"), { lang: "ja", text: "a", via: "claude" });
        setTranslation(makeKey("7", "de"), { lang: "ja", text: "b", via: "google" });
        setTranslation(makeKey("8", "en"), { lang: "ja", text: "c", via: "claude" });

        invalidateMessage("7");

        expect(getTranslation(makeKey("7", "en"))).toBeUndefined();
        expect(getTranslation(makeKey("7", "de"))).toBeUndefined();
        expect(getTranslation(makeKey("8", "en"))).toBeDefined();
    });

    it("does not invalidate a message whose id merely starts with the invalidated one", () => {
        // The separator discipline the prefix scan depends on: "7 " must not
        // match "70 en". Dropping the engine component shortened the key, so
        // this is worth pinning explicitly rather than trusting by inspection.
        setTranslation(makeKey("7", "en"), { lang: "ja", text: "a", via: "claude" });
        setTranslation(makeKey("70", "en"), { lang: "ja", text: "b", via: "claude" });

        invalidateMessage("7");

        expect(getTranslation(makeKey("7", "en"))).toBeUndefined();
        expect(getTranslation(makeKey("70", "en"))).toBeDefined();
    });

    it("notifies subscribers on write and stops after unsubscribe", () => {
        const fn = vi.fn();
        const unsub = subscribe(fn);
        setTranslation(makeKey("1", "en"), { lang: "ja", text: "x", via: "claude" });
        expect(fn).toHaveBeenCalledTimes(1);
        unsub();
        setTranslation(makeKey("2", "en"), { lang: "ja", text: "y", via: "claude" });
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
