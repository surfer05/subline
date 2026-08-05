import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { ChannelStore, FluxDispatcher, LocaleStore, MessageStore, React, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";
import type { Message } from "@vencord/discord-types";

import { createBatcher, type Batcher } from "./batcher";
import { isChannelEnabled, loadEnabledChannels, toggleChannel } from "./channels";
import { __resetCooldowns, cooldownUntil, loadCooldowns, setCooldown } from "./cooldownStore";
import { isConfidentlyTargetLanguage } from "./detectLang";
import { acquireSlot, rateGateSettings, resetRateGate, tuneRateGateToObservedLimit } from "./rateGate";
import settings from "./settings";
import { onSettingsChanged } from "./settingsBridge";
import { shouldSkip } from "./skip";
import {
    getTranslation, invalidateMessage, loadPersistedTranslations, makeKey,
    setTranslation, subscribe, type StoredTranslation
} from "./store";
import {
    FAST_DEBOUNCE_MS, FAST_MAX_BATCH, MIN_DETECT_CONFIDENCE,
    QUALITY_DEBOUNCE_MS, QUALITY_MAX_BATCH, SHORT_TEXT_MAX,
    type BatchRequest, type EngineId, type PendingMessage
} from "./types";
import { mayReplace } from "./upgrade";

const Native = VencordNative.pluginHelpers.VcTranslate as PluginNative<typeof import("./native")>;
const logger = new Logger("VcTranslate");

// Two independent pipelines over the same messages. The fast one exists so the
// reader never sits in front of an untranslated message; the quality one
// exists so what they end up reading is right. Neither waits on the other.
let fastBatcher: Batcher | null = null;
let qualityBatcher: Batcher | null = null;
let sessionFallback = false;   // set when the configured LLM engine (Claude/Gemini) is unusable this session
let announcedMissingKey = false;   // one toast per session, never per batch
let announcedCooldown = false;     // ditto, for the rate-limit-to-Google fallback

// Ids currently queued in the batcher or awaiting a translateBatch response.
// getTranslation() alone can't tell "in flight" apart from "never
// requested" -- a message is a cache miss for the WHOLE round trip (700ms
// debounce plus several seconds of network for Claude), not just briefly.
// Populated wherever a message is handed to batcher.add(), and drained in
// onFlush once that request settles (success, failure, or stranded by a
// rebuild) so it becomes retryable again.
const inFlight = new Set<string>();

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
 * The batch that triggered this is NOT lost: the caller re-runs it through
 * Google immediately.
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
 * Where enqueue() and catch-up currently hand off messages. Both batchers
 * already exist side by side (see rebuildBatcher), but wiring every message
 * to BOTH at once — the actual two-tier behaviour — is Task 3's job. Until
 * then this reproduces today's single pipeline: the quality tier when one is
 * configured and usable, the fast (Google) tier otherwise.
 */
function currentBatcher(): Batcher | null {
    return qualityBatcher ?? fastBatcher;
}

/**
 * Sends one flushed batch to `engine` and writes whatever comes back.
 *
 * This is exactly today's single onFlush body, just parameterised over which
 * engine (and which batcherGeneration) the flush belongs to, so both the fast
 * and the quality batcher can share it. The fallback shape — cooldown
 * diversion, 401 handling, deferred-vs-failed — is untouched; Task 5 owns
 * rewriting that. The one change here is that a real translation result is
 * now written through writeResult() instead of a bare setTranslation(), since
 * two tiers can now race for the same key.
 */
async function runTier(engine: EngineId, req: BatchRequest, myGeneration: number): Promise<void> {
    const markAllFailed = (r: { messages: { id: string }[]; targetLang: string; }) => {
        for (const m of r.messages) {
            setTranslation(makeKey(m.id, r.targetLang), { failed: true });
        }
    };

    // For a batch that was never attempted, or was rejected before the model
    // ever saw it (rate-limited). Not a translation failure — nothing about
    // the translation itself went wrong — so it must render and retry
    // differently from `failed`. See store.ts's StoredTranslation comment.
    const markAllDeferred = (r: { messages: { id: string }[]; targetLang: string; }) => {
        for (const m of r.messages) {
            setTranslation(makeKey(m.id, r.targetLang), { deferred: true });
        }
    };

    // `null` means the IPC call itself rejected — distinct from an
    // `ok: false` response, which is an engine-level failure the
    // native side successfully reported.
    const send = async (target: EngineId) => {
        try {
            return await Native.translateBatch(
                target,
                isLlmEngine(target) ? apiKeyFor(target) : "",
                JSON.stringify(target === "google" ? withSourceLangs(req) : req)
            );
        } catch {
            // onFlush is void-returning and invoked un-awaited, so an
            // unhandled rejection here would otherwise just vanish the
            // batch with no marker.
            return null;
        }
    };

    try {
        // Superseded by a later rebuild (settings changed, or a
        // fallback fired) before this flush even started — this
        // closure's `engine` no longer matches reality, so just drop
        // it rather than write under a stale key. The finally below
        // still releases the ids: a batch stranded here that stayed
        // "in flight" forever could never be retried by catch-up.
        if (myGeneration !== batcherGeneration) return;

        // THE fallback decision. An LLM engine that cannot serve this
        // batch — cooling down after a 429, or with no key — is not a
        // reason to show the user nothing. Google is worse; nothing is
        // worse still. `runEngine` is what the request is ACTUALLY sent
        // to and what gets recorded as `via`, so the ≈/✦ glyph stays
        // honest about which engine produced the line.
        //
        // (The no-key case already resolves to "google" in
        // effectiveEngine(), so `engine` is google here and this
        // condition simply doesn't fire.)
        let runEngine: EngineId = engine;
        if (isLlmEngine(engine) && isCoolingDown(engine)) runEngine = "google";

        // Only the two key-gated LLM engines are rate-gated — Google is
        // per-message with its own concurrency cap (engines/google.ts)
        // and was never the source of the 429 storm this gate exists
        // for. Gated on runEngine, not engine: a batch being diverted
        // to Google must not also burn an LLM token.
        if (isLlmEngine(runEngine)) {
            await acquireSlot();
            // stop()/rebuild may have happened while this flush sat
            // behind the gate (resetRateGate() wakes queued waiters
            // immediately for exactly that reason, rather than leaving
            // them to time out on the next refill tick). Re-check
            // before spending a real request on a batch nothing will
            // ever read the result of.
            if (myGeneration !== batcherGeneration) return;
        }

        let res = await send(runEngine);

        // THE race this guard exists for: rebuildBatcher() can run
        // WHILE the line above is awaiting the network round trip (a
        // settings change, or an LLM engine's 401 triggering
        // fallBackToGoogle mid-flight). The check before the await
        // only catches a flush that was already stale when it started
        // — it cannot catch one that went stale during the await.
        // Re-check before any write, so a superseded response is
        // dropped instead of landing under the old engine's key (or
        // worse, clobbering the new engine's in-progress results).
        if (myGeneration !== batcherGeneration) return;

        // The LLM engine just told us it is rate limited. Park it (see
        // enterCooldown) and serve THIS batch from Google rather than
        // handing the reader a pending marker: a mediocre translation
        // now beats a good one that never arrives.
        let rateLimitedToGoogle = false;
        if (res !== null && !res.ok && isLlmEngine(runEngine) && res.retryAfterMs) {
            enterCooldown(runEngine, res.retryAfterMs, res.quotaLimitPerMinute);
            rateLimitedToGoogle = true;
            runEngine = "google";
            res = await send(runEngine);
            if (myGeneration !== batcherGeneration) return;
        }

        if (res === null) {
            markAllFailed(req);
            return;
        }

        if (!res.ok) {
            // Always mark this batch's messages as resolved on a
            // request-level error, regardless of cause — an auth
            // failure must not leave them silently unresolved just
            // because it ALSO triggers a session fallback.
            //
            // `deferred` is now the narrow case it was always meant to
            // be: the message was never given a fair attempt. That is
            // true when the request was rate-limited (`retryAfterMs` is
            // only ever set for a 429, see native.ts) and when the
            // Google fallback above ALSO failed. Anything else is a
            // genuine attempt that came back broken, i.e. `failed`.
            if (rateLimitedToGoogle || res.retryAfterMs) {
                markAllDeferred(req);
            } else {
                markAllFailed(req);
            }

            // An auth failure means the key is wrong, not that the
            // network blipped — retrying it every batch would be pure
            // noise, so fall back to Google for the rest of the session
            // IN ADDITION to (not instead of) marking this batch failed.
            if (isLlmEngine(runEngine) && /\b40[13]\b/.test(res.error)) {
                fallBackToGoogle(`${LLM_ENGINES[runEngine].label} rejected the API key`);
            }
            return;
        }

        for (const r of res.results) {
            if ("failed" in r) {
                setTranslation(makeKey(r.id, req.targetLang), { failed: true });
                continue;
            }
            if (r.skip) {
                // A skip has nothing to DISPLAY, but something must
                // still be WRITTEN. An id with no entry is
                // indistinguishable from one that was never requested,
                // so leaving it blank made every
                // already-in-the-target-language message a permanent
                // cache miss: catch-up re-enqueued the entire backlog
                // on every single channel open, forever. In a
                // mixed-language chat most messages ARE already in the
                // target language, so that was the common case, not the
                // edge case — free on Google, real recurring spend on
                // Claude.
                setTranslation(makeKey(r.id, req.targetLang), { skipped: true });
                continue;
            }
            // `runEngine`, NOT the configured engine: the one the
            // request was actually sent to, already re-validated
            // against batcherGeneration above. Recording it in the
            // value is what survives the engine no longer being part of
            // the key — and it is what makes a fallback line render as
            // ≈ (Google, approximate) instead of claiming ✦. Routed
            // through writeResult(): the fast and quality tiers write the
            // same key from different latencies, so this one write has to
            // ask whether it is actually an improvement.
            writeResult(
                makeKey(r.id, req.targetLang),
                { lang: r.lang, text: r.text, via: runEngine, conf: r.conf }
            );
        }
    } finally {
        // Fires once this flush has fully settled, whichever way it
        // went (sent, diverted, stranded by a rebuild, rejected). That
        // is the earliest point these ids are safe to retry — not when
        // they were queued, and not only on the happy path.
        for (const m of req.messages) inFlight.delete(m.id);
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

    // Orphans are still marked in flight from their first pass. enqueue()
    // early-returns on that, which would silently drop every message caught
    // mid-debounce by a settings change — no entry, no marker, no retry.
    // Releasing the marks first is what makes the re-queue actually re-queue.
    for (const m of orphaned) inFlight.delete(m.id);
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
        currentBatcher()?.recordContext(pending);
        return;
    }
    // Already queued or awaiting a response: the store shows a miss for the
    // whole round trip, so "no entry" must not be read as "never requested".
    if (inFlight.has(pending.id)) return;

    announceMissingKeyOnce();
    inFlight.add(pending.id);
    currentBatcher()?.add(pending);
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
    // regardless of what kind of update this is.
    invalidateMessage(message.id);

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

        // A message already queued or awaiting a response is a cache miss
        // in getTranslation() for the whole round trip, not just briefly --
        // so a duplicate catch-up trigger (rapid channel reselection, or
        // CHANNEL_SELECT followed by LOAD_MESSAGES_SUCCESS for the same
        // channel) must not treat "no cache entry yet" as "never requested".
        if (inFlight.has(message.id)) continue;

        const key = makeKey(message.id, settings.store.targetLang);
        const entry = getTranslation(key);
        // Four resolved states, two of which are worth retrying. A real
        // translation is done — whichever engine produced it. That is the
        // deliberate consequence of dropping the engine from the key: a
        // message Google already translated is NOT re-requested just because
        // Gemini is now selected. Re-translating what the user has already
        // read would spend the LLM budget on the one thing it is least needed
        // for. A `{ skipped: true }` marker means the engine already told us
        // the message is in the target language — also done, and re-asking
        // would produce the same answer at the same cost.
        // `{ failed: true }` (a genuine attempt that came back broken) and
        // `{ deferred: true }` (never attempted, or rate-limited before the
        // model saw it) both get another attempt — a deferred message that
        // catch-up never retries is worse than the failed-forever bug this
        // whole scheme replaces. Both are engine-agnostic too: a failure
        // recorded under Google is retried under Gemini and vice versa.
        if (entry && !("failed" in entry) && !("deferred" in entry)) continue;

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

    // A deferred message was never given a fair attempt: the LLM engine was
    // rate limited AND the Google fallback did not come through either. It
    // will be retried, so it must NOT read as broken the way `failed` does.
    // Same muted token as the failure marker (this is still a "nothing to show
    // yet" line, not a real subtitle), different wording and glyph so a
    // rate-limited catch-up storm doesn't look like the plugin failing on
    // every message in it. Since the Google fallback landed this is now the
    // rare case rather than the routine one.
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
    const unsure = entry.conf !== undefined && entry.conf < MIN_DETECT_CONFIDENCE;
    const langName = languageName(entry.lang);
    const title = unsure
        ? `Translated by ${provenance.label}. ${langName} detected, but only `
          + `${Math.round(entry.conf! * 100)}% confidently — short messages are `
          + "often misread, so this may be wrong."
        : `Translated by ${provenance.label} · ${langName}`;

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
            // strand those ids in `inFlight` for the next session. fastBatcher
            // always exists whenever the plugin is running (rebuildBatcher()
            // builds it unconditionally), so it alone is a reliable check.
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
        inFlight.clear();
        // Bump the generation so an in-flight request from before stop()
        // (e.g. a Claude call awaiting its response) fails its post-await
        // guard check in onFlush and returns before ever reaching
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
