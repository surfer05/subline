import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { ChannelStore, FluxDispatcher, LocaleStore, MessageStore, React, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";
import type { Message } from "@vencord/discord-types";

import { createBatcher, type Batcher } from "./batcher";
import { isChannelEnabled, loadEnabledChannels, toggleChannel } from "./channels";
import { __resetCooldowns, cooldownUntil, loadCooldowns, setCooldown } from "./cooldownStore";
import { isConfidentlyTargetLanguage } from "./detectLang";
import { acquireSlot, rateGateSettings, resetRateGate, tuneRateGateToObservedLimit } from "./rateGate";
import { isRomanizedGuess } from "./romanized";
import settings from "./settings";
import { onSettingsChanged } from "./settingsBridge";
import { shouldSkip } from "./skip";
import {
    getTranslation, invalidateMessage, loadPersistedTranslations, makeKey,
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
let sessionFallback = false;   // set when the configured LLM engine (Claude/Gemini) is unusable this session
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
 * The two key-gated engines, keyed by the setting that holds their API key
 * and the label used in the "no key set" / "rejected the key" toasts. A
 * lookup table rather than an `engine === "claude" || engine === "gemini"`
 * conditional in every function below — this is the one place that has to
 * know both engines exist, so a third key-gated engine only means one new
 * entry here rather than a growing tangle of per-function branches.
 */
const LLM_ENGINES = {
    claude: { keySetting: "anthropicApiKey", label: "Anthropic" },
    gemini: { keySetting: "geminiApiKey", label: "Gemini" }
} as const satisfies Record<string, { keySetting: "anthropicApiKey" | "geminiApiKey"; label: string }>;

type LlmEngineId = keyof typeof LLM_ENGINES;

function isLlmEngine(id: EngineId): id is LlmEngineId {
    return id === "claude" || id === "gemini";
}

/** The API key configured for a key-gated engine. */
function apiKeyFor(engine: LlmEngineId): string {
    return settings.store[LLM_ENGINES[engine].keySetting];
}

/** The engine actually in use — may differ from the configured one. */
function effectiveEngine(): EngineId {
    const configured = settings.store.engine as EngineId;
    if (!isLlmEngine(configured)) return configured;
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
function isCoolingDown(engine: LlmEngineId): boolean {
    return Date.now() < cooldownUntil(engine);
}

/** "45s" / "2m" — deliberately coarse; this is a toast, not a countdown. */
function formatDuration(ms: number): string {
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
    return `${Math.max(1, Math.round(ms / 60_000))}m`;
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
    quotaLimitPerMinute: number | undefined
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

    announceCooldownOnce(engine, cooldownMs);
}

/**
 * Same one-toast-per-session discipline as announceMissingKeyOnce(): a
 * catch-up storm can enter cooldown on several batches in a row, and a toast
 * per batch would be worse than the problem it describes.
 */
function announceCooldownOnce(engine: LlmEngineId, cooldownMs: number): void {
    if (announcedCooldown) return;
    announcedCooldown = true;
    const { label } = LLM_ENGINES[engine];
    Toasts.show({
        id: Toasts.genId(),
        type: Toasts.Type.FAILURE,
        message:
            `VcTranslate: ${label} is rate limited — translations are using Google ` +
            `(≈) for about ${formatDuration(cooldownMs)}.`
    });
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

/**
 * The ONLY way an engine result reaches the store. Two tiers write to the same
 * key from different latencies, so every write has to ask whether it is
 * actually an improvement — see upgrade.ts.
 */
function writeResult(key: string, value: StoredTranslation): void {
    if (mayReplace(getTranslation(key), value)) setTranslation(key, value);
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
async function runTier(
    engine: EngineId, req: BatchRequest, myGeneration: number
): Promise<void> {
    const isQuality = engine !== "google";
    // The in-flight set belonging to THIS tier. The other tier's request for
    // the same id (if any) is a separate round trip and settles on its own.
    const inFlightSet = isQuality ? inFlightQuality : inFlightFast;

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
        if (myGeneration !== batcherGeneration) return;

        // Cooling down after a 429: do not spend a request to be told so
        // again. Nothing is marked and nothing is diverted — the fast tier's
        // Google line for these same messages is already on screen.
        if (isQuality && isLlmEngine(engine) && isCoolingDown(engine)) return;

        // Only the LLM engines are rate-gated — Google is per-message with its
        // own concurrency cap (engines/google.ts) and was never the source of
        // the 429 storm this gate exists for.
        if (isQuality) {
            await acquireSlot();
            // stop()/rebuild may have happened while this flush sat behind the
            // gate (resetRateGate() wakes queued waiters immediately for
            // exactly that reason, rather than leaving them to time out on the
            // next refill tick). Re-check before spending a real request on a
            // batch nothing will ever read the result of.
            if (myGeneration !== batcherGeneration) return;
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
                JSON.stringify(engine === "google" ? withSourceLangs(req) : req)
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
        if (myGeneration !== batcherGeneration) return;

        if (res === null || !res.ok) {
            if (res !== null) {
                // Park the engine for as long as the API asked for. Still the
                // whole point of the cooldown: retrying into a wall that just
                // rejected us is how half the observed traffic became 429s.
                // (`retryAfterMs` is only ever set for a 429 — see native.ts.)
                if (isLlmEngine(engine) && res.retryAfterMs) {
                    enterCooldown(engine, res.retryAfterMs, res.quotaLimitPerMinute);
                }
                // An auth failure means the key is wrong, not that the network
                // blipped — retrying it every batch would be pure noise, so
                // fall back to Google for the rest of the session. Worth
                // telling the user about exactly once.
                if (isLlmEngine(engine) && /\b40[13]\b/.test(res.error)) {
                    fallBackToGoogle(`${LLM_ENGINES[engine].label} rejected the API key`);
                }
            }

            // Markers only from the FAST tier — and writeResult still refuses
            // to put one over a real line. An id with no entry at all is
            // indistinguishable from one that was never requested, so the fast
            // tier must leave SOMETHING resolved or catch-up re-requests it
            // forever.
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
            writeResult(key, { lang: r.lang, text: r.text, via: engine, conf: r.conf });
        }
    } finally {
        // Fires once this flush has fully settled, whichever way it went
        // (sent, skipped for cooldown, stranded by a rebuild, rejected). That
        // is the earliest point these ids are safe to retry — not when they
        // were queued, and not only on the happy path.
        for (const m of req.messages) inFlightSet.delete(m.id);
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
 */
function enqueue(pending: PendingMessage, isOwn: boolean) {
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
    if (isLocallySkipped(pending.text, isOwn)) {
        // Both rings: fastBatcher's is never actually read (it does not
        // support context) but recording into it is harmless, and
        // qualityBatcher may be null (Google-only). Whichever tier(s) end up
        // consuming context see a coherent conversation either way.
        fastBatcher?.recordContext(pending);
        qualityBatcher?.recordContext(pending);
        return;
    }

    announceMissingKeyOnce();

    const key = makeKey(pending.id, settings.store.targetLang);

    // Already queued or awaiting a response on that tier: the store shows a
    // miss for the whole round trip, so "no entry" must not be read as
    // "never requested". Checked and set per tier — a message is legitimately
    // in flight on both at once.
    if (!inFlightFast.has(pending.id) && needsFast(key)) {
        inFlightFast.add(pending.id);
        fastBatcher?.add(pending);
    }

    if (qualityBatcher && !inFlightQuality.has(pending.id) && needsQuality(key)) {
        inFlightQuality.add(pending.id);
        qualityBatcher.add(pending);
    }
    // No `else`: when qualityBatcher is null (no LLM configured), there is no
    // second ring to feed — fastBatcher never reads its own context (it does
    // not support it), so there is nothing useful to record here. (TS proves
    // this too: in this branch qualityBatcher is narrowed to exactly `null`,
    // so calling through it — even via `?.` — would be provably unreachable.)
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
    return shouldSkip(text, isOwn)
        || isConfidentlyTargetLanguage(text, settings.store.targetLang);
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

/**
 * `becomingFocused` is for the one caller that KNOWS this channel is the one
 * the user is now on, but cannot prove it through SelectedChannelStore:
 * CHANNEL_SELECT. Flux hands that event to store handlers and plugin
 * subscribers without a guaranteed order, so SelectedChannelStore may still be
 * reporting the PREVIOUS channel when we run. Gating on the store there would
 * mean cold-channel catch-up — the headline feature — silently never firing.
 * The event's own payload is the authoritative statement of "this is now the
 * selected channel", so that caller passes true and every other caller proves
 * focus the normal way.
 */
function catchUp(channelId: string, becomingFocused = false) {
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
        const quality = qualityBatcher !== null
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
            message.author?.id === me
        );
    }
}

function onChannelSelect({ channelId }: { channelId: string; }) {
    // This event IS the focus change, so it does not have to ask
    // SelectedChannelStore whether it has caught up yet.
    if (channelId) catchUp(channelId, true);
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
    catchUp(channelId);
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
    gemini: { glyph: "✦", label: "Gemini" }
};

function TranslationAccessory({ message }: { message: Message; }) {
    const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);

    React.useEffect(() => subscribe(forceUpdate), []);

    if (!channelActive(message.channel_id)) return null;

    // No engine component: whatever engine produced this line, this is where
    // it is read from. That is what makes a Google-produced translation
    // visible while an LLM engine is selected.
    const key = makeKey(message.id, settings.store.targetLang);
    const entry: StoredTranslation | undefined = getTranslation(key);
    if (!entry) return null;

    // A skipped message is already in the target language: there is nothing to
    // subtitle. This MUST come before the failure branch — the marker exists so
    // catch-up can tell "resolved, nothing to show" from "never requested", and
    // falling through would label a perfectly fine message "translation
    // failed".
    if ("skipped" in entry) return null;

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

    return (
        <div style={{ fontSize: "0.95rem", color: TEXT_COLOUR, fontStyle: "italic" }}>
            <span style={{ color: "var(--text-muted)" }} title={title}>
                {provenance.glyph} {entry.lang}{unsure ? "?" : ""} ·{" "}
            </span>
            {entry.text}
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
                        if (nowOn) catchUp(message.channel_id, true);
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
        await loadEnabledChannels();
        // AWAITED, unlike the translation cache below: this decides whether the
        // very first batch of the session is even allowed to touch the LLM
        // engine. Reading it late would let that batch go out against a quota
        // we already know is exhausted — the exact wasted request, and the
        // unwanted rate-limit toast, that persisting the mark exists to stop.
        await loadCooldowns();

        // Deliberately NOT awaited: a slow IndexedDB read must not hold up the
        // Flux subscriptions below, and loadPersistedTranslations() never
        // rejects — a failed read degrades to an empty cache (every message is
        // a miss, exactly as before this phase), never to a broken plugin.
        const cacheReady = loadPersistedTranslations();

        rebuildBatcher();
        onSettingsChanged(rebuildBatcher);
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
            if (openChannelId) catchUp(openChannelId);
        });
    },

    stop() {
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
        // Toggling the plugin off and on is an explicit user action and a
        // natural retry boundary — the same one a restart provides — so the
        // quality tier's one-attempt-per-message budget resets with it.
        qualityAttempted.clear();
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
        // Only the in-memory mirror. The persisted mark deliberately SURVIVES:
        // an exhausted quota is a fact about the API key, not about this
        // plugin session, so restarting Discord (or toggling the plugin off
        // and on) must not buy a fresh probe request. start() reads it back.
        __resetCooldowns();
        announcedMissingKey = false;
        announcedCooldown = false;
        // Wakes anything still queued behind the rate gate immediately
        // (rather than leaving it to time out on the next refill tick) and
        // refills it to full capacity for the next start().
        resetRateGate();
    }
});
