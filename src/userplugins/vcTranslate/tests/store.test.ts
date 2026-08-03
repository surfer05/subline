import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearStore, getTranslation, invalidateMessage,
    makeKey, setTranslation, subscribe
} from "../store";

beforeEach(() => clearStore());

describe("makeKey", () => {
    it("distinguishes engine and language for the same message", () => {
        expect(makeKey("1", "en", "google")).not.toBe(makeKey("1", "en", "claude"));
        expect(makeKey("1", "en", "google")).not.toBe(makeKey("1", "de", "google"));
    });
});

describe("store", () => {
    it("round-trips a translation", () => {
        const k = makeKey("1", "en", "claude");
        setTranslation(k, { lang: "ja", text: "hello" });
        expect(getTranslation(k)).toEqual({ lang: "ja", text: "hello" });
    });

    it("returns undefined for an unknown key", () => {
        expect(getTranslation(makeKey("nope", "en", "claude"))).toBeUndefined();
    });

    it("stores a failure marker", () => {
        const k = makeKey("1", "en", "claude");
        setTranslation(k, { failed: true });
        expect(getTranslation(k)).toEqual({ failed: true });
    });

    it("stores a skipped marker", () => {
        const k = makeKey("1", "en", "claude");
        setTranslation(k, { skipped: true });
        expect(getTranslation(k)).toEqual({ skipped: true });
    });

    it("stores a deferred marker", () => {
        const k = makeKey("1", "en", "claude");
        setTranslation(k, { deferred: true });
        expect(getTranslation(k)).toEqual({ deferred: true });
    });

    it("keeps skipped, failed and deferred distinguishable from each other and from a translation", () => {
        // These four are the whole point of the union: the accessory renders a
        // different thing for each, and catch-up retries exactly two of them
        // (failed, deferred) but not the other two (a real translation,
        // skipped).
        setTranslation(makeKey("1", "en", "claude"), { skipped: true });
        setTranslation(makeKey("2", "en", "claude"), { failed: true });
        setTranslation(makeKey("3", "en", "claude"), { lang: "ja", text: "hi" });
        setTranslation(makeKey("4", "en", "claude"), { deferred: true });

        expect(getTranslation(makeKey("1", "en", "claude"))).not.toHaveProperty("failed");
        expect(getTranslation(makeKey("1", "en", "claude"))).not.toHaveProperty("deferred");
        expect(getTranslation(makeKey("2", "en", "claude"))).not.toHaveProperty("skipped");
        expect(getTranslation(makeKey("2", "en", "claude"))).not.toHaveProperty("deferred");
        expect(getTranslation(makeKey("3", "en", "claude"))).not.toHaveProperty("skipped");
        expect(getTranslation(makeKey("3", "en", "claude"))).not.toHaveProperty("deferred");
        expect(getTranslation(makeKey("4", "en", "claude"))).not.toHaveProperty("failed");
        expect(getTranslation(makeKey("4", "en", "claude"))).not.toHaveProperty("skipped");
    });

    it("a deferred entry is a hit, not a miss", () => {
        // Same reasoning as the skipped case: an unwritten id looks identical
        // to one that was never requested. Unlike skipped, catch-up DOES
        // re-request a deferred hit — but it must still be a hit, or the
        // "resolved vs never requested" distinction the whole store exists
        // for collapses for this variant too.
        const k = makeKey("1", "en", "claude");
        setTranslation(k, { deferred: true });
        expect(getTranslation(k)).toBeDefined();
    });

    it("a skipped entry is a hit, not a miss", () => {
        // The whole reason the variant exists: an unwritten id looks identical
        // to one that was never requested, so catch-up re-enqueues it forever.
        const k = makeKey("1", "en", "claude");
        setTranslation(k, { skipped: true });
        expect(getTranslation(k)).toBeDefined();
    });

    it("evicts the least recently used entry past the cap", () => {
        for (let i = 0; i < 500; i++) {
            setTranslation(makeKey(String(i), "en", "claude"), { lang: "ja", text: String(i) });
        }
        // Touch entry 0 so it is no longer least-recently-used.
        getTranslation(makeKey("0", "en", "claude"));
        setTranslation(makeKey("500", "en", "claude"), { lang: "ja", text: "500" });

        expect(getTranslation(makeKey("0", "en", "claude"))).toBeDefined();
        expect(getTranslation(makeKey("1", "en", "claude"))).toBeUndefined();
    });

    it("invalidates every entry for a message regardless of engine or language", () => {
        setTranslation(makeKey("7", "en", "claude"), { lang: "ja", text: "a" });
        setTranslation(makeKey("7", "de", "google"), { lang: "ja", text: "b" });
        setTranslation(makeKey("8", "en", "claude"), { lang: "ja", text: "c" });

        invalidateMessage("7");

        expect(getTranslation(makeKey("7", "en", "claude"))).toBeUndefined();
        expect(getTranslation(makeKey("7", "de", "google"))).toBeUndefined();
        expect(getTranslation(makeKey("8", "en", "claude"))).toBeDefined();
    });

    it("notifies subscribers on write and stops after unsubscribe", () => {
        const fn = vi.fn();
        const unsub = subscribe(fn);
        setTranslation(makeKey("1", "en", "claude"), { lang: "ja", text: "x" });
        expect(fn).toHaveBeenCalledTimes(1);
        unsub();
        setTranslation(makeKey("2", "en", "claude"), { lang: "ja", text: "y" });
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
