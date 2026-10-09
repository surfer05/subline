/**
 * The Subline translation relay.
 *
 * Holds the maker's paid upstream key (OpenRouter, with the direct Groq key as
 * the fallback); serves keyless AI translation to Subline
 * clients that present an opaque per-user CODE. Zero-retention (no request or
 * response body is ever logged — see metrics.ts, the only observability path)
 * and zero-identity (the code carries no name; the Merchant-of-Record holds the
 * email, the relay holds only the opaque code and counters).
 *
 * It returns the plugin's EXACT NativeResponse shape, so the client's `relay`
 * engine drops into native.ts with no reshaping:
 *   { ok: true,  results, used?, cap? }
 *   { ok: false, error, retryAfterMs? }
 *
 * THE RELAY OWNS THE MODEL AND THE PROMPT. A client sends only the structured
 * batch (messages + context + target). It cannot choose the model, inject a
 * system prompt, or reach the key — which is what makes a keyless relay safe to
 * expose. A valid code is not a general Groq proxy.
 */
import {
    authCode, reserve, refund, refundGroup, usage, mintCode, applyMorEvent, rpmLimitFor, costFor, budgetCostFor,
    isTasteBearer, isNewClient, resolveFreePlan, startTrial, tasteRecord, freezeAtFor,
    type Env, type CodeRecord, type FreePlan
} from "./codes";
import { translateBatch, toPreview, clipParent, type BatchRequest, type FallbackError, type Provider, type Result } from "./translate";
import { record, type Outcome } from "./metrics";
import { installOf, isApiV2, legacyFreeAllowed, PREVIEW_DAILY_CAP, resolveEntitlement } from "./entitle";
import { adminReissue, adminResetInstalls, createPromo, handleRedeem, handleStatusV2, promoStats } from "./v2";
import { bumpStat, markActive, safely, clampDays, readStats } from "./stats";
import { createCoupon, handleCheckout, handlePurchaseStatus, purchaseFor } from "./checkout";
import { readCapped } from "./body";
import { dayRowKey, type ReserveReq } from "./budget";
import { adminPatchHealth, handlePatchHealth } from "./patchHealth";
export { Budget } from "./budget";
export { Promo } from "./promo";
export { PatchHealth } from "./patchHealth";

const MAX_MESSAGES = 40;     // client's QUALITY_MAX_BATCH is 25; headroom, not unbounded
const MAX_CONTEXT = 12;      // client's context ring is 8; a big context is a cost-inflation vector
/** Covers a full batch from a v0.2.0 client already in the field (no byte
 *  budget of its own: 25 long CJK messages ran to ~34 KB and every message in
 *  it was refused). Newer clients split at ~30 KB (fitRequest.ts). Kept
 *  moderate on purpose: a preview is counted per message, so a much bigger body
 *  would let one counted preview carry far more upstream spend. A body this
 *  big is split into parallel upstream calls (translateBatch), so it fits the
 *  request's time budget instead of timing out on both providers. */
const MAX_BODY_BYTES = 131_072;
const MAX_TEXT_CHARS = 4_000;
/** A context line only steers the model; its first part does that. */
const MAX_CONTEXT_TEXT_CHARS = 1_000;
const MAX_AUTHOR_CHARS = 100;
/** Context characters in all; the oldest lines go first past this. */
const MAX_CONTEXT_CHARS = 6_000;
const MAX_TARGET_CHARS = 40; // a language name; anything longer is an injection payload
/** A reply link's id: a Discord snowflake, or any short plain id a test uses. */
const REPLY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** Characters of reply-parent copies (text + author) in one batch. */
export const MAX_REPLY_PARENT_TOTAL = 2_000;
/** The whole upstream budget of one request. A long batch is split into
 *  chunks that run at once (translate.ts translateBatch); each chunk's primary
 *  gets primaryTimeoutFor(chunk) of this (9 to 20 s), its fallback the rest (6
 *  s or more). The plugin waits 30 s for the relay (0.2.1+), so this leaves it
 *  about 4 s for the relay's own KV work and the network. */
const REQUEST_TIMEOUT_MS = 26_000;
const GROQ_FALLBACK_MODEL = "openai/gpt-oss-120b";

/** Resolve which upstream answers this request, as an explicit Provider.kind —
 *  never a regex on the model id, because OpenRouter and Groq serve the SAME
 *  "openai/gpt-oss-120b" through different endpoints and keys.
 *
 *  The routing, in order:
 *    1. MODEL is a `gemini*` id AND GEMINI_KEY is set → Gemini primary, with
 *       OpenRouter (else the direct Groq key) as the fallback.
 *    2. OPENROUTER_KEY is set → OpenRouter primary on env.MODEL, pinned to
 *       Groq's hosting inside translate.ts, with the direct Groq key as the
 *       automatic fallback (only when GROQ_KEY is actually set). This is the
 *       launch setting: Groq's Developer upgrade is closed, so the direct key is
 *       capped at the free tier's daily tokens, while OpenRouter is pay as you
 *       go on the same model.
 *    3. Neither → Groq-only, exactly as before.
 *
 *  A `gemini*` MODEL is never handed to an OpenAI-shaped provider: those get
 *  FALLBACK_MODEL instead, which also guards the misconfig where MODEL names
 *  Gemini but GEMINI_KEY was never set (that would 401 every call). */
export function providers(env: Env): { primary: Provider; fallback: Provider | null } {
    const fallbackModel = env.FALLBACK_MODEL || GROQ_FALLBACK_MODEL;
    const wantsGemini = /^gemini/i.test(env.MODEL || "");
    const openAiModel = wantsGemini ? fallbackModel : (env.MODEL || GROQ_FALLBACK_MODEL);

    const groq: Provider | null = env.GROQ_KEY
        ? { kind: "groq", apiKey: env.GROQ_KEY, model: fallbackModel }
        : null;
    const openrouter: Provider | null = env.OPENROUTER_KEY
        ? { kind: "openrouter", apiKey: env.OPENROUTER_KEY, model: openAiModel }
        : null;

    if (wantsGemini && env.GEMINI_KEY) {
        return { primary: { kind: "gemini", apiKey: env.GEMINI_KEY, model: env.MODEL }, fallback: openrouter ?? groq };
    }
    if (openrouter) return { primary: openrouter, fallback: groq };
    // Groq-only. Keeps the pre-OpenRouter behaviour byte for byte, including the
    // gemini-without-a-key misconfig falling back to the Groq fallback model.
    return {
        primary: { kind: "groq", apiKey: env.GROQ_KEY, model: wantsGemini ? fallbackModel : openAiModel },
        fallback: null
    };
}

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** { ok:false } in the plugin's shape. */
const fail = (error: string, status: number, retryAfterMs?: number): Response =>
    json(retryAfterMs === undefined ? { ok: false, error } : { ok: false, error, retryAfterMs }, status);

function bearer(req: Request): string | null {
    const h = req.headers.get("authorization") || "";
    return h.startsWith("Bearer ") ? h.slice(7).trim() || null : null;
}

/** Constant-time compare over fixed-length SHA-256 digests, so neither the
 *  length nor the content of the secret leaks through timing. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
    const e = new TextEncoder();
    const [ha, hb] = await Promise.all([
        crypto.subtle.digest("SHA-256", e.encode(a)),
        crypto.subtle.digest("SHA-256", e.encode(b))
    ]);
    const va = new Uint8Array(ha), vb = new Uint8Array(hb);
    let out = 0;
    for (let i = 0; i < 32; i++) out |= va[i]! ^ vb[i]!;
    return out === 0;
}

/** Base64-encode raw bytes (the Standard-Webhooks signature encoding). */
function bytesToBase64(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

/** Decode a Standard-Webhooks signing secret to its raw HMAC key bytes: strip
 *  the optional `whsec_` prefix, then base64-decode the remainder. Throws on a
 *  malformed (non-base64) secret so the caller can 503 rather than 401. */
function decodeSecret(secret: string): Uint8Array {
    const b64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const bin = atob(b64); // throws on invalid base64 ⇒ treated as misconfig upstream
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** A checked batch: what goes upstream, plus the ids refused on their own. */
export interface NormalizedBatch { batch: BatchRequest; tooLong: string[] }

/**
 * Check a batch's SHAPE and bound what it costs, refusing as little as
 * possible. A malformed body is null (400). Otherwise:
 *   - a message over MAX_TEXT_CHARS is answered {id, failed:true} on its own
 *     (tooLong) instead of failing every message beside it;
 *   - context is never a reason to refuse: each line is clipped, only the
 *     newest MAX_CONTEXT lines are kept, and the oldest go until the context
 *     fits MAX_CONTEXT_CHARS. A long post sitting in the client's 8-line ring
 *     used to fail every following batch in that channel.
 * Clipping context only steers the model less; it never changes what a
 * translation is labelled.
 */
export function normalizeBatch(v: unknown): NormalizedBatch | null {
    if (!v || typeof v !== "object") return null;
    const b = v as any;
    if (!Array.isArray(b.messages) || !Array.isArray(b.context) || typeof b.targetLang !== "string") return null;
    // Target language is untrusted and interpolated into the prompt: bound it
    // hard. A real target is a short name/code with no line breaks; anything
    // else is an injection attempt (translate.ts also enc()-escapes it).
    if (b.targetLang.length === 0 || b.targetLang.length > MAX_TARGET_CHARS) return null;
    if (/[\u0000-\u001f]/.test(b.targetLang)) return null;
    if (b.messages.length === 0 || b.messages.length > MAX_MESSAGES) return null;
    const messages: BatchRequest["messages"] = [];
    const tooLong: string[] = [];
    // R3: reply links. Never a reason to refuse: a malformed link is dropped
    // and the message is translated without it. The id must look like an id
    // and not point at the message itself; the parent copy is clipped, and
    // past MAX_REPLY_PARENT_TOTAL characters in all, later copies are dropped
    // (the link by id, when the parent is in the batch, still stands).
    let parentChars = 0;
    for (const m of b.messages) {
        if (!m || typeof m.id !== "string" || typeof m.text !== "string") return null;
        if (m.author !== undefined && typeof m.author !== "string") return null;
        if (m.text.length > MAX_TEXT_CHARS) { tooLong.push(m.id); continue; }
        const out: BatchRequest["messages"][number] = { id: m.id, text: m.text, ...(m.author !== undefined ? { author: clip(m.author, MAX_AUTHOR_CHARS) } : {}) };
        messages.push(out);
        if (typeof m.replyToId !== "string" || !REPLY_ID_RE.test(m.replyToId) || m.replyToId === m.id) continue;
        out.replyToId = m.replyToId;
        const p = m.replyTo;
        if (!p || typeof p !== "object" || typeof p.text !== "string" || p.text.trim() === "") continue;
        const text = clipParent(p.text);
        const author = typeof p.author === "string" ? clip(p.author, MAX_AUTHOR_CHARS) : "";
        if (parentChars + text.length + author.length > MAX_REPLY_PARENT_TOTAL) continue;
        parentChars += text.length + author.length;
        out.replyTo = { author, text };
    }
    for (const c of b.context) {
        if (!c || typeof c.text !== "string" || typeof c.author !== "string") return null;
    }
    let context: BatchRequest["context"] = b.context.slice(-MAX_CONTEXT).map((c: any) => ({
        author: clip(c.author, MAX_AUTHOR_CHARS),
        text: c.text.length > MAX_CONTEXT_TEXT_CHARS ? clip(c.text, MAX_CONTEXT_TEXT_CHARS) + "…" : c.text
    }));
    const size = (cs: BatchRequest["context"]) => cs.reduce((n, c) => n + c.text.length + c.author.length, 0);
    while (context.length > 0 && size(context) > MAX_CONTEXT_CHARS) context = context.slice(1);
    // force: the reader pressed ⚡ (or Preview ✦) on these messages and wants
    // them translated even where the model would normally skip. Only an exact
    // `true` counts. A preview may be forced too: it is counted per message,
    // and a counted preview that came back "skip" showed the reader nothing.
    const force = b.force === true;
    return { batch: { messages, context, targetLang: b.targetLang, ...(force ? { force: true } : {}) }, tooLong };
}

/** The first `max` UTF-16 units of `s`, never splitting a surrogate pair. */
function clip(s: string, max: number): string {
    if (s.length <= max) return s;
    const code = s.charCodeAt(max - 1);
    return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * The v0.1.6 keyless plan for this request. A legacy (v0.1.5) client sends no
 * `x-subline-client`, so it gets `free: null` and the record authCode already
 * gave it — byte-identical to before, with no trial: KV read or write. A new
 * client's well-formed free_ bearer is resolved to trial-or-taste, READ-ONLY
 * (an unseen id is a provisional trial; see startTrial for when it is written).
 *
 * If that lookup itself fails (KV hiccup) the request degrades to the legacy
 * taste record rather than failing, and `freeFailed` says so: the router then
 * refuses mode:"auto" (it cannot tell a trial from an ended one, and must not
 * let an automatic press spend the hand-pressed taste messages) while a press
 * by hand still gets taste. `newClient` is the header check on its own, which
 * decides whether a response may carry v0.1.6-only fields like `now`.
 */
async function keylessPlan(
    env: Env, req: Request, code: string | null, rec: CodeRecord, now: number
): Promise<{ record: CodeRecord; free: FreePlan | null; freeFailed: boolean; newClient: boolean }> {
    const newClient = isNewClient(req.headers.get("x-subline-client"));
    if (!isTasteBearer(code) || !newClient) return { record: rec, free: null, freeFailed: false, newClient };
    try {
        const free = await resolveFreePlan(env, code!, now);
        return { record: free.record, free, freeFailed: false, newClient };
    } catch (e) {
        // The cause, never the id: an outage should be diagnosable from logs.
        console.warn("trial lookup failed, degrading to taste", { error: String((e as any)?.message ?? e).slice(0, 200) });
        return { record: rec, free: null, freeFailed: true, newClient };
    }
}

/** The JSON body, or null when it is over MAX_BODY_BYTES (real bytes, read
 *  with a running count so an oversized body is never buffered whole) or is
 *  not JSON. */
async function readBody(req: Request): Promise<unknown | null> {
    const buf = await readCapped(req, MAX_BODY_BYTES);
    if (buf === null) return null;
    try { return JSON.parse(new TextDecoder().decode(buf)); } catch { return null; }
}

type Done = (r: Response, outcome: Outcome, code: string | null, msgs: number, plan?: string | null, detail?: string) => Response;

/** The metric label for a failed upstream call, from BOTH providers' statuses:
 *  a billing (402) or key (401/403) fault on either one is the owner's alarm,
 *  even when the other one's error is what the user is answered with. */
function upstreamLabel(err: FallbackError): Outcome {
    const s = [err.status, err.primaryStatus];
    if (s.includes(402)) return "relay_credit";
    if (s.some(x => x === 401 || x === 403)) return "relay_key_fail";
    return "upstream_error";
}

/** Put the results back in the client's order, with the messages that were
 *  refused on their own (too long) answered failed. */
function withRefused(order: string[], results: Result[], tooLong: string[]): Result[] {
    if (tooLong.length === 0) return results;
    const byId = new Map(results.map(r => [r.id, r] as const));
    for (const id of tooLong) byId.set(id, { id, failed: true });
    return order.map(id => byId.get(id) ?? { id, failed: true });
}

/**
 * Reserve, translate, answer: the shared tail of /v1/translate once the
 * request has been resolved to the counters it is charged to (`code`,
 * `rec`) and whether it is a preview. Legacy and v2 both end here, so spend,
 * refunds and error mapping cannot drift apart.
 */
async function serveBatch(
    env: Env, ctx: ExecutionContext, done: Done, req: Request, code: string | null, rec: CodeRecord,
    norm: NormalizedBatch, order: string[], preview: boolean, free: FreePlan | null, newClient: boolean, now: number,
    v2: boolean = false, pv?: PreviewPlan
): Promise<Response> {
    const once = pv?.once;
    const plan = rec.plan ?? "free";
    const { batch, tooLong } = norm;
    // Every message was too long on its own: nothing to send, nothing charged.
    if (batch.messages.length === 0) {
        const ok = { ok: true, results: withRefused(order, [], tooLong), rpmLimit: rpmLimitFor(rec) };
        return done(json(newClient ? { ...ok, now } : ok), "too_large", code, 0, plan);
    }
    const promptChars =
        batch.context.reduce((n, c) => n + c.text.length + c.author.length, 0) +
        batch.messages.reduce((n, m) => n + m.text.length + (m.author?.length ?? 0)
            + (m.replyTo ? m.replyTo.text.length + m.replyTo.author.length : 0), 0) +
        batch.targetLang.length;
    // Two units: `cost` is the per-bearer daily count the client sees
    // (messages only for taste/trial, one per ordinary message for a code),
    // `budgetCost` is the real spend the global guard, the monthly allowance
    // and the trial's per-IP cost cap are charged.
    // An account preview counts MESSAGES, a message sent in parts once (see previewPlan).
    const cost = pv ? pv.cost : costFor(rec, batch.messages.length, promptChars);
    const budgetCost = budgetCostFor(batch.messages.length, promptChars);
    // The per-IP taste/trial ceiling needs the caller's address, and ONLY
    // for a keyless request: no other plan grows an ip counter, and a
    // request with no cf-connecting-ip (not fronted by Cloudflare) just
    // skips the cap.
    // A v2 preview is charged per ACCOUNT (a paying Automatic owner), never
    // per address, so it skips the keyless per-IP ceilings.
    const tasteIp = !v2 && (plan === "taste" || plan === "trial") ? req.headers.get("cf-connecting-ip") : null;

    const res = await reserve(env, code!, rec, cost, now, tasteIp, budgetCost, once, pv?.parts);
    if (!res.ok) {
        // Counters or the budget could not be reached: refused CLOSED,
        // before any spend (see reserve).
        if (res.reason === "unavailable") {
            return done(fail("temporarily unavailable", 503, res.retryAfterMs), "capacity", code, 0, plan);
        }
        const status = 429; // cap_exceeded / rate_limited / capacity all park the engine
        if (res.reason === "rate_limited") {
            // State the ceiling that was hit, in the field the plugin's
            // rate gate already learns from (native.ts →
            // enterCooldown → tuneRateGateToObservedLimit), so one
            // 429 retunes the client to this code's real limit.
            return done(json({
                ok: false, error: "slow down", retryAfterMs: res.retryAfterMs,
                quotaLimitPerMinute: rpmLimitFor(rec)
            }, status), "rate_limited", code, 0, plan);
        }
        if (res.reason === "month_cap_exceeded") {
            return done(fail("monthly limit reached", status, res.retryAfterMs), "month_cap_exceeded", code, 0, plan);
        }
        return done(fail(
            res.reason === "cap_exceeded" ? "daily limit reached" : "temporarily unavailable",
            status, res.retryAfterMs
        ), res.reason as Outcome, code, 0, plan);
    }

    // What this request really added to the day count: 0 for a repeat of a
    // preview already counted today (see previewOnce).
    const charged = res.charged ?? cost;

    // Every KV write that is not a spend counter happens only from here
    // on, after reserve() passed the per-bearer and per-IP ceilings and
    // the budget. Before this point a request with a fresh random free_
    // id costs the relay reads only, so rerolling ids cannot be turned
    // into unbounded KV writes.
    if (free?.provisional) {
        // First successful press of this id: make its trial real.
        ctx.waitUntil(startTrial(env, code!, now).catch(e =>
            console.warn("trial start write failed", { error: String((e as any)?.message ?? e).slice(0, 200) })));
    }
    // Owner stats (distinct installs / trials / paid codes per day), off
    // the critical path and failure-proof.
    ctx.waitUntil(safely(() => markActive(env, code!, rec.plan, now)));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let primaryFail: number | "throw" | null = null;
    try {
        const { primary, fallback } = providers(env);
        const full = await translateBatch(batch, primary, fallback, controller.signal, {
            onPrimaryFail: s => { primaryFail = s ?? "throw"; }
        });
        clearTimeout(timer);
        // The primary failed and the fallback saved the request: still worth
        // a row, so a primary that is out of credit (402) or has a dead key
        // (401) is countable while users never notice.
        if (primaryFail !== null) ctx.waitUntil(record(env, "primary_fail", code, 0, plan, String(primaryFail)));
        // A LEGACY (v0.1.6 keyless) preview is cut on the server. A v2
        // preview, an Automatic owner's, is the FULL ✦ line: it is counted
        // once per message (previewPlan) and the reader is shown all of it.
        const results = withRefused(order, preview && !v2 ? toPreview(full) : full, tooLong);
        // A v2 preview with nothing to show (every row failed) is given back:
        // the reader saw nothing, and the client offers the press again.
        // An ACCOUNT preview (pv) is also given back per MESSAGE when any part
        // of it failed: the plugin shows nothing for a message with a missing
        // part. A part refused as too long does not count here: the plugin
        // never sends one (it splits under the limit), so it cannot be used to
        // get the other parts translated for free.
        const allFailed = results.every(r => "failed" in r);
        if (preview && v2 && pv && !allFailed) {
            const lostSet = failedMessages(results, tooLong, pv.baseOf);
            const lost = lostSet.size;
            if (lost > 0) {
                const back = pv.parts
                    ? await refundGroup(env, code!, now, pv.parts)
                    : Math.min(charged, lost);
                if (!pv.parts && back > 0) ctx.waitUntil(refund(env, code!, back, now, tasteIp, plan, budgetCost, once?.key));
                // A message with a failed part is shown NOTHING: every row of it
                // is answered failed. The plugin drops such a message anyway
                // (joinParts), and a modified client must not keep the other
                // parts' full ✦ text while the message is given back.
                const shown = results.map(r => lostSet.has(pv.baseOf.get(r.id) ?? r.id) && !("failed" in r) ? { id: r.id, failed: true as const } : r);
                const partOk = { ok: true, results: shown, used: Math.max(0, res.used - back), cap: res.cap, rpmLimit: rpmLimitFor(rec) };
                return done(json(newClient ? { ...partOk, now } : partOk), "ok", code, Math.max(0, charged - back), plan);
            }
        }
        if (preview && v2 && allFailed) {
            let back = charged;
            if (pv?.parts) back = await refundGroup(env, code!, now, pv.parts);
            else ctx.waitUntil(refund(env, code!, charged, now, tasteIp, plan, budgetCost, once?.key));
            const failedOk = { ok: true, results, used: Math.max(0, res.used - back), cap: res.cap, rpmLimit: rpmLimitFor(rec) };
            return done(json(newClient ? { ...failedOk, now } : failedOk), "ok", code, 0, plan);
        }
        if (preview && charged > 0) ctx.waitUntil(safely(() => bumpStat(env, now, "previews")));
        // `rpmLimit` rides every success so the plugin's rate gate can
        // tune itself to this code's ceiling without ever hitting it.
        // `now` (server epoch ms) only for a header'd client, so it can
        // count trialEndsAt down against the relay's clock rather than a
        // skewed local one; a legacy body stays byte-identical.
        const ok = { ok: true, results, used: res.used, cap: res.cap, rpmLimit: rpmLimitFor(rec) };
        return done(json(newClient ? { ...ok, now } : ok), "ok", code, charged, plan);
    } catch (e) {
        clearTimeout(timer);
        const err = (e ?? {}) as FallbackError;
        // Only a request whose OWN time budget ran out counts as a timeout:
        // the last call reached a provider and may have billed, so it stays
        // charged (which also stops a client forcing slow batches to burn
        // the key for free). A primary that hit its own deadline and was
        // followed by a fallback that failed fast is refunded.
        const timedOut = controller.signal.aborted || err.timedOut === true || err.status === 504;
        const keyFault = err.status === 401 || err.status === 403;
        // A v2 PREVIEW is always given back, a timeout included: the reader
        // saw nothing and must be able to press again for free. Its body is
        // one capped message and the global budget stays charged, so this
        // cannot be turned into free upstream spend beyond that.
        if ((preview && v2) || (!timedOut && !keyFault)) {
            if (pv?.parts) ctx.waitUntil(refundGroup(env, code!, now, pv.parts));
            else ctx.waitUntil(refund(env, code!, charged, now, tasteIp, plan, budgetCost, once?.key));
        }
        const label = upstreamLabel(err);
        // The relay's OWN key failing (401/403) or its credit running out
        // (402) is a SERVER fault, never surfaced as "your code is bad".
        if (keyFault || err.status === 402) {
            return done(fail("translation service unavailable", 503), label, code, 0, plan);
        }
        if (err.status === 429) {
            return done(fail("translation service busy", 429, err.retryAfterMs ?? 30_000), label, code, 0, plan);
        }
        if (timedOut) {
            // The request ran out of time. It stays charged (see above), so
            // the client must not re-send it at once: a 5xx is retried once by
            // the plugin (native.ts isRetryable) and would be charged again for
            // the same outage. A 429 is never retried there; it parks ✦ for
            // retryAfterMs while the ≈ line stays on screen.
            return done(fail("translation service busy", 429, 60_000), label === "upstream_error" ? "upstream_timeout" : label, code, 0, plan);
        }
        return done(fail("translation service unavailable", 503, 15_000), label, code, 0, plan);
    }
}

/**
 * /v1/translate for a v2 (paid-only) client. ✦ needs AI and is charged to the
 * account's live AI code. An Automatic owner without AI gets ✦ PREVIEWS only
 * (5 messages a day per account, each the full ✦ line, see previewOnce). Nothing else is served: no
 * entitlement is 402 not_activated. The trial and taste tiers do not exist for
 * a v2 client.
 */
async function translateV2(env: Env, ctx: ExecutionContext, done: Done, req: Request): Promise<Response> {
    const install = installOf(req);
    const credential = bearer(req);
    if (!install || !credential || (credential.startsWith("free_") && credential !== install)) {
        return done(fail("bad request", 400), "bad_payload", credential, 0);
    }
    const now = Date.now();
    const body = await readBody(req);
    if (body === null) return done(fail("payload too large or malformed", 413), "too_large", credential, 0);
    const norm = normalizeBatch(body);
    if (!norm) return done(fail("bad request", 400), "bad_payload", credential, 0);
    const order = (body as any).messages.map((m: any) => m.id as string);
    const r = await resolveEntitlement(env, install, credential, now);
    if (!r.ok) {
        const outcome: Outcome = r.error === "device_limit" ? "device_limit" : "capacity";
        return done(fail(r.error, r.status), outcome, credential, 0);
    }
    if (r.ai && r.aiCode && r.aiRec) {
        const preview = (body as any).mode === "preview";
        return serveBatch(env, ctx, done, req, r.aiCode, r.aiRec, norm, order, preview, null, true, now, true);
    }
    if (!r.automatic || !r.acctId) return done(fail("not_activated", 402), "not_activated", credential, 0);
    if ((body as any).mode !== "preview") return done(fail("ai_required", 402), "ai_required", credential, 0);
    // A preview row with no text is never sent by the plugin (it previews a
    // message it could read). Refused before any spend: an empty row is the
    // easiest way to make a part fail on purpose.
    if (norm.batch.messages.some(m => m.text.trim() === "")) return done(fail("bad request", 400), "bad_payload", credential, 0);
    // The account's previews: a synthetic taste-shaped record on its own
    // counter ("pv:<account>", counted in the Budget object, see reserve).
    const pvRec: CodeRecord = { status: "active", plan: "taste", dailyCap: PREVIEW_DAILY_CAP };
    return serveBatch(env, ctx, done, req, "pv:" + r.acctId, pvRec, norm, order, true, null, true, now, true,
        await previewPlan(r.acctId, norm, now));
}

/** /v1/translate for an older (0.1.x) client: a code or a free_ id. */
async function translateLegacy(env: Env, ctx: ExecutionContext, done: Done, req: Request): Promise<Response> {
    const code = bearer(req);

    const auth = await authCode(env, code);
    if (!auth.ok) {
        const map = { no_code: 401, unknown_code: 401, revoked: 401, expired: 401 } as const;
        // A distinct, actionable reason so the client can tell "renew your
        // subscription" (expired) apart from "this code is wrong" (unknown).
        const msg =
            auth.reason === "expired" ? "code expired or subscription lapsed" :
            auth.reason === "revoked" ? "code revoked" :
            "invalid or missing code";
        return done(fail(msg, map[auth.reason]), auth.reason, code, 0);
    }

    const now = Date.now();
    // After LAUNCH_AT the legacy free tier is gone except for real
    // early users (see legacyFreeAllowed). Refused before anything is
    // parsed, reserved or written.
    if (!(await legacyFreeAllowed(env, code, now))) {
        return done(fail("not activated", 402), "trial_ended", code, 0, "taste");
    }
    const body = await readBody(req);
    const authPlan = auth.record.plan ?? "free";
    if (body === null) return done(fail("payload too large or malformed", 413), "too_large", code, 0, authPlan);
    const norm = normalizeBatch(body);
    if (!norm) return done(fail("bad request", 400), "bad_payload", code, 0, authPlan);
    const order = (body as any).messages.map((m: any) => m.id as string);
    // `mode` is a v0.1.6 hint; any other value (or none) is legacy.
    const mode = (body as any).mode;
    // "preview" is honoured only for a keyless install; a real code has
    // paid for full text and always gets it.
    const preview = mode === "preview" && isTasteBearer(code);
    // A PREVIEW IS ALWAYS THE TASTE ALLOWANCE (3 a day), whatever the
    // id's trial state: it never reads trial:<id> and never starts a
    // trial. Otherwise an id whose trial never started (or whose record
    // lapsed) would be resolved as a provisional 300-a-day trial and
    // its "3 previews a day" would not be 3.
    const { record: rec, free, freeFailed, newClient } = preview
        ? { record: tasteRecord(), free: null, freeFailed: false, newClient: isNewClient(req.headers.get("x-subline-client")) }
        : await keylessPlan(env, req, code, auth.record, now);
    const plan = rec.plan ?? "free";
    // "auto" = the plugin translating on its own, which is the trial's
    // feature. Once the trial is over, refuse it BEFORE reserving, so an
    // automatic press can never spend the 3 taste messages the user
    // meant to press by hand. Only a new client (free !== null) is told;
    // a legacy client never sends a mode, and one that did gets taste.
    if (mode === "auto" && free && !free.trialActive) {
        return done(json({ ok: false, error: "trial ended", trialEndsAt: free.trialEndsAt, now }, 402), "trial_ended", code, 0, plan);
    }
    // The trial lookup itself failed, so this bearer may or may not still
    // be in its trial. Refuse an automatic press with a plain 503 and
    // spend nothing: an outage must never let auto-translate drain the 3
    // messages the user meant to press by hand, and it must never TELL a
    // user mid-trial that their trial ended (a 402 is reserved for an
    // ending the relay actually has on record). A hand press still gets
    // taste below.
    if (mode === "auto" && freeFailed) {
        return done(fail("temporarily unavailable", 503, 60_000), "capacity", code, 0, plan);
    }
    return serveBatch(env, ctx, done, req, code, rec, norm, order, preview, free, newClient, now);
}

/** How often one previewed message may be asked again in a day without being
 *  counted again (a lost answer, a restart). Past this a repeat counts. */
export const PREVIEW_FREE_REPEATS = 2;

/** Most distinct parts one message may have in a day before a new part counts
 *  again. The plugin numbers parts 0..31, so an honest message never gets here. */
export const PREVIEW_MAX_PARTS = 32;

/**
 * A message sent in parts is counted by SIZE: one preview per started
 * PREVIEW_PART_UNIT characters of distinct part text (budget.ts
 * ReserveReq.parts). The relay cannot check that the parts are one message,
 * so without this one preview could carry 32 unrelated 4,000-character
 * texts. Discord caps a message at 4,000 characters; mention names and
 * UTF-16 counting can grow that, so an honest long message stays at 1.
 */
export const PREVIEW_PART_UNIT = 2 * MAX_TEXT_CHARS;

/** Part-group refunds an account may have in a day (budget.ts /refund-group).
 *  A failed part is rare for an honest message; past this, the retry of the
 *  same parts is still free under the repeat rule. */
export const PREVIEW_GROUP_REFUNDS = 3;

/**
 * A row id the plugin made by splitting a long message (fitRequest.ts
 * splitTextToLimit): "<message id>~p<n>", n = 0..31 written plainly (no
 * leading zero). Anything else is an ordinary id, the whole of it.
 */
const PART_ID_RE = /^(.+)~p(0|[1-9]|[12][0-9]|3[01])$/;
export function partOf(id: string): { base: string; n: number } | null {
    const m = PART_ID_RE.exec(id);
    return m ? { base: m[1]!, n: Number(m[2]) } : null;
}

/** How an account preview is counted (see previewPlan). */
export interface PreviewPlan {
    /** Previews this request counts as: one per message, parts of one message once. */
    cost: number;
    /** A single ordinary message: its marker (budget.ts ReserveReq.once). */
    once?: { key: string; maxFree: number };
    /** Every row is a part of ONE message: its group (budget.ts ReserveReq.parts),
     *  with the account's refund row for /refund-group. */
    parts?: NonNullable<ReserveReq["parts"]> & { refunds: string; maxRefunds: number };
    /** Row id → the message it belongs to. */
    baseOf: Map<string, string>;
}

async function hex12(s: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
    return Array.from(digest.slice(0, 12), b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * ONE PREVIEW PER MESSAGE, on the relay.
 *  - One ordinary message: a marker row (budget.ts ReserveReq.once) keyed by
 *    the account, the UTC day and a hash of the message id, its text and the
 *    target language, so a retry of the same message is free while a reused id
 *    with other text is a new preview.
 *  - Parts of ONE message ("<id>~p<n>"), in this request or in consecutive
 *    ones the same UTC day: one group row per message (account, day, hash of
 *    the base id and target) counts it once; each part has its own marker (base
 *    id, n, target, text), so a repeat is free up to PREVIEW_FREE_REPEATS and a
 *    part with other text is a new part (at most PREVIEW_MAX_PARTS free).
 *  - Anything else (several messages): one preview per distinct message, no marker.
 */
export async function previewPlan(acctId: string, norm: NormalizedBatch, now: number): Promise<PreviewPlan> {
    const msgs = norm.batch.messages;
    const target = norm.batch.targetLang;
    const baseOf = new Map<string, string>();
    const parsed = msgs.map(m => ({ m, part: partOf(m.id) }));
    for (const { m, part } of parsed) baseOf.set(m.id, part ? part.base : m.id);
    const bases = new Set(baseOf.values());
    if (bases.size === 1 && parsed.length > 0 && parsed.every(x => x.part !== null)) {
        const base = parsed[0]!.part!.base;
        const g = await hex12(`${base}\n${target}`);
        const keys: string[] = [];
        const sizes: number[] = [];
        for (const { m, part } of parsed) {
            keys.push(dayRowKey(`pvp:${acctId}:${await hex12(`${base}\n${part!.n}\n${target}\n${m.text}`)}`, now));
            sizes.push(m.text.length);
        }
        // Distinct part texts only: a row repeated in one request is one part.
        const seen = new Map<string, number>();
        keys.forEach((k, i) => { if (!seen.has(k)) seen.set(k, sizes[i]!); });
        const partChars = [...seen.values()].reduce((n, x) => n + x, 0);
        return {
            cost: Math.max(1, Math.ceil(partChars / PREVIEW_PART_UNIT)), baseOf,
            parts: {
                group: dayRowKey(`pvg:${acctId}:${g}`, now), charge: dayRowKey(`pvc:${acctId}:${g}`, now),
                chars: dayRowKey(`pvs:${acctId}:${g}`, now), sizes, unit: PREVIEW_PART_UNIT,
                keys, maxFree: PREVIEW_FREE_REPEATS, maxNew: PREVIEW_MAX_PARTS,
                refunds: dayRowKey(`pvr:${acctId}`, now), maxRefunds: PREVIEW_GROUP_REFUNDS
            }
        };
    }
    if (msgs.length === 1) {
        const m = msgs[0]!;
        const hex = await hex12(`${m.id}\n${target}\n${m.text}`);
        return { cost: 1, baseOf, once: { key: dayRowKey(`pvm:${acctId}:${hex}`, now), maxFree: PREVIEW_FREE_REPEATS } };
    }
    // Several messages: one preview each, a message sent in parts counted by
    // size like a parts group (PREVIEW_PART_UNIT), so mixing one ordinary row
    // in cannot make 32 parts cost 1.
    const charsOf = new Map<string, number>();
    for (const { m, part } of parsed) if (part) charsOf.set(part.base, (charsOf.get(part.base) ?? 0) + m.text.length);
    let cost = 0;
    for (const b of bases) cost += charsOf.has(b) ? Math.max(1, Math.ceil(charsOf.get(b)! / PREVIEW_PART_UNIT)) : 1;
    return { cost, baseOf };
}

/** Messages with a failed row (a too-long refusal aside, see serveBatch). */
function failedMessages(results: Result[], tooLong: string[], baseOf: Map<string, string>): Set<string> {
    const skip = new Set(tooLong);
    const lost = new Set<string>();
    for (const r of results) {
        if ("failed" in r && !skip.has(r.id)) lost.add(baseOf.get(r.id) ?? r.id);
    }
    return lost;
}

/** Owner check for the /admin/* routes: null when allowed, else the refusal. */
async function adminRefusal(req: Request, env: Env, method: string): Promise<Response | null> {
    if (req.method !== method) return fail("method not allowed", 405);
    const token = bearer(req);
    if (!env.ADMIN_TOKEN) return fail("admin disabled", 503);
    if (!token || !(await timingSafeEqual(token, env.ADMIN_TOKEN))) return fail("unauthorized", 401);
    return null;
}

/** The global budget as the owner sees it: spent units, the freeze point, and
 *  the share free traffic may use. Null when the object cannot be reached. */
async function budgetView(env: Env): Promise<{ total: number; freezeAt: number; freeFreezeAt: number; frozen: boolean } | null> {
    try {
        const st = await (await env.BUDGET.get(env.BUDGET.idFromName("global")).fetch("https://budget.internal/status")).json() as { total?: number };
        const total = typeof st.total === "number" ? st.total : 0;
        const freezeAt = freezeAtFor(env, false);
        return { total, freezeAt, freeFreezeAt: freezeAtFor(env, true), frozen: total >= freezeAt };
    } catch (e) {
        console.warn("admin: budget status failed", { error: String((e as any)?.message ?? e).slice(0, 200) });
        return null;
    }
}

export default {
    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(req.url);
        // `plan` rides every metric row so the taste tier is countable: how many
        // keyless installs tasted the AI tier, and how many hit the wall.
        const done: Done = (r, outcome, code, msgs, plan, detail) => {
            ctx.waitUntil(record(env, outcome, code, msgs, plan, detail));
            return r;
        };

        // ---- POST /v1/translate — the hot path ----------------------------
        if (url.pathname === "/v1/translate") {
            if (req.method !== "POST") return fail("method not allowed", 405);
            try {
                return await (isApiV2(req) ? translateV2(env, ctx, done, req) : translateLegacy(env, ctx, done, req));
            } catch (e) {
                // Anything unexpected (a KV read in authCode or resolve, a
                // future bug) is a JSON 503 with a metric row and the cause
                // logged, never Cloudflare's bare error page.
                const code = bearer(req);
                let msg = String((e as any)?.message ?? e).slice(0, 200);
                if (code) msg = msg.split(code).join("<redacted>");
                console.warn("translate failed unexpectedly", { error: msg });
                return done(fail("temporarily unavailable", 503, 60_000), "capacity", code, 0);
            }
        }

        // ---- GET /v1/status — usage for the settings pane -----------------
        // A taste bearer answers here exactly like a real code, with plan:"taste"
        // and cap 3, which is what the plugin reads at startup to show
        // "2 of 3 left today" before anyone presses anything.
        if (url.pathname === "/v1/status") {
            if (isApiV2(req)) return handleStatusV2(req, env, Date.now());
            const code = bearer(req);
            const auth = await authCode(env, code);
            if (!auth.ok) return fail("invalid or missing code", auth.reason === "no_code" ? 401 : 403);
            const now = Date.now();
            // READ-ONLY, for every caller: no trial write, no stats, no seen
            // marker. Status is free to call with any random free_ id, so any
            // write here would be a KV write anyone can trigger at will. A new
            // client's unseen id is shown a PROVISIONAL trial (plan "trial",
            // trialEndsAt = now + 7 days) so the plugin can say "trial: 7 days
            // left" at startup; the trial is written on its first successful
            // translate.
            // After LAUNCH_AT, a free_ id that is not a real early user keeps the
            // same response shape but nothing to spend: plan taste, cap 0, and
            // for a header'd client a trial that ended now. Still read-only.
            if (!(await legacyFreeAllowed(env, code, now))) {
                const shut: Record<string, unknown> = { ok: true, plan: "taste", used: 0, cap: 0, resetsInMs: (await usage(env, code!, tasteRecord(), now)).resetsInMs };
                return json(isNewClient(req.headers.get("x-subline-client")) ? { ...shut, trialEndsAt: now, now } : shut);
            }
            const { record: rec, free, newClient } = await keylessPlan(env, req, code, auth.record, now);
            const u = await usage(env, code!, rec, now);
            const base: Record<string, unknown> = { ok: true, plan: rec.plan ?? "free", ...u };
            // A purchase made from this install (POST /v1/checkout → webhooks,
            // see checkout.ts): the key goes back to the holder of this free_
            // id only, and only to a header'd client. Read-only, never throws.
            if (newClient && isTasteBearer(code)) {
                const purchase = await purchaseFor(env, code!, now);
                if (purchase) base.purchase = purchase;
            }
            // Legacy clients (no header) get exactly the pre-trial shape; a
            // header'd one also gets the server clock (`now`, epoch ms).
            // `trialProvisional: true` marks an id the relay has never started a
            // trial for: its trialEndsAt is only "now + 7 days", moves forward
            // on every call, and the client must never let it extend a trial.
            return json(free
                ? { ...base, trialEndsAt: free.trialEndsAt, ...(free.provisional ? { trialProvisional: true } : {}), now }
                : newClient ? { ...base, now } : base);
        }

        // ---- POST /v1/patch-health — Subline patches that stopped applying --
        // Counts only (patchHealth.ts); emails the owner once per patch per day
        // when enough installs agree.
        if (url.pathname === "/v1/patch-health") {
            try {
                return await handlePatchHealth(req, env, Date.now());
            } catch (e) {
                console.warn("patch health failed unexpectedly", { error: String((e as any)?.message ?? e).slice(0, 200) });
                return fail("temporarily unavailable", 503);
            }
        }

        // ---- GET /admin/patch-health — recent patch reports (ADMIN_TOKEN) ---
        if (url.pathname === "/admin/patch-health") {
            const refused = await adminRefusal(req, env, "GET");
            if (refused) return refused;
            return adminPatchHealth(env, url, Date.now());
        }

        // ---- POST /v1/checkout — buy without handling a key (checkout.ts) --
        // ---- POST /v1/redeem — a promo code grants Automatic (v2 only) -------
        if (url.pathname === "/v1/redeem") {
            if (!isApiV2(req)) return fail("bad request", 400);
            return handleRedeem(req, env, Date.now());
        }

        // ---- POST /admin/reset-installs — free an account's computers ------
        if (url.pathname === "/admin/reset-installs") {
            if (req.method !== "POST") return fail("method not allowed", 405);
            const token = bearer(req);
            if (!env.ADMIN_TOKEN) return fail("admin disabled", 503);
            if (!token || !(await timingSafeEqual(token, env.ADMIN_TOKEN))) return fail("unauthorized", 401);
            const body = await readBody(req);
            if (!body) return fail("bad request", 400);
            return adminResetInstalls(env, body);
        }

        // ---- POST /admin/reissue — replace a leaked code (ADMIN_TOKEN) -------
        if (url.pathname === "/admin/reissue") {
            if (req.method !== "POST") return fail("method not allowed", 405);
            const token = bearer(req);
            if (!env.ADMIN_TOKEN) return fail("admin disabled", 503);
            if (!token || !(await timingSafeEqual(token, env.ADMIN_TOKEN))) return fail("unauthorized", 401);
            const body = await readBody(req);
            if (!body) return fail("bad request", 400);
            return adminReissue(env, body, Date.now());
        }

        // ---- POST /admin/promo — create a promo code (ADMIN_TOKEN) ---------
        if (url.pathname === "/admin/promo") {
            if (req.method !== "POST") return fail("method not allowed", 405);
            const token = bearer(req);
            if (!env.ADMIN_TOKEN) return fail("admin disabled", 503);
            if (!token || !(await timingSafeEqual(token, env.ADMIN_TOKEN))) return fail("unauthorized", 401);
            const body = await readBody(req);
            if (!body) return fail("bad request", 400);
            return createPromo(env, body, Date.now());
        }

        if (url.pathname === "/v1/checkout") {
            return handleCheckout(req, env);
        }

        // ---- GET /v1/purchase-status — public, for the site's thanks page --
        // {"state":"active"|"pending"|"failed"|"unknown"} from webhook data only
        // (checkout.ts handlePurchaseStatus): no auth, no personal data.
        if (url.pathname === "/v1/purchase-status") {
            return handlePurchaseStatus(req, env);
        }

        // ---- POST /admin/coupon — a personal 100%-off code (ADMIN_TOKEN) ---
        if (url.pathname === "/admin/coupon") {
            if (req.method !== "POST") return fail("method not allowed", 405);
            const token = bearer(req);
            if (!env.ADMIN_TOKEN) return fail("admin disabled", 503);
            if (!token || !(await timingSafeEqual(token, env.ADMIN_TOKEN))) return fail("unauthorized", 401);
            const body = await readBody(req);
            if (!body) return fail("bad request", 400);
            return createCoupon(env, body);
        }

        // ---- GET /admin/stats — approximate owner counts (ADMIN_TOKEN) ----
        // Daily counts only (see stats.ts): never an id, a code, or an IP.
        // Days are NEWEST FIRST; ?days= is clamped to 1..30, default 14.
        if (url.pathname === "/admin/stats") {
            if (req.method !== "GET") return fail("method not allowed", 405);
            const token = bearer(req);
            if (!env.ADMIN_TOKEN) return fail("admin disabled", 503);
            if (!token || !(await timingSafeEqual(token, env.ADMIN_TOKEN))) return fail("unauthorized", 401);
            const days = clampDays(url.searchParams.get("days"));
            return json({
                ok: true, approximate: true, days: await readStats(env, days, Date.now()), promos: await promoStats(env),
                // The money ceiling, so a freeze is seen coming (see budget.ts).
                budget: await budgetView(env)
            });
        }

        // ---- GET /admin/budget, POST /admin/budget/reset (ADMIN_TOKEN) -----
        // The global budget total and its freeze point; reset starts a fresh
        // window at once, with no deploy (raising GLOBAL_BUDGET_MESSAGES also
        // unfreezes, see budget.ts).
        if (url.pathname === "/admin/budget") {
            const refused = await adminRefusal(req, env, "GET");
            if (refused) return refused;
            const view = await budgetView(env);
            return view ? json({ ok: true, ...view }) : fail("budget unavailable", 503);
        }
        if (url.pathname === "/admin/budget/reset") {
            const refused = await adminRefusal(req, env, "POST");
            if (refused) return refused;
            try {
                await env.BUDGET.get(env.BUDGET.idFromName("global")).fetch("https://budget.internal/reset", { method: "POST" });
            } catch (e) {
                console.warn("admin: budget reset failed", { error: String((e as any)?.message ?? e).slice(0, 200) });
                return fail("budget unavailable", 503);
            }
            console.warn("admin: global budget reset");
            return json({ ok: true, ...(await budgetView(env)) });
        }

        // ---- POST /admin/codes — mint / revoke (ADMIN_TOKEN gated) --------
        if (url.pathname === "/admin/codes") {
            if (req.method !== "POST") return fail("method not allowed", 405);
            const token = bearer(req);
            if (!env.ADMIN_TOKEN) return fail("admin disabled", 503);
            if (!token || !(await timingSafeEqual(token, env.ADMIN_TOKEN))) return fail("unauthorized", 401);
            const body = await readBody(req) as any;
            if (!body || typeof body.action !== "string") return fail("bad request", 400);

            if (body.action === "mint") {
                const code = typeof body.code === "string" ? body.code : mintCode();
                // The free_ prefix belongs to the synthetic taste tier, which
                // authCode answers WITHOUT reading KV. A minted free_ record
                // would therefore be unreadable dead state that silently looks
                // like a 3/day install, so refuse it rather than pretend.
                if (code.startsWith("free_")) return fail("free_ is reserved for the taste tier", 400);
                // Never overwrite a code that exists: minting over a customer's
                // license key would drop its expiry, terminal flag and purchase
                // ids, and could turn a refunded key active for good.
                if (await env.CODES.get(`code:${code}`)) return fail("that code already exists", 409);
                const orderRef = typeof body.orderRef === "string" ? body.orderRef : undefined;
                // Nor point a real purchase's refund and renewal index elsewhere.
                if (orderRef && await env.CODES.get(`order:${orderRef}`)) return fail("that orderRef already exists", 409);
                const capN = body.dailyCap === undefined ? 500 : Math.floor(Number(body.dailyCap));
                if (!Number.isFinite(capN) || capN < 1 || capN > 10_000) return fail("dailyCap must be 1 to 10000", 400);
                const rec: CodeRecord = {
                    status: "active",
                    dailyCap: capN,
                    plan: body.plan === "paid" ? "paid" : "free",
                    note: typeof body.note === "string" ? body.note.slice(0, 120) : undefined,
                    orderRef
                };
                await env.CODES.put(`code:${code}`, JSON.stringify(rec));
                if (rec.orderRef) await env.CODES.put(`order:${rec.orderRef}`, code);
                return json({ ok: true, code, record: rec });
            }
            if (body.action === "revoke" && typeof body.code === "string") {
                const raw = await env.CODES.get(`code:${body.code}`);
                if (!raw) return fail("no such code", 404);
                const rec = JSON.parse(raw) as CodeRecord;
                rec.status = "revoked";
                await env.CODES.put(`code:${body.code}`, JSON.stringify(rec));
                return json({ ok: true, code: body.code, revoked: true });
            }
            return fail("bad request", 400);
        }

        // ---- POST /webhook/mor — Merchant-of-Record (Dodo Payments) ------
        // Verify the Standard-Webhooks signature over the RAW body, then mirror
        // the event's lifecycle into KV (see applyMorEvent). Inert until
        // MOR_WEBHOOK_SECRET is set. This router does signature + transport only;
        // all state logic and idempotency live in codes.ts so they are unit-testable.
        if (url.pathname === "/webhook/mor") {
            if (req.method !== "POST") return fail("method not allowed", 405);
            // Secret unset ⇒ 503, never a silent 200: an unconfigured relay must
            // not look like it accepted (and dropped) a real purchase event.
            if (!env.MOR_WEBHOOK_SECRET) return fail("webhooks not configured", 503);

            // Read the RAW bytes and sign THOSE — the HMAC covers the exact body
            // Dodo signed; re-serialising parsed JSON would change bytes and never
            // match. (Read BEFORE any JSON.parse.)
            const rawBuf = await readCapped(req, MAX_BODY_BYTES);
            if (rawBuf === null) return fail("payload too large", 413);
            const raw = new TextDecoder().decode(rawBuf);

            // Standard Webhooks headers. ALL three are required — a missing one is
            // an unsigned/forged request and is rejected, never processed.
            const webhookId = req.headers.get("webhook-id") || "";
            const webhookTs = req.headers.get("webhook-timestamp") || "";
            const sigHeader = req.headers.get("webhook-signature") || "";
            if (!webhookId || !webhookTs || !sigHeader) return fail("bad signature", 401);

            // REPLAY WINDOW (the security review's ask): reject a timestamp more
            // than 5 minutes from now in EITHER direction. A captured valid body
            // can be resent, but only within this window; combined with the
            // terminal/forward-only state machine, replays stay harmless. A
            // non-numeric timestamp is malformed ⇒ reject (never NaN-compare true).
            const tsSecs = Number(webhookTs);
            if (!Number.isFinite(tsSecs) || Math.abs(Date.now() - tsSecs * 1000) > 5 * 60_000) {
                return fail("bad signature", 401);
            }

            // The signing secret is `whsec_<base64>`: strip the prefix and
            // base64-decode to the raw HMAC key (confirmed against the
            // standardwebhooks JS lib that Dodo's SDK uses — it does exactly
            // this). A malformed secret is a config error ⇒ 503, never a silent
            // accept and never an unhandled throw.
            let hkey: CryptoKey;
            try {
                hkey = await crypto.subtle.importKey("raw", decodeSecret(env.MOR_WEBHOOK_SECRET),
                    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
            } catch {
                return fail("webhooks misconfigured", 503);
            }

            // Signed content = `${webhook-id}.${webhook-timestamp}.${rawBody}`
            // (use the timestamp header STRING exactly as received). HMAC-SHA256
            // → base64 = the expected `v1` signature.
            const mac = await crypto.subtle.sign("HMAC", hkey, new TextEncoder().encode(`${webhookId}.${webhookTs}.${raw}`));
            const expected = bytesToBase64(new Uint8Array(mac));
            // webhook-signature is a SPACE-DELIMITED list of `v1,<base64>` entries
            // (key rotation / multi-sig). Accept if ANY entry matches. Compare via
            // timingSafeEqual, which SHA-256s both sides to a fixed 32 bytes first
            // — so a wrong-LENGTH or garbage signature compares safely and never
            // throws, and the compare leaks neither length nor content via timing.
            let good = false;
            for (const entry of sigHeader.split(" ")) {
                const comma = entry.indexOf(",");
                if (comma < 0 || entry.slice(0, comma) !== "v1") continue; // only the v1 scheme
                if (await timingSafeEqual(entry.slice(comma + 1), expected)) { good = true; break; }
            }
            if (!good) return fail("bad signature", 401);

            let evt: any; try { evt = JSON.parse(raw); } catch { return fail("bad payload", 400); }

            // Mirror the event. On an unexpected failure return 500 so Dodo RETRIES
            // (dropping a paid-lifecycle event silently would strand access); log
            // only the event name — never the key, email, body, or signature.
            try {
                await applyMorEvent(env, evt, Date.now());
            } catch {
                console.warn("mor webhook: mirror failed", { event: evt?.type });
                return fail("processing error", 500);
            }
            // Delivery/emailing the customer is the MoR's job; Dodo ignores the
            // response body, so we return a BARE 2xx — never the code (echoing a
            // freshly minted code in a 200 was a leak and served no purpose).
            return json({ ok: true });
        }

        return fail("not found", 404);
    }
} satisfies ExportedHandler<Env>;
