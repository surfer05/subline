import type { IpcMainInvokeEvent } from "electron";

import { translateWithClaude, TRUNCATED_ERROR } from "./engines/claude";
import { translateWithGemini } from "./engines/gemini";
import { translateWithGoogle } from "./engines/google";
import { translateWithGroq } from "./engines/groq";
import { fetchRelayStatus, translateWithRelayDetailed } from "./engines/relay";
import type { ProviderRateLimit } from "./rateHint";
import { withRetry } from "./retry";
import { readStagedBuildIdSync } from "./stagedBuild";
import { writeStatusBeacon } from "./statusFile";
import type { BatchRequest, EngineId, Result } from "./types";

export type NativeResponse =
    | {
        ok: true;
        results: Result[];
        /**
         * What the PROVIDER said about our remaining allowance, when the
         * provider says anything at all (see rateHint.ts's
         * rateLimitFromHeaders — today that is Groq alone; Gemini and Claude
         * report nothing and leave this undefined).
         *
         * Takes the same route as `retryAfterMs` and `quotaLimitPerMinute`
         * below, and exists for the same reason: the engine is the only code
         * that ever sees a Response, so a number not carried here is a number
         * parsed and discarded. What is new is WHEN it arrives — those two are
         * salvage from a rejection, this rides on a SUCCESS, which is what
         * lets the renderer's quota indicator report the provider's own
         * remaining count instead of only ever the plugin's internal guess.
         */
        providerRateLimit?: ProviderRateLimit;
        /**
         * The per-minute CEILING the provider states for this credential, on
         * a success — today the relay alone (`rpmLimit`: 20 on a free code,
         * 60 on a paid one). Same name as the 429 field below because it is
         * the same fact and feeds the same retune (tuneRateGateToObservedLimit);
         * arriving on a success is what lets the gate reach the relay's real
         * rate without ever having to hit a 429 to learn it.
         */
        quotaLimitPerMinute?: number;
        /**
         * The TASTE tier's daily count, as the relay stated it on this
         * success: `quotaUsed` messages spent today out of `quotaCap` (three).
         *
         * Same route and same reason as `quotaLimitPerMinute` above — the
         * engine is the only code that ever sees a Response — but a different
         * consumer: this is what the ⚡ button reads to say "2 of 3 left
         * today" to a free install. Undefined for every other engine, and for
         * a paid code, which has no daily count worth showing.
         */
        quotaUsed?: number;
        quotaCap?: number;
    }
    | {
        ok: false;
        error: string;
        retryAfterMs?: number;
        quotaLimitPerMinute?: number;
        /**
         * The model a 429 said the quota was enforced against, when it said
         * so. Purely diagnostic: the renderer uses it to tell the user THIS
         * MODEL is unavailable on their key rather than "you are rate
         * limited". See rateHint.ts's modelFromGeminiBody.
         */
        quotaModel?: string;
    };

/**
 * What one engine call produced: the translations, plus anything the provider
 * volunteered about our remaining allowance.
 *
 * A UNIFORM shape for all four engines, even though only Groq ever fills the
 * second field. The alternative — dispatching to functions with two different
 * return types — would put a `typeof`/shape test in the retry path, which is
 * precisely where a mistake becomes "the batch silently returned nothing".
 */
interface EngineOutcome {
    results: Result[];
    rateLimit?: ProviderRateLimit;
    /** The per-minute ceiling the provider stated on this success (the relay's `rpmLimit`). */
    statedLimitPerMinute?: number;
    /** The relay's taste-tier daily count on this success (`used`/`cap`). */
    quotaUsed?: number;
    quotaCap?: number;
}

/**
 * Both engines report transport failures as `<engine>: HTTP <status>`.
 * One shared, strict extractor so the retry decision and the rate-limit
 * signal can never disagree about what a message means.
 */
function httpStatus(msg: string): number | undefined {
    const m = /\bHTTP (\d{3})\b/.exec(msg);
    return m ? Number(m[1]) : undefined;
}

/**
 * The `error` string below crosses the IPC boundary into the renderer, where it
 * may be logged or displayed. It is whatever an engine threw, so nothing
 * structurally stops a key ending up in it — today's engines are clean, but a
 * future one, or a dependency's error, need not be. Redact defensively.
 *
 * split/join rather than a regex: the key is arbitrary user input and must not
 * be interpreted as a pattern.
 *
 * No-op for an unset key. The blank check is `trim()`, not `length`: the google
 * path passes "", and a whitespace-only key is not a secret but WOULD otherwise
 * be a live separator — scrubbing on "   " would replace every three-space run
 * in an unrelated message with [redacted]. Guarding on length alone leaves that
 * hole open; splitting on "" would shred the message into single characters.
 * A trimmed-blank key redacts nothing. Any other key, however short, is
 * redacted in full — mangling a diagnostic beats leaking a credential, and the
 * raw (untrimmed) value is what the header carries, so that is what we match.
 */
function scrubKey(message: string, apiKey: string): string {
    if (apiKey.trim().length === 0) return message;
    return message.split(apiKey).join("[redacted]");
}

/** 4xx failures repeat identically on retry; 429 and everything else may not. */
function isRetryable(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    // A truncated response carries no HTTP status, so the "no status → retry"
    // default below would retry it — and the retry sends the same prompt with
    // the same output budget, truncating at exactly the same place. Pure
    // double spend for a guaranteed second failure.
    if (msg === TRUNCATED_ERROR) return false;
    const status = httpStatus(msg);
    if (status === undefined) return true; // network/parse error — one retry is worthwhile
    // A 429 is NOT retried here, for the same reason as TRUNCATED_ERROR above:
    // it is a guaranteed second failure at double the cost. The API states how
    // long to wait and it is far longer than any delay worth blocking an IPC
    // call for — 33s in one captured response, against this retry's 1s — so the
    // second attempt is rejected too, having consumed another request from the
    // very quota that is exhausted. Rate limiting is handled where it can be
    // handled properly: the renderer parks the engine for the interval the API
    // asked for. Nothing is re-sent or diverted — the fast tier put a Google
    // line on screen for these exact messages before the LLM was ever asked,
    // so a rate-limited batch costs the reader only the upgrade.
    if (status === 429) return false;
    return status < 400 || status >= 500;  // retry 5xx, never other 4xx
}

/**
 * The single dispatch point: engine id → engine call.
 *
 * Extracted from `translateBatch`'s retry closure so the per-engine argument
 * lists (which differ — Google takes no key, Claude takes no model) live in
 * one readable place, and so adding an engine is one branch here rather than a
 * longer expression inside a callback.
 */
async function runEngine(
    engine: EngineId,
    req: BatchRequest,
    apiKey: string,
    model: string | undefined,
    debug: boolean
): Promise<EngineOutcome> {
    // The relay states the ceiling for this code on every success; Groq is
    // the only engine that reports a remaining count of its own.
    if (engine === "relay") {
        const out = await translateWithRelayDetailed(req, apiKey, fetch);
        return {
            results: out.results,
            statedLimitPerMinute: out.rpmLimit,
            quotaUsed: out.used,
            quotaCap: out.cap
        };
    }
    if (engine === "groq") return translateWithGroq(req, apiKey, fetch, model, debug);
    if (engine === "claude") return { results: await translateWithClaude(req, apiKey, fetch, debug) };
    if (engine === "gemini") {
        return { results: await translateWithGemini(req, apiKey, fetch, model, debug) };
    }
    return { results: await translateWithGoogle(req) };
}

/**
 * `model` is meaningful for Gemini and Groq today. It crosses IPC as an argument
 * rather than being read here because settings live in the RENDERER — the main
 * process has no access to the plugin's settings store — so this is the same
 * route `apiKey` already takes. An empty/absent value means "whatever the
 * engine's default is" (see DEFAULT_GEMINI_MODEL in types.ts); the engine, not
 * this function, owns that fallback.
 */
export async function translateBatch(
    _: IpcMainInvokeEvent,
    engine: EngineId,
    apiKey: string,
    reqJson: string,
    model?: string,
    // Same route as `apiKey`/`model`, for the same reason (see their own
    // comments): the debugLogging setting lives in the RENDERER, and this
    // process cannot read it, so the renderer reads it once and passes the
    // answer down. Defaults false so every existing call site (and every test
    // that does not care about this) behaves exactly as it did before this
    // parameter existed.
    debug = false
): Promise<NativeResponse> {
    let req: BatchRequest;
    try {
        req = JSON.parse(reqJson) as BatchRequest;
    } catch {
        return { ok: false, error: "bad request payload" };
    }

    try {
        const outcome = await withRetry(
            () => runEngine(engine, req, apiKey, model, debug),
            { retries: 1, delayMs: 1000, shouldRetry: isRetryable }
        );
        // `providerRateLimit` is undefined for every engine that reports
        // nothing, which is what keeps this response byte-identical to the one
        // Gemini/Claude/Google produced before this field existed.
        return {
            ok: true,
            results: outcome.results,
            providerRateLimit: outcome.rateLimit,
            quotaLimitPerMinute: outcome.statedLimitPerMinute,
            quotaUsed: outcome.quotaUsed,
            quotaCap: outcome.quotaCap
        };
    } catch (err) {
        const raw = err instanceof Error ? err.message : "unknown error";
        // Surface rate limiting so the renderer can pause the queue. Extracted
        // from the RAW message, exactly as isRetryable saw it. Reading it off
        // the scrubbed string instead would let a degenerate key (one that
        // happens to contain "HTTP 429", or a substring of it) rewrite the
        // status out from under this check and desync the two decisions.
        // Scrubbing happens afterwards, and only for the value that leaves.
        //
        // The engine may have parsed the API's own retry hint (a `Retry-After`
        // header, or Gemini's RetryInfo body — see rateHint.ts) onto the error
        // as `retryAfterMs` (see httpError.ts). Prefer that real number over
        // the guessed 30s constant; fall back to the constant only when the
        // engine had no hint to offer.
        const rateLimited = httpStatus(raw) === 429;
        const hinted = (err as { retryAfterMs?: unknown })?.retryAfterMs;
        const retryAfterMs = rateLimited
            ? (typeof hinted === "number" ? hinted : 30_000)
            : undefined;

        // The quota the API says it just enforced, when it said so (see
        // rateHint.ts). Unlike retryAfterMs there is NO default: the renderer
        // retunes its rate gate from this, and inventing a ceiling would be
        // worse than keeping the one it already has.
        const limit = (err as { quotaLimitPerMinute?: unknown })?.quotaLimitPerMinute;
        const quotaLimitPerMinute = rateLimited && typeof limit === "number" && limit > 0
            ? limit
            : undefined;

        // The model the 429 named, when it named one (see rateHint.ts). Like
        // the quota there is no default — "no model stated" must stay
        // distinguishable from a named one, because the renderer says something
        // materially different in each case. Scrubbed on the same principle as
        // `error`: it is engine-supplied text on its way to the renderer.
        const named = (err as { quotaModel?: unknown })?.quotaModel;
        const quotaModel = rateLimited && typeof named === "string" && named !== ""
            ? scrubKey(named, apiKey)
            : undefined;

        return {
            ok: false,
            error: scrubKey(raw, apiKey),
            retryAfterMs,
            quotaLimitPerMinute,
            quotaModel
        };
    }
}

export type RelayStatusResponse =
    | { ok: true; plan: string; used: number; cap: number }
    | { ok: false; error: string };

/**
 * Today's taste count for one credential, read without spending one.
 *
 * Here for the same reason `translateBatch` is: THE RENDERER DOES NO NETWORK
 * for the relay, so the one place that holds a bearer and calls fetch is this
 * file. The credential is scrubbed out of any error on the way back, exactly as
 * `translateBatch` scrubs an API key — an install id is not a secret in the way
 * a key is, but it is the one identifier the taste tier sends and it has no
 * business in a log.
 *
 * Never throws: an unreachable status endpoint means "count unknown", and the
 * renderer treats unknown as "tastes may still be available" rather than taking
 * a free user's three away over a transient network fault.
 */
export async function relayStatus(
    _: IpcMainInvokeEvent,
    code: string
): Promise<RelayStatusResponse> {
    try {
        const status = await fetchRelayStatus(code, fetch);
        return { ok: true, plan: status.plan, used: status.used, cap: status.cap };
    } catch (err) {
        const raw = err instanceof Error ? err.message : "unknown error";
        return { ok: false, error: scrubKey(raw, code) };
    }
}

/**
 * Write the status beacon (see statusFile.ts / statusShape.ts).
 *
 * Here, and not in a module of its own, because THE RENDERER CANNOT WRITE
 * FILES and this file is already the plugin's answer to that: Vencord exposes
 * every export of `native.ts` on `VencordNative.pluginHelpers.VcTranslate`, so
 * `translateBatch` and this share one mechanism, one lifetime and one
 * permission story. A second channel (a preload, a stray ipcMain.handle) would
 * be a second thing to keep working across Vencord updates for no gain.
 *
 * `json` is a serialised beacon and is treated as untrusted: `writeStatusBeacon`
 * rebuilds it from whitelisted, type-checked fields before anything reaches
 * disk. That is deliberate — it is what makes spec §7's "never message text"
 * a property of the writer rather than a promise made by the caller.
 *
 * Returns whether the write landed, and never throws: a beacon is diagnostics,
 * and diagnostics must not become a new way for translation to fail.
 */
export async function reportStatus(_: IpcMainInvokeEvent, json: string): Promise<boolean> {
    return writeStatusBeacon(json);
}

/**
 * The build id of the mod bundle staged on disk (see stagedBuild.ts), or null.
 *
 * Same channel and same "never throws" contract as `reportStatus`: the
 * renderer cannot read files, so it asks the main process. The renderer
 * compares the answer against its compiled BUILD_ID to notice that the helper
 * has installed a newer build than the one currently running (updateNotice.ts).
 */
export async function readStagedBuildId(_: IpcMainInvokeEvent): Promise<string | null> {
    return readStagedBuildIdSync();
}
