/**
 * The Subline translation relay.
 *
 * Holds the maker's paid Groq key; serves keyless AI translation to Subline
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
import { authCode, reserve, refund, usage, mintCode, applyMorEvent, type Env, type CodeRecord } from "./codes";
import { translate, type BatchRequest, type TranslateError } from "./translate";
import { record, type Outcome } from "./metrics";
export { Budget } from "./budget";

const MAX_MESSAGES = 40;     // client's QUALITY_MAX_BATCH is 25; headroom, not unbounded
const MAX_CONTEXT = 12;      // client's context ring is 8; a big context is a cost-inflation vector
const MAX_BODY_BYTES = 32_768;
const MAX_TEXT_CHARS = 4_000;
const MAX_TARGET_CHARS = 40; // a language name; anything longer is an injection payload
const GROQ_TIMEOUT_MS = 20_000;

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

async function readBody(req: Request): Promise<unknown | null> {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) return null; // real bytes, not UTF-16 chars
    try { return JSON.parse(new TextDecoder().decode(buf)); } catch { return null; }
}

export default {
    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(req.url);
        const done = (r: Response, outcome: Outcome, code: string | null, msgs: number) => {
            ctx.waitUntil(record(env, outcome, code, msgs));
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

            const body = await readBody(req);
            if (body === null) return done(fail("payload too large or malformed", 413), "too_large", code, 0);
            if (!validBatch(body)) return done(fail("bad request", 400), "bad_payload", code, 0);
            const batch = body as BatchRequest;
            const promptChars =
                batch.context.reduce((n, c) => n + c.text.length + c.author.length, 0) +
                batch.messages.reduce((n, m) => n + m.text.length + (m.author?.length ?? 0), 0) +
                batch.targetLang.length;
            const cost = batch.messages.length + Math.ceil(promptChars / 1000);

            const now = Date.now();
            const res = await reserve(env, code!, auth.record, cost, now);
            if (!res.ok) {
                const status = 429; // cap_exceeded / rate_limited / capacity all park the engine
                const label = res.reason === "capacity" ? "capacity" : res.reason;
                return done(fail(
                    res.reason === "cap_exceeded" ? "daily limit reached" :
                    res.reason === "rate_limited" ? "slow down" : "temporarily unavailable",
                    status, res.retryAfterMs
                ), label as Outcome, code, 0);
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
            try {
                const results = await translate(batch, env.GROQ_KEY, env.MODEL || "openai/gpt-oss-120b", controller.signal);
                clearTimeout(timer);
                return done(json({ ok: true, results, used: res.used, cap: res.cap }), "ok", code, cost);
            } catch (e) {
                clearTimeout(timer);
                const err = e as TranslateError;
                const timedOut = controller.signal.aborted || err.status === 504;
                // Refund only when the call genuinely did not spend. A timeout
                // reached Groq and may have billed, so it stays charged — which
                // also stops a client forcing slow batches to burn the key for
                // free while their daily cap never advances.
                if (!timedOut && err.status !== 401 && err.status !== 403) {
                    ctx.waitUntil(refund(env, code!, cost, now));
                }
                // The relay's OWN key failing (401/403 from Groq) is a SERVER
                // fault, never surfaced as "your key is bad".
                if (err.status === 401 || err.status === 403) {
                    return done(fail("translation service unavailable", 503), "relay_key_fail", code, 0);
                }
                if (err.status === 429) {
                    return done(fail("translation service busy", 429, err.retryAfterMs ?? 30_000), "upstream_error", code, 0);
                }
                return done(fail("translation service unavailable", 503, 15_000), "upstream_error", code, 0);
            }
        }

        // ---- GET /v1/status — usage for the settings pane -----------------
        if (url.pathname === "/v1/status") {
            const code = bearer(req);
            const auth = await authCode(env, code);
            if (!auth.ok) return fail("invalid or missing code", auth.reason === "no_code" ? 401 : 403);
            const u = await usage(env, code!, auth.record, Date.now());
            return json({ ok: true, plan: auth.record.plan ?? "free", ...u });
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

        // ---- POST /webhook/mor — Merchant-of-Record (Lemon Squeezy) ------
        // Verify the HMAC signature over the RAW body, then mirror the event's
        // lifecycle into KV (see applyMorEvent). Inert until MOR_WEBHOOK_SECRET
        // is set. This router does signature + transport only; all state logic
        // and idempotency live in codes.ts so they are unit-testable.
        if (url.pathname === "/webhook/mor") {
            if (req.method !== "POST") return fail("method not allowed", 405);
            // Secret unset ⇒ 503, never a silent 200: an unconfigured relay must
            // not look like it accepted (and dropped) a real purchase event.
            if (!env.MOR_WEBHOOK_SECRET) return fail("webhooks not configured", 503);

            // Read the RAW bytes and sign THOSE — the HMAC must cover the exact
            // body LS signed; re-serialising parsed JSON would change bytes and
            // never match. (Read before any JSON.parse.)
            const rawBuf = await req.arrayBuffer();
            if (rawBuf.byteLength > MAX_BODY_BYTES) return fail("payload too large", 413);
            const raw = new TextDecoder().decode(rawBuf);

            const sig = req.headers.get("x-signature") || "";
            if (!sig) return fail("bad signature", 401); // missing header ⇒ reject, never process
            const hkey = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.MOR_WEBHOOK_SECRET),
                { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
            const mac = await crypto.subtle.sign("HMAC", hkey, new TextEncoder().encode(raw));
            const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
            // timingSafeEqual hashes both sides to a fixed 32 bytes first, so a
            // wrong-LENGTH signature compares safely and never throws.
            if (!(await timingSafeEqual(sig, expected))) return fail("bad signature", 401);

            let evt: any; try { evt = JSON.parse(raw); } catch { return fail("bad payload", 400); }

            // Mirror the event. On an unexpected failure return 500 so LS RETRIES
            // (dropping a paid-lifecycle event silently would strand access);
            // log only the event name — never the key, email, body, or signature.
            try {
                await applyMorEvent(env, evt, Date.now());
            } catch {
                console.warn("mor webhook: mirror failed", { event: evt?.meta?.event_name });
                return fail("processing error", 500);
            }
            // Delivery/emailing the customer is the MoR's job; LS ignores the
            // response body, so we return a BARE 2xx — never the code (echoing a
            // freshly minted code in a 200 was a leak and served no purpose).
            return json({ ok: true });
        }

        return fail("not found", 404);
    }
} satisfies ExportedHandler<Env>;
