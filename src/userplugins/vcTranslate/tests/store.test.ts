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
