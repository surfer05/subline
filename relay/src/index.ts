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
import { authCode, reserve, refund, usage, mintCode, type Env, type CodeRecord } from "./codes";
import { translate, type BatchRequest, type TranslateError } from "./translate";
import { record, type Outcome } from "./metrics";

const MAX_MESSAGES = 40;     // client's QUALITY_MAX_BATCH is 25; headroom, not unbounded
const MAX_BODY_BYTES = 32_768;
const MAX_TEXT_CHARS = 4_000;
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

/** Constant-time string compare, for the admin token. */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let out = 0;
    for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return out === 0;
}

function validBatch(v: unknown): v is BatchRequest {
    if (!v || typeof v !== "object") return false;
    const b = v as any;
    if (!Array.isArray(b.messages) || !Array.isArray(b.context) || typeof b.targetLang !== "string") return false;
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
    const len = Number(req.headers.get("content-length") || "0");
    if (len > MAX_BODY_BYTES) return null;
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return null;
    try { return JSON.parse(text); } catch { return null; }
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
                const map = { no_code: 401, unknown_code: 403, revoked: 403 } as const;
                return done(fail("invalid or missing code", map[auth.reason]), auth.reason, code, 0);
            }

            const body = await readBody(req);
            if (body === null) return done(fail("payload too large or malformed", 413), "too_large", code, 0);
            if (!validBatch(body)) return done(fail("bad request", 400), "bad_payload", code, 0);
            const batch = body as BatchRequest;
            const cost = batch.messages.length;

            const res = await reserve(env, code!, auth.record, cost, Date.now());
            if (!res.ok) {
                const status = res.reason === "cap_exceeded" ? 429 : res.reason === "rate_limited" ? 429 : 503;
                const label = res.reason === "capacity" ? "capacity" : res.reason;
                return done(fail(
                    res.reason === "cap_exceeded" ? "daily limit reached" :
                    res.reason === "rate_limited" ? "slow down" : "temporarily unavailable",
                    status, res.retryAfterMs
                ), label as Outcome, code, 0);
            }

            try {
                const results = await Promise.race([
                    translate(batch, env.GROQ_KEY, env.MODEL || "openai/gpt-oss-120b"),
                    new Promise<never>((_, rej) => setTimeout(() => rej({ status: 504 } as TranslateError), GROQ_TIMEOUT_MS))
                ]);
                return done(json({ ok: true, results, used: res.used, cap: res.cap }), "ok", code, cost);
            } catch (e) {
                // Refund — a Groq outage must not cost the user their quota.
                ctx.waitUntil(refund(env, code!, cost, Date.now()));
                const err = e as TranslateError;
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
            if (!token || !timingSafeEqual(token, env.ADMIN_TOKEN)) return fail("unauthorized", 401);
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
        // Scaffold: verify HMAC signature, then issue/revoke a code on the
        // purchase/refund/cancel events. Wired but inert until MOR_WEBHOOK_SECRET
        // is set and payments go live.
        if (url.pathname === "/webhook/mor") {
            if (req.method !== "POST") return fail("method not allowed", 405);
            if (!env.MOR_WEBHOOK_SECRET) return fail("webhooks not configured", 503);
            const raw = await req.text();
            const sig = req.headers.get("x-signature") || "";
            const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.MOR_WEBHOOK_SECRET),
                { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
            const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
            const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
            if (!timingSafeEqual(sig, expected)) return fail("bad signature", 401);

            let evt: any; try { evt = JSON.parse(raw); } catch { return fail("bad payload", 400); }
            const name = evt?.meta?.event_name as string | undefined;
            const orderRef = String(evt?.data?.id ?? evt?.meta?.custom_data?.order_id ?? "");
            if (!orderRef) return json({ ok: true }); // nothing to key on

            if (name === "order_created" || name === "subscription_created") {
                const code = mintCode();
                const rec: CodeRecord = { status: "active", dailyCap: 1500, plan: "paid", orderRef };
                await env.CODES.put(`code:${code}`, JSON.stringify(rec));
                await env.CODES.put(`order:${orderRef}`, code);
                // The MoR emails the customer; the relay never sees the address.
                return json({ ok: true, code });
            }
            if (name === "order_refunded" || name === "subscription_cancelled" || name === "subscription_expired") {
                const code = await env.CODES.get(`order:${orderRef}`);
                if (code) {
                    const raw2 = await env.CODES.get(`code:${code}`);
                    if (raw2) {
                        const rec = JSON.parse(raw2) as CodeRecord;
                        rec.status = "revoked";
                        await env.CODES.put(`code:${code}`, JSON.stringify(rec));
                    }
                }
                return json({ ok: true });
            }
            return json({ ok: true });
        }

        return fail("not found", 404);
    }
} satisfies ExportedHandler<Env>;
