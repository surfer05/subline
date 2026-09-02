import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearStore, getTranslation, invalidateMessage, loadPersistedTranslations,
    makeKey, persistenceSettled, PERSIST_KEY, setTranslation, subscribe
} from "../store";
import * as DataStore from "./stubs/api-datastore";

beforeEach(() => {
    clearStore();
    DataStore.__reset();
});

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

    it("survives a restart: what was written is still there after a reload", async () => {
        // The whole point of persisting: a Discord restart used to re-translate
        // the entire visible backlog from scratch, every time, out of a budget
        // of a few dozen requests a day.
        setTranslation(makeKey("1", "en"), { lang: "es", text: "hello", via: "gemini" });
        setTranslation(makeKey("2", "en"), { skipped: true });
        await persistenceSettled();

        // Simulate the restart: memory is gone, disk is not.
        clearStore();
        expect(getTranslation(makeKey("1", "en"))).toBeUndefined();

        await loadPersistedTranslations();

        expect(getTranslation(makeKey("1", "en"))).toEqual({ lang: "es", text: "hello", via: "gemini" });
        expect(getTranslation(makeKey("2", "en"))).toEqual({ skipped: true });
    });

    it("survives a restart with a skipped marker's provenance intact", async () => {
        // The whole point of `via` on `skipped`: an LLM's skip must stay
        // authoritative across a restart, not just for the rest of the
        // session. If this variant were dropped on reload, the message would
        // look like a cache miss again and re-enqueue into the fast tier,
        // exactly the churn the field exists to prevent.
        setTranslation(makeKey("1", "en"), { skipped: true, via: "gemini" });
        await persistenceSettled();

        clearStore();
        await loadPersistedTranslations();

        expect(getTranslation(makeKey("1", "en"))).toEqual({ skipped: true, via: "gemini" });
    });

    it("does not resurrect a translation that was invalidated by an edit", async () => {
        setTranslation(makeKey("1", "en"), { lang: "es", text: "hello", via: "gemini" });
        await persistenceSettled();

        invalidateMessage("1");
        await persistenceSettled();

        clearStore();
        await loadPersistedTranslations();

        expect(getTranslation(makeKey("1", "en"))).toBeUndefined();
    });

    it("drops a persisted entry whose shape does not match", async () => {
        // Anything on disk is untrusted input: it was written by an older
        // version of this plugin, or corrupted, or hand-edited.
        await DataStore.set(PERSIST_KEY, [
            ["good en", { lang: "es", text: "hello", via: "google" }],
            ["missing-text en", { lang: "es", via: "google" }],
            ["wrong-types en", { lang: 5, text: [], via: "google" }],
            ["not-a-marker en", { failed: true, extra: 1 }],
            ["null en", null],
            "not-a-pair",
            ["only-one-element"],
            [42, { lang: "es", text: "hello", via: "google" }]
        ]);

        await loadPersistedTranslations();

        expect(getTranslation("good en")).toEqual({ lang: "es", text: "hello", via: "google" });
        for (const key of ["missing-text en", "wrong-types en", "not-a-marker en", "null en", "only-one-element"]) {
            expect(getTranslation(key)).toBeUndefined();
        }
    });

    it("drops a persisted entry whose engine id is no longer known", async () => {
        // The failure the Phase 1 implementer flagged: `via` lives in the
        // stored VALUE, so it outlives a rename of the engine ids. A trusted
        // stale id would reach the accessory's ENGINE_PROVENANCE lookup and
        // render as undefined; dropping it costs one re-translation.
        await DataStore.set(PERSIST_KEY, [
            ["stale en", { lang: "es", text: "hello", via: "claude-haiku-legacy" }],
            ["current en", { lang: "es", text: "hello", via: "claude" }]
        ]);

        await loadPersistedTranslations();

        expect(getTranslation("stale en")).toBeUndefined();
        expect(getTranslation("current en")).toBeDefined();
    });

    it("drops a skipped marker whose engine id is no longer known", async () => {
        // Same reasoning as the real-translation case above, applied to
        // `skipped`'s optional `via`: an unknown engine id must not be
        // trusted just because the marker itself is otherwise well-formed.
        await DataStore.set(PERSIST_KEY, [
            ["stale en", { skipped: true, via: "not-an-engine" }],
            ["current en", { skipped: true, via: "gemini" }]
        ]);

        await loadPersistedTranslations();

        expect(getTranslation("stale en")).toBeUndefined();
        expect(getTranslation("current en")).toEqual({ skipped: true, via: "gemini" });
    });

    it("does not throw or wipe the session when the stored value is not an array", async () => {
        await DataStore.set(PERSIST_KEY, { nope: true });
        setTranslation(makeKey("1", "en"), { lang: "es", text: "hello", via: "google" });

        await expect(loadPersistedTranslations()).resolves.toBeUndefined();

        expect(getTranslation(makeKey("1", "en"))).toBeDefined();
    });

    it("degrades to an empty cache when the read itself fails", async () => {
        const get = vi.spyOn(DataStore, "get").mockRejectedValueOnce(new Error("IndexedDB is having a day"));

        await expect(loadPersistedTranslations()).resolves.toBeUndefined();
        expect(getTranslation(makeKey("1", "en"))).toBeUndefined();

        get.mockRestore();
    });

    it("does not let a load clobber something translated while it was in flight", async () => {
        await DataStore.set(PERSIST_KEY, [[makeKey("1", "en"), { lang: "es", text: "stale", via: "google" }]]);
        setTranslation(makeKey("1", "en"), { lang: "es", text: "fresh", via: "gemini" });

        await loadPersistedTranslations();

        expect(getTranslation(makeKey("1", "en"))).toEqual({ lang: "es", text: "fresh", via: "gemini" });
    });

    it("caps what it stores so the on-disk cache cannot grow without bound", async () => {
        for (let i = 0; i < 2100; i++) {
            setTranslation(makeKey(String(i), "en"), { lang: "es", text: String(i), via: "google" });
        }
        await persistenceSettled();

        const stored = await DataStore.get<[string, unknown][]>(PERSIST_KEY);
        expect(stored).toHaveLength(2000);
        // Newest kept, oldest evicted.
        expect(stored!.some(([k]) => k === makeKey("2099", "en"))).toBe(true);
        expect(stored!.some(([k]) => k === makeKey("0", "en"))).toBe(false);
    });

    it("rolls the mirror back when a write fails, rather than claiming it saved", async () => {
        setTranslation(makeKey("1", "en"), { lang: "es", text: "saved", via: "google" });
        await persistenceSettled();

        const set = vi.spyOn(DataStore, "set").mockRejectedValueOnce(new Error("disk full"));
        setTranslation(makeKey("2", "en"), { lang: "es", text: "lost", via: "google" });
        await persistenceSettled();
        set.mockRestore();

        // The entry stays usable for this session...
        expect(getTranslation(makeKey("2", "en"))).toBeDefined();

        // ...but the next successful write must not re-assert it as persisted,
        // because it never reached the disk.
        setTranslation(makeKey("3", "en"), { lang: "es", text: "next", via: "google" });
        await persistenceSettled();

        const stored = await DataStore.get<[string, unknown][]>(PERSIST_KEY);
        const keys = stored!.map(([k]) => k);
        expect(keys).toContain(makeKey("1", "en"));
        expect(keys).toContain(makeKey("3", "en"));
        expect(keys).not.toContain(makeKey("2", "en"));
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

    // A failure is a fact about a MOMENT — the throttled minute, the parked
    // engine — not about the message. Persisting one turns "Google was busy on
    // Tuesday" into a warning the reader sees every session until catch-up
    // happens to heal it. Real translations and skips persist; markers do not.
    describe("markers are session-scoped", () => {
        it("does not persist failed or deferred markers", async () => {
            setTranslation("m1 en", { failed: true });
            setTranslation("m2 en", { deferred: true });
            setTranslation("m3 en", { lang: "es", text: "hi", via: "google" });
            await new Promise(r => setTimeout(r, 0)); // let the write chain drain

            const written = await DataStore.get(PERSIST_KEY) as [string, unknown][];
            const keys = written.map(([k]) => k);
            expect(keys).toContain("m3 en");
            expect(keys).not.toContain("m1 en");
            expect(keys).not.toContain("m2 en");
        });

        it("drops markers persisted by earlier builds on load", async () => {
            await DataStore.set(PERSIST_KEY, [
                ["old1 en", { failed: true }],
                ["old2 en", { deferred: true }],
                ["old3 en", { lang: "es", text: "kept", via: "google" }]
            ]);
            clearStore();
            await loadPersistedTranslations();

            expect(getTranslation("old3 en")).toMatchObject({ text: "kept" });
            expect(getTranslation("old1 en")).toBeUndefined();
            expect(getTranslation("old2 en")).toBeUndefined();
        });
    });
});
