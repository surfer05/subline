# vcTranslate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Vencord userplugin that automatically translates incoming Discord messages in enabled channels and renders the translation as a subtitle beneath the original.

**Architecture:** Three layers. Pure logic (skip rules, cache, batching) lives in dependency-free modules that are unit-tested without Discord. Network calls live in `native.ts`, which Vencord runs in Electron's **main** process — required because Discord's CSP blocks the renderer from reaching translation APIs. A thin `index.tsx` shell subscribes to Discord's Flux dispatcher and renders accessories.

**Tech Stack:** TypeScript, React (Discord's bundled copy), Vencord plugin API, vitest, Node `fetch` (main process only).

## Global Constraints

- **Plugin folder:** `src/userplugins/vcTranslate/` inside a from-source Vencord checkout. Userplugins do not work with the stock installer.
- **Plugin name is load-bearing:** `definePlugin({ name: "VcTranslate" })` must match `VencordNative.pluginHelpers.VcTranslate` exactly. A mismatch yields `undefined` at runtime with no error.
- **Anthropic model ID:** `claude-haiku-4-5` — exact string, no date suffix.
- **Do NOT send `effort` or `thinking` to Haiku 4.5.** `output_config.effort` returns an error on this model. Neither is needed for translation.
- **Anthropic request headers:** `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`.
- **Raw `fetch`, not the Anthropic SDK.** Deliberate deviation from normal Anthropic guidance. Userplugins live inside a Vencord git checkout the user must `git pull` to update; adding a dependency to Vencord's `package.json` causes a merge conflict on every Vencord update. Every Vencord native module uses bare `fetch`. Consistency and zero-maintenance win here.
- **`native.ts` functions take `IpcMainInvokeEvent` as their first parameter.** The renderer does **not** pass it — Vencord injects it. So `Native.translateBatch(a, b)` in the renderer maps to `translateBatch(_, a, b)` in native.
- **Never log the API key**, including inside error paths.
- **All files under 200 lines.** Split rather than grow.

## File Structure

| File | Process | Responsibility |
|---|---|---|
| `types.ts` | shared | `BatchRequest`, `Result`, `EngineId`, `ENGINE_CAPS` |
| `skip.ts` | renderer | Pure: should this message be translated at all? |
| `store.ts` | renderer | LRU translation cache + subscribe/notify for re-render |
| `batcher.ts` | renderer | Debounce, batch, assemble rolling context |
| `channels.ts` | renderer | Which channels are enabled (persisted via DataStore) |
| `settings.ts` | renderer | `definePluginSettings` |
| `index.tsx` | renderer | Plugin definition, Flux hook, accessory component, header button |
| `native.ts` | **main** | Engine dispatch, retry/backoff |
| `engines/google.ts` | **main** | Google free-endpoint request/response mapping |
| `engines/claude.ts` | **main** | Claude prompt building + structured-output parsing |
| `tests/*.test.ts` | — | vitest suites for every pure module |

---

### Task 1: Types and skip rules

**Files:**
- Create: `src/userplugins/vcTranslate/types.ts`
- Create: `src/userplugins/vcTranslate/skip.ts`
- Create: `src/userplugins/vcTranslate/tests/skip.test.ts`
- Create: `src/userplugins/vcTranslate/vitest.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EngineId`, `PendingMessage`, `BatchRequest`, `Result`, `ENGINE_CAPS` from `types.ts`; `shouldSkip(text: string, isOwnMessage: boolean): boolean` from `skip.ts`.

- [ ] **Step 1: Create the type module**

`types.ts`:

```ts
export type EngineId = "google" | "claude";

export interface PendingMessage {
    id: string;
    author: string;
    text: string;
    channelId: string;
}

export interface BatchRequest {
    messages: { id: string; author: string; text: string }[];
    context: { author: string; text: string }[];
    targetLang: string;
}

export type Result =
    | { id: string; lang: string; text: string; skip: false }
    | { id: string; skip: true };

export const ENGINE_CAPS: Record<EngineId, { supportsContext: boolean }> = {
    google: { supportsContext: false },
    claude: { supportsContext: true }
};
```

- [ ] **Step 2: Add the vitest config**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node"
    }
});
```

- [ ] **Step 3: Write the failing test**

`tests/skip.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldSkip } from "../skip";

describe("shouldSkip", () => {
    it("skips your own messages", () => {
        expect(shouldSkip("hola amigos", true)).toBe(true);
    });

    it("skips empty and whitespace-only messages", () => {
        expect(shouldSkip("", false)).toBe(true);
        expect(shouldSkip("   \n ", false)).toBe(true);
    });

    it("skips messages that are only custom emotes", () => {
        expect(shouldSkip("<:pepe:123456789>", false)).toBe(true);
        expect(shouldSkip("<a:dance:987> <:kek:654>", false)).toBe(true);
    });

    it("skips messages that are only unicode emoji", () => {
        expect(shouldSkip("😂😂😂", false)).toBe(true);
    });

    it("skips messages that are only links", () => {
        expect(shouldSkip("https://example.com/clip", false)).toBe(true);
    });

    it("skips messages that are only mentions", () => {
        expect(shouldSkip("<@123> <@!456> <#789>", false)).toBe(true);
    });

    it("skips purely numeric messages", () => {
        expect(shouldSkip("2", false)).toBe(true);
        expect(shouldSkip("10 / 10", false)).toBe(true);
    });

    it("translates real text", () => {
        expect(shouldSkip("vamos a jugar", false)).toBe(false);
    });

    it("translates text mixed with a mention", () => {
        expect(shouldSkip("<@123> vamos", false)).toBe(false);
    });

    it("translates short but meaningful words", () => {
        expect(shouldSkip("да", false)).toBe(false);
    });

    it("skips keycap emoji sequences", () => {
        expect(shouldSkip("1️⃣2️⃣3️⃣", false)).toBe(true);
    });

    it("skips lone combining marks", () => {
        expect(shouldSkip("́", false)).toBe(true);
    });

    it("skips Arabic-Indic digits", () => {
        expect(shouldSkip("١٢٣", false)).toBe(true);
    });

    // Real non-Latin text with combining marks must survive \p{M} stripping and still translate.
    it("translates decomposed café (Latin with combining mark)", () => {
        expect(shouldSkip("café", false)).toBe(false);
    });

    it("translates Devanagari script (has virama, category Mn)", () => {
        expect(shouldSkip("नमस्ते", false)).toBe(false);
    });

    it("translates Thai script (has combining marks)", () => {
        expect(shouldSkip("สวัสดี", false)).toBe(false);
    });

    it("translates Arabic script (non-Latin with no ASCII)", () => {
        expect(shouldSkip("مرحبا", false)).toBe(false);
    });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/skip.test.ts`
Expected: FAIL — cannot resolve `../skip`.

- [ ] **Step 5: Implement `skip.ts`**

The approach: strip everything that carries no translatable meaning, then check whether anything is left.

```ts
const CUSTOM_EMOTE = /<a?:\w+:\d+>/g;
const MENTION = /<[@#][!&]?\d+>/g;
const URL = /https?:\/\/\S+/g;
// Emoji, variation selectors, ZWJ, skin-tone modifiers, regional indicators.
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;

export function shouldSkip(text: string, isOwnMessage: boolean): boolean {
    if (isOwnMessage) return true;

    const stripped = text
        .replace(CUSTOM_EMOTE, "")
        .replace(MENTION, "")
        .replace(URL, "")
        .replace(EMOJI, "")
        // Anything left that is only digits, punctuation, whitespace, or combining marks
        // carries no translatable meaning.
        .replace(/[\p{Nd}\p{P}\p{S}\p{M}\s]/gu, "");

    return stripped.length === 0;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/skip.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 7: Commit**

```bash
git add src/userplugins/vcTranslate/
git commit -m "feat(vcTranslate): add shared types and message skip rules"
```

---

### Task 2: Translation store (LRU cache + change notification)

**Files:**
- Create: `src/userplugins/vcTranslate/store.ts`
- Create: `src/userplugins/vcTranslate/tests/store.test.ts`

**Interfaces:**
- Consumes: `Result` from `types.ts`.
- Produces: `makeKey(messageId, lang, engine): string`, `getTranslation(key): StoredTranslation | undefined`, `setTranslation(key, value): void`, `invalidateMessage(messageId): void`, `subscribe(fn: () => void): () => void`, `clearStore(): void`, and `type StoredTranslation = { lang: string; text: string } | { failed: true }`.

The store doubles as the re-render trigger: translations arrive asynchronously, so the accessory component subscribes and re-renders when its entry lands.

- [ ] **Step 1: Write the failing test**

`tests/store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — cannot resolve `../store`.

- [ ] **Step 3: Implement `store.ts`**

`Map` preserves insertion order, so delete-then-set moves an entry to the most-recent position. That is the whole LRU mechanism.

```ts
export type StoredTranslation =
    | { lang: string; text: string }
    | { failed: true };

const MAX_ENTRIES = 500;

const cache = new Map<string, StoredTranslation>();
const listeners = new Set<() => void>();

export function makeKey(messageId: string, lang: string, engine: string): string {
    return `${messageId} ${lang} ${engine}`;
}

export function getTranslation(key: string): StoredTranslation | undefined {
    const hit = cache.get(key);
    if (hit === undefined) return undefined;
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
}

export function setTranslation(key: string, value: StoredTranslation): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value as string;
        cache.delete(oldest);
    }
    for (const fn of listeners) fn();
}

export function invalidateMessage(messageId: string): void {
    const prefix = `${messageId} `;
    for (const key of [...cache.keys()]) {
        if (key.startsWith(prefix)) cache.delete(key);
    }
    for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function clearStore(): void {
    cache.clear();
    listeners.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/userplugins/vcTranslate/store.ts src/userplugins/vcTranslate/tests/store.test.ts
git commit -m "feat(vcTranslate): add LRU translation store with change notification"
```

---

### Task 3: Batcher

**Files:**
- Create: `src/userplugins/vcTranslate/batcher.ts`
- Create: `src/userplugins/vcTranslate/tests/batcher.test.ts`

**Interfaces:**
- Consumes: `PendingMessage`, `BatchRequest` from `types.ts`.
- Produces: `createBatcher(opts: BatcherOptions): Batcher`, where
  `BatcherOptions = { debounceMs: number; maxBatch: number; contextSize: number; supportsContext: boolean; targetLang: string; onFlush: (req: BatchRequest, channelId: string) => void }`
  and `Batcher = { add(msg: PendingMessage): void; recordContext(msg: PendingMessage): void; flushNow(): void; dispose(): void }`.

Two entry points matter. `add()` queues a message **for translation**. `recordContext()` records a message into the rolling context window **without** queueing it — used for messages that were skipped (already English, emote-only) but still carry conversational meaning.

- [ ] **Step 1: Write the failing test**

`tests/batcher.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBatcher } from "../batcher";
import type { BatchRequest, PendingMessage } from "../types";

const msg = (id: string, text: string, channelId = "c1"): PendingMessage =>
    ({ id, author: `user${id}`, text, channelId });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(overrides: Partial<Parameters<typeof createBatcher>[0]> = {}) {
    const flushed: { req: BatchRequest; channelId: string }[] = [];
    const batcher = createBatcher({
        debounceMs: 700,
        maxBatch: 10,
        contextSize: 8,
        supportsContext: true,
        targetLang: "en",
        onFlush: (req, channelId) => flushed.push({ req, channelId }),
        ...overrides
    });
    return { batcher, flushed };
}

describe("createBatcher", () => {
    it("does not flush before the debounce window elapses", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "hola"));
        vi.advanceTimersByTime(699);
        expect(flushed).toHaveLength(0);
    });

    it("flushes once after the debounce window", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "hola"));
        vi.advanceTimersByTime(700);
        expect(flushed).toHaveLength(1);
        expect(flushed[0].req.messages).toHaveLength(1);
        expect(flushed[0].channelId).toBe("c1");
    });

    it("coalesces a burst into one batch", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "hola"));
        vi.advanceTimersByTime(300);
        batcher.add(msg("2", "que tal"));
        vi.advanceTimersByTime(300);
        batcher.add(msg("3", "bien"));
        vi.advanceTimersByTime(700);

        expect(flushed).toHaveLength(1);
        expect(flushed[0].req.messages.map(m => m.id)).toEqual(["1", "2", "3"]);
    });

    it("flushes immediately when the batch cap is reached", () => {
        const { batcher, flushed } = setup({ maxBatch: 3 });
        batcher.add(msg("1", "a"));
        batcher.add(msg("2", "b"));
        batcher.add(msg("3", "c"));
        expect(flushed).toHaveLength(1);
        expect(flushed[0].req.messages).toHaveLength(3);
    });

    it("keeps separate queues per channel", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "hola", "c1"));
        batcher.add(msg("2", "salut", "c2"));
        vi.advanceTimersByTime(700);

        expect(flushed).toHaveLength(2);
        const byChannel = Object.fromEntries(flushed.map(f => [f.channelId, f.req.messages.length]));
        expect(byChannel).toEqual({ c1: 1, c2: 1 });
    });

    it("includes prior messages as context, newest last", () => {
        const { batcher, flushed } = setup();
        batcher.recordContext(msg("1", "first"));
        batcher.recordContext(msg("2", "second"));
        batcher.add(msg("3", "tercero"));
        vi.advanceTimersByTime(700);

        expect(flushed[0].req.context.map(c => c.text)).toEqual(["first", "second"]);
    });

    it("caps context at contextSize, keeping the most recent", () => {
        const { batcher, flushed } = setup({ contextSize: 2 });
        batcher.recordContext(msg("1", "a"));
        batcher.recordContext(msg("2", "b"));
        batcher.recordContext(msg("3", "c"));
        batcher.add(msg("4", "d"));
        vi.advanceTimersByTime(700);

        expect(flushed[0].req.context.map(c => c.text)).toEqual(["b", "c"]);
    });

    it("sends empty context when the engine does not support it", () => {
        const { batcher, flushed } = setup({ supportsContext: false });
        batcher.recordContext(msg("1", "a"));
        batcher.add(msg("2", "b"));
        vi.advanceTimersByTime(700);

        expect(flushed[0].req.context).toEqual([]);
    });

    it("queued messages also become context for the next batch", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "uno"));
        vi.advanceTimersByTime(700);
        batcher.add(msg("2", "dos"));
        vi.advanceTimersByTime(700);

        expect(flushed[1].req.context.map(c => c.text)).toEqual(["uno"]);
    });

    it("dispose cancels a pending flush", () => {
        const { batcher, flushed } = setup();
        batcher.add(msg("1", "hola"));
        batcher.dispose();
        vi.advanceTimersByTime(2000);
        expect(flushed).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/batcher.test.ts`
Expected: FAIL — cannot resolve `../batcher`.

- [ ] **Step 3: Implement `batcher.ts`**

```ts
import type { BatchRequest, PendingMessage } from "./types";

export interface BatcherOptions {
    debounceMs: number;
    maxBatch: number;
    contextSize: number;
    supportsContext: boolean;
    targetLang: string;
    onFlush: (req: BatchRequest, channelId: string) => void;
}

export interface Batcher {
    add(msg: PendingMessage): void;
    recordContext(msg: PendingMessage): void;
    flushNow(): void;
    dispose(): void;
}

interface ChannelState {
    queue: PendingMessage[];
    context: { author: string; text: string }[];
    timer: ReturnType<typeof setTimeout> | null;
}

export function createBatcher(opts: BatcherOptions): Batcher {
    const channels = new Map<string, ChannelState>();

    const stateFor = (channelId: string): ChannelState => {
        let s = channels.get(channelId);
        if (!s) {
            s = { queue: [], context: [], timer: null };
            channels.set(channelId, s);
        }
        return s;
    };

    const pushContext = (s: ChannelState, msg: PendingMessage) => {
        s.context.push({ author: msg.author, text: msg.text });
        if (s.context.length > opts.contextSize) {
            s.context.splice(0, s.context.length - opts.contextSize);
        }
    };

    const flushChannel = (channelId: string) => {
        const s = channels.get(channelId);
        if (!s) return;
        if (s.timer !== null) {
            clearTimeout(s.timer);
            s.timer = null;
        }
        if (s.queue.length === 0) return;

        const batch = s.queue.splice(0, s.queue.length);
        // Snapshot context BEFORE the batch's own messages join it.
        const context = opts.supportsContext ? [...s.context] : [];
        for (const m of batch) pushContext(s, m);

        opts.onFlush(
            {
                messages: batch.map(m => ({ id: m.id, author: m.author, text: m.text })),
                context,
                targetLang: opts.targetLang
            },
            channelId
        );
    };

    return {
        add(msg) {
            const s = stateFor(msg.channelId);
            s.queue.push(msg);

            if (s.queue.length >= opts.maxBatch) {
                flushChannel(msg.channelId);
                return;
            }
            if (s.timer === null) {
                s.timer = setTimeout(() => flushChannel(msg.channelId), opts.debounceMs);
            }
        },

        recordContext(msg) {
            pushContext(stateFor(msg.channelId), msg);
        },

        flushNow() {
            for (const channelId of [...channels.keys()]) flushChannel(channelId);
        },

        dispose() {
            for (const s of channels.values()) {
                if (s.timer !== null) clearTimeout(s.timer);
            }
            channels.clear();
        }
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/batcher.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/userplugins/vcTranslate/batcher.ts src/userplugins/vcTranslate/tests/batcher.test.ts
git commit -m "feat(vcTranslate): add per-channel debounced batcher with rolling context"
```

---

### Task 4: Google engine

**Files:**
- Create: `src/userplugins/vcTranslate/engines/google.ts`
- Create: `src/userplugins/vcTranslate/tests/google.test.ts`

**Interfaces:**
- Consumes: `BatchRequest`, `Result` from `types.ts`.
- Produces: `translateWithGoogle(req: BatchRequest, fetchImpl?: typeof fetch): Promise<Result[]>`.

Google's free endpoint translates one string per request and has no concept of conversation, so this loops with a concurrency cap of 4. `fetchImpl` is injected purely so tests never touch the network.

The response is an untyped nested array — `[[["translated","original",...]],null,"pt",...]`. Detected language is at index `[2]`. It is unversioned and may change shape without notice, so parsing is defensive and any surprise is treated as an ordinary failure.

- [ ] **Step 1: Write the failing test**

`tests/google.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { translateWithGoogle } from "../engines/google";
import type { BatchRequest } from "../types";

const req = (texts: string[]): BatchRequest => ({
    messages: texts.map((t, i) => ({ id: String(i), author: "a", text: t })),
    context: [],
    targetLang: "en"
});

const okResponse = (translated: string, detected: string) => ({
    ok: true,
    json: async () => [[[translated, "orig", null, null, 10]], null, detected]
});

describe("translateWithGoogle", () => {
    it("maps a translated message to a Result", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse("let's go", "es"));
        const [result] = await translateWithGoogle(req(["vamos"]), fetchImpl as any);
        expect(result).toEqual({ id: "0", lang: "es", text: "let's go", skip: false });
    });

    it("marks messages already in the target language as skipped", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse("hello", "en"));
        const [result] = await translateWithGoogle(req(["hello"]), fetchImpl as any);
        expect(result).toEqual({ id: "0", skip: true });
    });

    it("joins multi-segment translations", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [[["one ", "a"], ["two", "b"]], null, "de"]
        });
        const [result] = await translateWithGoogle(req(["eins zwei"]), fetchImpl as any);
        expect(result).toEqual({ id: "0", lang: "de", text: "one two", skip: false });
    });

    it("translates every message in the batch", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse("x", "fr"));
        const results = await translateWithGoogle(req(["a", "b", "c"]), fetchImpl as any);
        expect(results).toHaveLength(3);
        expect(results.map(r => r.id)).toEqual(["0", "1", "2"]);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("throws when the endpoint returns a non-OK status", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
        await expect(translateWithGoogle(req(["hola"]), fetchImpl as any)).rejects.toThrow();
    });

    it("throws on an unexpected response shape rather than returning garbage", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ error: "nope" }) });
        await expect(translateWithGoogle(req(["hola"]), fetchImpl as any)).rejects.toThrow();
    });

    it("url-encodes the message text", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse("hi", "es"));
        await translateWithGoogle(req(["a&b c?"]), fetchImpl as any);
        const url = fetchImpl.mock.calls[0][0] as string;
        expect(url).toContain(encodeURIComponent("a&b c?"));
    });

    it("throws when the detected-language field is not a string", async () => {
        // Segments are valid but body[2] is a number. Without the shape guard
        // this returns a Result with lang=123 instead of throwing, i.e. bogus
        // data rendered as a real translation.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [[["hola", "orig"]], null, 123]
        });
        await expect(translateWithGoogle(req(["x"]), fetchImpl as any)).rejects.toThrow();
    });

    it("throws when the segments array is missing", async () => {
        // body[0] is null rather than an array of segments.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [null, null, "es"]
        });
        await expect(translateWithGoogle(req(["x"]), fetchImpl as any)).rejects.toThrow();
    });

    it("throws when the response is an object rather than an array", async () => {
        // A numeric-keyed object satisfies body[0] and body[2] but is not the
        // array wrapper the endpoint contracts for. Without the Array.isArray(body)
        // guard this returns a bogus translation instead of throwing.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => JSON.parse('{"0":[["hola","orig"]],"2":"es"}')
        });
        await expect(translateWithGoogle(req(["x"]), fetchImpl as any)).rejects.toThrow();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/google.test.ts`
Expected: FAIL — cannot resolve `../engines/google`.

- [ ] **Step 3: Implement `engines/google.ts`**

```ts
import type { BatchRequest, Result } from "../types";

const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const CONCURRENCY = 4;

async function translateOne(
    msg: { id: string; text: string },
    targetLang: string,
    fetchImpl: typeof fetch
): Promise<Result> {
    const url =
        `${ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}` +
        `&dt=t&q=${encodeURIComponent(msg.text)}`;

    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`google: HTTP ${res.status}`);

    const body = await res.json();
    // Expected: [[["translated","original",...], ...], null, "<detected lang>"]
    if (!Array.isArray(body) || !Array.isArray(body[0]) || typeof body[2] !== "string") {
        throw new Error("google: unexpected response shape");
    }

    const detected = body[2] as string;
    if (detected === targetLang) return { id: msg.id, skip: true };

    const text = (body[0] as unknown[])
        .map(seg => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
        .join("")
        .trim();

    if (text.length === 0) throw new Error("google: empty translation");

    return { id: msg.id, lang: detected, text, skip: false };
}

export async function translateWithGoogle(
    req: BatchRequest,
    fetchImpl: typeof fetch = fetch
): Promise<Result[]> {
    const results: Result[] = [];
    for (let i = 0; i < req.messages.length; i += CONCURRENCY) {
        const slice = req.messages.slice(i, i + CONCURRENCY);
        const settled = await Promise.all(
            slice.map(m => translateOne(m, req.targetLang, fetchImpl))
        );
        results.push(...settled);
    }
    return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/google.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/userplugins/vcTranslate/engines/google.ts src/userplugins/vcTranslate/tests/google.test.ts
git commit -m "feat(vcTranslate): add Google free-endpoint translation engine"
```

---

### Task 5: Claude engine

**Files:**
- Create: `src/userplugins/vcTranslate/engines/claude.ts`
- Create: `src/userplugins/vcTranslate/tests/claude.test.ts`

**Interfaces:**
- Consumes: `BatchRequest`, `Result` from `types.ts`.
- Produces: `buildPrompt(req: BatchRequest): string`, `parseClaudeResponse(body: unknown, req: BatchRequest): Result[]`, and `translateWithClaude(req: BatchRequest, apiKey: string, fetchImpl?: typeof fetch): Promise<Result[]>`.

`buildPrompt` and `parseClaudeResponse` are exported separately so both are directly testable without mocking a full HTTP round trip.

This uses **structured outputs** (`output_config.format`) so the model returns schema-valid JSON rather than prose that needs regex-scraping. Every schema field is `required` — structured outputs handle optional fields poorly — so a skipped message is expressed as `skip: true` with an empty `text`.

- [ ] **Step 1: Write the failing test**

`tests/claude.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildPrompt, parseClaudeResponse, translateWithClaude } from "../engines/claude";
import type { BatchRequest } from "../types";

const req: BatchRequest = {
    messages: [
        { id: "10", author: "kenji", text: "今日はやめとく" },
        { id: "11", author: "ana", text: "ok cool" }
    ],
    context: [{ author: "sam", text: "are we playing tonight?" }],
    targetLang: "en"
};

const apiResponse = (payload: unknown) => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] })
});

describe("buildPrompt", () => {
    it("includes every message with its id and author", () => {
        const prompt = buildPrompt(req);
        expect(prompt).toContain("今日はやめとく");
        expect(prompt).toContain("kenji");
        expect(prompt).toContain("10");
    });

    it("includes context messages", () => {
        expect(buildPrompt(req)).toContain("are we playing tonight?");
    });

    it("names the target language", () => {
        expect(buildPrompt(req)).toContain("en");
    });

    it("omits the context section entirely when there is none", () => {
        const prompt = buildPrompt({ ...req, context: [] });
        expect(prompt).not.toContain("Recent conversation");
    });
});

describe("parseClaudeResponse", () => {
    it("maps translations and skips", () => {
        const body = {
            content: [{
                type: "text",
                text: JSON.stringify({
                    translations: [
                        { id: "10", lang: "ja", text: "I'll skip today", skip: false },
                        { id: "11", lang: "en", text: "", skip: true }
                    ]
                })
            }]
        };
        expect(parseClaudeResponse(body, req)).toEqual([
            { id: "10", lang: "ja", text: "I'll skip today", skip: false },
            { id: "11", skip: true }
        ]);
    });

    it("drops entries whose id was not in the request", () => {
        const body = {
            content: [{
                type: "text",
                text: JSON.stringify({
                    translations: [
                        { id: "10", lang: "ja", text: "ok", skip: false },
                        { id: "999", lang: "ja", text: "hallucinated", skip: false }
                    ]
                })
            }]
        };
        expect(parseClaudeResponse(body, req).map(r => r.id)).toEqual(["10"]);
    });

    it("throws when the response contains no text block", () => {
        expect(() => parseClaudeResponse({ content: [] }, req)).toThrow();
    });

    it("throws when the text block is not valid JSON", () => {
        const body = { content: [{ type: "text", text: "sorry, I can't" }] };
        expect(() => parseClaudeResponse(body, req)).toThrow();
    });

    it("throws when translations is missing", () => {
        const body = { content: [{ type: "text", text: JSON.stringify({ nope: [] }) }] };
        expect(() => parseClaudeResponse(body, req)).toThrow();
    });
});

describe("translateWithClaude", () => {
    it("sends the correct model, headers, and no effort/thinking params", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            apiResponse({ translations: [{ id: "10", lang: "ja", text: "ok", skip: false }] })
        );
        await translateWithClaude(req, "sk-test", fetchImpl as any);

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe("https://api.anthropic.com/v1/messages");
        expect(init.headers["x-api-key"]).toBe("sk-test");
        expect(init.headers["anthropic-version"]).toBe("2023-06-01");

        const sent = JSON.parse(init.body);
        expect(sent.model).toBe("claude-haiku-4-5");
        expect(sent.output_config.format.type).toBe("json_schema");
        expect(sent).not.toHaveProperty("thinking");
        expect(sent.output_config).not.toHaveProperty("effort");
    });

    it("throws on a non-OK status", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 401, text: async () => "unauthorized"
        });
        await expect(translateWithClaude(req, "bad", fetchImpl as any)).rejects.toThrow(/401/);
    });

    it("never includes the api key in a thrown error", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 401, text: async () => "unauthorized"
        });
        await expect(translateWithClaude(req, "sk-secret-value", fetchImpl as any))
            .rejects.toThrow(expect.not.stringContaining("sk-secret-value") as any);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/claude.test.ts`
Expected: FAIL — cannot resolve `../engines/claude`.

- [ ] **Step 3: Implement `engines/claude.ts`**

```ts
import type { BatchRequest, Result } from "../types";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";

const SCHEMA = {
    type: "object",
    properties: {
        translations: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    lang: { type: "string" },
                    text: { type: "string" },
                    skip: { type: "boolean" }
                },
                required: ["id", "lang", "text", "skip"],
                additionalProperties: false
            }
        }
    },
    required: ["translations"],
    additionalProperties: false
} as const;

export function buildPrompt(req: BatchRequest): string {
    const parts: string[] = [];

    parts.push(
        `You are translating a live gaming voice-chat conversation into ${req.targetLang}.`,
        "",
        "Rules:",
        `- Translate each message into ${req.targetLang}.`,
        `- If a message is already in ${req.targetLang}, set skip to true and text to "".`,
        "- Preserve the casual register. Slang stays slang; do not formalise it.",
        "- Leave usernames, game terms, and custom emote names untranslated.",
        "- Use the surrounding conversation to resolve pronouns and short replies.",
        "- Set lang to the BCP-47 code of the message's original language.",
        "- Return exactly one entry per message id given, and no other ids.",
        ""
    );

    if (req.context.length > 0) {
        parts.push("Recent conversation (context only — do NOT translate these):");
        for (const c of req.context) parts.push(`${c.author}: ${c.text}`);
        parts.push("");
    }

    parts.push("Messages to translate:");
    for (const m of req.messages) {
        parts.push(`[id=${m.id}] ${m.author}: ${m.text}`);
    }

    return parts.join("\n");
}

export function parseClaudeResponse(body: unknown, req: BatchRequest): Result[] {
    const content = (body as { content?: unknown[] })?.content;
    if (!Array.isArray(content)) throw new Error("claude: missing content");

    const textBlock = content.find(
        b => (b as { type?: string })?.type === "text"
    ) as { text?: string } | undefined;

    if (typeof textBlock?.text !== "string") throw new Error("claude: no text block in response");

    let parsed: unknown;
    try {
        parsed = JSON.parse(textBlock.text);
    } catch {
        throw new Error("claude: response was not valid JSON");
    }

    const rows = (parsed as { translations?: unknown })?.translations;
    if (!Array.isArray(rows)) throw new Error("claude: missing translations array");

    const validIds = new Set(req.messages.map(m => m.id));
    const results: Result[] = [];

    for (const row of rows) {
        const r = row as { id?: unknown; lang?: unknown; text?: unknown; skip?: unknown };
        if (typeof r.id !== "string" || !validIds.has(r.id)) continue;
        if (r.skip === true) {
            results.push({ id: r.id, skip: true });
            continue;
        }
        if (typeof r.lang !== "string" || typeof r.text !== "string" || r.text.trim() === "") continue;
        results.push({ id: r.id, lang: r.lang, text: r.text, skip: false });
    }

    return results;
}

export async function translateWithClaude(
    req: BatchRequest,
    apiKey: string,
    fetchImpl: typeof fetch = fetch
): Promise<Result[]> {
    const res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 2048,
            output_config: { format: { type: "json_schema", schema: SCHEMA } },
            messages: [{ role: "user", content: buildPrompt(req) }]
        })
    });

    if (!res.ok) {
        // Deliberately does not include the request body or key.
        throw new Error(`claude: HTTP ${res.status}`);
    }

    return parseClaudeResponse(await res.json(), req);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/claude.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/userplugins/vcTranslate/engines/claude.ts src/userplugins/vcTranslate/tests/claude.test.ts
git commit -m "feat(vcTranslate): add Claude Haiku engine with structured output"
```

---

### Task 6: Native bridge with retry and backoff

**Files:**
- Create: `src/userplugins/vcTranslate/native.ts`
- Create: `src/userplugins/vcTranslate/retry.ts`
- Create: `src/userplugins/vcTranslate/tests/retry.test.ts`

**Interfaces:**
- Consumes: `translateWithGoogle`, `translateWithClaude`, `EngineId`, `BatchRequest`, `Result`.
- Produces: `withRetry<T>(fn: () => Promise<T>, opts: { retries: number; delayMs: number; sleep?: (ms: number) => Promise<void> }): Promise<T>` from `retry.ts`; and the native entry point
  `translateBatch(_: IpcMainInvokeEvent, engine: EngineId, apiKey: string, reqJson: string): Promise<{ ok: true; results: Result[] } | { ok: false; error: string; retryAfterMs?: number }>`.

The native function returns a result object rather than throwing — IPC serialises poorly across process boundaries, and every Vencord native module follows this convention.

`BatchRequest` crosses the IPC boundary as a JSON string to avoid structured-clone surprises.

- [ ] **Step 1: Write the failing test for retry**

`tests/retry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../retry";

const noSleep = () => Promise.resolve();

describe("withRetry", () => {
    it("returns the value when the first attempt succeeds", async () => {
        const fn = vi.fn().mockResolvedValue("ok");
        await expect(withRetry(fn, { retries: 1, delayMs: 10, sleep: noSleep })).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries once and succeeds on the second attempt", async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValue("ok");
        await expect(withRetry(fn, { retries: 1, delayMs: 10, sleep: noSleep })).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it("gives up after exhausting retries and rethrows the last error", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("always fails"));
        await expect(withRetry(fn, { retries: 2, delayMs: 10, sleep: noSleep }))
            .rejects.toThrow("always fails");
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("waits between attempts", async () => {
        const sleep = vi.fn().mockResolvedValue(undefined);
        const fn = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("ok");
        await withRetry(fn, { retries: 1, delayMs: 1000, sleep });
        expect(sleep).toHaveBeenCalledWith(1000);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/retry.test.ts`
Expected: FAIL — cannot resolve `../retry`.

- [ ] **Step 3: Implement `retry.ts`**

```ts
const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: { retries: number; delayMs: number; sleep?: (ms: number) => Promise<void> }
): Promise<T> {
    const sleep = opts.sleep ?? defaultSleep;
    let lastError: unknown;

    for (let attempt = 0; attempt <= opts.retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < opts.retries) await sleep(opts.delayMs);
        }
    }
    throw lastError;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/retry.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Implement `native.ts`**

No test file — this module is a thin dispatcher whose two branches are already covered by Tasks 4, 5, and the retry suite. It is verified in the Task 10 manual pass.

```ts
import type { IpcMainInvokeEvent } from "electron";

import { translateWithClaude } from "./engines/claude";
import { translateWithGoogle } from "./engines/google";
import { withRetry } from "./retry";
import type { BatchRequest, EngineId, Result } from "./types";

export type NativeResponse =
    | { ok: true; results: Result[] }
    | { ok: false; error: string; retryAfterMs?: number };

export async function translateBatch(
    _: IpcMainInvokeEvent,
    engine: EngineId,
    apiKey: string,
    reqJson: string
): Promise<NativeResponse> {
    let req: BatchRequest;
    try {
        req = JSON.parse(reqJson) as BatchRequest;
    } catch {
        return { ok: false, error: "bad request payload" };
    }

    try {
        const results = await withRetry(
            () =>
                engine === "claude"
                    ? translateWithClaude(req, apiKey)
                    : translateWithGoogle(req),
            { retries: 1, delayMs: 1000 }
        );
        return { ok: true, results };
    } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        // Surface rate limiting so the renderer can pause the queue.
        const retryAfterMs = /\b429\b/.test(message) ? 30_000 : undefined;
        return { ok: false, error: message, retryAfterMs };
    }
}
```

- [ ] **Step 6: Run the full suite to confirm nothing regressed**

Run: `npx vitest run`
Expected: PASS — all suites from Tasks 1–6.

- [ ] **Step 7: Commit**

```bash
git add src/userplugins/vcTranslate/native.ts src/userplugins/vcTranslate/retry.ts src/userplugins/vcTranslate/tests/retry.test.ts
git commit -m "feat(vcTranslate): add native IPC bridge with retry and rate-limit signalling"
```

---

### Task 7: Settings and per-channel enablement

**Files:**
- Create: `src/userplugins/vcTranslate/settings.ts`
- Create: `src/userplugins/vcTranslate/channels.ts`

**Interfaces:**
- Consumes: `EngineId` from `types.ts`.
- Produces: default-exported `settings` from `settings.ts` with `settings.store.{engine, anthropicApiKey, targetLang, catchUpCount, globalAuto}`; and from `channels.ts`: `loadEnabledChannels(): Promise<void>`, `isChannelEnabled(id: string): boolean`, `toggleChannel(id: string): Promise<boolean>`.

`channels.ts` keeps an in-memory `Set` for synchronous reads (the accessory renderer and the Flux handler are both hot paths and cannot await), and persists to Vencord's `DataStore` asynchronously.

- [ ] **Step 1: Implement `settings.ts`**

```ts
import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    engine: {
        type: OptionType.SELECT,
        description: "Translation engine",
        options: [
            { label: "Google (free, no key, lower quality)", value: "google", default: true },
            { label: "Claude Haiku (needs API key, best quality)", value: "claude" }
        ]
    },
    anthropicApiKey: {
        type: OptionType.STRING,
        description: "Anthropic API key (only used when the Claude engine is selected)",
        default: "",
        placeholder: "sk-ant-..."
    },
    targetLang: {
        type: OptionType.STRING,
        description: "Target language code",
        default: "en"
    },
    catchUpCount: {
        type: OptionType.SLIDER,
        description: "How many recent messages to translate when opening an enabled channel",
        markers: [0, 10, 20, 30, 50],
        default: 20,
        stickToMarkers: true
    },
    globalAuto: {
        type: OptionType.BOOLEAN,
        description: "Auto-translate every channel (otherwise use the per-channel globe button)",
        default: false
    }
});

export default settings;
```

- [ ] **Step 2: Implement `channels.ts`**

```ts
import * as DataStore from "@api/DataStore";

const KEY = "VcTranslate_enabledChannels";

let enabled = new Set<string>();

export async function loadEnabledChannels(): Promise<void> {
    const stored = await DataStore.get<string[]>(KEY);
    enabled = new Set(stored ?? []);
}

export function isChannelEnabled(id: string): boolean {
    return enabled.has(id);
}

export async function toggleChannel(id: string): Promise<boolean> {
    if (enabled.has(id)) enabled.delete(id);
    else enabled.add(id);

    await DataStore.set(KEY, [...enabled]);
    return enabled.has(id);
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .` from the Vencord root.
Expected: no errors from `src/userplugins/vcTranslate/`.

- [ ] **Step 4: Commit**

```bash
git add src/userplugins/vcTranslate/settings.ts src/userplugins/vcTranslate/channels.ts
git commit -m "feat(vcTranslate): add plugin settings and per-channel enablement"
```

---

### Task 8: Plugin shell — Flux hook and subtitle rendering

**Files:**
- Create: `src/userplugins/vcTranslate/index.tsx`

**Interfaces:**
- Consumes: everything produced by Tasks 1–7.
- Produces: the default-exported plugin object. `VencordNative.pluginHelpers.VcTranslate` becomes available once `name: "VcTranslate"` is registered.

This is the Discord-coupled shell. It is deliberately thin — it wires modules together and contains no translation logic of its own.

- [ ] **Step 1: Implement `index.tsx`**

Note the `effectiveEngine()` indirection. The spec requires that a missing or
rejected Claude key falls back to Google **for the session** rather than leaving
you staring at untranslated text. Because the cache key includes the engine,
every read and write must go through the same effective value — otherwise a
fallback would write under `google` and the accessory would read under `claude`
and never find it.

```tsx
import definePlugin, { PluginNative } from "@utils/types";
import { FluxDispatcher, React, Toasts, UserStore } from "@webpack/common";
import type { Message } from "@vencord/discord-types";

import { createBatcher, type Batcher } from "./batcher";
import { isChannelEnabled, loadEnabledChannels } from "./channels";
import settings from "./settings";
import { shouldSkip } from "./skip";
import {
    getTranslation, invalidateMessage, makeKey,
    setTranslation, subscribe, type StoredTranslation
} from "./store";
import { ENGINE_CAPS, type EngineId, type PendingMessage } from "./types";

const Native = VencordNative.pluginHelpers.VcTranslate as PluginNative<typeof import("./native")>;

let batcher: Batcher | null = null;
let pausedUntil = 0;
let sessionFallback = false;   // set when Claude is unusable this session

/** The engine actually in use — may differ from the configured one. */
function effectiveEngine(): EngineId {
    const configured = settings.store.engine as EngineId;
    if (configured !== "claude") return configured;
    if (sessionFallback || settings.store.anthropicApiKey.trim() === "") return "google";
    return "claude";
}

function channelActive(channelId: string): boolean {
    return settings.store.globalAuto || isChannelEnabled(channelId);
}

function fallBackToGoogle(reason: string) {
    if (sessionFallback) return;   // only announce once
    sessionFallback = true;
    Toasts.show({
        id: Toasts.genId(),
        type: Toasts.Type.FAILURE,
        message: `VcTranslate: ${reason}. Using Google for this session.`
    });
    rebuildBatcher();
}

function rebuildBatcher() {
    batcher?.dispose();
    const engine = effectiveEngine();

    batcher = createBatcher({
        debounceMs: 700,
        maxBatch: 10,
        contextSize: 8,
        supportsContext: ENGINE_CAPS[engine].supportsContext,
        targetLang: settings.store.targetLang,
        onFlush: async req => {
            if (Date.now() < pausedUntil) return;

            const res = await Native.translateBatch(
                engine,
                settings.store.anthropicApiKey,
                JSON.stringify(req)
            );

            if (!res.ok) {
                if (res.retryAfterMs) pausedUntil = Date.now() + res.retryAfterMs;

                // An auth failure means the key is wrong, not that the network
                // blipped — retrying it every batch would be pure noise.
                if (engine === "claude" && /\b40[13]\b/.test(res.error)) {
                    fallBackToGoogle("Claude rejected the API key");
                } else {
                    for (const m of req.messages) {
                        setTranslation(makeKey(m.id, req.targetLang, engine), { failed: true });
                    }
                }
                return;
            }

            for (const r of res.results) {
                if (r.skip) continue;
                setTranslation(
                    makeKey(r.id, req.targetLang, engine),
                    { lang: r.lang, text: r.text }
                );
            }
        }
    });
}

function onMessageCreate({ message, optimistic }: { message: Message; optimistic?: boolean; }) {
    if (optimistic || !message?.id) return;
    if (!channelActive(message.channel_id)) return;

    const pending: PendingMessage = {
        id: message.id,
        author: message.author?.username ?? "unknown",
        text: message.content ?? "",
        channelId: message.channel_id
    };

    const isOwn = message.author?.id === UserStore.getCurrentUser()?.id;

    // Skipped messages still shape the conversation, so they become context.
    if (shouldSkip(pending.text, isOwn)) batcher?.recordContext(pending);
    else batcher?.add(pending);
}

function onMessageUpdate({ message }: { message: Message; }) {
    if (message?.id) invalidateMessage(message.id);
}

function TranslationAccessory({ message }: { message: Message; }) {
    const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);

    React.useEffect(() => subscribe(forceUpdate), []);

    if (!channelActive(message.channel_id)) return null;

    const key = makeKey(message.id, settings.store.targetLang, effectiveEngine());
    const entry: StoredTranslation | undefined = getTranslation(key);
    if (!entry) return null;

    if ("failed" in entry) {
        return (
            <div style={{ fontSize: "0.8rem", opacity: 0.4, fontStyle: "italic" }}>
                ⚠ translation failed
            </div>
        );
    }

    return (
        <div style={{ fontSize: "0.9rem", opacity: 0.6, fontStyle: "italic" }}>
            ⤷ {entry.lang} · {entry.text}
        </div>
    );
}

export default definePlugin({
    name: "VcTranslate",
    description: "Automatically translates incoming messages and shows them as subtitles.",
    // This is a local userplugin — do not attribute it to a Vencord maintainer
    // via `Devs.*`. Put your own handle here.
    authors: [{ name: "surfer", id: 0n }],
    settings,

    renderMessageAccessory: ({ message }: { message: Message; }) => (
        <TranslationAccessory message={message} />
    ),

    async start() {
        await loadEnabledChannels();
        rebuildBatcher();
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onMessageUpdate);
        batcher?.dispose();
        batcher = null;
    }
});
```

- [ ] **Step 2: Build Vencord**

Run: `pnpm build` from the Vencord root.
Expected: build succeeds with no errors mentioning `vcTranslate`.

- [ ] **Step 3: Verify in Discord**

1. Restart Discord.
2. Settings → Plugins → enable **VcTranslate**.
3. Settings → VcTranslate → turn on **globalAuto** temporarily.
4. Have someone post a non-English message (or post one from a second account).
5. Confirm a dimmed italic subtitle appears beneath it within ~1 second.

- [ ] **Step 4: Commit**

```bash
git add src/userplugins/vcTranslate/index.tsx
git commit -m "feat(vcTranslate): add plugin shell with Flux hook and subtitle rendering"
```

---

### Task 9: Per-channel toggle button and catch-up on open

**Files:**
- Modify: `src/userplugins/vcTranslate/index.tsx`

**Interfaces:**
- Consumes: `toggleChannel`, `isChannelEnabled` from `channels.ts`; `MessageStore`, `SelectedChannelStore` from `@webpack/common`.
- Produces: no new exports.

Two behaviours: a globe button so the user does not have to leave the channel to enable translation, and a backlog pass so tabbing back in after a game shows the last N messages already translated.

- [ ] **Step 1: Add the catch-up handler**

Insert into `index.tsx`, after `onMessageUpdate`:

```tsx
function catchUp(channelId: string) {
    if (!channelActive(channelId)) return;

    const count = settings.store.catchUpCount;
    if (count <= 0) return;

    const all = MessageStore.getMessages(channelId)?.toArray?.() ?? [];
    const recent = all.slice(-count);
    const me = UserStore.getCurrentUser()?.id;
    const engine = effectiveEngine();

    for (const message of recent) {
        const key = makeKey(message.id, settings.store.targetLang, engine);
        if (getTranslation(key)) continue;   // already done, don't re-spend

        const pending: PendingMessage = {
            id: message.id,
            author: message.author?.username ?? "unknown",
            text: message.content ?? "",
            channelId
        };

        if (shouldSkip(pending.text, message.author?.id === me)) batcher?.recordContext(pending);
        else batcher?.add(pending);
    }
}

function onChannelSelect({ channelId }: { channelId: string; }) {
    if (channelId) catchUp(channelId);
}
```

- [ ] **Step 2: Add `MessageStore` to the webpack imports**

Change the `@webpack/common` import line to:

```tsx
import { FluxDispatcher, MessageStore, React, UserStore } from "@webpack/common";
```

- [ ] **Step 3: Subscribe and unsubscribe the handler**

In `start()`, after the existing subscriptions:

```tsx
FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
```

In `stop()`, alongside the others:

```tsx
FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect);
```

- [ ] **Step 4: Add the per-channel toggle to the message popover**

Vencord's `messagePopoverButton` is the lowest-risk place to hang this — it needs no component patching. Add to the plugin object, after `renderMessageAccessory`:

```tsx
    messagePopoverButton: {
        key: "vc-translate-toggle",
        icon: () => <span style={{ fontSize: "1rem" }}>🌐</span>,
        render(message: Message) {
            const on = channelActive(message.channel_id);
            return {
                label: on ? "Disable auto-translate here" : "Enable auto-translate here",
                icon: () => <span style={{ fontSize: "1rem" }}>{on ? "🌐" : "🌫"}</span>,
                message,
                channel: message.channel_id,
                onClick: async () => {
                    const nowOn = await toggleChannel(message.channel_id);
                    if (nowOn) catchUp(message.channel_id);
                }
            };
        }
    },
```

- [ ] **Step 5: Add `toggleChannel` to the channels import**

```tsx
import { isChannelEnabled, loadEnabledChannels, toggleChannel } from "./channels";
```

- [ ] **Step 6: Build and verify**

Run: `pnpm build`, then restart Discord.

1. Turn **globalAuto** back off.
2. Hover a message → click the 🌐 button → confirm the channel's backlog translates.
3. Switch away and back → confirm no duplicate API calls (translations appear instantly from cache).
4. Click 🌐 again → confirm subtitles disappear.

- [ ] **Step 7: Commit**

```bash
git add src/userplugins/vcTranslate/index.tsx
git commit -m "feat(vcTranslate): add per-channel toggle and catch-up on channel open"
```

---

### Task 10: Manual verification pass and README

**Files:**
- Create: `src/userplugins/vcTranslate/README.md`

**Interfaces:**
- Consumes: the finished plugin.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Run the full automated suite**

Run: `npx vitest run`
Expected: PASS — all suites from Tasks 1–6, zero skipped.

- [ ] **Step 2: Work the manual checklist**

Mark each line pass/fail. These are the paths no unit test covers because they cross into Discord.

| # | Check | Expected |
|---|---|---|
| 1 | Post a non-English message in an enabled channel | Subtitle appears within ~1s |
| 2 | Post an English message | No subtitle (skipped) |
| 3 | Post only an emote or a link | No subtitle, no API call |
| 4 | Post your own non-English message | No subtitle |
| 5 | Three people post at once in three languages | One batch; all three translate |
| 6 | Edit a translated message | Subtitle re-translates to match |
| 7 | Delete a translated message | Subtitle disappears with it |
| 8 | Scroll far up and back down | Subtitles persist, no re-translation |
| 9 | Switch engine Google → Claude in settings | New messages use Claude; old cached ones keep their engine's result |
| 10 | Select Claude with an **empty** API key | Silently uses Google; translations still appear, no toast |
| 11 | Select Claude with an **invalid** API key | One toast, then Google for the rest of the session; translations appear |
| 12 | Fix the key and restart Discord | Claude is used again (session fallback resets) |
| 13 | Disconnect network, post a message | `⚠ translation failed`, no popup, no console spam |
| 14 | Reconnect, post again | Translation resumes |
| 15 | Disable the plugin in settings | Subtitles stop; no console errors |
| 16 | Restart Discord | Enabled channels are remembered |

- [ ] **Step 3: Write the README**

`README.md`:

````markdown
# vcTranslate

Automatically translates incoming Discord messages and renders them as
subtitles beneath the original.

## Install

Requires a from-source Vencord checkout — userplugins do not work with the
stock installer.

```bash
# from the Vencord repo root
mkdir -p src/userplugins
cp -r /path/to/vcTranslate src/userplugins/
pnpm build
pnpm inject
```

Restart Discord, then enable **VcTranslate** in Settings → Plugins.

## Use

Hover any message → click 🌐 to enable auto-translate for that channel.
The choice persists across restarts. Settings → VcTranslate has a
`globalAuto` option to enable every channel at once.

## Engines

| Engine | Cost | Quality |
|---|---|---|
| Google (default) | free, no key | Poor on slang and short fragments; no conversation context |
| Claude Haiku | ~$2-3/month | Handles slang and mixed languages; uses conversation context |

To use Claude: create a key at console.anthropic.com, paste it into the
plugin settings, and switch the engine dropdown. **Scope the key to a
dedicated project with a spend limit** — it is stored in plaintext in
Vencord's settings, like every other Vencord credential.

## Privacy

Message text is sent to the selected translation provider. Google's free
endpoint is unofficial, with no data-processing agreement. This includes
other people's messages, not just your own.

## Tests

```bash
npx vitest run
```

## Limits

Incoming messages only. No outgoing translation, no voice, no DMs,
desktop app only.
````

- [ ] **Step 4: Commit**

```bash
git add src/userplugins/vcTranslate/README.md
git commit -m "docs(vcTranslate): add README and record manual verification pass"
```

---

## Notes for the implementer

**If `Native` is `undefined` at runtime** — the `name` in `definePlugin` does not match the `VencordNative.pluginHelpers.<Name>` key. They must be character-identical.

**If the accessory never appears** — check that the plugin is enabled *and* that `channelActive()` returns true. During bring-up, flip `globalAuto` on to eliminate the per-channel state as a variable.

**If translations appear but never update on edit** — `MESSAGE_UPDATE` fires for embed hydration too, so it can invalidate more often than expected. That is intentional (correctness over a few extra calls), but if it proves noisy, compare `message.content` against the cached original before invalidating.

**Do not add `effort` or `thinking` to the Claude request.** `effort` errors on Haiku 4.5, and thinking would add latency and cost for no quality gain on this task.
