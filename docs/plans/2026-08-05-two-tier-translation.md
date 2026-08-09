# Two-Tier Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every message gets a readable subtitle in about a second from Google, and then — for every message, not a chosen subset — a context-aware LLM translation replaces it in place, while using roughly a tenth of the API quota we use today.

**Architecture:** Split the single engine pipeline into two independent batchers fed by the same `enqueue()`. A **fast tier** (always Google: 700ms window, ≤10 per batch) writes a subtitle almost immediately. A **quality tier** (the configured LLM: 20s window, ≤25 per batch) re-translates the same messages with conversation context and upgrades the stored line. A strict ranking rule makes writes upgrade-only, so a slow Google result — or any LLM failure — can never clobber a better line that is already on screen.

**Tech Stack:** TypeScript, React (Vencord userplugin), vitest.

## Why this shape (do not "simplify" it away)

Measured against the live Gemini API on 2026-08-05: the free-tier limit is
**20 requests per rolling minute** (three probes returned retry hints of
8.5s, 52.9s and 36.8s — all sub-minute, so it is not a daily cap).

The current batcher uses a **fixed 3s window from the first message of a
burst**. A continuously active channel therefore flushes every 3 seconds —
**20 requests/minute, exactly the ceiling.** The rate gate holds it to
15/min, still 75% of the limit, so any channel switch (catch-up enqueues up
to 20 messages at once) tips it over. That is why ~90% of subtitles are
currently Google's.

Latency and quota are coupled by that single dial: shortening the window to
feel responsive spends more quota; lengthening it to save quota feels worse.
Two tiers decouple them. Google is free and unlimited, so it can be fast.
The LLM becomes rare and large-batched, so it can be thorough.

Expected steady state in a busy channel (60 messages/min): the quality tier
flushes when 25 messages accumulate, i.e. **~2-3 requests/min against a limit
of 20** — while the reader sees a subtitle in under a second.

### What a burst actually does (measured, not assumed)

Feeding 50 messages into a 20s/25-message batcher produces **two flushes of
25, both fired before the timer** — forced by the batch cap. The queue never
exceeds `maxBatch`, nothing is dropped, and no request ever carries more than
25 messages (which is what claude.ts's `max_tokens: 24000` was sized for).

So the cap makes a busy channel flush *sooner*, never later:

```
requests/min  ≈  max(3, messages_per_min / 25)     per channel
```

150 messages/min is 6 requests/min. Reaching 20 would take ~500 messages per
minute in a single channel.

**The burst that DOES matter is channel switching, not chat volume.** Each
channel keeps its own queue and its own timer. Live translation is
focused-channel-only, but catch-up runs for every channel visited, so hopping
through 10 channels leaves 10 independent pending batches that fire ~20s
later — up to 10 requests in one clump. That stays under 20 and the rate gate
(15/min) smooths it, but it is the one realistic route to the ceiling and the
reason the rate gate must NOT be removed as "no longer needed". If the ceiling
is ever hit in practice, the fix is a global (not per-channel) quality-tier
flush budget, not a longer window.

### Romanized text: where Google is confidently wrong

Measured against the live endpoint on 2026-08-05, Moroccan Darija written in
Latin letters (Arabizi — "3" for ع, "7" for ح):

| input | detected | conf | returned | actually means |
|---|---|---|---|---|
| `baraka 3lik mn dak monster` | ar | 0.94 | *unchanged* | "enough of that Monster" |
| `salam khouya kifach` | ar | 0.98 | *unchanged* | "hi bro, how's it going" |
| `3lach dayr hakka` | ar | **1.00** | "3 days ago hakka" | "why are you acting like that" |
| `ana bghit nmchi l dar` | ar | **1.00** | "I don't want to go home" | "I **want** to go home" |

Two things follow, and both contradict assumptions elsewhere in this codebase:

1. **A pass-through is not a skip.** `isSameText` was written for English chat
   slang, where text coming back unchanged means "already English". For
   romanized Arabic it means "Google gave up" — and recording `{ skipped: true }`
   marked the message permanently handled, so nothing ever retried it. That is
   why a Darija message showed no subtitle at all. Task 1's `via` on the skip
   marker plus `needsQuality` is what reopens it.

2. **Detection confidence does not protect us here.** 1.00 while inverting a
   negation. The `?` marker added earlier keys off LOW confidence and would stay
   silent on exactly the most dangerous output. Task 6 adds the second,
   independent signal: a language whose native script is non-Latin, detected
   from text that is entirely Latin, is a romanization — and Google's answer for
   it is untrustworthy no matter what confidence it reports.

## Global Constraints

- **Run tests from the plugin directory**: `cd /Users/surfer/dev/discord-translate/src/userplugins/vcTranslate && npx vitest run`. From the repo root the aliases silently do not load and `tests/index.test.ts` is omitted while still reporting a pass.
- **Baseline: 290 tests across 12 files.** Report both numbers after every task.
- **Mutation-verify every new test**: break the implementation, confirm the intended test fails, restore. A test that still passes is vacuous — say so plainly rather than moving on. Nine vacuous tests have already been caught this way in this project.
- **Never edit `/Users/surfer/dev/Vencord`.** It is the build host; `src/userplugins/vcTranslate` there is a symlink to this repo. `git status --short` in it must stay empty.
- **Read files with the Read tool.** Bash output truncates template literals, and `grep` is non-functional in this environment (use the Grep tool or `node`).
- **Gates per task**: full suite green · `npx tsc --noEmit --pretty false` with no new errors beyond the pre-existing `Cannot find module 'vitest'` set · `pnpm build` exit 0 in the Vencord checkout.
- **If an existing test's ASSERTION must change, STOP and ask.** Mechanical churn (renames, added arguments) is fine.
- `shouldSkip()` and `isConfidentlyTargetLanguage()` decide locally, for free, that a message needs no engine at all. That check is unchanged and still runs before either tier.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `upgrade.ts` | Which translation may replace which. Pure, no I/O. | **Create** |
| `store.ts` | `StoredTranslation` gains `via` on the `skipped` variant. | Modify |
| `index.tsx` | Two batchers, per-tier routing, catch-up upgrade logic, rendering. | Modify |
| `types.ts` | Tier constants. | Modify |
| `tests/upgrade.test.ts` | Unit tests for the ranking rules. | **Create** |
| `tests/index.test.ts` | Two-tier integration behaviour. | Modify |

---

## Task 1: The upgrade rule

The single rule that makes two writers safe. Everything else depends on it,
and it is pure, so it is worth its own file and its own tests.

**Files:**
- Create: `src/userplugins/vcTranslate/upgrade.ts`
- Create: `src/userplugins/vcTranslate/tests/upgrade.test.ts`
- Modify: `src/userplugins/vcTranslate/store.ts` (the `skipped` variant only)

**Interfaces:**
- Consumes: `StoredTranslation` from `./store`, `EngineId` from `./types`.
- Produces: `ENGINE_RANK`, `isRealTranslation(e)`, `mayReplace(existing, next)`.

- [ ] **Step 1: Give the `skipped` marker a provenance**

In `store.ts`, change the `StoredTranslation` union. Only the `skipped`
variant changes:

```ts
export type StoredTranslation =
    | { lang: string; text: string; via: EngineId; conf?: number }
    | { failed: true }
    // `via` matters here: Google reports "already in the target language" for
    // short messages it simply failed to identify — it returns "ne" unchanged,
    // which isSameText reads as a skip. Treating THAT as final would deny the
    // quality tier the exact messages it is best at. Only an LLM's skip is
    // authoritative enough to close a message for good.
    | { skipped: true; via?: EngineId }
    | { deferred: true };
```

- [ ] **Step 2: Write the failing tests**

Create `tests/upgrade.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd /Users/surfer/dev/discord-translate/src/userplugins/vcTranslate && npx vitest run tests/upgrade.test.ts`
Expected: FAIL — cannot resolve `../upgrade`.

- [ ] **Step 4: Implement**

Create `upgrade.ts`:

```ts
import type { StoredTranslation } from "./store";
import type { EngineId } from "./types";

/**
 * How authoritative an engine's output is.
 *
 * Two writers now race for the same key — the fast tier (Google, ~1s) and the
 * quality tier (an LLM, up to ~20s later) — and ordering is not guaranteed in
 * either direction. A rank makes the outcome depend on WHICH engine produced
 * a line rather than on which reply happened to arrive last.
 *
 * Claude and Gemini share a rank: both see the conversation, neither is
 * meaningfully more authoritative than the other, and only one is ever
 * configured at a time.
 */
export const ENGINE_RANK: Record<EngineId, number> = {
    google: 0,
    claude: 1,
    gemini: 1
};

/** A stored entry that actually carries text to show, as opposed to a marker. */
export function isRealTranslation(
    e: StoredTranslation | undefined
): e is { lang: string; text: string; via: EngineId; conf?: number } {
    return e !== undefined && "lang" in e;
}

/**
 * May `next` be written over `existing`?
 *
 * Two rules, both about never taking something away from the reader:
 *  - a lower-ranked engine never replaces a higher-ranked one, so a slow
 *    Google reply cannot degrade a line the LLM already improved;
 *  - a marker (failed/deferred/skipped) never replaces a real translation, so
 *    a rate-limited quality tier leaves the readable Google line in place
 *    instead of turning it into an error.
 */
export function mayReplace(
    existing: StoredTranslation | undefined,
    next: StoredTranslation
): boolean {
    if (existing === undefined) return true;
    if (!isRealTranslation(existing)) return true;
    if (!isRealTranslation(next)) return false;
    return ENGINE_RANK[next.via] >= ENGINE_RANK[existing.via];
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run` (from the plugin directory)
Expected: PASS, 290 + 8 = 298 tests.

- [ ] **Step 6: Mutation-verify**

Change `ENGINE_RANK[next.via] >= ENGINE_RANK[existing.via]` to `return true`.
Expected: "NEVER lets a late Google result clobber an LLM line" FAILS. Restore.

Change `if (!isRealTranslation(next)) return false;` to `return true`.
Expected: "never writes a failure marker over a real translation" FAILS. Restore.

If either still passes, that test is vacuous — report it.

- [ ] **Step 7: Commit**

```bash
git add src/userplugins/vcTranslate/upgrade.ts \
        src/userplugins/vcTranslate/store.ts \
        src/userplugins/vcTranslate/tests/upgrade.test.ts
git commit -m "feat(vcTranslate): add the upgrade rule that makes two writers safe"
```

---

## Task 2: Two batchers

**Files:**
- Modify: `src/userplugins/vcTranslate/types.ts` (constants)
- Modify: `src/userplugins/vcTranslate/index.tsx` (`rebuildBatcher`, module state, `stop()`)

**Interfaces:**
- Consumes: `createBatcher`/`Batcher` from `./batcher` (unchanged), `mayReplace` from `./upgrade`.
- Produces: module-level `fastBatcher` and `qualityBatcher`; `writeResult(key, value)`; constants `FAST_DEBOUNCE_MS`, `FAST_MAX_BATCH`, `QUALITY_DEBOUNCE_MS`, `QUALITY_MAX_BATCH`.

- [ ] **Step 1: Add the tier constants**

In `types.ts`, append:

```ts
/**
 * The fast tier: Google, on a short window. Free and unmetered, so the only
 * thing being traded off is how many tiny HTTP calls we make — hence a small
 * batch and a short wait. This is what the reader actually sees first.
 */
export const FAST_DEBOUNCE_MS = 700;
export const FAST_MAX_BATCH = 10;

/**
 * The quality tier: the configured LLM, on a long window.
 *
 * 20s is chosen against a MEASURED limit of 20 requests per rolling minute.
 * The batcher flushes on a fixed window from the first queued message, so the
 * window alone caps a single channel at 3 requests/minute; in a busy channel
 * the 25-message batch cap flushes sooner, at roughly 2-3 requests/minute for
 * 60 messages/minute of chat. Either way it sits an order of magnitude under
 * the ceiling, which is the entire point — the previous 3s window produced up
 * to 20 requests/minute and sat exactly ON the ceiling.
 *
 * The reader does not wait on this: the fast tier has already put a subtitle
 * on screen. This window only decides how long the line stays Google's.
 */
export const QUALITY_DEBOUNCE_MS = 20_000;
export const QUALITY_MAX_BATCH = 25;
```

Delete `LLM_DEBOUNCE_MS`, `LLM_MAX_BATCH`, `GOOGLE_DEBOUNCE_MS`, `GOOGLE_MAX_BATCH` from `index.tsx` (lines ~82-85) and import the four new constants from `./types` instead.

- [ ] **Step 2: Replace the single batcher with two**

In `index.tsx`, replace `let batcher: Batcher | null = null;` with:

```ts
// Two independent pipelines over the same messages. The fast one exists so the
// reader never sits in front of an untranslated message; the quality one
// exists so what they end up reading is right. Neither waits on the other.
let fastBatcher: Batcher | null = null;
let qualityBatcher: Batcher | null = null;
```

- [ ] **Step 3: Add the guarded write**

Add near the other store helpers in `index.tsx`:

```ts
/**
 * The ONLY way an engine result reaches the store. Two tiers write to the same
 * key from different latencies, so every write has to ask whether it is
 * actually an improvement — see upgrade.ts.
 */
function writeResult(key: string, value: StoredTranslation): void {
    if (mayReplace(getTranslation(key), value)) setTranslation(key, value);
}
```

Import `mayReplace` from `./upgrade` and `StoredTranslation` from `./store`
(the latter is already imported as a type).

- [ ] **Step 4: Rebuild both batchers**

Rewrite `rebuildBatcher()` so it builds both. Keep the existing generation
guard, the `orphaned` re-queue, and the `onFlush` body; the change is that
`onFlush` now knows which tier it belongs to.

```ts
function rebuildBatcher() {
    // Anything still sitting in either debounce window would otherwise be lost
    // when dispose() clears it below. Drain BOTH before the generation bump.
    const orphaned = [
        ...(fastBatcher?.drainPending() ?? []),
        ...(qualityBatcher?.drainPending() ?? [])
    ];

    const quality = effectiveEngine();
    batcherGeneration++;
    const myGeneration = batcherGeneration;
    fastBatcher?.dispose();
    qualityBatcher?.dispose();

    fastBatcher = createBatcher({
        debounceMs: FAST_DEBOUNCE_MS,
        maxBatch: FAST_MAX_BATCH,
        contextSize: 8,
        supportsContext: false,          // Google is per-message; context is wasted on it
        targetLang: settings.store.targetLang,
        onFlush: req => runTier("google", req, myGeneration)
    });

    // Only when an LLM is actually configured AND usable. With engine=google
    // there is no second tier at all and the fast tier is the whole plugin,
    // exactly as before this change.
    qualityBatcher = isLlmEngine(quality)
        ? createBatcher({
            debounceMs: QUALITY_DEBOUNCE_MS,
            maxBatch: QUALITY_MAX_BATCH,
            contextSize: 8,
            supportsContext: true,
            targetLang: settings.store.targetLang,
            onFlush: req => runTier(quality, req, myGeneration)
        })
        : null;

    // Re-queue under the new settings rather than marking them failed —
    // nothing about these messages failed, the settings changed under them.
    for (const m of orphaned) enqueue(m, false);
}
```

`runTier` is written in Task 5; for this task, stub it as a function that
sends the batch exactly the way the current `onFlush` does and writes results
through `writeResult`. Do not delete the existing fallback code yet — Task 5
owns that.

- [ ] **Step 5: Dispose both in `stop()`**

In `stop()`, replace the single `batcher?.dispose(); batcher = null;` with
both, keeping every surrounding line unchanged:

```ts
fastBatcher?.dispose();
qualityBatcher?.dispose();
fastBatcher = null;
qualityBatcher = null;
```

- [ ] **Step 6: Run the suite**

Run: `npx vitest run`
Expected: PASS. Existing tests assert per-engine call sequences; if any fails
on *assertion* rather than mechanics, STOP and ask.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(vcTranslate): run a fast Google tier and a slow LLM tier side by side"
```

---

## Task 3: Route every message to both tiers

**Files:**
- Modify: `src/userplugins/vcTranslate/index.tsx` (`enqueue`, `inFlight`)
- Modify: `src/userplugins/vcTranslate/tests/index.test.ts`

**Interfaces:**
- Consumes: `fastBatcher`, `qualityBatcher`, `writeResult` from Task 2; `isRealTranslation`, `ENGINE_RANK` from `./upgrade`.
- Produces: `needsFast(key)`, `needsQuality(key)`, per-tier `inFlightFast`/`inFlightQuality`.

- [ ] **Step 1: Split the in-flight bookkeeping**

A message is now legitimately in flight on two engines at once. One shared set
would let the fast request suppress the quality one. Replace
`const inFlight = new Set<string>();` with:

```ts
// Per tier, because a message is legitimately in flight on both at once. A
// single shared set would let whichever tier queued first silently suppress
// the other — the quality tier would simply never run.
const inFlightFast = new Set<string>();
const inFlightQuality = new Set<string>();
```

Update every existing `inFlight` use: the flush cleanup in `runTier` deletes
from the set for its own tier, and `catchUp` checks both (Task 4).

- [ ] **Step 2: Write the failing tests**

Add to `tests/index.test.ts`:

```ts
describe("every message goes to both tiers", () => {
    beforeEach(() => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    });

    it("translates with Google first and the LLM afterwards", async () => {
        native.translateBatch.mockImplementation(async (engine: string) => ({
            ok: true,
            results: [{
                id: "1", lang: "de",
                text: engine === "google" ? "rough" : "good",
                skip: false
            }]
        }));

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });

        // The fast window is 700ms; the quality window is 20s. After ~1s the
        // reader must already have something, and it must be Google's.
        await vi.advanceTimersByTimeAsync(1_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(getTranslation(key("1"))).toMatchObject({ via: "google", text: "rough" });

        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(getTranslation(key("1"))).toMatchObject({ via: "gemini", text: "good" });
    });

    it("does not let a slow Google reply overwrite the LLM line", async () => {
        // Ordering between the tiers is not guaranteed. Without the upgrade
        // rule the reader watches a good line degrade into a worse one.
        setTranslation(key("1"), { lang: "de", text: "good", via: "gemini" });
        respondWith({ ok: true, results: [{ id: "1", lang: "de", text: "rough", skip: false }] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();

        expect(getTranslation(key("1"))).toMatchObject({ via: "gemini", text: "good" });
    });

    it("uses only the fast tier when the configured engine is Google", async () => {
        settings.store.engine = "google";
        rebuildForSettings();
        respondWith({ ok: true, results: [{ id: "1", lang: "de", text: "rough", skip: false }] });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(native.translateBatch.mock.calls.map(c => c[0])).toEqual(["google"]);
    });
});
```

`rebuildForSettings()` is whatever the existing tests already use to apply a
settings change (the settings stub fires `onChange`); if a helper does not
exist, assign through `settings.store` as the surrounding tests do.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/index.test.ts`
Expected: the first test FAILS (only one engine is called).

- [ ] **Step 4: Implement the routing**

Add the per-tier predicates and rewrite the tail of `enqueue`:

```ts
/**
 * Has the fast tier still got something to contribute?
 *
 * Its whole job is "put SOMETHING readable on screen quickly". Once any real
 * translation exists — from either tier — that job is done, and re-running it
 * would only risk replacing a good line with a worse one.
 */
function needsFast(key: string): boolean {
    const e = getTranslation(key);
    return e === undefined || "failed" in e || "deferred" in e;
}

/**
 * Has the quality tier still got something to contribute?
 *
 * A Google line is a candidate for upgrade, not a finished answer. Only an
 * LLM's own verdict closes a message: an LLM translation, or an LLM skip.
 * A GOOGLE skip deliberately does NOT close it — Google reports "already in
 * the target language" for short messages it merely failed to identify (it
 * returns "ne" unchanged, which isSameText reads as a skip), and those are
 * exactly the messages the quality tier is best at.
 */
function needsQuality(key: string): boolean {
    const e = getTranslation(key);
    if (e === undefined) return true;
    if (isRealTranslation(e)) return ENGINE_RANK[e.via] < 1;
    if ("skipped" in e) return e.via === undefined || ENGINE_RANK[e.via] < 1;
    return true;   // failed / deferred — both tiers get another go
}
```

Replace the last three lines of `enqueue` (`announceMissingKeyOnce();
inFlight.add(...); batcher?.add(...)`) with:

```ts
    announceMissingKeyOnce();

    const key = makeKey(pending.id, settings.store.targetLang);

    if (!inFlightFast.has(pending.id) && needsFast(key)) {
        inFlightFast.add(pending.id);
        fastBatcher?.add(pending);
    }

    if (qualityBatcher && !inFlightQuality.has(pending.id) && needsQuality(key)) {
        inFlightQuality.add(pending.id);
        qualityBatcher.add(pending);
    } else if (!qualityBatcher) {
        // No LLM configured: the message still belongs in the context ring, so
        // a later flush of the OTHER tier sees a coherent conversation.
        qualityBatcher?.recordContext(pending);
    }
```

Delete the now-unused single `inFlight` set.

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Mutation-verify**

Make `needsQuality` always return `false`.
Expected: "translates with Google first and the LLM afterwards" FAILS.

Make `enqueue` add to `fastBatcher` only.
Expected: same test FAILS.

Change `needsQuality`'s skip branch to `return false` unconditionally, then
store `{ skipped: true, via: "google" }` for a message and enqueue it.
Expected: a quality request is no longer made. Add a test asserting a Google
skip does NOT close the message if one does not already exist. Restore.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(vcTranslate): send every message through both tiers, upgrade-only"
```

---

## Task 4: Catch-up understands "pending upgrade"

Without this the whole feature is a silent no-op on channel open: a Google
line exists for every message, catch-up reads that as "handled", and the
quality tier never runs. This is the failure most likely to look like
"Gemini isn't working" while every test passes.

**Files:**
- Modify: `src/userplugins/vcTranslate/index.tsx` (`catchUp`)
- Modify: `src/userplugins/vcTranslate/tests/index.test.ts`

**Interfaces:**
- Consumes: `needsFast`, `needsQuality`, `inFlightFast`, `inFlightQuality` from Task 3.

- [ ] **Step 1: Write the failing test**

```ts
describe("catch-up upgrades messages Google already translated", () => {
    it("re-enqueues a Google line for the LLM on channel open", async () => {
        // The silent-no-op guard. Every message has a Google subtitle within a
        // second, so a resolved-check that only asks "is there an entry?" would
        // consider the whole backlog finished and never upgrade any of it.
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        setTranslation(key("1"), { lang: "de", text: "rough", via: "google" });
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);
        respondWith({ ok: true, results: [] });

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        const engines = native.translateBatch.mock.calls.map(c => c[0]);
        expect(engines).toContain("gemini");
        expect(engines).not.toContain("google");   // Google's work is already done
    });

    it("leaves a message the LLM already translated completely alone", async () => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
        setTranslation(key("1"), { lang: "de", text: "good", via: "gemini" });
        stubMessages.set(CHANNEL, [discordMessage("1", "hola")]);

        FluxDispatcher.dispatch("CHANNEL_SELECT", { channelId: CHANNEL });
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(native.translateBatch).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: the first test FAILS — no request is made at all.

- [ ] **Step 3: Implement**

In `catchUp`, replace the resolved check
(`if (entry && !("failed" in entry) && !("deferred" in entry)) continue;`) with:

```ts
        // A message is finished only when NEITHER tier has anything left to do.
        // Asking "is there an entry?" is no longer enough: the fast tier writes
        // one within a second of every message arriving, so that question now
        // answers "yes" for the entire backlog and the quality tier would never
        // run again.
        const fast = !inFlightFast.has(message.id) && needsFast(key);
        const quality = qualityBatcher !== null
            && !inFlightQuality.has(message.id)
            && needsQuality(key);
        if (!fast && !quality) continue;

        candidates.push(message);
        // Budget only what will actually reach an engine — see the budget
        // comment above. An upgrade is one request's worth of work just as a
        // first translation is.
        if (!isLocallySkipped(message.content ?? "", message.author?.id === me)) budget++;
```

Delete the now-redundant `if (inFlight.has(message.id)) continue;` line above
it, since both tier checks now include their own in-flight test.

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Mutation-verify**

Change the resolved check back to `if (entry) continue;`.
Expected: "re-enqueues a Google line for the LLM on channel open" FAILS.

Change `if (!fast && !quality) continue;` to `if (!fast) continue;`.
Expected: the same test FAILS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "fix(vcTranslate): let catch-up see a Google line as pending upgrade, not as done"
```

---

## Task 5: A failing quality tier costs the reader nothing

With a Google line always present, most of the existing fallback machinery
becomes both unnecessary and harmful — its markers would overwrite a
perfectly readable subtitle.

**Files:**
- Modify: `src/userplugins/vcTranslate/index.tsx` (`runTier`, cooldown path)
- Modify: `src/userplugins/vcTranslate/tests/index.test.ts`

**Interfaces:**
- Produces: `runTier(engine, req, generation)` — the single flush implementation for both tiers.

- [ ] **Step 1: Write the failing tests**

```ts
describe("a failing quality tier never takes anything away from the reader", () => {
    beforeEach(() => {
        settings.store.engine = "gemini";
        settings.store.geminiApiKey = "AIza-test";
    });

    it("keeps the Google line when the LLM is rate limited", async () => {
        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "google"
                ? { ok: true, results: [{ id: "1", lang: "de", text: "rough", skip: false }] }
                : { ok: false, error: "gemini: HTTP 429", retryAfterMs: 30_000 });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        // Still readable, still marked Google. NOT failed, NOT deferred.
        expect(getTranslation(key("1"))).toMatchObject({ via: "google", text: "rough" });
    });

    it("does not send a quality request at all while the engine is cooling down", async () => {
        native.translateBatch.mockImplementation(async (engine: string) =>
            engine === "google"
                ? { ok: true, results: [{ id: "9", lang: "de", text: "rough", skip: false }] }
                : { ok: false, error: "gemini: HTTP 429", retryAfterMs: 600_000 });

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("1", "hola") });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        const before = native.translateBatch.mock.calls.length;

        FluxDispatcher.dispatch("MESSAGE_CREATE", { message: discordMessage("2", "que tal") });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        const later = native.translateBatch.mock.calls.slice(before).map(c => c[0]);
        expect(later).not.toContain("gemini");
        expect(later).toContain("google");
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Expected: the first FAILS — the entry is `{ deferred: true }`.

- [ ] **Step 3: Implement `runTier`**

```ts
/**
 * One flush, for either tier. The tier is entirely described by which engine
 * it was built with, so there is one implementation rather than two.
 *
 * The old Google-fallback-on-429 path is gone: with a fast tier the fallback
 * has ALREADY run, before the LLM was even asked. A quality tier that cannot
 * answer simply stays quiet and the Google line stands.
 */
async function runTier(engine: EngineId, req: BatchRequest, myGeneration: number) {
    const isQuality = engine !== "google";
    const inFlightSet = isQuality ? inFlightQuality : inFlightFast;

    try {
        if (myGeneration !== batcherGeneration) return;
        // Cooling down after a 429: do not spend the request to be told so
        // again. Nothing is marked — the reader already has a Google line.
        if (isQuality && isLlmEngine(engine) && isCoolingDown(engine)) return;
        if (isQuality) await acquireSlot();

        let res: NativeResponse | null;
        try {
            res = await Native.translateBatch(
                engine,
                isLlmEngine(engine) ? apiKeyFor(engine) : "",
                JSON.stringify(engine === "google" ? withSourceLangs(req) : req)
            );
        } catch {
            res = null;
        }
        if (myGeneration !== batcherGeneration) return;

        if (res === null || !res.ok) {
            if (res && !res.ok) {
                if (isQuality && isLlmEngine(engine) && res.retryAfterMs) {
                    enterCooldown(engine, res.retryAfterMs, res.quotaLimitPerMinute);
                }
                if (isLlmEngine(engine) && /\b40[13]\b/.test(res.error)) {
                    fallBackToGoogle(`${LLM_ENGINES[engine].label} rejected the API key`);
                }
            }
            // Markers only from the FAST tier, and writeResult still refuses to
            // put one over a real line. A quality failure is invisible by
            // design: the reader keeps what they already had.
            if (!isQuality) {
                for (const m of req.messages) {
                    writeResult(makeKey(m.id, req.targetLang), { failed: true });
                }
            }
            return;
        }

        for (const r of res.results) {
            const key = makeKey(r.id, req.targetLang);
            if ("failed" in r) {
                if (!isQuality) writeResult(key, { failed: true });
                continue;
            }
            if (r.skip) {
                writeResult(key, { skipped: true, via: engine });
                continue;
            }
            writeResult(key, { lang: r.lang, text: r.text, via: engine, conf: r.conf });
        }
    } finally {
        for (const m of req.messages) inFlightSet.delete(m.id);
    }
}
```

Note `{ skipped: true, via: engine }` is written through `writeResult` so it
cannot replace a real translation — a Google skip must never erase an LLM line.

- [ ] **Step 4: Delete the superseded fallback code**

Remove the old `send`/`rateLimitedToGoogle`/`markAllDeferred` block from the
former `onFlush`. Keep `fallBackToGoogle` (still correct for a rejected key)
and `markAllFailed` only if still referenced; delete it if not.

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: PASS. Several existing rate-limit tests assert the old
Google-fallback sequence within one flush. Those assertions describe
behaviour this task deliberately removes — **STOP and ask** before changing
them.

- [ ] **Step 6: Mutation-verify**

Remove the `if (!isQuality)` guard around the failure markers.
Expected: "keeps the Google line when the LLM is rate limited" FAILS.

Remove the `isCoolingDown` early return.
Expected: "does not send a quality request at all while the engine is cooling down" FAILS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor(vcTranslate): a failing quality tier leaves the Google line alone"
```

---

## Task 6: Never present a romanized guess as confident

Confidence alone cannot flag Google's worst output. This adds the independent
signal — see "Romanized text" above for the measurements this is built on.

**Files:**
- Create: `src/userplugins/vcTranslate/romanized.ts`
- Create: `src/userplugins/vcTranslate/tests/romanized.test.ts`
- Modify: `src/userplugins/vcTranslate/index.tsx` (`TranslationAccessory`)

**Interfaces:**
- Produces: `isRomanizedGuess(detectedLang: string, originalText: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/romanized.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isRomanizedGuess } from "../romanized";

describe("isRomanizedGuess", () => {
    it("flags Arabic detected from Latin-only text", () => {
        // Google reported ar at confidence 1.00 for this and inverted the
        // negation — "I don't want to go home" for "I want to go home".
        expect(isRomanizedGuess("ar", "ana bghit nmchi l dar")).toBe(true);
        expect(isRomanizedGuess("ar", "baraka 3lik mn dak monster")).toBe(true);
    });

    it("does not flag Arabic written in Arabic script", () => {
        // Google is good at this; flagging it would cry wolf on the common case.
        expect(isRomanizedGuess("ar", "يعطيك العافية")).toBe(false);
    });

    it("does not flag languages that are natively Latin", () => {
        expect(isRomanizedGuess("es", "hola que tal")).toBe(false);
        expect(isRomanizedGuess("de", "sind die gruppenraume klimatisiert")).toBe(false);
        expect(isRomanizedGuess("ha", "ne")).toBe(false);   // Hausa IS Latin-script
    });

    it("does not flag a script-tagged code that already says Latin", () => {
        expect(isRomanizedGuess("ber-Latn", "wach nta labas")).toBe(false);
    });

    it("flags the other big non-Latin scripts", () => {
        expect(isRomanizedGuess("ru", "privet kak dela")).toBe(true);
        expect(isRomanizedGuess("ja", "konnichiwa")).toBe(true);
        expect(isRomanizedGuess("hi", "kya haal hai")).toBe(true);
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/romanized.test.ts`
Expected: FAIL — cannot resolve `../romanized`.

- [ ] **Step 3: Implement**

Create `romanized.ts`:

```ts
/**
 * Languages normally written in a non-Latin script. If one of these is
 * detected from text containing no non-Latin letters at all, the input was
 * romanized — and Google's answer for it cannot be trusted.
 *
 * Not exhaustive, and does not need to be: a language missing from this list
 * costs an unflagged line, exactly as today. Adding one is free.
 */
const NON_LATIN_SCRIPT = new Set([
    "ar", "fa", "ur", "ps", "sd", "ug", "he", "yi",
    "ru", "uk", "be", "bg", "sr", "mk", "kk", "ky", "mn", "tg",
    "el", "hy", "ka", "am", "ti",
    "hi", "bn", "pa", "gu", "or", "ta", "te", "kn", "ml", "si", "ne", "mr", "sa",
    "th", "lo", "km", "my", "bo", "dv",
    "zh", "ja", "ko", "yue"
]);

const LETTER = /\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * True when `detectedLang` is normally non-Latin but `originalText` is written
 * entirely in Latin letters.
 *
 * This is the signal detection confidence cannot give us. Measured: Google
 * reports 1.00 confidence on romanized Moroccan Darija while inverting a
 * negation, so a low-confidence check stays silent on precisely the output most
 * likely to mislead. Script mismatch is independent of confidence and catches
 * that class directly.
 *
 * A code that names its own script ("ber-Latn") is taken at its word.
 */
export function isRomanizedGuess(detectedLang: string, originalText: string): boolean {
    const base = detectedLang.toLowerCase().split("-")[0];
    if (detectedLang.toLowerCase().includes("-latn")) return false;
    if (!NON_LATIN_SCRIPT.has(base)) return false;

    for (const ch of originalText) {
        if (LETTER.test(ch) && !LATIN_LETTER.test(ch)) return false;
    }
    return true;
}
```

- [ ] **Step 4: Use it in the accessory**

In `TranslationAccessory`, extend the `unsure` condition. It must apply only to
Google lines — an LLM result is not a script guess:

```ts
    const romanized = isRomanizedGuess(entry.lang, message.content ?? "");
    const unsure = ENGINE_RANK[entry.via] === 0 && (
        (entry.conf !== undefined && entry.conf < MIN_DETECT_CONFIDENCE)
        || romanized
    );
```

and give the romanized case its own tooltip, since "only 100% confident" would
read as nonsense:

```ts
    const title = !unsure
        ? `Translated by ${provenance.label} · ${langName}`
        : romanized
            ? `Translated by ${provenance.label}. This looks like ${langName} `
              + "written in Latin letters, which Google translates badly — "
              + "often confidently and wrongly. Wait for the ✦ line."
            : `Translated by ${provenance.label}. ${langName} detected, but only `
              + `${Math.round(entry.conf! * 100)}% confidently — short messages are `
              + "often misread, so this may be wrong.";
```

- [ ] **Step 5: Add the integration test**

```ts
it("marks a romanized Google line unsure even at full confidence", () => {
    // The measured case: ar detected at 1.00 from Latin text, negation
    // inverted. Confidence alone would let this through unmarked.
    setTranslation(key("1"), {
        lang: "ar", text: "I don't want to go home", via: "google", conf: 1
    });
    const node = render(discordMessage("1", "ana bghit nmchi l dar"));
    expect(text(node)).toContain("ar?");
    expect(titleOf(node)).toContain("Latin letters");
});

it("does not mark an LLM line as a romanization guess", () => {
    setTranslation(key("1"), { lang: "ar", text: "I want to go home", via: "gemini" });
    expect(text(render(discordMessage("1", "ana bghit nmchi l dar")))).not.toContain("?");
});
```

- [ ] **Step 6: Run and mutation-verify**

Run: `npx vitest run` — Expected: PASS.

Make `isRomanizedGuess` always return `false`.
Expected: "marks a romanized Google line unsure even at full confidence" FAILS.

Remove the `ENGINE_RANK[entry.via] === 0` guard.
Expected: "does not mark an LLM line as a romanization guess" FAILS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(vcTranslate): flag romanized text Google mistranslates with full confidence"
```

---

## Task 7: Rendering, docs and manual verification

**Files:**
- Modify: `src/userplugins/vcTranslate/index.tsx` (`TranslationAccessory`)
- Modify: `src/userplugins/vcTranslate/README.md`
- Modify: `src/userplugins/vcTranslate/tests/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("drops the low-confidence ? once the LLM has upgraded the line", async () => {
    // The ? means "Google was guessing at the language". Once the LLM has
    // answered, that caveat is no longer true and must not linger.
    setTranslation(key("1"), { lang: "ha", text: "it is", via: "google", conf: 0.217 });
    expect(text(render(discordMessage("1", "ne")))).toContain("ha?");

    setTranslation(key("1"), { lang: "de", text: "no", via: "gemini" });
    expect(text(render(discordMessage("1", "ne")))).not.toContain("?");
});
```

- [ ] **Step 2: Run to verify it fails**

If it already passes, the rendering needs no change — the `?` is driven by
`entry.conf`, which the LLM does not set. Say so, keep the test as a
regression guard, and skip Step 3.

- [ ] **Step 3: Implement if needed**

No change is expected: `unsure` is `entry.conf !== undefined && entry.conf <
MIN_DETECT_CONFIDENCE`, and an LLM result carries no `conf`. If the test
fails, make the `?` conditional on `ENGINE_RANK[entry.via] === 0` as well.

- [ ] **Step 4: Update the README**

Rewrite the engine section to describe two tiers rather than one selected
engine. It must state:
- every message is translated by Google within about a second, then re-translated by the configured LLM and upgraded in place;
- `≈` therefore means "the LLM has not answered for this message *yet*, or could not" — it is no longer a permanent verdict;
- the measured limit (20 requests/rolling-minute) and why the 20s window keeps us an order of magnitude under it;
- setting the engine to Google disables the second tier entirely.

- [ ] **Step 5: Add manual verification rows**

Append to the manual checklist table:

| # | Action | Expected | ✓ |
|---|---|---|---|
| 10 | Post a foreign message in a busy channel | A `≈` subtitle appears within ~1s | ☐ |
| 11 | Keep watching that same message for ~30s | It changes to `✦` with a better translation | ☐ |
| 12 | Open a channel with a long untranslated backlog | `≈` lines appear immediately, `✦` follows in batches | ☐ |
| 13 | Exhaust the Gemini quota, then post a message | `≈` still appears; no `⚠`, no `⏳`, no toast storm | ☐ |
| 14 | Watch the AI Studio rate-limit dashboard for 10 min of normal use | Well under 20 requests/min | ☐ |
| 15 | Post romanized Darija: `ana bghit nmchi l dar` | Either no ≈ line, or one marked `ar?`; the ✦ line that follows says "I want to go home" (NOT "don't want") | ☐ |
| 16 | Post `baraka 3lik mn dak monster` | Google returns it unchanged so there may be no ≈ line at all — but a ✦ line still arrives and mentions the drink | ☐ |
| 17 | Confirm the DM is enabled with the 🌐 button first | Rows 15-16 do nothing in a DM that was never enabled; `globalAuto` never covers DMs | ☐ |

- [ ] **Step 6: Full gates**

```bash
cd /Users/surfer/dev/discord-translate/src/userplugins/vcTranslate && npx vitest run
cd /Users/surfer/dev/Vencord && npx tsc --noEmit --pretty false && pnpm build && git status --short
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "docs(vcTranslate): describe the two-tier pipeline and how to verify it"
```

---

## Self-review

**Spec coverage.** Instant subtitle → Tasks 2-3 (fast tier, 700ms).
LLM over *every* message → Task 3 (`needsQuality`, no eligibility filter).
Upgrade in place → Tasks 1 and 3. Within quota → Task 2 constants plus Task 5
(no request while cooling down). The three problems identified before writing:
no-downgrade → Task 1; per-engine in-flight → Task 3; catch-up resolved-check
→ Task 4.

**Deliberately not included.** A "translating…" placeholder. With the fast
tier the gap is ~700ms rather than 3-5s, and a placeholder that flashes for
under a second is likely worse than nothing. It also cannot key off "no store
entry", because locally-skipped messages never write one and would show the
placeholder forever — it would need `inFlightFast` to notify the renderer.
Re-evaluate after Task 6 with the real latency in hand; do not build it
speculatively.

**Known tradeoff.** Every message now goes through the unofficial Google
endpoint, not just fallback traffic. That is a volume increase on an endpoint
with no stated limits. Task 6 row 14 is where that gets watched.
