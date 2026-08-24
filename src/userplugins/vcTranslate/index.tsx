import type { ChatBarProps } from "@api/ChatButtons";
import { addMessagePopoverButton, removeMessagePopoverButton } from "@api/MessagePopover";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { ChannelStore, FluxDispatcher, LocaleStore, MessageStore, React, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";
import type { Message } from "@vencord/discord-types";

import { createBatcher, type Batcher } from "./batcher";
import { isChannelEnabled, loadEnabledChannels, toggleChannel } from "./channels";
import { __resetCooldowns, cooldownUntil, loadCooldowns, setCooldown } from "./cooldownStore";
import { isConfidentlyTargetLanguage } from "./detectLang";
import {
    acquireSlot, loadRateGateTuning, rateGateAvailable, rateGateSettings, rateGateWaitMs,
    resetRateGate, tuneRateGateToObservedLimit, tuneRateGateToProviderBudget
} from "./rateGate";
import { isRomanizedGuess } from "./romanized";
import settings from "./settings";
import { onSettingsChanged } from "./settingsBridge";
import { shouldSkip } from "./skip";
import {
    recordError, recordPluginLoaded, recordRendered, recordTranslation, resetStatusBeacon
} from "./statusBeacon";
import type { BeaconErrorCode } from "./statusShape";
import {
    clearStore, getTranslation, invalidateMessage, loadPersistedTranslations, makeKey,
    setTranslation, subscribe, type StoredTranslation
} from "./store";
import {
    ENGINE_CAPS, FAST_DEBOUNCE_MS, FAST_MAX_BATCH, MIN_DETECT_CONFIDENCE,
    QUALITY_DEBOUNCE_MS, QUALITY_MAX_BATCH, SHORT_TEXT_MAX,
    type BatchRequest, type EngineId, type PendingMessage
} from "./types";
import { ENGINE_RANK, isRealTranslation, mayReplace } from "./upgrade";

const Native = VencordNative.pluginHelpers.VcTranslate as PluginNative<typeof import("./native")>;
const logger = new Logger("VcTranslate");

// Two independent pipelines over the same messages. The fast one exists so the
// reader never sits in front of an untranslated message; the quality one
// exists so what they end up reading is right. Neither waits on the other.
let fastBatcher: Batcher | null = null;
let qualityBatcher: Batcher | null = null;
let sessionFallback = false;   // set when the configured LLM engine is unusable this session
/**
 * Which engine+key `sessionFallback` was set against.
 *
 * The pin exists so a rejected key is not retried every batch. But it used to
 * outlive the key itself: Vencord persists a settings field on every keystroke,
 * so a batch firing while a key is half-pasted gets a 401, pins the session,
 * and stays pinned after the correct key lands. The user is then left with a
 * valid key, no LLM calls, no error on screen, and — because `effectiveEngine()`
 * reports google — not even the quota indicator that would have hinted at it.
 *
 * Recording WHAT was rejected makes the pin mean "this credential is bad"
 * rather than "this session is bad", so changing the key or the engine lifts
 * it and nothing else does.
 */
let fallbackPinnedFor: string | null = null;

/**
 * Quality translations already produced this session, keyed by exact source
 * text and target language.
 *
 * TWO PROBLEMS, ONE MAP. A Persian greeting arrived twice in one conversation
 * and came back as "how are you guys?" once and "hello kids" the other time —
 * two answers to one question, in a chat where both were on screen together.
 * And the second answer cost a request the first had already paid for.
 *
 * Only LLM results go in. Google's are cheap enough that the round trip is not
 * worth avoiding, and its habit of echoing short or romanised text back
 * unchanged would poison the map with non-translations.
 *
 * Keyed on the EXACT string, so it can only ever fire on a genuine repeat.
 * That is deliberately conservative: the same words in a different
 * conversation could warrant a different reading, and this trades that
 * possibility away for consistency the reader can see.
 */
const qualityPhrases = new Map<string, StoredTranslation>();

/** Bounded: a long session in a busy server must not grow this without limit. */
const MAX_CACHED_PHRASES = 500;

function phraseKey(text: string, targetLang: string): string {
    return `${targetLang}\u0000${text.trim()}`;
}

function rememberPhrase(text: string, targetLang: string, value: StoredTranslation): void {
    if (!isRealTranslation(value)) return;
    if (ENGINE_RANK[value.via] < 1) return;   // quality tier only
    if (qualityPhrases.size >= MAX_CACHED_PHRASES) {
        // Oldest first — Map preserves insertion order, and a chat's repeats
        // cluster in time, so the recent end is the useful end.
        const oldest = qualityPhrases.keys().next();
        if (!oldest.done) qualityPhrases.delete(oldest.value);
    }
    qualityPhrases.set(phraseKey(text, targetLang), value);
}
/** Why the pin was set, so the indicator does not have to guess. */
let fallbackKind: FallbackKind = "key";
let announcedMissingKey = false;   // one toast per session, never per batch
let announcedCooldown = false;     // ditto, for a rate-limited quality tier

// Ids currently queued in a batcher or awaiting a translateBatch response.
// getTranslation() alone can't tell "in flight" apart from "never
// requested" -- a message is a cache miss for the WHOLE round trip (its
// tier's debounce window, 700ms fast / 20s quality, plus several seconds of
// network for an LLM), not just briefly.
// Populated wherever a message is handed to batcher.add(), and drained in
// runTier once that request settles (success, failure, or stranded by a
// rebuild) so it becomes retryable again.
//
// Per tier, because a message is legitimately in flight on both at once. A
// single shared set would let whichever tier queued first silently suppress
// the other — the quality tier would simply never run.
const inFlightFast = new Set<string>();
const inFlightQuality = new Set<string>();

/**
 * Ids currently out on the MANUAL ⚡ force-quality path, purely so
 * `TranslationAccessory` can show a `⚡ translating…` hint while one is
 * outstanding. Deliberately NOT the same thing as `inFlightQuality` above:
 * that set also covers the automatic quality tier (live chat, catch-up),
 * and this indicator is scoped to the manual click only — the fast tier
 * lands in about a second and an indicator under every incoming message
 * would be noise, not help.
 *
 * Deliberately NOT written into the translation store either. store.ts's
 * `StoredTranslation` union is four RESOLVED states that catch-up's
 * cache-hit check depends on; a `{ translating: true }` entry would be a
 * fifth, transient one that persistence, the upgrade rule and every reader
 * of that union would have to be taught to ignore. This is UI-only, ephemeral
 * state, so it gets its own set and its own listeners — mirroring store.ts's
 * subscribe()/notify shape (a Set of no-arg callbacks, notified after every
 * mutation) rather than reusing the store's own subscribe(), which is exactly
 * what would put this inside the union it is being kept out of.
 */
const forcedInFlight = new Set<string>();
const forcedInFlightListeners = new Set<() => void>();

function notifyForcedInFlight(): void {
    for (const fn of forcedInFlightListeners) fn();
}

/** Mirrors store.ts's subscribe(): add a listener, get back its unsubscribe. */
function subscribeForcedInFlight(fn: () => void): () => void {
    forcedInFlightListeners.add(fn);
    return () => forcedInFlightListeners.delete(fn);
}

/** Whether THIS message has a manual ⚡ request outstanding right now. */
function isForcedInFlight(messageId: string): boolean {
    return forcedInFlight.has(messageId);
}

/**
 * Why the manual ⚡ click gets a self-reported failure hint and the batched
 * pipeline never does — see runTier's own comment for the reasoning ("a
 * quality failure is invisible by design"). That silence is correct for an
 * AUTOMATIC batch: nothing the reader did caused it, and an error marker
 * would take away a readable Google line for information they cannot act on.
 * A manual click is different — the user spent a scarce request on purpose,
 * and "translating…" flashing then vanishing into silence reads as a bug,
 * not as nothing having happened.
 *
 * Three kinds because the remedy differs: `cooldown` and `gate` both mean
 * the request never left the client at all (wait a moment and try again);
 * `failed` means it went out and the engine itself rejected or failed it
 * (something is actually wrong). `code` is only ever a `BeaconErrorCode` — a
 * closed set of categories, the same ones the beacon already uses — never
 * the engine's own error text, which can echo back translated message
 * content and must never reach the DOM.
 */
type ForcedHint =
    | { kind: "cooldown" }
    | { kind: "gate" }
    | { kind: "failed"; code: BeaconErrorCode };

// How long a failure hint stays on screen before it clears itself. Long
// enough to read, short enough that it cannot be mistaken for a permanent
// marker — and it never becomes one: nothing here is ever written through
// setTranslation/writeResult, so it cannot outlive this module's memory.
// Exported so tests can advance exactly this long rather than hardcoding a
// duplicate of the constant.
export const FORCED_HINT_TTL_MS = 5_000;

const forcedHints = new Map<string, ForcedHint>();
const forcedHintTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Records (and self-expires) the hint for one message's most recent manual
 * click. Replaces rather than stacks: a second click's outcome always wins
 * over whatever the first left behind. Notifies over the SAME channel
 * `forcedInFlight` uses (see its own doc for why this reuses rather than
 * duplicates that pub/sub) — one subscription in TranslationAccessory
 * already covers both.
 */
function setForcedHint(messageId: string, hint: ForcedHint): void {
    const existingTimer = forcedHintTimers.get(messageId);
    if (existingTimer !== undefined) clearTimeout(existingTimer);
    forcedHints.set(messageId, hint);
    forcedHintTimers.set(messageId, setTimeout(() => {
        forcedHintTimers.delete(messageId);
        forcedHints.delete(messageId);
        notifyForcedInFlight();
    }, FORCED_HINT_TTL_MS));
    notifyForcedInFlight();
}

/**
 * Called at the START of every fresh manual click, so a hint left over from
 * an EARLIER click on this same message cannot linger alongside — or
 * outlive — this one.
 */
function clearForcedHint(messageId: string): void {
    const existingTimer = forcedHintTimers.get(messageId);
    if (existingTimer !== undefined) clearTimeout(existingTimer);
    forcedHintTimers.delete(messageId);
    forcedHints.delete(messageId);
}

/** What TranslationAccessory shows for THIS message's manual ⚡ hint, if anything. */
function forcedHintFor(messageId: string): ForcedHint | undefined {
    return forcedHints.get(messageId);
}

/**
 * Store keys the quality tier has already SPENT A REQUEST on this session.
 *
 * THE BUG THIS EXISTS FOR: a quality-tier failure deliberately writes nothing
 * (see runTier) so the reader keeps their Google line. But that means the store
 * looks exactly as it did before the request — a `via: "google"` entry, which
 * needsQuality() correctly reads as "still upgradable". Nothing else remembered
 * the attempt, so every later catch-up offered the same message to the LLM
 * again: four CHANNEL_SELECTs produced four Gemini requests for one message,
 * and scrolling up (LOAD_MESSAGES_SUCCESS also drives catch-up) did the same.
 * A message the model routinely omits from a 25-message batch — llmShared.ts
 * marks those `failed` per id — could be re-requested forever, spending exactly
 * the quota the two-tier split exists to conserve.
 *
 * THE RULE: the quality tier gets ONE request per message per session. The
 * ledger is written at the moment the request is actually sent (not when it
 * fails), because the thing being bounded is REQUESTS SPENT — a flush that
 * returns early for a cooldown, a stale generation or the rate gate has cost
 * nothing and must stay retryable. A success needs no ledger entry to stop
 * repeating (its store write closes the message on its own), but marking it
 * anyway keeps the invariant one sentence long instead of two.
 *
 * THE TRADE-OFF, taken deliberately: a message whose one attempt failed
 * transiently never gets its ✦ this session. That costs the reader an
 * occasional missed upgrade, which is invisible — the readable ≈ line is still
 * there. Retrying instead costs the quota, which is not invisible: it takes the
 * quality tier down for every OTHER message too. A restart, or an edit (see
 * forgetQualityAttempts), is the natural retry point.
 *
 * In memory only, and deliberately not persisted: the store entry it qualifies
 * is what persists, and a new session is exactly the kind of natural retry
 * boundary a spent attempt should be forgotten at.
 */
const qualityAttempted = new Set<string>();

/**
 * The channel whose NEXT `LOAD_MESSAGES_SUCCESS` is still the initial backlog
 * landing rather than scroll-back. Armed by every entry point that means "the
 * user just opened this channel" (CHANNEL_SELECT, and start() for whatever is
 * already on screen); consumed by the first history load that follows.
 *
 * THE DEFECT THIS EXISTS FOR: `catchUp()`'s budget (`catchUpCount`, 20) is per
 * INVOCATION, and catch-up runs on every `LOAD_MESSAGES_SUCCESS` — which
 * Discord fires again and again as the user scrolls back through history. Each
 * scroll therefore got a fresh 20-message allowance and produced another
 * quality-tier batch of legitimately-new backlog. The `qualityAttempted` ledger
 * cannot help: it bounds re-attempts of the SAME message, and every one of
 * these is a different message. Measured against the live Gemini free tier the
 * ceiling is 20 requests per ROLLING MINUTE (probes returned retry hints of
 * 29.5s, then 56.7s, then 11.2s as the window drained), so a few hundred
 * messages of scroll-back spends the whole minute's quota in seconds — the
 * rate-limit toast reported right after a restart.
 *
 * THE RULE: the quality tier serves the LIVE conversation and the CHANNEL-OPEN
 * backlog; deep scroll-back is fast-tier only. That is where the LLM's context
 * advantage is worth quota and where it is not — history being skimmed still
 * gets its Google `≈` subtitle within a second, it simply never flips to `✦`.
 * Bounding it here rather than by lowering `catchUpCount` is deliberate: the
 * budget is what makes opening a channel useful, and that is the case worth
 * spending on.
 *
 * Holds at most one channel: only one channel is ever focused, and catch-up is
 * focus-gated, so a token for anything else could never be redeemed anyway.
 * Clearing on each arm is what keeps it that way rather than accumulating one
 * dead entry per channel visited this session.
 */
const initialHistoryPending = new Set<string>();

/**
 * "The user just opened this channel; the history that lands next is its
 * opening backlog, not scroll-back." See `initialHistoryPending`.
 */
function armInitialHistory(channelId: string): void {
    // Only one channel can be focused, so only one token can ever be redeemed.
    initialHistoryPending.clear();
    initialHistoryPending.add(channelId);
}

/**
 * True at most ONCE per channel open — the first history load after it was
 * armed. `CHANNEL_SELECT` fires before Discord has necessarily fetched a cold
 * channel's backlog, so that first load IS the channel-open catch-up (the "tab
 * back in after a game" case); every load after it is the user scrolling.
 */
function takeInitialHistory(channelId: string): boolean {
    return initialHistoryPending.delete(channelId);
}

/**
 * Same order of magnitude as the store's own 500-entry LRU, and for the same
 * reason: an id evicted from here is one the translation cache has almost
 * certainly forgotten too, so it reads as "never requested" on both sides at
 * once rather than as a half-remembered message that can never be upgraded.
 */
const QUALITY_ATTEMPT_MEMORY = 500;

function markQualityAttempted(key: string): void {
    // Re-insert to refresh recency, exactly as store.ts's LRU does.
    qualityAttempted.delete(key);
    qualityAttempted.add(key);
    while (qualityAttempted.size > QUALITY_ATTEMPT_MEMORY) {
        qualityAttempted.delete(qualityAttempted.values().next().value as string);
    }
}

/**
 * Forget every attempt recorded for a message id, across target languages.
 *
 * Called next to invalidateMessage() — an edited message is a DIFFERENT text,
 * so the request already spent was spent on something that no longer exists.
 * Without this, editing a message the quality tier had already attempted would
 * leave it pinned to the fast tier's line forever. Same `"<id> "` prefix
 * discipline as invalidateMessage(), so message 7 does not match message 70.
 */
function forgetQualityAttempts(messageId: string): void {
    const prefix = `${messageId} `;
    for (const key of [...qualityAttempted]) {
        if (key.startsWith(prefix)) qualityAttempted.delete(key);
    }
}

// Bumped on every rebuildBatcher(). Each onFlush closure captures the
// generation it was created under; if a response lands after a later
// rebuild has already happened (settings changed mid-flight, or an LLM
// engine's auth failure triggered the Google fallback), the closure's
// `engine` is stale and writing under it would land under a key nobody reads
// (or clobber the new engine's cache with a translation from the old one).
let batcherGeneration = 0;

/**
 * The key-gated engines, keyed by the setting that holds their API key and the
 * label used in the "no key set" / "rejected the key" toasts. A lookup table
 * rather than an `engine === "claude" || engine === "gemini"` conditional in
 * every function below — this is the one place that has to know which engines
 * exist, so adding a key-gated engine is one new entry here rather than a
 * growing tangle of per-function branches. Adding Groq proved that: this row
 * and the settings fields it names were the whole of it.
 */
const LLM_ENGINES = {
    claude: { keySetting: "anthropicApiKey", label: "Anthropic" },
    gemini: { keySetting: "geminiApiKey", label: "Gemini" },
    groq: { keySetting: "groqApiKey", label: "Groq" }
} as const satisfies Record<
    string,
    { keySetting: "anthropicApiKey" | "geminiApiKey" | "groqApiKey"; label: string }
>;

type LlmEngineId = keyof typeof LLM_ENGINES;

/**
 * Asked of the table itself rather than of a hand-written list of ids, so the
 * table above stays the single place that knows which engines are key-gated —
 * a repeated `||` chain is exactly how a fourth engine would end up recognised
 * in some functions and silently not in others.
 */
function isLlmEngine(id: EngineId): id is LlmEngineId {
    return Object.prototype.hasOwnProperty.call(LLM_ENGINES, id);
}

/** The API key configured for a key-gated engine. */
function apiKeyFor(engine: LlmEngineId): string {
    return settings.store[LLM_ENGINES[engine].keySetting];
}

/**
 * The model name to send with a batch, or "" for an engine that has no such
 * setting (Google, and Claude — whose model is pinned in engines/claude.ts).
 *
 * Read at SEND time rather than captured when the batcher was built: a user
 * changing the model is almost always a user trying to escape a model that is
 * refusing them, and the next batch should already use the new one. "" means
 * "engine default" on the far side; the engine owns that fallback so the empty
 * string can never reach the wire as a model name.
 */
function modelFor(engine: EngineId): string {
    const configured = engine === "gemini"
        ? settings.store.geminiModel
        : engine === "groq"
            ? settings.store.groqModel
            : "";
    return typeof configured === "string" ? configured.trim() : "";
}

/** The engine actually in use — may differ from the configured one. */
function effectiveEngine(): EngineId {
    const configured = settings.store.engine as EngineId;
    if (!isLlmEngine(configured)) return configured;
    // An expired block lifts itself here rather than needing a settings change
    // or a restart, which is the difference between a transient network fault
    // and a wrong credential.
    if (sessionFallback && fallbackExpiresAt !== null && Date.now() >= fallbackExpiresAt) {
        sessionFallback = false;
        fallbackExpiresAt = null;
        fallbackPinnedFor = null;
        rebuildBatcher();
    }
    if (sessionFallback || apiKeyFor(configured).trim() === "") return "google";
    return configured;
}

/* ------------------------------------------------- LLM cooldown / fallback -- */

/**
 * Used only when a 429 arrives with no usable retry hint at all. Every real
 * Gemini 429 observed so far states its own delay in the error body, and
 * native.ts already substitutes 30s when an engine offers nothing, so this is
 * a third line of defence rather than the normal case.
 */
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Per-engine "do not send to this engine before <timestamp>".
 *
 * A TIMESTAMP, not a flag and not a timer: expiry is then a comparison that
 * every flush does for itself, so the engine resumes automatically the first
 * time a batch becomes due after the window closes. Nothing has to fire, be
 * cancelled on stop(), or be restarted by the user.
 *
 * Per engine rather than global because switching Gemini → Claude mid-cooldown
 * should use Claude immediately; Claude's quota has nothing to do with
 * Gemini's.
 *
 * PERSISTED (see cooldownStore.ts) rather than held only in module state: a
 * restart used to clear the mark, so every Discord launch inside a rate-limit
 * window spent a request rediscovering the limit and greeted the user with a
 * rate-limit toast before showing them anything.
 */
function isCoolingDown(engine: EngineId): boolean {
    return Date.now() < cooldownUntil(engine);
}

/** "45s" / "2m" — deliberately coarse; this is a toast, not a countdown. */
function formatDuration(ms: number): string {
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
    return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/**
 * "0:45" / "1:05" — a live countdown, unlike `formatDuration()`'s one-shot
 * toast wording. The quota indicator (see `QuotaIndicator` below) ticks once
 * a second while mounted, so this has to read as counting DOWN rather than
 * as a coarse "about how long" estimate.
 */
function formatCountdown(ms: number): string {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The last thing the PROVIDER itself said about our remaining allowance, for
 * the engine that said it.
 *
 * THE DEFECT THIS EXISTS FOR: the `✦ N` indicator used to show our own token
 * bucket and nothing else, so it could read `✦ 3` while the provider was
 * refusing instantly — the user clicks ⚡ on the strength of a number the
 * provider never agreed to and gets an immediate 429. Only an OpenAI-compatible
 * engine (Groq) reports this at all; Gemini and Claude say nothing on a
 * success, and for them everything below simply never fires.
 *
 * Not a Map keyed by engine: exactly one engine is ever configured at a time,
 * so a second entry could only ever be a stale reading for an engine nobody is
 * using — and `engine` is recorded here precisely so that a reading taken
 * before the user switched engines is discarded rather than shown against the
 * new one.
 */
interface ProviderQuotaReading {
    engine: LlmEngineId;
    remaining: number;
    /** When this was read, for the staleness check below. */
    observedAt: number;
    /** When the provider's window rolls over, if it said. */
    resetAt: number | null;
}

let providerQuota: ProviderQuotaReading | null = null;

/**
 * How long a provider reading is worth showing when the provider named no
 * reset time.
 *
 * A remaining count is a snapshot: it goes out of date as the window rolls and
 * as anything else on the same key spends. Sixty seconds is the shortest
 * window any of these providers rate-limits over, so a reading older than that
 * cannot still be describing the window it was taken in.
 */
const PROVIDER_QUOTA_MAX_AGE_MS = 60_000;

/**
 * Record what a successful response reported. Every field is re-validated
 * here rather than trusted: this arrives from a remote header, through IPC,
 * and a NaN or a negative would otherwise reach the indicator as a number the
 * user is asked to make a decision on.
 */
function recordProviderQuota(engine: LlmEngineId, reported: unknown): void {
    if (reported === null || typeof reported !== "object") return;
    const { remainingRequests, resetRequestsMs } = reported as {
        remainingRequests?: unknown;
        resetRequestsMs?: unknown;
    };
    // A reading with no remaining count says nothing this can use. Zero IS a
    // usable count — it is the single most important thing the provider can
    // tell us — so the guard is on type and sign, never on truthiness.
    if (typeof remainingRequests !== "number" || !Number.isFinite(remainingRequests)) return;
    if (remainingRequests < 0) return;

    const now = Date.now();
    const resetMs = typeof resetRequestsMs === "number"
        && Number.isFinite(resetRequestsMs)
        && resetRequestsMs > 0
        ? resetRequestsMs
        : null;

    providerQuota = {
        engine,
        remaining: remainingRequests,
        observedAt: now,
        resetAt: resetMs === null ? null : now + resetMs
    };
}

/**
 * The provider's own remaining count for this engine, if we have one worth
 * believing — otherwise undefined, which is the state Gemini and Claude are
 * permanently in.
 *
 * "Worth believing" is deliberately conservative, because a stale number here
 * is worse than no number: it is a confident wrong answer in a place the user
 * reads to decide whether to spend. So it must be for THIS engine, taken
 * recently, and from a window that has not since rolled over — once the
 * provider's window resets, the count we hold is a floor the provider has
 * already moved past, and showing it would understate what is available.
 *
 * `resetInMs` rides alongside `remaining` because a `remaining` of zero is
 * shown as a WAIT, not a bare zero (see `describeQuotaState`), and a wait
 * needs a duration. When the provider stated a real reset time that duration
 * IS the window closing. When it did not, the most honest duration this
 * function can offer is how much longer THIS READING stays trusted at all —
 * the distrust cutoff below — because past that point the reading is
 * discarded anyway and whatever the gate itself says takes over.
 */
function providerRemainingFor(
    engine: LlmEngineId
): { remaining: number; resetInMs: number } | undefined {
    const reading = providerQuota;
    if (reading === null || reading.engine !== engine) return undefined;
    const now = Date.now();
    if (reading.resetAt !== null) {
        if (now >= reading.resetAt) return undefined;
        return { remaining: reading.remaining, resetInMs: reading.resetAt - now };
    }
    const age = now - reading.observedAt;
    if (age > PROVIDER_QUOTA_MAX_AGE_MS) return undefined;
    return { remaining: reading.remaining, resetInMs: PROVIDER_QUOTA_MAX_AGE_MS - age };
}

/**
 * "Would an ⚡ click actually go through right now, for this engine — and if
 * not, for how long?" The single source both the chat-bar quota indicator and
 * the ⚡ popover label read from, so the two can never disagree about what
 * pressing ⚡ is about to do.
 *
 * WHAT CHANGED, AND WHY: this used to answer with a COUNT — how many requests
 * the plugin's own rate gate happened to be holding. A reader who did not
 * build this plugin has no way to know that number is an internal pacing
 * budget rather than the provider's own quota, and read `✦ 3` as "3 calls
 * remaining" — a reasonable reading of the glyph and number, and wrong. A
 * count also implies rationing, and on a generous quota there is nothing to
 * ration. What the reader can actually act on is READINESS: would ⚡ send
 * right now, and if not, how long until it would. That is what this returns.
 *
 * COOLDOWN TAKES PRIORITY on purpose: the rate gate can still be holding
 * tokens while the engine itself is parked after a 429 (the two are
 * independent — see `runTier`'s cooldown check, which runs BEFORE the gate is
 * ever asked), and "ready" would tell the user ⚡ works when clicking it would
 * actually do nothing.
 *
 * TWO LIMITS, AND READY REQUIRES CLEARING BOTH. `rateGateAvailable()` is a
 * PURE read of the gate this engine's requests actually go through. For an
 * engine that DOES report its own remaining count (see `providerRemainingFor`)
 * both limits are real and a request has to clear both, so readiness is
 * `gate > 0 && provider > 0`. That is what fixes the original defect: at gate
 * 3, provider 0, this now reports "not ready" — the truth — instead of a
 * count that implied otherwise. When no provider figure is known, only the
 * gate's answer matters, and the previous behaviour is untouched by
 * construction.
 *
 * `source` (only present when not ready, and not cooling) says WHICH limit is
 * binding, so the wait shown is the right one: the provider's own reset time
 * when the provider's figure is what is holding things up, the gate's own
 * refill wait otherwise. Ties go to `provider` only when its figure is the
 * smaller or equal one, because that is when it is the number actually doing
 * the work.
 */
function describeQuotaState(
    engine: LlmEngineId
): { cooling: true; remainingMs: number }
    | { cooling: false; ready: true }
    | { cooling: false; ready: false; remainingMs: number; source: "gate" | "provider" } {
    const remainingMs = cooldownUntil(engine) - Date.now();
    if (remainingMs > 0) return { cooling: true, remainingMs };

    const gate = rateGateAvailable();
    const provider = providerRemainingFor(engine);

    if (provider === undefined) {
        if (gate > 0) return { cooling: false, ready: true };
        return { cooling: false, ready: false, remainingMs: rateGateWaitMs(), source: "gate" };
    }

    if (Math.min(gate, provider.remaining) > 0) return { cooling: false, ready: true };

    const bindingIsProvider = provider.remaining <= gate;
    return {
        cooling: false,
        ready: false,
        remainingMs: bindingIsProvider ? provider.resetInMs : rateGateWaitMs(),
        source: bindingIsProvider ? "provider" : "gate"
    };
}

/**
 * A 429 from an LLM engine. Three things happen, in this order:
 *
 *  1. The engine is parked for as long as the API itself asked for. Retrying
 *     into a wall that just rejected us is how roughly half the observed API
 *     traffic became 429s; the point of this phase is to stop doing that.
 *  2. The rate gate is retuned if the response stated the real quota. See
 *     rateGate.ts — this is what stops the SAME 429 recurring once the
 *     cooldown lifts, so the cooldown stays close to what the API asked for
 *     rather than a padded guess. It is floored at the gate's refill interval
 *     (see below): the API's sub-second hint frees exactly one slot, which is
 *     not enough to be worth waking up for.
 *  3. The user is told, at most once per session.
 *
 * The batch that triggered this is NOT lost, and nothing has to re-send it:
 * the fast tier already translated these same messages through Google before
 * the LLM was ever asked. A rate-limited quality tier costs the reader
 * nothing but the upgrade.
 */
function enterCooldown(
    engine: LlmEngineId,
    retryAfterMs: number | undefined,
    quotaLimitPerMinute: number | undefined,
    quotaModel?: string
): void {
    const asked = typeof retryAfterMs === "number" && retryAfterMs > 0
        ? retryAfterMs
        : DEFAULT_COOLDOWN_MS;

    // Retune BEFORE flooring: the floor below is read off the gate, so a
    // response that states its quota should size the floor using the rate it
    // just taught us, not the one we were using when we broke it.
    if (typeof quotaLimitPerMinute === "number") {
        tuneRateGateToObservedLimit(quotaLimitPerMinute);
    }

    // The API's hint answers "when does ONE slot free up?" — 551ms in the
    // captured response, because that is when the oldest request ages out of
    // its rolling window. Taken literally that means: wait half a second, get
    // exactly one request through, and be rejected again. Repeated every
    // debounce window, that is the 429 treadmill this phase exists to stop.
    //
    // The floor is the gate's own refill interval rather than a constant,
    // because a cooldown shorter than that cannot change what actually
    // happens — the gate would withhold the token anyway — and because it
    // then tracks the retune above instead of needing its own tuning. The
    // retune is still what fixes the steady state; this only stops us
    // spending requests to relearn that during the transient.
    const cooldownMs = Math.max(asked, rateGateSettings().refillMs);
    setCooldown(engine, Date.now() + cooldownMs);

    announceCooldownOnce(engine, cooldownMs, quotaModel);
}

/**
 * Same one-toast-per-session discipline as announceMissingKeyOnce(): a
 * catch-up storm can enter cooldown on several batches in a row, and a toast
 * per batch would be worse than the problem it describes.
 *
 * TWO MESSAGES, because there are two genuinely different problems and they
 * arrive as the identical HTTP status.
 *
 *  - No model named: ordinary throttling. Wait it out; the ≈ line stands. This
 *    is the message that has always been shown.
 *  - A model named ("Quota exceeded for metric: ..., model: <name>"): the quota
 *    that was exceeded belongs to THAT MODEL. On a free-tier key that is
 *    usually not a rate at all — a model the key has no allowance for returns
 *    429 on the first request of a session and on every request thereafter, so
 *    waiting changes nothing and the ✦ upgrade never arrives. Days were lost to
 *    reading exactly that as throttling, so the model name and the setting that
 *    changes it go into the toast. See `geminiModel` in settings.ts.
 */
function announceCooldownOnce(
    engine: LlmEngineId, cooldownMs: number, quotaModel?: string
): void {
    if (announcedCooldown) return;
    announcedCooldown = true;
    const { label } = LLM_ENGINES[engine];

    const message = typeof quotaModel === "string" && quotaModel !== ""
        ? `VcTranslate: ${label} model "${quotaModel}" is over quota (429) — this model may `
        + "have no free-tier availability on your key. Change the model in VcTranslate "
        + "settings to try another. Translations are using Google (≈) meanwhile."
        : `VcTranslate: ${label} is rate limited — translations are using Google `
        + `(≈) for about ${formatDuration(cooldownMs)}.`;

    Toasts.show({ id: Toasts.genId(), type: Toasts.Type.FAILURE, message });
}

/**
 * Is this the channel the user is actually looking at?
 *
 * DEFINITION: "focused" means `SelectedChannelStore.getChannelId()` equals this
 * channel id AT THE MOMENT THE MESSAGE ARRIVES. Nothing is remembered, nothing
 * is debounced — a message that lands one tick after the user navigates away is
 * simply not enqueued.
 *
 * NOT HANDLED, deliberately: popped-out channels and second Discord windows.
 * SelectedChannelStore reports one id for the main window, so a message in a
 * popped-out channel the user is genuinely reading reads as unfocused here.
 * The cost of being wrong is bounded and small: that message is translated
 * LATER (when the channel is next opened and catch-up runs over the backlog),
 * never NEVER. Detecting popouts would mean depending on more Discord
 * internals than this is worth.
 *
 * This is intentionally orthogonal to `channelActive`: globalAuto decides WHICH
 * channels are eligible at all, focus decides which eligible channel is worth
 * spending the day's budget on right now. A restart with globalAuto on used to
 * fan catch-up out across every open channel before the user had read a single
 * message — the single largest source of wasted requests.
 */
function isFocusedChannel(channelId: string): boolean {
    return SelectedChannelStore.getChannelId() === channelId;
}

function channelActive(channelId: string): boolean {
    // An explicit per-channel opt-in always wins, including for DMs.
    if (isChannelEnabled(channelId)) return true;
    if (!settings.store.globalAuto) return false;

    // globalAuto means "every server channel I read", not "every private
    // conversation I have". Translating a public channel is a decision the
    // user makes for a room where everyone can already read everything;
    // shipping a DM to a third-party endpoint is a materially different one,
    // and the spec puts DMs out of scope. DMs and group DMs have no guild_id.
    const channel = ChannelStore.getChannel(channelId);
    return Boolean(channel?.guild_id);
}

/** Identifies the credential a pin applies to. Never logged, never displayed. */
function credentialFingerprint(): string {
    const configured = settings.store.engine as EngineId;
    return `${configured}:${apiKeyFor(configured).trim()}`;
}

/**
 * Lift the pin when the credential it was set against is no longer configured.
 *
 * Called from the settings subscriber. Deliberately NOT "clear on any settings
 * change": that would re-arm the rejected key every time an unrelated field was
 * touched, and put the plugin back to retrying a known-bad key on every batch.
 */
function releaseFallbackIfCredentialChanged(): void {
    if (!sessionFallback) return;
    if (credentialFingerprint() === fallbackPinnedFor) return;
    sessionFallback = false;
    fallbackPinnedFor = null;
    fallbackExpiresAt = null;
}

type FallbackKind = "key" | "blocked";

/**
 * How long a NETWORK block pins the quality tier before it is retried.
 *
 * A rejected key is a fact about the credential: it will still be wrong in an
 * hour, so retrying it every batch is pure noise and the pin lasts the session.
 * A 403 is a fact about the connection — a VPN, an ISB, a region — and those
 * come back. Pinning until restart meant a block on one day left the tier off
 * for as long as Discord stayed open: a real session ran three days past a
 * network hiccup that had cleared within the hour, showing "✦ blocked" the
 * whole time while Groq was reachable.
 *
 * Long enough that a persistent block is not retried every batch, short enough
 * that nobody has to restart Discord to recover from a transient one.
 */
const BLOCKED_RETRY_AFTER_MS = 15 * 60_000;

/** When a `blocked` pin stops applying. Null when the pin is not time-based. */
let fallbackExpiresAt: number | null = null;

function fallBackToGoogle(reason: string, kind: FallbackKind = "key") {
    if (sessionFallback) return;   // only announce once
    sessionFallback = true;
    fallbackKind = kind;
    fallbackExpiresAt = kind === "blocked" ? Date.now() + BLOCKED_RETRY_AFTER_MS : null;
    fallbackPinnedFor = credentialFingerprint();
    Toasts.show({
        id: Toasts.genId(),
        type: Toasts.Type.FAILURE,
        message: `VcTranslate: ${reason}. Using Google for this session.`
    });
    rebuildBatcher();
}

/**
 * An LLM engine (Claude or Gemini) is selected but no key has been entered,
 * so effectiveEngine() is quietly using Google. Say so — once.
 *
 * Deliberately NOT routed through fallBackToGoogle(): that sets
 * `sessionFallback`, which pins the session to Google until Discord restarts.
 * That is right for a key the engine REJECTED (retrying a wrong key every
 * batch is noise) and wrong for a key that simply has not been pasted yet —
 * pasting one mid-session must start using that engine immediately. So this
 * shares the announce-once shape but keeps its own flag and does not touch
 * the engine.
 *
 * Called from the enqueue path rather than from effectiveEngine(), because
 * effectiveEngine() also runs during render and a toast must not be a render
 * side effect.
 */
function announceMissingKeyOnce() {
    if (announcedMissingKey) return;
    const configured = settings.store.engine as EngineId;
    if (!isLlmEngine(configured)) return;
    if (apiKeyFor(configured).trim() !== "") return;
    announcedMissingKey = true;
    const { label } = LLM_ENGINES[configured];
    Toasts.show({
        id: Toasts.genId(),
        type: Toasts.Type.FAILURE,
        message: `VcTranslate: no ${label} API key set. Using Google until you add one.`
    });
}

/** A short, human-readable description of a stored entry, for debug logging only. */
function describeStoredForLog(e: StoredTranslation | undefined): string {
    if (e === undefined) return "‹none›";
    if (isRealTranslation(e)) return `${e.via}:${JSON.stringify(e.text)}`;
    if ("skipped" in e) return `skipped(${e.via ?? "google-unmarked"})`;
    if ("failed" in e) return "failed";
    return "deferred";
}

/**
 * Why mayReplace() refused a write, for debug logging only — mirrors its two
 * refusal branches exactly (see upgrade.ts). Only called once a refusal is
 * already known, so `existing` is guaranteed to be a real translation here:
 * that is the only case mayReplace() ever returns false for.
 */
function refuseReasonForLog(existing: StoredTranslation | undefined, next: StoredTranslation): string {
    const existingVia = (existing as { via: EngineId }).via;
    if (!isRealTranslation(next)) return `a marker cannot replace ${existingVia}'s real translation`;
    return `${next.via} (rank ${ENGINE_RANK[next.via]}) cannot replace ${existingVia} (rank ${ENGINE_RANK[existingVia]})`;
}

/**
 * The ONLY way an engine result reaches the store. Two tiers write to the same
 * key from different latencies, so every write has to ask whether it is
 * actually an improvement — see upgrade.ts.
 */
function writeResult(key: string, value: StoredTranslation): void {
    const existing = getTranslation(key);
    const allowed = mayReplace(existing, value);
    if (settings.store.debugLogging) {
        logger.debug(
            allowed
                ? `[write] ${key}: wrote ${describeStoredForLog(value)}`
                : `[write] ${key}: refused ${describeStoredForLog(value)} over `
                  + `${describeStoredForLog(existing)} — ${refuseReasonForLog(existing, value)}`
        );
    }
    if (allowed) {
        setTranslation(key, value);
        // The beacon counts translations that were actually ACCEPTED into the
        // store the subtitle reads from — not results received, and not markers.
        // A refused write produced nothing the reader will ever see, and
        // counting it would let a dead install (every LLM result refused, or
        // every batch a failure marker) still report translations. See
        // statusBeacon.ts. Never the text, never the id: only which tier.
        if (isRealTranslation(value)) recordTranslation(value.via);
    }
}

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
 *
 * ...but only while the tier has not already had its one go at this message.
 * The store alone cannot answer that, because a failed quality attempt writes
 * NOTHING to it by design (see runTier): the entry is left exactly as the fast
 * tier wrote it, so every question below still answers "yes, upgradable" and
 * every channel open re-spends a request on the same message. The ledger is
 * what closes that loop — see `qualityAttempted`.
 */
function needsQuality(key: string): boolean {
    if (qualityAttempted.has(key)) return false;
    const e = getTranslation(key);
    if (e === undefined) return true;
    if (isRealTranslation(e)) return ENGINE_RANK[e.via] < 1;
    if ("skipped" in e) return e.via === undefined || ENGINE_RANK[e.via] < 1;
    return true;   // failed / deferred — both tiers get another go
}

/**
 * Has an LLM already had its say on this message — a real translation or an
 * authoritative skip? Used only to decide whether the force-quality popover
 * button (see `forceQualityPopoverRender`) has anything left to offer.
 *
 * Deliberately `needsQuality()` minus the `qualityAttempted` check: that
 * ledger bounds AUTOMATIC re-attempts (catch-up re-offering the same message
 * on every channel open), and the whole point of the button this feeds is to
 * let the user override it by hand for a message whose one automatic attempt
 * already failed. Only a verdict actually sitting in the store — the one
 * thing forcing another request cannot improve on — closes the door here.
 */
function hasQualityVerdict(key: string): boolean {
    const e = getTranslation(key);
    if (e === undefined) return false;
    if (isRealTranslation(e)) return ENGINE_RANK[e.via] >= 1;
    if ("skipped" in e) return e.via !== undefined && ENGINE_RANK[e.via] >= 1;
    return false;   // failed / deferred — still worth a forced attempt
}

/**
 * Reduce a failed batch to one of the beacon's four error codes.
 *
 * A REDUCTION, not a summary: `res.error` is remote text (it has already been
 * observed carrying a model name, and nothing structurally stops a future
 * engine putting worse in it), so none of it reaches the beacon. The codes are
 * chosen to separate the failures that mean materially different things to
 * someone reading the diagnostics — a wrong key, an exhausted quota, and a
 * native half that never answered all need different advice.
 */
/** The HTTP status an engine's error text names, when it names one. */
function beaconErrorStatus(res: { error: string } | null): number | undefined {
    const match = res === null ? null : /\bHTTP (\d{3})\b/.exec(res.error);
    return match === null ? undefined : Number(match[1]);
}

function beaconErrorCode(res: { error: string } | null): BeaconErrorCode {
    if (res === null) return "ipc-failed";
    if (/\bHTTP 429\b/.test(res.error)) return "rate-limited";
    if (/\bHTTP 401\b/.test(res.error)) return "auth-rejected";
    // 403 is NOT an auth failure. It is the network, region or ISP being
    // refused before the key is ever looked at.
    if (/\bHTTP 403\b/.test(res.error)) return "access-blocked";
    return "engine-error";
}

/**
 * One flush, for either tier. The tier is entirely described by which engine
 * it was built with — the fast tier is Google by construction and the quality
 * tier is only ever built for an LLM (see rebuildBatcher) — so there is one
 * implementation rather than two, and `engine` no longer changes mid-flush.
 *
 * WHAT IS DELIBERATELY ABSENT: the old "429 → immediately re-run this batch
 * through Google" retry, and with it the `deferred` marker it produced. Both
 * existed because a rate-limited LLM used to be the reader's only translator.
 * It no longer is: the fast tier already sent these exact messages to Google
 * ~19s earlier, so the fallback has ALREADY run and re-sending would spend a
 * second request to obtain a line that is on screen. A quality tier that
 * cannot answer simply stays quiet and the Google line stands.
 *
 * That is also why only the FAST tier writes failure markers. A quality
 * failure is invisible by design — replacing a readable Google subtitle with
 * "⚠ translation failed" would take something away from the reader in
 * exchange for information they can do nothing with. (writeResult/mayReplace
 * already refuses a marker over a REAL translation; the `isQuality` guard is
 * what additionally protects the entries mayReplace considers replaceable —
 * a Google `skipped` marker most of all, since relabelling an
 * already-in-the-target-language message as failed is a pure regression.)
 *
 * Writing nothing is why the `qualityAttempted` ledger has to exist: an
 * invisible failure leaves no trace in the store, so the ledger is the only
 * record that the request was spent. It is written below at the moment the
 * request actually goes out.
 *
 * Everything else is unchanged and load-bearing: the generation guard runs
 * both before and after the network await, `enterCooldown` still parks the
 * engine on a 429, a 401/403 still falls the session back to Google, and the
 * `finally` still releases this tier's in-flight ids however the flush ended.
 */
/**
 * Resolve every id in a batch that never produced a per-message answer.
 *
 * Fast tier only, and `deferred` always: nothing here is a statement about any
 * individual message. See the block comment on the marker write in runTier.
 */
function deferBatch(isQuality: boolean, req: BatchRequest): void {
    if (isQuality) return;
    for (const m of req.messages) writeResult(makeKey(m.id, req.targetLang), { deferred: true });
}

async function runTier(
    engine: EngineId, req: BatchRequest, myGeneration: number,
    // Manual-⚡-only: set by forceQualityTranslate so it can learn WHY this
    // flush produced nothing, in terms the reader can act on (see
    // ForcedHint's own doc). Both onFlush closures in rebuildBatcher leave
    // this undefined, so every `report?.(...)` below is a no-op for the
    // automatic pipeline — its invisible-failure behaviour is unchanged.
    report?: (outcome: ForcedHint) => void
): Promise<void> {
    const isQuality = engine !== "google";
    // The in-flight set belonging to THIS tier. The other tier's request for
    // the same id (if any) is a separate round trip and settles on its own.
    const inFlightSet = isQuality ? inFlightQuality : inFlightFast;
    const debug = settings.store.debugLogging;

    if (debug) {
        const ids = req.messages.map(m => m.id);
        logger.debug(`[flush] ${engine}: batch of ${ids.length} — ids=${JSON.stringify(ids)}`);
    }

    try {
        // Superseded by a later rebuild (settings changed, or a fallback
        // fired) before this flush even started — this closure's `engine` no
        // longer matches reality, so drop it rather than send under a stale
        // configuration. The finally below still releases the ids: a batch
        // stranded here that stayed "in flight" forever could never be
        // retried by catch-up.
        //
        // DEFENCE IN DEPTH, AND CURRENTLY UNREACHABLE — measured, not assumed.
        // Instrumented and run against the whole suite plus five hand-built
        // staleness scenarios (settings change mid-debounce, two channels at
        // once, a 401 fallback rebuilding while a fast batch sits queued,
        // stop()/start(), and a rebuild during a queued quality batch): this
        // branch fired ZERO times, while the post-await guard below fired as
        // expected. The reason is an invariant in rebuildBatcher(): every
        // `batcherGeneration++` is bracketed by drainPending() — which clears
        // each batcher's armed timer and empties its queue — and dispose(),
        // with no await anywhere between, so no old-generation closure can
        // still be INVOKED afterwards. Only a flush already past this line and
        // awaiting the network can be superseded.
        //
        // KEEP IT ANYWAY. It costs one integer compare, and it becomes live
        // and load-bearing the moment anyone adds an await inside
        // rebuildBatcher, stops draining, or schedules onFlush through a
        // microtask instead of calling it synchronously. Because it is
        // unreachable, no behavioural test can pin it (removing it changes
        // nothing observable); the invariant that keeps it unreachable is
        // pinned instead, by "leaves no stale timer behind" in index.test.ts.
        if (myGeneration !== batcherGeneration) {
            if (debug) logger.debug(`[flush] ${engine}: blocked — stale generation (pre-gate)`);
            report?.({ kind: "gate" });
            return;
        }

        // Cooling down after a 429: do not spend a request to be told so
        // again. Nothing is marked and nothing is diverted — the fast tier's
        // Google line for these same messages is already on screen.
        // The fast tier is included now. Google's free endpoint rate-limits
        // by IP and answers 429 with an HTML block page; retrying into that is
        // how a transient block becomes a sustained one — and unlike the LLMs,
        // Google has no rate gate to fall back on.
        if (isCoolingDown(engine)) {
            if (debug) {
                logger.debug(
                    `[flush] ${engine}: blocked — cooling down for another `
                    + `${formatCountdown(cooldownUntil(engine) - Date.now())}`
                );
            }
            report?.({ kind: "cooldown" });
            // A fast-tier batch skipped here never went out, so no id in it
            // has an answer. Leave them readable as "delayed" rather than
            // blank — and resolved, so catch-up sees work already accounted
            // for instead of re-requesting into the same closed door.
            deferBatch(isQuality, req);
            return;
        }

        // Only the LLM engines are rate-gated — Google is per-message with its
        // own concurrency cap (engines/google.ts) and was never the source of
        // the 429 storm this gate exists for.
        if (isQuality) {
            const gateWaitStarted = Date.now();
            await acquireSlot();
            if (debug) {
                const waitedMs = Date.now() - gateWaitStarted;
                logger.debug(
                    waitedMs > 5
                        ? `[flush] ${engine}: rate gate — waited ${waitedMs}ms for a slot`
                        : `[flush] ${engine}: rate gate — slot was available immediately`
                );
            }
            // stop()/rebuild may have happened while this flush sat behind the
            // gate (resetRateGate() wakes queued waiters immediately for
            // exactly that reason, rather than leaving them to time out on the
            // next refill tick). Re-check before spending a real request on a
            // batch nothing will ever read the result of.
            if (myGeneration !== batcherGeneration) {
                if (debug) logger.debug(`[flush] ${engine}: blocked — stale generation (post-gate)`);
                report?.({ kind: "gate" });
                return;
            }
        }

        // The request is about to be SPENT, so record it before it can fail in
        // any of the ways below. This is the one place that knows a quality
        // request actually left the client — every earlier `return` above
        // (stale generation, cooldown, rate gate) cost nothing and must leave
        // the message retryable. A quality failure writes nothing to the store,
        // so without this ledger entry there is no record anywhere that the
        // attempt happened and catch-up re-requests it forever. See
        // `qualityAttempted`.
        if (isQuality) {
            for (const m of req.messages) markQualityAttempted(makeKey(m.id, req.targetLang));
        }

        // `null` means the IPC call itself rejected — distinct from an
        // `ok: false` response, which is an engine-level failure the native
        // side successfully reported. onFlush is void-returning and invoked
        // un-awaited, so an unhandled rejection here would otherwise just
        // vanish the batch with no marker.
        let res: Awaited<ReturnType<typeof Native.translateBatch>> | null;
        try {
            res = await Native.translateBatch(
                engine,
                isLlmEngine(engine) ? apiKeyFor(engine) : "",
                JSON.stringify(engine === "google" ? withSourceLangs(req) : req),
                modelFor(engine),
                debug
            );
        } catch {
            res = null;
        }

        // THE race this second guard exists for: rebuildBatcher() can run
        // WHILE the line above is awaiting the network round trip (a settings
        // change, or an LLM engine's 401 triggering fallBackToGoogle
        // mid-flight). The check before the await only catches a flush that
        // was already stale when it started — it cannot catch one that went
        // stale during the await. Re-check before any write, so a superseded
        // response is dropped instead of landing under the old engine's key.
        if (myGeneration !== batcherGeneration) {
            if (debug) logger.debug(`[flush] ${engine}: blocked — stale generation (post-response)`);
            return;
        }

        if (res === null || !res.ok) {
            if (debug) {
                logger.debug(
                    `[flush] ${engine}: response not ok — `
                    + (res === null ? "IPC call rejected" : res.error)
                );
            }
            // Tell the beacon THAT something failed and roughly what class of
            // thing it was — never the engine's message, which is remote text
            // (see BEACON_ERROR_CODES). This is what lets the installer report
            // "loaded, but erroring" instead of the indistinguishable "loaded,
            // nothing to translate yet".
            const errorCode = beaconErrorCode(res);
            recordError(errorCode, beaconErrorStatus(res));
            // Manual-⚡-only — see ForcedHint's own doc. Reuses the same
            // closed set of categories the beacon just recorded, so this can
            // never leak the engine's own (potentially remote-text-bearing)
            // error string into the DOM.
            report?.({ kind: "failed", code: errorCode });

            if (res !== null) {
                // Park the engine for as long as the API asked for. Still the
                // whole point of the cooldown: retrying into a wall that just
                // rejected us is how half the observed traffic became 429s.
                // (`retryAfterMs` is only ever set for a 429 — see native.ts.)
                if (isLlmEngine(engine) && res.retryAfterMs) {
                    enterCooldown(
                        engine, res.retryAfterMs, res.quotaLimitPerMinute, res.quotaModel
                    );
                } else if (!isLlmEngine(engine) && /\b429\b/.test(res.error)) {
                    // Google, parked through the plain store rather than
                    // enterCooldown: that function retunes the rate gate and
                    // announces a quota, and Google is behind neither — it is
                    // per-message with its own concurrency cap, and its free
                    // endpoint states no quota to retune towards. All that is
                    // wanted here is "stop asking for a while".
                    setCooldown(engine, Date.now() + (res.retryAfterMs ?? DEFAULT_COOLDOWN_MS));
                }
                // Retrying either of these every batch would be pure noise, so
                // both fall back to Google for the rest of the session — but
                // they are told apart, because the remedies are opposites.
                //
                // 403 means the request was refused before the key was
                // consulted: a VPN, a region, an ISP. Reporting it as a
                // rejected key sends the user to replace a credential that
                // works. Observed live — Groq answered 403 to an
                // UNAUTHENTICATED request from the same machine.
                if (isLlmEngine(engine) && /\b403\b/.test(res.error)) {
                    fallBackToGoogle(
                        `cannot reach ${LLM_ENGINES[engine].label} from this network`,
                        "blocked"
                    );
                } else if (isLlmEngine(engine) && /\b401\b/.test(res.error)) {
                    fallBackToGoogle(`${LLM_ENGINES[engine].label} rejected the API key`, "key");
                }
            }

            // Markers only from the FAST tier — and writeResult still refuses
            // to put one over a real line. An id with no entry at all is
            // indistinguishable from one that was never requested, so the fast
            // tier must leave SOMETHING resolved or catch-up re-requests it
            // forever.
            if (!isQuality) {
                for (const m of req.messages) {
                    writeResult(makeKey(m.id, req.targetLang), { deferred: true });
                }
            }
            return;
        }

        // What the provider itself said is left, when the provider says
        // anything (OpenAI-compatible engines only — see native.ts's
        // `providerRateLimit`). Two consumers, and they want different things
        // from the same number:
        //
        //  - the quota indicator, which can now show the provider's truth
        //    instead of our guess (see describeQuotaState). This is the fix
        //    for `✦ 3` sitting next to an instant 429.
        //  - the rate gate, which retunes from it exactly as it already does
        //    from a 429's stated quota — but only ever downwards, and without
        //    persisting it (see tuneRateGateToProviderBudget for why both).
        //
        // Recorded BEFORE the results are written, so a reading is not lost to
        // an exception in the write loop, and only for the quality tier: the
        // fast tier is Google, which is not gated, not keyed and reports none
        // of this.
        if (isQuality && isLlmEngine(engine)) {
            const reported = res.providerRateLimit;
            recordProviderQuota(engine, reported);
            if (reported !== undefined && typeof reported.remainingRequests === "number") {
                const retuned = tuneRateGateToProviderBudget(
                    reported.remainingRequests, reported.resetRequestsMs
                );
                if (debug && retuned) {
                    logger.debug(
                        `[flush] ${engine}: rate gate retuned from the provider's own remaining `
                        + `count (${reported.remainingRequests} left) — now one request every `
                        + `${rateGateSettings().refillMs}ms`
                    );
                }
            }
        }

        for (const r of res.results) {
            const key = makeKey(r.id, req.targetLang);
            if (debug) {
                const outcome = "failed" in r ? "failed" : r.skip ? "skip" : `translation (${r.lang})`;
                logger.debug(`[response] ${engine} ${r.id}: ${outcome}`);
            }
            if ("failed" in r) {
                if (!isQuality) writeResult(key, { failed: true });
                continue;
            }
            if (r.skip) {
                // A skip has nothing to DISPLAY, but something must still be
                // WRITTEN, for the same "no entry looks like never requested"
                // reason as above — in a mixed-language chat most messages ARE
                // already in the target language, so this is the common case.
                //
                // `via` is what makes the skip interpretable later: a GOOGLE
                // skip is not authoritative (Google echoes short and romanized
                // text back unchanged — "salam khouya kifach" comes back
                // byte-identical — which isSameText reads as "already in the
                // target language" when it actually means "Google gave up"),
                // while an LLM skip closes the message. needsQuality() reads
                // exactly that distinction. Written through writeResult so it
                // still cannot replace a real translation: a Google skip must
                // never erase an LLM line.
                writeResult(key, { skipped: true, via: engine });
                continue;
            }
            // `engine` is recorded in the value because it is no longer part
            // of the key — and it is what makes a Google line render as ≈
            // (approximate) instead of claiming ✦. Routed through
            // writeResult(): the two tiers write the same key from different
            // latencies, so this write has to ask whether it is an improvement.
            const value: StoredTranslation = { lang: r.lang, text: r.text, via: engine, conf: r.conf };
            writeResult(key, value);
            // Recorded from the SENT text, so the lookup in enqueue() keys on
            // exactly what a later identical message will present.
            const sent = req.messages.find(m => m.id === r.id);
            if (sent !== undefined) rememberPhrase(sent.text, req.targetLang, value);
        }
    } finally {
        // Fires once this flush has fully settled, whichever way it went
        // (sent, skipped for cooldown, stranded by a rebuild, rejected). That
        // is the earliest point these ids are safe to retry — not when they
        // were queued, and not only on the happy path.
        for (const m of req.messages) inFlightSet.delete(m.id);
    }
}

/**
 * Force ONE message through the quality tier on the user's explicit say-so —
 * the click handler behind the force-quality popover button.
 *
 * Deliberately does not consult `needsQuality()`, the `qualityAttempted`
 * ledger, or `allowQuality`: those bound AUTOMATIC spending (catch-up,
 * scroll-back, live chat), and a user naming one specific message outranks
 * all three — that is the entire point of a manual override. What this does
 * NOT skip is `runTier()`'s own gates: the cooldown and the rate gate are
 * limits on the ENGINE (how much it can be asked right now), not on how a
 * request was chosen, and bypassing either would let one click spend the
 * quota every other message is waiting on, or hammer an engine that just
 * rejected us. Routed through `runTier()` itself — not a second call to
 * `Native.translateBatch` — so the write still lands through
 * `writeResult()`/`mayReplace()` exactly as an automatic quality batch does:
 * a Google result arriving later still cannot clobber what this bought.
 */
async function forceQualityTranslate(message: Message): Promise<void> {
    const debug = settings.store.debugLogging;
    if (debug) logger.debug(`[force-quality] ${message.id}: click received`);

    const engine = effectiveEngine();
    // Not actually usable right now (no LLM configured, no key, or pinned to
    // Google by an earlier auth failure) — the popover render() below already
    // hides the button in exactly this case, but the engine can change
    // between render and click, so check again rather than trust stale props.
    if (!isLlmEngine(engine)) {
        if (debug) logger.debug(`[force-quality] ${message.id}: blocked — no LLM engine usable right now`);
        return;
    }

    // A duplicate click, or a race with a request already in flight for this
    // message on this tier (live chat, catch-up). One spend at a time per
    // message, same discipline as the automatic paths.
    if (inFlightQuality.has(message.id)) {
        if (debug) logger.debug(`[force-quality] ${message.id}: blocked — already in flight on the quality tier`);
        return;
    }
    if (debug) logger.debug(`[force-quality] ${message.id}: passed guards, spending a ${engine} request`);
    inFlightQuality.add(message.id);
    // A hint left over from an EARLIER click on this same message must not
    // survive into this one — see clearForcedHint's own doc.
    clearForcedHint(message.id);
    // Manual-path-only indicator for TranslationAccessory — see the comment
    // on `forcedInFlight` above for why this is a second set rather than a
    // second use of inFlightQuality.
    forcedInFlight.add(message.id);
    notifyForcedInFlight();

    const req: BatchRequest = {
        messages: [{
            id: message.id,
            author: message.author?.username ?? "unknown",
            text: message.content ?? "",
            replyToId: replyParentId(message)
        }],
        // The messages immediately BEFORE this one, read from the store.
        //
        // This used to send `context: []`, reasoning that a single out-of-band
        // request does not need the conversation ring. That was wrong in the
        // case it matters most. Romanized Maghrebi Arabic is where this plugin
        // is weakest, and a real example had the author's own English
        // rendering of the sentence one message above it — "when we type, we
        // write in a mix of arabic and french". Without it, "ki nebdew
        // nektbou" came back as "what's up" and the verb "write" vanished.
        //
        // Read from the store rather than from the live context ring: the ring
        // is a window on what is arriving NOW, so forcing an old scroll-back
        // message would hand the model a conversation that has nothing to do
        // with it — worse than no context at all.
        //
        // This is also the request that can least afford to be wrong: the user
        // clicked a button and is watching for the answer.
        context: contextBefore(message, FORCED_CONTEXT_SIZE),
        targetLang: settings.store.targetLang
    };
    // Whichever way runTier settles — success, failure, cooldown block, a
    // stale-generation drop or a rate-gate rejection — the manual indicator
    // must come down. runTier's OWN finally already releases inFlightQuality
    // on every one of those paths (see runTier), so piggy-backing on the same
    // await here releases forcedInFlight at exactly the same point, never
    // stuck on a path runTier itself handles.
    //
    // `report` is how runTier tells THIS caller — and only this caller, see
    // ForcedHint's own doc — why nothing landed, so TranslationAccessory can
    // show a brief, self-clearing hint instead of the silence an automatic
    // failure gets. Success needs no report of its own: the store write is
    // what the accessory's ✦/≈ line already reacts to.
    try {
        await runTier(engine, req, batcherGeneration, outcome => setForcedHint(message.id, outcome));
    } finally {
        forcedInFlight.delete(message.id);
        notifyForcedInFlight();
    }
}

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
        // Read from the engine table rather than hardcoded per tier: whether an
        // engine can use conversation context is a fact about the ENGINE, and
        // duplicating it here is how the table and the code that depends on it
        // drift apart. (Google is per-message; context is wasted on it.)
        supportsContext: ENGINE_CAPS.google.supportsContext,
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
            // Same table, same reason. `quality` is narrowed to an LLM engine
            // here, so this is `true` today — but it is true BECAUSE the engine
            // says so, which is what makes adding a fourth engine one row in
            // types.ts rather than a second place to remember.
            supportsContext: ENGINE_CAPS[quality].supportsContext,
            targetLang: settings.store.targetLang,
            onFlush: req => runTier(quality, req, myGeneration)
        })
        : null;

    // Orphans are still marked in flight from their first pass. enqueue()
    // early-returns on that, which would silently drop every message caught
    // mid-debounce by a settings change — no entry, no marker, no retry.
    // Releasing the marks first is what makes the re-queue actually re-queue.
    // Both sets, unconditionally: an orphan drained from fastBatcher's queue
    // was only ever marked in inFlightFast and one from qualityBatcher's queue
    // only in inFlightQuality, so releasing the set that was never set for a
    // given id is simply a no-op — and a message queued in BOTH at once (fully
    // legitimate under dual dispatch) needs both released anyway.
    for (const m of orphaned) {
        inFlightFast.delete(m.id);
        inFlightQuality.delete(m.id);
    }
    // Re-queue under the new settings rather than marking them failed —
    // nothing about these messages failed, the settings changed under them.
    for (const m of orphaned) enqueue(m, false);
}

/**
 * The single path from "this message needs handling" to the batcher, shared by
 * MESSAGE_CREATE, MESSAGE_UPDATE and catch-up. Keeping it in one place is what
 * stops the skip rule, the in-flight guard and the context bookkeeping from
 * drifting apart between the three callers — the edited-message path in
 * particular has to do exactly what the created-message path does.
 *
 * `allowQuality` is false for exactly one caller: catch-up driven by a
 * scroll-back `LOAD_MESSAGES_SUCCESS` (see `initialHistoryPending`). Those
 * messages go to the fast tier only, so the reader still gets a `≈` line
 * within a second while the quality tier's 20-requests-per-rolling-minute
 * budget stays available for the live conversation. They are deliberately not
 * recorded as quality CONTEXT either: the context ring is a window on the
 * conversation being read, and filling it with an hour-old stretch of history
 * the user happened to scroll past would evict exactly the recent messages that
 * make the next live batch worth its request.
 */
function enqueue(pending: PendingMessage, isOwn: boolean, allowQuality = true) {
    // Two flavours of local skip, handled identically: the structural one
    // (own message, nothing translatable left after stripping emotes/links)
    // and the linguistic one (we can tell locally that this is already in the
    // target language — see detectLang.ts, which is heavily biased toward
    // saying "no idea", i.e. toward spending the request).
    //
    // Both record context rather than writing a store entry, exactly as the
    // structural skip always has. Nothing is written because nothing was
    // decided by an ENGINE: re-examining the message on the next channel open
    // is a pure local function call that returns the same answer for free, and
    // not writing keeps a local guess out of the persisted cache, where a
    // heuristic mistake would otherwise outlive the session.
    const skipReason = localSkipReason(pending.text, isOwn);
    if (skipReason !== null) {
        // Guarded, not just quiet: with the setting off this must cost
        // nothing beyond the one boolean read below — no template string is
        // built. See settings.ts's debugLogging for what this is for and why
        // message text is included.
        if (settings.store.debugLogging) {
            logger.debug(
                `[enqueue] ${pending.id}: locally skipped by ${skipReason} `
                + `— text=${JSON.stringify(pending.text)}`
            );
        }
        // Both rings: fastBatcher's is never actually read (it does not
        // support context) but recording into it is harmless, and
        // qualityBatcher may be null (Google-only). Whichever tier(s) end up
        // consuming context see a coherent conversation either way.
        fastBatcher?.recordContext(pending);
        if (allowQuality) qualityBatcher?.recordContext(pending);
        return;
    }

    announceMissingKeyOnce();

    const key = makeKey(pending.id, settings.store.targetLang);

    // Already queued or awaiting a response on that tier: the store shows a
    // miss for the whole round trip, so "no entry" must not be read as
    // "never requested". Checked and set per tier — a message is legitimately
    // in flight on both at once.
    let wentFast = false;
    if (!inFlightFast.has(pending.id) && needsFast(key)) {
        inFlightFast.add(pending.id);
        fastBatcher?.add(pending);
        wentFast = true;
    }

    let wentQuality = false;
    if (allowQuality && qualityBatcher && !inFlightQuality.has(pending.id) && needsQuality(key)) {
        // An identical line already translated by the quality tier this
        // session: reuse the answer rather than buying a second, possibly
        // different one. Still routed through writeResult, so it cannot
        // replace anything better and the beacon counts it like any other.
        const seen = qualityPhrases.get(phraseKey(pending.text, settings.store.targetLang));
        if (seen !== undefined) {
            writeResult(key, seen);
            if (settings.store.debugLogging) {
                logger.debug(`[enqueue] ${pending.id}: reused a cached quality phrase`);
            }
        } else {
            inFlightQuality.add(pending.id);
            qualityBatcher.add(pending);
            wentQuality = true;
        }
    }
    // No `else`. Two ways to reach one: qualityBatcher is null (no LLM
    // configured), in which case there is no second ring to feed at all —
    // fastBatcher never reads its own context (it does not support it), so
    // there is nothing useful to record; or allowQuality is false, i.e.
    // scroll-back, which must NOT be recorded as context for the reasons in
    // this function's doc comment.

    if (settings.store.debugLogging) {
        const tiers = [wentFast && "fast", wentQuality && "quality"].filter(Boolean).join("+");
        logger.debug(`[enqueue] ${pending.id}: -> ${tiers || "neither (in flight or already resolved)"}`);
    }
}

/** Which local rule decided to skip a message — see `localSkipReason`. */
type LocalSkipReason = "shouldSkip" | "isConfidentlyTargetLanguage";

/**
 * Decided locally, for free, with no engine involved: either there is nothing
 * translatable left in the text (`shouldSkip`), or it is already in the
 * target language (`isConfidentlyTargetLanguage`) — or neither, `null`.
 *
 * Same short-circuit order as the `||` this replaces: `shouldSkip` is checked
 * first and `isConfidentlyTargetLanguage` only when it says no, so behaviour
 * is unchanged. Split out from a plain boolean (what `isLocallySkipped` below
 * still returns, for its two ordinary callers) so debugLogging can report
 * WHICH of the two rules fired — the enqueue-side logging exists specifically
 * so a message that silently never reaches an engine is still diagnosable
 * from the console.
 */
function localSkipReason(text: string, isOwn: boolean): LocalSkipReason | null {
    if (shouldSkip(text, isOwn)) return "shouldSkip";
    if (isConfidentlyTargetLanguage(text, settings.store.targetLang)) return "isConfidentlyTargetLanguage";
    return null;
}

/**
 * Decided locally, for free, with no engine involved: either there is nothing
 * translatable left in the text, or it is already in the target language.
 *
 * Shared by enqueue() and catchUp() ON PURPOSE. catch-up has to predict the
 * same answer enqueue() will give, so that a message costing no request also
 * costs no catch-up budget — see the budget comment in catchUp().
 */
function isLocallySkipped(text: string, isOwn: boolean): boolean {
    return localSkipReason(text, isOwn) !== null;
}

/**
 * "de" -> "German", "ha" -> "Hausa".
 *
 * The two-letter code alone is not readable: a reader who sees "ha" has no way
 * to know it means Hausa, and therefore no way to notice that a message in a
 * German conversation was detected as a West African language — which is
 * precisely the moment the translation should be distrusted.
 *
 * Intl.DisplayNames ships with the runtime, so this costs no table of our own.
 * It throws on a malformed code and returns the input unchanged for a
 * well-formed one it doesn't know, so both fall back to showing the raw code.
 */
function languageName(code: string): string {
    try {
        return new Intl.DisplayNames([LocaleStore.locale || "en"], { type: "language" })
            .of(code) ?? code;
    } catch {
        return code;
    }
}

/**
 * Fill in `sourceLang` for the short messages Google cannot detect on their own.
 *
 * The motivating case, observed in a live German channel: "ne" replying to
 * "sind die gruppenräume klimatisiert an der uni?". Under `sl=auto` Google
 * reads "ne" as Hausa (confidence 0.217) and renders "it is" — the exact
 * opposite of the German "no" that was meant, and perfectly readable as an
 * answer, so nothing warns the reader. Pinning `sl=de` returns "no".
 *
 * Only SHORT texts borrow, and only from a parent that was itself detected
 * confidently. Both limits matter in a multilingual channel: a long message is
 * detected reliably on its own and must not be forced into its parent's
 * language, and borrowing from an uncertain parent would spread one bad
 * detection down a whole reply chain.
 *
 * Google-only by construction. The LLM engines already receive the surrounding
 * conversation, which resolves "ne" far better than a language code can.
 */
function withSourceLangs(req: BatchRequest): BatchRequest {
    const targetLang = req.targetLang;
    return {
        ...req,
        messages: req.messages.map(m => {
            if (m.sourceLang !== undefined) return m;
            if (m.replyToId === undefined) return m;
            if (m.text.trim().length > SHORT_TEXT_MAX) return m;

            const parent = getTranslation(makeKey(m.replyToId, targetLang));
            if (parent === undefined || !("lang" in parent)) return m;
            // An undefined `conf` means the parent was itself pinned rather
            // than detected, which is a borrow we already vouched for.
            if (parent.conf !== undefined && parent.conf < MIN_DETECT_CONFIDENCE) return m;

            return { ...m, sourceLang: parent.lang };
        })
    };
}

/**
 * The id of the message a reply points at, or undefined for a normal message.
 *
 * Discord exposes this two ways depending on how the message reached us —
 * `message_reference` on the Flux payload, `referenced_message` on a hydrated
 * store object — so both are checked rather than assuming the shape of
 * whichever path happened to be tested.
 */
function replyParentId(message: any): string | undefined {
    const ref = message?.message_reference?.message_id;
    if (typeof ref === "string") return ref;
    const hydrated = message?.referenced_message?.id;
    return typeof hydrated === "string" ? hydrated : undefined;
}

/** How many preceding messages a forced translation gets as context. */
const FORCED_CONTEXT_SIZE = 6;

/**
 * The messages immediately before `message` in its channel, oldest-first.
 *
 * Positioned by ID rather than by taking the newest N, because the whole point
 * is the conversation around THIS message — which, for anything reached by
 * scrolling back, is nowhere near the newest.
 *
 * Empty-content messages (embeds, attachments, joins) are dropped: they cost
 * prompt tokens and carry nothing a translator can use. A message the store
 * does not have — the target was never loaded, or Discord's internals moved —
 * yields no context rather than throwing, because a forced translation with
 * imperfect context is still far better than one that errors.
 */
function contextBefore(message: any, size: number): { author: string; text: string }[] {
    const channelId = message?.channel_id;
    if (typeof channelId !== "string") return [];

    const store = MessageStore.getMessages(channelId);
    if (!store || typeof store.toArray !== "function") return [];

    let all: any[];
    try {
        all = store.toArray();
    } catch {
        return [];
    }

    const index = all.findIndex(m => m?.id === message.id);
    if (index < 0) return [];

    return all
        .slice(Math.max(0, index - size), index)
        .filter(m => typeof m?.content === "string" && m.content.trim() !== "")
        .map(m => ({ author: m.author?.username ?? "unknown", text: m.content as string }));
}

function onMessageCreate({ message, optimistic }: { message: Message; optimistic?: boolean; }) {
    if (optimistic || !message?.id) return;
    if (!channelActive(message.channel_id)) return;
    // Not the channel on screen: don't spend a request on it now. It is not
    // lost — opening that channel runs catch-up over its recent backlog.
    if (!isFocusedChannel(message.channel_id)) return;

    enqueue(
        {
            id: message.id,
            author: message.author?.username ?? "unknown",
            text: message.content ?? "",
            channelId: message.channel_id,
            replyToId: replyParentId(message)
        },
        message.author?.id === UserStore.getCurrentUser()?.id
    );
}

function onMessageUpdate({ message }: { message: Message; }) {
    if (!message?.id) return;

    // Whatever we had cached describes the pre-edit text, so it is wrong now
    // regardless of what kind of update this is. The quality tier's spent
    // attempt is discarded with it, for the same reason: it was spent on text
    // that no longer exists, so the edited message is entitled to its own.
    invalidateMessage(message.id);
    forgetQualityAttempts(message.id);

    // MESSAGE_UPDATE is not only fired for user edits: it also fires for embed
    // hydration (a link preview resolving, an attachment finishing processing)
    // and for pin/flag changes. Those payloads are PARTIAL — they carry no
    // `content` field at all — so re-queuing unconditionally would spend a
    // translation call on every link anyone posts. Requiring non-empty content
    // means embed-only updates are invalidated (harmless, the text is
    // unchanged so it re-resolves identically) but never re-requested.
    const text = message.content;
    if (typeof text !== "string" || text === "") return;

    if (!message.channel_id || !channelActive(message.channel_id)) return;
    // Same focus rule as a new message: an edit in a channel nobody is looking
    // at waits for that channel to be opened. The invalidation above already
    // happened, so it is a cache miss when catch-up gets to it.
    if (!isFocusedChannel(message.channel_id)) return;

    // Invalidating without re-queuing was the bug this replaces: the subtitle
    // vanished on edit and only came back on the next channel open. Goes
    // through enqueue() so the skip rule and the in-flight guard apply exactly
    // as they do for a new message. (An edit landing inside the ~1s window
    // while the original is still in flight is dropped by that guard, and the
    // in-flight response then writes the pre-edit translation; the next
    // channel-open catch-up does not correct it, since that entry looks
    // resolved. Rare enough to accept rather than add a second cache layer.)
    enqueue(
        {
            id: message.id,
            author: message.author?.username ?? "unknown",
            text,
            channelId: message.channel_id,
            replyToId: replyParentId(message)
        },
        message.author?.id === UserStore.getCurrentUser()?.id
    );
}

interface CatchUpOptions {
    /**
     * For the one caller that KNOWS this channel is the one the user is now on,
     * but cannot prove it through SelectedChannelStore: CHANNEL_SELECT. Flux
     * hands that event to store handlers and plugin subscribers without a
     * guaranteed order, so SelectedChannelStore may still be reporting the
     * PREVIOUS channel when we run. Gating on the store there would mean
     * cold-channel catch-up — the headline feature — silently never firing.
     * The event's own payload is the authoritative statement of "this is now
     * the selected channel", so that caller passes true and every other caller
     * proves focus the normal way.
     */
    becomingFocused?: boolean;
    /**
     * False for scroll-back only: a `LOAD_MESSAGES_SUCCESS` that is not the
     * initial backlog landing for a channel the user just opened. Those
     * messages are enqueued for the FAST tier alone.
     *
     * WHY, precisely: this catch-up's budget (`catchUpCount`, 20) is per
     * invocation, and Discord re-fires LOAD_MESSAGES_SUCCESS for every chunk of
     * history a scroll loads — so scrolling hands the quality tier an unbounded
     * stream of fresh, never-before-seen messages, each batch legitimately new
     * and therefore untouched by the `qualityAttempted` ledger. Against the
     * measured Gemini free-tier ceiling of 20 requests per ROLLING minute that
     * empties the quota in seconds. Live chat and channel-open backlog are what
     * the LLM's conversation context is actually worth spending on; history
     * being skimmed past is not. See `initialHistoryPending`.
     */
    allowQuality?: boolean;
}

function catchUp(channelId: string, opts: CatchUpOptions = {}) {
    const { becomingFocused = false, allowQuality = true } = opts;

    if (!channelActive(channelId)) return;
    if (!becomingFocused && !isFocusedChannel(channelId)) return;

    const count = settings.store.catchUpCount;
    if (count <= 0) return;

    const store = MessageStore.getMessages(channelId);
    if (!store || typeof store.toArray !== "function") {
        // Not necessarily an error -- a channel with no messages loaded yet
        // legitimately has nothing to iterate. But if the store or method
        // itself is gone, Discord's internals moved and we'd otherwise fail
        // silently with no way to tell "empty channel" from "broken".
        logger.warn(`MessageStore.getMessages(${channelId}) has no usable toArray(); skipping catch-up.`);
        return;
    }

    // Walk newest-first over EVERY loaded message and cap on how many we
    // actually enqueue, rather than slicing the newest `count` up front.
    // Those are the same set on a first open, but they diverge as soon as you
    // scroll up: scrolling loads older history and re-fires this, and a
    // fixed tail slice would keep re-examining the same already-translated
    // recent messages while the newly-loaded older ones never got picked up.
    const all = store.toArray();
    const me = UserStore.getCurrentUser()?.id;

    // Select newest-first so the messages nearest the viewport win the budget,
    // then enqueue oldest-first.
    const candidates: any[] = [];
    // `count` is a budget of REQUESTS, not of messages looked at.
    //
    // A locally-skipped message deliberately writes nothing to the store (see
    // enqueue), so it never becomes "resolved" and turns up again on every
    // single catch-up. Counting those against the budget meant that in an
    // English-majority channel the newest ~20 English lines consumed catch-up
    // entirely and the foreign message further up — the only one that needed
    // translating, and the whole reason the plugin exists — was never reached.
    // Scrolling back could not fix it either, because each re-run spent the
    // budget on the same newest messages again.
    let budget = 0;
    for (let i = all.length - 1; i >= 0 && budget < count; i--) {
        const message = all[i];

        const key = makeKey(message.id, settings.store.targetLang);

        // A message is finished only when NEITHER tier has anything left to do.
        // Asking "is there an entry?" is no longer enough: the fast tier writes
        // one within a second of every message arriving, so that question now
        // answers "yes" for the entire backlog and the quality tier would never
        // run again. Delegating to needsFast/needsQuality (rather than a coarse
        // pre-filter on entry shape) is also what lets a GOOGLE skip stay open
        // to the quality tier — Google echoes short/romanized text back
        // unchanged and that reads as "already in the target language" when it
        // actually means "Google gave up"; only an LLM's own skip closes a
        // message. Each check folds in its own in-flight test, since a message
        // can legitimately be in flight on one tier and idle on the other.
        //
        // needsQuality() ALSO folds in the one-request-per-message ledger, and
        // this loop is why: catch-up runs on every channel open and on every
        // scroll-up (LOAD_MESSAGES_SUCCESS), so without it a quality failure —
        // which writes nothing, by design — would be re-requested here for the
        // rest of the session. See `qualityAttempted`.
        const fast = !inFlightFast.has(message.id) && needsFast(key);
        // `allowQuality` first, so a scroll-back pass does not even SELECT a
        // message whose only outstanding work is a quality upgrade: it would
        // consume budget and then be enqueued for a tier that will not take it.
        const quality = allowQuality
            && qualityBatcher !== null
            && !inFlightQuality.has(message.id)
            && needsQuality(key);
        if (!fast && !quality) continue;

        candidates.push(message);
        // Still enqueued above (a skipped message is real conversation and
        // belongs in the context window), just not charged for: enqueue() will
        // resolve it locally without ever reaching an engine.
        if (!isLocallySkipped(message.content ?? "", message.author?.id === me)) budget++;
    }
    // Back to chronological order before enqueuing, so the batcher's rolling
    // context window sees the conversation the right way round.
    candidates.reverse();

    if (settings.store.debugLogging) {
        logger.debug(
            `[catchUp] ${channelId}: allowQuality=${allowQuality} `
            + `candidates=${candidates.length} budgetSpent=${budget}/${count}`
        );
    }

    for (const message of candidates) {

        // Skipped messages still shape the conversation, so enqueue() turns
        // them into context instead of a request. pushContext() de-duplicates
        // by message id, which matters here: catch-up runs for BOTH
        // CHANNEL_SELECT and LOAD_MESSAGES_SUCCESS on a single channel open,
        // so without that the same backlog would be pushed into the 8-slot
        // ring twice, evicting genuine context with copies of itself.
        enqueue(
            {
                id: message.id,
                author: message.author?.username ?? "unknown",
                text: message.content ?? "",
                channelId,
                replyToId: replyParentId(message)
            },
            message.author?.id === me,
            allowQuality
        );
    }
}

function onChannelSelect({ channelId }: { channelId: string; }) {
    if (!channelId) return;
    // The backlog may not be fetched yet for a channel not visited this
    // session, so the history load that follows is still part of THIS open and
    // is entitled to the quality tier. Armed before catch-up runs, so a
    // synchronous LOAD_MESSAGES_SUCCESS could not outrun it.
    armInitialHistory(channelId);
    // This event IS the focus change, so it does not have to ask
    // SelectedChannelStore whether it has caught up yet.
    catchUp(channelId, { becomingFocused: true });
}

// CHANNEL_SELECT fires before Discord has necessarily fetched the backlog
// of a channel not yet visited this session, so MessageStore.getMessages()
// can still be empty when catchUp() above runs -- exactly the "tab back in
// after a game" case the feature exists for. LOAD_MESSAGES_SUCCESS is
// Discord's event for "message history for this channel just landed"; it's
// confirmed as a real client event via the FluxEvents union in
// packages/discord-types/src/fluxEvents.d.ts, but no existing Vencord
// plugin subscribes to it, so its `channelId` payload field is inferred
// from MessageStore's own consistent naming (getMessages(channelId),
// isLoadingMessages(channelId)) and CHANNEL_SELECT's confirmed shape, not
// independently verified against a real dispatch.
function onMessagesLoaded(payload: any) {
    // The payload shape for this event is not exercised anywhere in the
    // Vencord checkout, so the field name is unverified. Accept the two
    // plausible spellings and log loudly if neither is present, so a
    // Discord-internals change is diagnosable instead of a silent no-op --
    // this is the headline "tab back in after a game" case, so a silent
    // failure here would be the worst kind: no error, just nothing happens.
    const channelId: string | undefined = payload?.channelId ?? payload?.channel_id;
    if (!channelId) {
        logger.warn(
            "LOAD_MESSAGES_SUCCESS payload had no channelId/channel_id; " +
            "cold-channel catch-up will not run. Payload keys: " +
            Object.keys(payload ?? {}).join(", ")
        );
        return;
    }
    // No `becomingFocused` here: by the time history has actually landed,
    // SelectedChannelStore is settled, and this event also fires for a channel
    // the user is NOT looking at (scrolling loads more history, background
    // fetches). Requiring real focus is what keeps it from re-opening the
    // fan-out this phase closed.
    //
    // The FIRST load after a channel open is that open's own backlog — the
    // "tab back in after a game" case CHANNEL_SELECT was too early to serve —
    // so it gets the quality tier. Every load after it is the user scrolling
    // back through history, and gets the fast tier only: each such load hands
    // catch-up a fresh budget of never-before-seen messages, so nothing else in
    // the plugin bounds how much of the 20-requests-per-rolling-minute quota a
    // long scroll can spend. Those messages still get their Google `≈`
    // subtitle; they just do not get upgraded to `✦`.
    catchUp(channelId, { allowQuality: takeInitialHistory(channelId) });
}

const TEXT_COLOUR = "var(--text-default, var(--text-normal, #dbdee1))";

/**
 * How each engine's output is announced on the subtitle itself.
 *
 * With the engine gone from the cache key, a subtitle no longer implicitly
 * means "produced by whatever is currently configured" — a Google line and a
 * Gemini line sit side by side in the same channel. The glyph is the reader's
 * only way to tell a context-aware translation from an approximate one, which
 * matters most exactly when it differs from what they configured.
 *
 * One lookup keyed by EngineId rather than per-engine literals scattered
 * through the renderer: adding a fourth engine is one row here, and it is
 * impossible for the glyph and the hover text to disagree about which engine
 * they describe.
 */
const ENGINE_PROVENANCE: Record<EngineId, { glyph: string; label: string; }> = {
    // ≈ — approximate: per-message, no conversation context.
    google: { glyph: "≈", label: "Google Translate" },
    // ✦ — context-aware: batched, with a rolling window of recent messages.
    claude: { glyph: "✦", label: "Claude" },
    gemini: { glyph: "✦", label: "Gemini" },
    groq: { glyph: "✦", label: "Groq" }
};

/**
 * The short, human phrase for a `failed` hint's tooltip — "if it is cheap,
 * include a short human phrase... so the user can tell 'wait a minute' from
 * 'something is broken' without turning on debug logging." Reuses
 * `BeaconErrorCode` rather than inventing a second vocabulary, so this can
 * never drift from what the beacon itself already records — and, same as
 * that code, is never the engine's own (potentially remote-text-bearing)
 * error string.
 */
function describeFailureReason(code: BeaconErrorCode): string {
    switch (code) {
        case "rate-limited": return "rate limited";
        case "auth-rejected": return "rejected key";
        case "ipc-failed":
        case "engine-error":
        default: return "engine error";
    }
}

/**
 * What a `ForcedHint` renders as — glyph text plus a longer tooltip. Text
 * differs across all three kinds (not just the tooltip) so "wait a minute"
 * reads as visibly different from "something is wrong" even for a reader who
 * never hovers.
 */
function forcedHintDisplay(hint: ForcedHint): { text: string; title: string } {
    switch (hint.kind) {
        case "cooldown":
            return {
                text: "⚡ cooling down",
                title: "VcTranslate: this engine is cooling down after a rate limit — "
                    + "the request was never sent. Try ⚡ again in a moment."
            };
        case "gate":
            return {
                text: "⚡ rate limited",
                title: "VcTranslate: the request was still waiting for a rate-limit slot "
                    + "when it was superseded, so nothing was sent. Try ⚡ again."
            };
        case "failed":
            return {
                text: "⚡ translation failed",
                title: `VcTranslate: the request went out and failed (${describeFailureReason(hint.code)}).`
            };
    }
}

function TranslationAccessory({ message }: { message: Message; }) {
    const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);

    React.useEffect(() => {
        // Two independent publishers, same subscribe/notify shape: the
        // translation store's own subscribe() for the four resolved states,
        // and forcedInFlight's for the manual ⚡ click's transient "still
        // running" state (see the comment on `forcedInFlight`). Either firing
        // must re-render this message's accessory.
        const unsubStore = subscribe(forceUpdate);
        const unsubForced = subscribeForcedInFlight(forceUpdate);
        return () => {
            unsubStore();
            unsubForced();
        };
    }, []);

    if (!channelActive(message.channel_id)) return null;

    // No engine component: whatever engine produced this line, this is where
    // it is read from. That is what makes a Google-produced translation
    // visible while an LLM engine is selected.
    const key = makeKey(message.id, settings.store.targetLang);
    const entry: StoredTranslation | undefined = getTranslation(key);

    // A manual ⚡ click currently out for this message. Read AFTER the store
    // lookup above but used throughout below — this is the one thing in this
    // component that is not itself a StoredTranslation, so it is threaded
    // through every branch rather than folded into `entry`.
    const forcing = isForcedInFlight(message.id);
    // The transient, self-clearing outcome of the MOST RECENT manual click —
    // present only once `forcing` has already come back down (see
    // forceQualityTranslate/setForcedHint), so a stale hint from an earlier
    // click can never render alongside a fresh "⚡ translating…". Never read
    // when `forcing` is true, for exactly that reason.
    const hint = forcing ? undefined : forcedHintFor(message.id);

    if (!entry) {
        // Nothing to show yet — UNLESS a forced request is why: the reader
        // clicked ⚡ on a message that had never been translated at all (no
        // existing Google line to keep), and would otherwise see nothing
        // happen until the response lands, possibly several seconds away.
        if (forcing) {
            return (
                <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                    ⚡ translating…
                </div>
            );
        }
        // Same reasoning, once the click has SETTLED without a store write —
        // exactly the case a quality failure always produces (see runTier).
        // Automatic failures leave this branch returning null, unchanged.
        if (hint) {
            const { text, title } = forcedHintDisplay(hint);
            return (
                <div
                    style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontStyle: "italic" }}
                    title={title}
                >
                    {text}
                </div>
            );
        }
        return null;
    }

    // A skipped message is already in the target language: there is nothing to
    // subtitle. This MUST come before the failure branch — the marker exists so
    // catch-up can tell "resolved, nothing to show" from "never requested", and
    // falling through would label a perfectly fine message "translation
    // failed". Same "nothing to show, but a forced click just changed that"
    // exception as the no-entry branch above: `hasQualityVerdict()` still
    // offers ⚡ on a Google-only skip (see forceQualityPopoverRender), so this
    // is a real, reachable state, not a dead one.
    if ("skipped" in entry) {
        if (forcing) {
            return (
                <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                    ⚡ translating…
                </div>
            );
        }
        if (hint) {
            const { text, title } = forcedHintDisplay(hint);
            return (
                <div
                    style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontStyle: "italic" }}
                    title={title}
                >
                    {text}
                </div>
            );
        }
        return null;
    }

    // Colours come from Discord's own theme tokens rather than a bare opacity:
    // the accessory container already renders muted, so stacking an opacity on
    // top compounded into invisible text on the dark theme.
    //
    // The token chain matters. Discord renamed its primary text token, so
    // --text-normal no longer resolves in current builds; an unresolvable var()
    // invalidates the whole declaration and the text silently inherits the
    // container's muted colour, i.e. becomes unreadable. --text-default is the
    // current name, --text-normal the legacy one, and the literal is a
    // dark-theme-readable last resort if Discord renames it again.
    if ("failed" in entry) {
        return (
            <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                ⚠ translation failed
                {forcing && " · ⚡ translating…"}
                {!forcing && hint && (
                    <span title={forcedHintDisplay(hint).title}> · {forcedHintDisplay(hint).text}</span>
                )}
            </div>
        );
    }

    // A deferred message was never given a fair attempt. NOTHING WRITES THIS
    // ANY MORE: with a fast tier, a rate-limited quality tier leaves the
    // Google line in place rather than marking anything (see runTier), so the
    // only way one reaches the store today is a persisted cache written by an
    // earlier version. The branch stays because those entries are still read
    // back on the next launch and must not fall through to "⚠ translation
    // failed" — a message awaiting a retry is not a broken one. Same muted
    // token as the failure marker (this is still a "nothing to show yet"
    // line), different wording and glyph.
    if ("deferred" in entry) {
        return (
            <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                ⏳ translation delayed — retrying
                {forcing && " · ⚡ translating…"}
                {!forcing && hint && (
                    <span title={forcedHintDisplay(hint).title}> · {forcedHintDisplay(hint).text}</span>
                )}
            </div>
        );
    }

    // The prefix says both WHAT language this was and WHERE it came from. The
    // whole prefix stays on the muted token and the body on the --text-default
    // chain — same split as before, just with the provenance glyph replacing
    // the decorative ⤷. `title` spells the glyph out on hover, since a symbol
    // alone can't teach its own meaning.
    const provenance = ENGINE_PROVENANCE[entry.via];
    // Google reports how sure it is about the language it detected, and on
    // short replies it is often barely sure at all — "ne" came back as Hausa
    // at 0.217 and was rendered as "it is", the opposite of the German "no"
    // that was meant. A wrong translation reads exactly as fluently as a right
    // one, so the only defence is to say which is which.
    //
    // Confidence alone misses the worst case: Google reported 1.00 confidence
    // on romanized Moroccan Darija ("ana bghit nmchi l dar") while inverting a
    // negation. Script mismatch — a normally non-Latin language detected from
    // Latin-only text — is an independent signal that catches exactly that,
    // regardless of what confidence was reported. Only Google's own lines are
    // a script GUESS in the first place; an LLM result is never checked here.
    const romanized = isRomanizedGuess(entry.lang, message.content ?? "");
    const unsure = ENGINE_RANK[entry.via] === 0 && (
        (entry.conf !== undefined && entry.conf < MIN_DETECT_CONFIDENCE)
        || romanized
    );
    const langName = languageName(entry.lang);
    const title = !unsure
        ? `Translated by ${provenance.label} · ${langName}`
        : romanized
            ? `Translated by ${provenance.label}. This looks like ${langName} `
              + "written in Latin letters, which Google translates badly — "
              + "often confidently and wrongly. Wait for the ✦ line."
            : `Translated by ${provenance.label}. ${langName} detected, but only `
              + `${Math.round(entry.conf! * 100)}% confidently — short messages are `
              + "often misread, so this may be wrong.";

    // SPEC §7 STEP 4, and the only thing this project accepts as proof the
    // install works: a translation reached the screen. Everything else the
    // installer can see — the patch, the load, even a translation sitting in
    // the store — is also true of the install described in spec §6, where a
    // Discord frontend change leaves the mod loading and rendering nothing.
    //
    // A timestamp assignment and nothing else, which is what makes it safe in a
    // render body: no React state, no counter, so a StrictMode double render or
    // a concurrent re-render produces exactly the same beacon as one render.
    recordRendered();

    return (
        <div style={{ fontSize: "0.95rem", color: TEXT_COLOUR, fontStyle: "italic" }}>
            <span style={{ color: "var(--text-muted)" }} title={title}>
                {provenance.glyph} {entry.lang}{unsure ? "?" : ""} ·{" "}
            </span>
            {entry.text}
            {/*
              * ALONGSIDE the line above, never instead of it — a forced click
              * on a message that already carries a Google ≈ line (the common
              * case: ⚡ exists specifically to upgrade one) must not take that
              * readable line away while the request is out. Same muted token
              * as the provenance prefix, so this reads as a continuation of
              * it rather than a second, competing style. The settled-failure
              * hint gets the identical treatment once the click comes back
              * down — the ≈ line above is exactly what must never be taken
              * away in exchange for a failure the reader cannot act on.
              */}
            {forcing && (
                <span style={{ color: "var(--text-muted)" }}> · ⚡ translating…</span>
            )}
            {!forcing && hint && (
                <span style={{ color: "var(--text-muted)" }} title={forcedHintDisplay(hint).title}>
                    {" "}· {forcedHintDisplay(hint).text}
                </span>
            )}
        </div>
    );
}

/**
 * Registered separately from `messagePopoverButton` below, via the lower-level
 * `@api/MessagePopover` — the same real mechanism `messagePopoverButton`
 * itself is backed by (see `startPlugin`/`stopPlugin` in Vencord's
 * `PluginManager.ts`), just called under a second identifier. `definePlugin`'s
 * declarative field only ever holds ONE button, because PluginManager
 * registers it keyed by the plugin's own name; a second, independently
 * visible action needs its own key. This is not a new registration mechanism,
 * only a second use of the one Vencord already provides for exactly this.
 */
export const FORCE_QUALITY_POPOVER_ID = "VcTranslate-forceQuality";

/**
 * The ⚡ popover action: "spend one of the LLM's requests on THIS message,
 * right now." Distinct from the 🌐 channel toggle above (which is a per-CHANNEL
 * setting, no request involved) both in glyph — so the two are never confused
 * in the hover toolbar — and in what it does: a one-shot, per-MESSAGE spend.
 *
 * Hidden whenever it could not do anything useful:
 *  - no LLM is actually usable right now (`engine: "google"`, no key entered,
 *    or pinned to Google by an earlier auth failure — see `effectiveEngine()`)
 *    means there is no quality tier to force a message into at all;
 *  - the message already carries an LLM verdict (`hasQualityVerdict()`) — a
 *    real ✦ translation or an authoritative LLM skip — so another request
 *    could not improve on what is already there.
 *
 * Still shown for a message stuck on a `≈` Google line, however that
 * happened: scroll-back demoted it, the earlier automatic attempt failed and
 * `qualityAttempted` is refusing to retry it, or it simply has not been
 * reached yet. All three are exactly what this button exists to override.
 */
function forceQualityPopoverRender(message: Message) {
    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel) return null;

    const engine = effectiveEngine();
    if (!isLlmEngine(engine)) return null;

    const key = makeKey(message.id, settings.store.targetLang);
    if (hasQualityVerdict(key)) return null;

    const { label } = LLM_ENGINES[engine];

    // Say what pressing this would actually do — the user should not have to
    // look away at the chat-bar indicator (see QuotaIndicator below) to
    // decide whether ⚡ is worth clicking right now, and the wording has to
    // stay honest when the answer is "nothing" (cooling down, or not ready).
    //
    // Checked FIRST, ahead of the quota description: a request already out
    // for THIS message (the same inFlightQuality guard forceQualityTranslate
    // itself checks — automatic or a previous manual click) means a click
    // right now does nothing at all, which outranks readiness. Without this a
    // second click on a slow request was a silent no-op; see
    // TranslationAccessory's own `⚡ translating…` line for the same state
    // reflected on the message.
    //
    // Matches QuotaIndicator's own wording for the same three states
    // (ready / cooling / a wait) so the two can never disagree about what
    // pressing ⚡ is about to do — see that component's docs for why a
    // countdown, not a count, is the only number either of them shows.
    const quota = describeQuotaState(engine);
    const spendDescription = inFlightQuality.has(message.id)
        ? "already translating…"
        : quota.cooling
            ? `cooling down, ${formatCountdown(quota.remainingMs)} left`
            : quota.ready
                ? "ready to send now"
                : `not ready, ${formatCountdown(quota.remainingMs)} left`;

    return {
        label: `Translate with ${label} now (${spendDescription})`,
        icon: () => <span style={{ fontSize: "1rem" }}>⚡</span>,
        message,
        channel,
        onClick: () => {
            void forceQualityTranslate(message);
        }
    };
}

/**
 * The chat-bar quota indicator — "is ⚡ ready to send right now, and if not,
 * how long" — sitting next to the message input via Vencord's
 * `@api/ChatButtons` (`chatBarButton` below; see `src/api/ChatButtons.tsx` in
 * a Vencord checkout for the contract this implements).
 *
 * WHY THIS SHOWS READINESS, NOT A COUNT. It used to show this plugin's own
 * rate-gate token count — `✦ 3` — and a reader with no reason to know that
 * number was an internal pacing budget read it as "3 API calls remaining". On
 * a generous quota (Groq's free tier, 30 req/min) there is nothing to ration,
 * so the number was meaningless at best and actively misleading at worst: it
 * implied scarcity that was not real, from a figure the user could not spend
 * against anyway (⚡ enforces the real limits itself; the number was never
 * load-bearing for anything the user could do). A countdown is different —
 * it is the one number a reader can actually act on ("wait" vs. "don't") —
 * so that is the only number either this or the ⚡ label ever shows.
 *
 * WHAT DECIDES READY VS. WAIT still legitimately depends on the engine, and
 * the tooltip says why. For Claude and Gemini, readiness depends only on this
 * plugin's own pacing, because those providers report nothing about their
 * side. For an engine that DOES report its remaining quota on every response
 * (Groq — see `providerRemainingFor`), a request has to clear BOTH real
 * limits, so the provider's own figure can still make this show "not ready"
 * even while the internal pacing has room — the defect `describeQuotaState`'s
 * docs describe, now expressed as readiness rather than as a count.
 *
 * PRIORITY ORDER, exactly `describeQuotaState()`'s: cooling down (⚡ will not
 * work at all right now, however ready the pacing itself would otherwise say)
 * outranks a wait, which outranks nothing — rendering NOTHING is itself a
 * state: no LLM engine is configured, or one is but has no key, so there is
 * no quality tier to report readiness FOR at all, and a permanent indicator
 * would be noise rather than information. `effectiveEngine()` is what decides
 * that, so this also goes quiet for the third, less obvious case it already
 * covers — a key an engine has rejected this session (see `sessionFallback`)
 * — for the same reason: no request pressing ⚡ would send right now belongs
 * to a "quality tier" that, this session, does not exist.
 *
 * LIVE: neither the rate gate nor the cooldown store notifies on change (see
 * `rateGateAvailable()`'s and `cooldownUntil()`'s own docs — a read that
 * pushed updates would have to mutate state to schedule them, which is
 * exactly what a pure read must not do), so this component ticks itself,
 * once a second, for as long as it stays mounted — needed now more than ever,
 * since a live countdown (unlike a static count) is wrong the instant it
 * stops moving.
 */
function QuotaIndicator(_props: ChatBarProps & { isMainChat: boolean; isAnyChat: boolean; }) {
    const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        const id = setInterval(forceUpdate, 1_000);
        return () => clearInterval(id);
    }, []);

    const engine = effectiveEngine();

    const indicatorStyle = {
        fontSize: "0.85rem",
        color: "var(--text-muted)",
        padding: "0 4px",
        whiteSpace: "nowrap"
    } as const;

    /**
     * A rejected key gets its OWN state rather than no indicator at all.
     *
     * `effectiveEngine()` reports google once the pin is set, so this component
     * used to return null here — removing the only on-screen sign of the LLM
     * tier at precisely the moment something was wrong with it. The subtitles
     * kept appearing (Google still answers), so nothing looked broken; the
     * upgrade simply never came, with no way to find out why short of reading
     * the beacon file.
     */
    const configured = settings.store.engine as EngineId;
    if (sessionFallback && isLlmEngine(configured)) {
        return (
            <div
                style={indicatorStyle}
                title={
                    fallbackKind === "blocked"
                        ? `Subline could not reach ${LLM_ENGINES[configured].label} from this network — a VPN, `
                          + "region or ISP is refusing the connection, and the API key is not the problem. "
                          + "Google is being used meanwhile."
                        : `${LLM_ENGINES[configured].label} rejected the API key, so Subline is using Google. `
                          + "Correct the key in settings and the better translations resume — no restart needed."
                }
            >
                {fallbackKind === "blocked" ? "✦ blocked" : "✦ key rejected"}
            </div>
        );
    }

    if (!isLlmEngine(engine)) return null;

    const { label } = LLM_ENGINES[engine];
    const quota = describeQuotaState(engine);

    if (quota.cooling) {
        const countdown = formatCountdown(quota.remainingMs);
        return (
            <div
                style={indicatorStyle}
                title={
                    `VcTranslate: ${label} is cooling down after a rate limit — the ⚡ `
                    + `force-translate action will not send anything for another ${countdown}.`
                }
            >
                ✦ {countdown}
            </div>
        );
    }

    if (quota.ready) {
        return (
            <div
                style={indicatorStyle}
                title={
                    `VcTranslate: ${label} is ready — the ⚡ force-translate action will send `
                    + "immediately."
                }
            >
                ✦
            </div>
        );
    }

    // Not cooling, not ready: SOMETHING would refuse the request right now —
    // either this plugin's own pacing or (for an engine that reports its own
    // quota) the provider itself. `source` says which, so the explanation is
    // never a guess and never the wrong one: plainly this plugin's own pacing
    // when it is the plugin's own pacing, plainly the provider's own stated
    // quota when the provider itself is what is holding things up — that
    // second case is exactly the one the old `✦ N` presentation used to get
    // wrong, showing a plugin-budget number while the provider was the real
    // reason a request would fail.
    const countdown = formatCountdown(quota.remainingMs);
    const why = quota.source === "provider"
        ? `${label} itself reports no requests left in its current window`
        : `this plugin is pacing requests to ${label} to stay within safe usage limits`;

    return (
        <div
            style={indicatorStyle}
            title={`VcTranslate: ${why} — the ⚡ force-translate action will not send anything `
                + `for another ${countdown}.`}
        >
            ✦ {countdown}
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

    renderMessageAccessory: props => (
        <TranslationAccessory message={props.message} />
    ),

    // Declarative — unlike the force-quality popover above, this is the ONLY
    // chat-bar button this plugin registers, so it needs no second, manual
    // registration through the lower-level `@api/ChatButtons` functions;
    // PluginManager registers and unregisters this field itself, exactly as
    // it does `messagePopoverButton` below.
    chatBarButton: {
        icon: () => <span style={{ fontSize: "1rem" }}>✦</span>,
        render: QuotaIndicator
    },

    messagePopoverButton: {
        icon: () => <span style={{ fontSize: "1rem" }}>🌐</span>,
        render(message: Message) {
            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) return null;

            const on = channelActive(message.channel_id);
            return {
                label: on ? "Disable auto-translate here" : "Enable auto-translate here",
                icon: () => <span style={{ fontSize: "1rem" }}>{on ? "🌐" : "🌫"}</span>,
                message,
                channel,
                onClick: async () => {
                    try {
                        const nowOn = await toggleChannel(message.channel_id);
                        // `becomingFocused: true` — the user just clicked a
                        // button on a message in this channel and explicitly
                        // asked for it to be translated. That click is a
                        // stronger statement of intent than the focus check
                        // exists to infer, and it is the one place where
                        // spending the budget was directly requested.
                        if (nowOn) catchUp(message.channel_id, { becomingFocused: true });
                    } catch {
                        // toggleChannel rethrows on persistence failure (memory
                        // already rolled back by then) -- surface it instead of
                        // leaving an unhandled rejection. catchUp() is inside
                        // this try too, so a throw there can't escape unhandled
                        // either.
                        Toasts.show({
                            id: Toasts.genId(),
                            type: Toasts.Type.FAILURE,
                            message: "VcTranslate: couldn't save that toggle, try again."
                        });
                    }
                }
            };
        }
    },

    async start() {
        // Registered here (and removed in stop()) rather than left as a
        // static side effect of the module loading: the plugin can be
        // disabled and re-enabled without a Discord restart, and a button
        // still registered under a stopped plugin would call into handlers
        // that assume the batchers/subscriptions below exist.
        addMessagePopoverButton(
            FORCE_QUALITY_POPOVER_ID,
            forceQualityPopoverRender,
            () => <span style={{ fontSize: "1rem" }}>⚡</span>
        );

        // FIRST, before anything that can be slow or can fail. This is the
        // installer's "the mod loaded" signal (spec §7 step 3) and it is the
        // one thing that distinguishes a patched-but-inert Discord — spec §3b's
        // BetterDiscord install, where our patch verifies byte-perfect and none
        // of this code ever runs — from a live one. Recording it after the
        // awaits below would make a slow IndexedDB read look like a dead
        // install, and a failing one look like it forever.
        recordPluginLoaded();

        await loadEnabledChannels();
        // AWAITED, unlike the translation cache below: this decides whether the
        // very first batch of the session is even allowed to touch the LLM
        // engine. Reading it late would let that batch go out against a quota
        // we already know is exhausted — the exact wasted request, and the
        // unwanted rate-limit toast, that persisting the mark exists to stop.
        await loadCooldowns();
        // AWAITED for the same reason, one step further on: this decides at
        // what RATE the first batches of the session are allowed to go out.
        // Reading it late would let the session's opening burst leave under the
        // untaught defaults at a rate this project's quota has already been
        // proven not to allow — the 429 (and the toast) seconds after every
        // restart that persisting the learned quota exists to stop. Nothing
        // below this line can flush before it resolves: the batchers and the
        // Flux subscriptions are both built after it.
        await loadRateGateTuning();

        // Deliberately NOT awaited: a slow IndexedDB read must not hold up the
        // Flux subscriptions below, and loadPersistedTranslations() never
        // rejects — a failed read degrades to an empty cache (every message is
        // a miss, exactly as before this phase), never to a broken plugin.
        const cacheReady = loadPersistedTranslations();

        rebuildBatcher();
        onSettingsChanged(() => {
            // Order matters: lift a stale pin BEFORE rebuilding, so the new
            // batcher is built for the engine the user now has credentials for.
            releaseFallbackIfCredentialChanged();
            rebuildBatcher();
        });
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
        FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onMessagesLoaded);

        // Catch up whatever channel is already on screen. Both catch-up
        // triggers are events that already fired before we subscribed, so
        // enabling the plugin (or restarting Discord) while sitting in a
        // channel would otherwise translate nothing currently visible until
        // you navigated away and back.
        //
        // Sequenced after the cache load (rather than run immediately) so the
        // restart case actually costs nothing: running first would treat every
        // already-translated message on screen as a miss and re-request the
        // whole visible backlog, which is the exact spend persistence exists to
        // remove. start() still returns without waiting on it.
        void cacheReady.then(() => {
            // stop() may have run while the read was in flight; both batchers
            // are null exactly then, and enqueuing into a stopped plugin would
            // strand those ids in the in-flight sets for the next session.
            // fastBatcher always exists whenever the plugin is running
            // (rebuildBatcher() builds it unconditionally), so it alone is a
            // reliable check.
            if (fastBatcher === null) return;
            const openChannelId = SelectedChannelStore.getChannelId();
            if (!openChannelId) return;
            // Same standing as a CHANNEL_SELECT: this IS the channel being
            // opened, as far as the plugin is concerned, so the history load
            // that follows a restart still counts as this open's backlog and
            // keeps the quality tier. Only the SCROLLING after that is demoted.
            armInitialHistory(openChannelId);
            catchUp(openChannelId);
        });
    },

    stop() {
        removeMessagePopoverButton(FORCE_QUALITY_POPOVER_ID);
        onSettingsChanged(null);
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onMessageUpdate);
        FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect);
        FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", onMessagesLoaded);
        fastBatcher?.dispose();
        qualityBatcher?.dispose();
        fastBatcher = null;
        qualityBatcher = null;
        // Anything still marked in-flight belongs to a batcher that just got
        // disposed without flushing -- without this, those ids would stay
        // permanently unretryable across a stop/start cycle.
        inFlightFast.clear();
        inFlightQuality.clear();
        // Same reasoning: a stop() mid-request must not leave a message
        // stuck showing "⚡ translating…" forever across a stop/start cycle.
        if (forcedInFlight.size > 0) {
            forcedInFlight.clear();
            notifyForcedInFlight();
        }
        // Same reasoning, for the failure hint: a stopped plugin must not
        // leave a timer armed (it would fire into a torn-down module on the
        // next start()) or a hint that resurrects for a click that belonged
        // to a session already gone.
        if (forcedHints.size > 0 || forcedHintTimers.size > 0) {
            for (const timer of forcedHintTimers.values()) clearTimeout(timer);
            forcedHintTimers.clear();
            forcedHints.clear();
            notifyForcedInFlight();
        }
        // Toggling the plugin off and on is an explicit user action and a
        // natural retry boundary — the same one a restart provides — so the
        // quality tier's one-attempt-per-message budget resets with it.
        qualityAttempted.clear();
        // start() arms this again for whatever channel is on screen, so a
        // token left over from the previous session would only ever be a stale
        // claim on the quality tier.
        initialHistoryPending.clear();
        // Bump the generation so an in-flight request from before stop()
        // (e.g. a Claude call awaiting its response) fails its post-await
        // guard check in runTier and returns before ever reaching
        // fallBackToGoogle()/rebuildBatcher() — otherwise it could resurrect
        // a batcher (and re-set sessionFallback) on an already-stopped
        // plugin. Must happen so any myGeneration captured before this
        // point can never match again.
        batcherGeneration++;
        // So toggling the plugin off/on after fixing a bad key retries
        // Claude instead of staying pinned to Google.
        sessionFallback = false;
        fallbackPinnedFor = null;
        fallbackExpiresAt = null;
        // Session-scoped by design: a new session may have a different engine,
        // model or target language, and answers from the old one should not
        // silently survive into it.
        qualityPhrases.clear();
        // THE TWO CALLBACK LISTS. Both hold functions belonging to subtitle
        // components from the session being torn down. Nothing removed them:
        // stop() unsubscribed Flux and disposed the batchers, then left these
        // pointing at the previous session's screen elements — and fired them
        // twice on the way out, through the very set it was not clearing.
        //
        // Neither is persisted and neither has any reason to cross a session
        // boundary. They survived because "clear every global by hand" is a
        // convention, and a convention applied nineteen times out of twenty-one
        // looks exactly like one applied twenty-one times.
        forcedInFlightListeners.clear();
        // clearStore() has existed and worked the whole time, and the plugin
        // never called it — only the test harness did, which is why the tests
        // were better isolated than the shipped code. It drops the in-memory
        // cache too, which costs nothing: start() reloads it from disk via
        // loadPersistedTranslations(), and clearStore deliberately leaves disk
        // alone.
        clearStore();

        // Only the in-memory mirror. The persisted mark deliberately SURVIVES:
        // an exhausted quota is a fact about the API key, not about this
        // plugin session, so restarting Discord (or toggling the plugin off
        // and on) must not buy a fresh probe request. start() reads it back.
        __resetCooldowns();
        announcedMissingKey = false;
        announcedCooldown = false;
        // Wakes anything still queued behind the rate gate immediately
        // (rather than leaving it to time out on the next refill tick) and
        // refills it to full capacity for the next start(). Only the in-memory
        // tuning is dropped — like the cooldown mark above, the learned quota
        // is persisted and start() reads it back, so the next session does not
        // reopen the gate at the untaught defaults and buy a fresh 429.
        resetRateGate();
        // The provider's last reported remaining count. Dropped with the rest
        // of the in-memory session state and deliberately NOT persisted: it
        // describes a rate-limit window that has almost certainly rolled over
        // by the time anything reads it again, and a stale count shown as if
        // it were current is worse than showing the gate's own number.
        providerQuota = null;
        // Drops the session AND any armed coalescing timer, so a stopped plugin
        // cannot write a beacon afterwards. That matters for more than
        // tidiness: the beacon's `loadedAt` is what the installer compares
        // against its own launch time, so a write from a stopped plugin would
        // be vouching for a session that no longer exists.
        resetStatusBeacon();
    }
});
