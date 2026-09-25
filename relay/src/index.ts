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
    authCode, reserve, refund, usage, mintCode, applyMorEvent, rpmLimitFor, costFor,
    isTasteBearer, isNewClient, resolveFreePlan, type Env, type CodeRecord, type FreePlan
} from "./codes";
import { translateWithFallback, toPreview, type BatchRequest, type TranslateError, type Provider } from "./translate";
import { record, type Outcome } from "./metrics";
import { bumpStat, markActive, safely, clampDays, readStats } from "./stats";
export { Budget } from "./budget";

const MAX_MESSAGES = 40;     // client's QUALITY_MAX_BATCH is 25; headroom, not unbounded
const MAX_CONTEXT = 12;      // client's context ring is 8; a big context is a cost-inflation vector
const MAX_BODY_BYTES = 32_768;
const MAX_TEXT_CHARS = 4_000;
const MAX_TARGET_CHARS = 40; // a language name; anything longer is an injection payload
const GROQ_TIMEOUT_MS = 20_000;
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

function validBatch(v: unknown): v is BatchRequest {
    if (!v || typeof v !== "object") return false;
    const b = v as any;
    if (!Array.isArray(b.messages) || !Array.isArray(b.context) || typeof b.targetLang !== "string") return false;
    // Target language is untrusted and interpolated into the prompt: bound it
    // hard. A real target is a short name/code with no line breaks; anything
    // else is an injection attempt (translate.ts also enc()-escapes it).
    if (b.targetLang.length === 0 || b.targetLang.length > MAX_TARGET_CHARS) return false;
    if (/[\u0000-\u001f]/.test(b.targetLang)) return false;
    if (b.context.length > MAX_CONTEXT) return false;
    if (b.messages.length === 0 || b.messages.length > MAX_MESSAGES) return false;
    for (const m of b.messages) {
        if (!m || typeof m.id !== "string" || typeof m.text !== "string") return false;
        if (m.text.length > MAX_TEXT_CHARS) return false;
    }
    for (const c of b.context) {
        if (!c || typeof c.text !== "string" || typeof c.author !== "string") return false;
        if (c.text.length > MAX_TEXT_CHARS) return false;
    }
    return true;
}

/**
 * The v0.1.6 keyless plan for this request. A legacy (v0.1.5) client sends no
 * `x-subline-client`, so it gets `free: null` and the record authCode already
 * gave it — byte-identical to before, with no trial: KV read or write. A new
 * client's well-formed free_ bearer is resolved to trial-or-taste. If that
 * lookup itself fails (KV hiccup) the request degrades to the legacy taste
 * behaviour rather than failing: the trial is a bonus, never a precondition.
 */
async function keylessPlan(
    env: Env, ctx: ExecutionContext, req: Request, code: string | null, rec: CodeRecord, now: number
): Promise<{ record: CodeRecord; free: FreePlan | null }> {
    if (!isTasteBearer(code) || !isNewClient(req.headers.get("x-subline-client"))) return { record: rec, free: null };
    try {
        const free = await resolveFreePlan(env, code!, now);
        if (free.started) ctx.waitUntil(safely(() => bumpStat(env, now, "trials_started")));
        return { record: free.record, free };
    } catch {
        return { record: rec, free: null };
    }
}

async function readBody(req: Request): Promise<unknown | null> {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) return null; // real bytes, not UTF-16 chars
    try { return JSON.parse(new TextDecoder().decode(buf)); } catch { return null; }
}

export default {
    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(req.url);
        // `plan` rides every metric row so the taste tier is countable: how many
        // keyless installs tasted the AI tier, and how many hit the wall.
        const done = (r: Response, outcome: Outcome, code: string | null, msgs: number, plan?: string | null) => {
            ctx.waitUntil(record(env, outcome, code, msgs, plan));
            return r;
        };

        // ---- POST /v1/translate — the hot path ----------------------------
        if (url.pathname === "/v1/translate") {
            if (req.method !== "POST") return fail("method not allowed", 405);
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
            const { record: rec, free } = await keylessPlan(env, ctx, req, code, auth.record, now);
            // Owner stats (distinct installs / trials / paid codes per day), off
            // the critical path and failure-proof.
            ctx.waitUntil(safely(() => markActive(env, code!, rec.plan, now)));

            const plan = rec.plan ?? "free";
            const body = await readBody(req);
            if (body === null) return done(fail("payload too large or malformed", 413), "too_large", code, 0, plan);
            if (!validBatch(body)) return done(fail("bad request", 400), "bad_payload", code, 0, plan);
            const batch = body as BatchRequest;
            // `mode` is a v0.1.6 hint; any other value (or none) is legacy.
            const mode = (body as any).mode;
            // "auto" = the plugin translating on its own, which is the trial's
            // feature. Once the trial is over, refuse it BEFORE reserving, so an
            // automatic press can never spend the 3 taste messages the user
            // meant to press by hand. Only a new client (free !== null) is told;
            // a legacy client never sends a mode, and one that did gets taste.
            if (mode === "auto" && free && !free.trialActive) {
                return done(json({ ok: false, error: "trial ended", trialEndsAt: free.trialEndsAt }, 402), "trial_ended", code, 0, plan);
            }
            // "preview" is honoured only for a keyless install; a real code has
            // paid for full text and always gets it.
            const preview = mode === "preview" && isTasteBearer(code);
            const promptChars =
                batch.context.reduce((n, c) => n + c.text.length + c.author.length, 0) +
                batch.messages.reduce((n, m) => n + m.text.length + (m.author?.length ?? 0), 0) +
                batch.targetLang.length;
            const cost = costFor(rec, batch.messages.length, promptChars);
            // The per-IP taste/trial ceiling needs the caller's address, and ONLY
            // for a keyless request: no other plan grows an ip counter, and a
            // request with no cf-connecting-ip (not fronted by Cloudflare) just
            // skips the cap.
            const tasteIp = plan === "taste" || plan === "trial" ? req.headers.get("cf-connecting-ip") : null;

            const res = await reserve(env, code!, rec, cost, now, tasteIp);
            if (!res.ok) {
                const status = 429; // cap_exceeded / rate_limited / capacity all park the engine
                const label = res.reason === "capacity" ? "capacity" : res.reason;
                if (res.reason === "rate_limited") {
                    // State the ceiling that was hit, in the field the plugin's
                    // rate gate already learns from (native.ts →
                    // enterCooldown → tuneRateGateToObservedLimit), so one
                    // 429 retunes the client to this code's real limit.
                    return done(json({
                        ok: false, error: "slow down", retryAfterMs: res.retryAfterMs,
                        quotaLimitPerMinute: rpmLimitFor(rec)
                    }, status), label as Outcome, code, 0, plan);
                }
                return done(fail(
                    res.reason === "cap_exceeded" ? "daily limit reached" : "temporarily unavailable",
                    status, res.retryAfterMs
                ), label as Outcome, code, 0, plan);
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
            try {
                const { primary, fallback } = providers(env);
                const full = await translateWithFallback(batch, primary, fallback, controller.signal);
                clearTimeout(timer);
                // Preview: cut on the server so the full text never leaves here.
                const results = preview ? toPreview(full) : full;
                if (preview) ctx.waitUntil(safely(() => bumpStat(env, now, "previews")));
                // `rpmLimit` rides every success so the plugin's rate gate can
                // tune itself to this code's ceiling without ever hitting it.
                return done(json({ ok: true, results, used: res.used, cap: res.cap, rpmLimit: rpmLimitFor(rec) }), "ok", code, cost, plan);
            } catch (e) {
                clearTimeout(timer);
                const err = e as TranslateError;
                const timedOut = controller.signal.aborted || err.status === 504;
                // Refund only when the call genuinely did not spend. A timeout
                // reached Groq and may have billed, so it stays charged — which
                // also stops a client forcing slow batches to burn the key for
                // free while their daily cap never advances.
                if (!timedOut && err.status !== 401 && err.status !== 403) {
                    ctx.waitUntil(refund(env, code!, cost, now, tasteIp, rec.plan));
                }
                // The relay's OWN key failing (401/403 from an upstream) is a
                // SERVER fault, never surfaced as "your code is bad".
                if (err.status === 401 || err.status === 403) {
                    return done(fail("translation service unavailable", 503), "relay_key_fail", code, 0, plan);
                }
                // 402 = OpenRouter is out of credits. The relay's BILLING
                // problem, and by now the Groq fallback has already been tried
                // and failed too (translateWithFallback runs first). Same
                // user-facing answer as a dead key — never "your code is bad" —
                // with its own metric label so a billing alarm is countable.
                if (err.status === 402) {
                    return done(fail("translation service unavailable", 503), "relay_credit", code, 0, plan);
                }
                if (err.status === 429) {
                    return done(fail("translation service busy", 429, err.retryAfterMs ?? 30_000), "upstream_error", code, 0, plan);
                }
                return done(fail("translation service unavailable", 503, 15_000), "upstream_error", code, 0, plan);
            }
        }

        // ---- GET /v1/status — usage for the settings pane -----------------
        // A taste bearer answers here exactly like a real code, with plan:"taste"
        // and cap 3, which is what the plugin reads at startup to show
        // "2 of 3 left today" before anyone presses anything.
        if (url.pathname === "/v1/status") {
            const code = bearer(req);
            const auth = await authCode(env, code);
            if (!auth.ok) return fail("invalid or missing code", auth.reason === "no_code" ? 401 : 403);
            const now = Date.now();
            // A new client's status call starts the trial too, so the plugin can
            // show "trial: 7 days left" at startup before any translation.
            const { record: rec, free } = await keylessPlan(env, ctx, req, code, auth.record, now);
            ctx.waitUntil(safely(() => markActive(env, code!, rec.plan, now)));
            const u = await usage(env, code!, rec, now);
            // Legacy clients (free === null) get exactly the pre-trial shape.
            return json(free
                ? { ok: true, plan: rec.plan ?? "free", ...u, trialEndsAt: free.trialEndsAt }
                : { ok: true, plan: rec.plan ?? "free", ...u });
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
            return json({ ok: true, approximate: true, days: await readStats(env, days, Date.now()) });
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
                const rec: CodeRecord = {
                    status: "active",
                    dailyCap: Number(body.dailyCap) || 500,
                    plan: body.plan === "paid" ? "paid" : "free",
                    note: typeof body.note === "string" ? body.note.slice(0, 120) : undefined,
                    orderRef: typeof body.orderRef === "string" ? body.orderRef : undefined
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
            const rawBuf = await req.arrayBuffer();
            if (rawBuf.byteLength > MAX_BODY_BYTES) return fail("payload too large", 413);
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
