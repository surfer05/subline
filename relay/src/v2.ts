/**
 * The v2 (paid-only) endpoints: status with entitlements and a signed token,
 * promo redemption, and the owner's promo admin. See entitle.ts for the model.
 * Legacy clients never reach this file (index.ts routes on `x-subline-api: 2`).
 */
import { ipBucket, isNewClient, isTasteBearer, mintCode, type CodeRecord, type Env } from "./codes";
import { installHash } from "./checkout";
import {
    grantCode, installOf, previewKey, PREVIEW_DAILY_CAP, PROMO_RE, promoIndex, resolveEntitlement,
    signToken, TOKEN_TTL_MS
} from "./entitle";

export const REDEEM_IP_DAILY_CAP = 3;
export const PROMO_DEFAULT_CAP = 100;
export const PROMO_MAX_CAP = 100_000;

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (error: string, status: number): Response => json({ ok: false, error }, status);

function credentialOf(req: Request): string | null {
    const h = req.headers.get("authorization") || "";
    return h.startsWith("Bearer ") ? h.slice(7).trim() || null : null;
}

/** Install id + bearer of a v2 request, or null when malformed. */
function identify(req: Request): { install: string; credential: string } | null {
    const install = installOf(req);
    const credential = credentialOf(req);
    if (!install || !credential || !isNewClient(req.headers.get("x-subline-client"))) return null;
    // A bearer that is an install id must be THIS install's id.
    if (credential.startsWith("free_") && credential !== install) return null;
    return { install, credential };
}

async function readCount(env: Env, key: string): Promise<number> {
    const v = await env.CODES.get(key);
    const n = v === null ? 0 : Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** GET /v1/status for a v2 client. */
export async function handleStatusV2(req: Request, env: Env, now: number): Promise<Response> {
    const id = identify(req);
    if (!id) return fail("bad request", 400);
    const r = await resolveEntitlement(env, id.install, id.credential, now);
    if (!r.ok) return fail(r.error, r.status);
    let used = 0;
    if (r.automatic && !r.ai && r.acctId) {
        try { used = await readCount(env, previewKey(r.acctId, now)); } catch { used = 0; }
    }
    const tokenExpiresAt = now + TOKEN_TTL_MS;
    const token = await signToken(env, { v: 1, i: r.hash, a: r.automatic, ai: r.ai, exp: tokenExpiresAt });
    return json({
        ok: true,
        automatic: r.automatic,
        ai: r.ai,
        ...(r.aiUntil !== undefined ? { aiUntil: r.aiUntil } : {}),
        ...(r.saveCode ? { code: r.saveCode } : {}),
        previews: { used, cap: r.automatic ? PREVIEW_DAILY_CAP : 0 },
        token,
        tokenExpiresAt,
        now
    });
}

function today(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

/** POST /v1/redeem: a promo code grants Automatic to this install. */
export async function handleRedeem(req: Request, env: Env, now: number): Promise<Response> {
    if (req.method !== "POST") return fail("method not allowed", 405);
    const id = identify(req);
    if (!id) return fail("bad request", 400);
    let body: any;
    try { body = JSON.parse(await req.text()); } catch { return fail("bad request", 400); }
    const promo = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!PROMO_RE.test(promo)) return fail("not_found", 404);
    if (!env.PROMO) return fail("unavailable", 503);

    const ip = req.headers.get("cf-connecting-ip");
    const ipKey = ip ? `rl:rd:${ipBucket(ip)}:${today(now)}` : null;
    let def: { cap?: number } | null;
    try {
        if (ipKey && (await readCount(env, ipKey)) >= REDEEM_IP_DAILY_CAP) return fail("rate_limited", 429);
        const raw = await env.CODES.get(`promo:${promo}`);
        def = raw ? JSON.parse(raw) : null;
    } catch {
        return fail("unavailable", 503);
    }
    if (!def) return fail("not_found", 404);
    const cap = Number(def.cap) || PROMO_DEFAULT_CAP;

    const r = await resolveEntitlement(env, id.install, id.credential, now);
    if (!r.ok) return fail(r.error, r.status);
    if (r.automatic) return fail("already", 409);

    const stub = env.PROMO.get(env.PROMO.idFromName(promo));
    let claim: { result?: string };
    try {
        const res = await stub.fetch("https://promo.internal/claim", {
            method: "POST", body: JSON.stringify({ install: r.hash, cap })
        });
        claim = await res.json() as { result?: string };
    } catch {
        return fail("unavailable", 503);
    }
    if (claim.result === "claimed") return fail("claimed", 410);
    if (claim.result === "already") return fail("already", 409);
    if (claim.result !== "ok") return fail("unavailable", 503);

    // The slot is taken: mint and attach, or give the slot back.
    const code = mintCode();
    try {
        const rec: CodeRecord = { status: "active", plan: "automatic", dailyCap: PREVIEW_DAILY_CAP, note: `promo:${promo}` };
        await env.CODES.put(`code:${code}`, JSON.stringify(rec));
        if (!(await grantCode(env, id.install, code, promo, now))) {
            await release(stub, r.hash);
            return fail("device_limit", 403);
        }
    } catch (e) {
        console.warn("redeem: grant failed, slot released", { error: String((e as any)?.message ?? e).slice(0, 200) });
        await release(stub, r.hash);
        return fail("unavailable", 503);
    }
    if (ipKey) {
        try {
            const n = await readCount(env, ipKey);
            await env.CODES.put(ipKey, String(n + 1), { expirationTtl: 2 * 86_400 });
        } catch { /* soft limit */ }
    }
    return json({ ok: true, code });
}

async function release(stub: DurableObjectStub, hash: string): Promise<void> {
    try {
        await stub.fetch("https://promo.internal/release", { method: "POST", body: JSON.stringify({ install: hash }) });
    } catch { /* the slot stays taken; an approximate loss of one */ }
}

/** POST /admin/promo {code, cap} (auth checked by the router). */
export async function createPromo(env: Env, body: any, now: number): Promise<Response> {
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!PROMO_RE.test(code)) return fail("code must be 4 to 16 uppercase letters or digits", 400);
    const capIn = body?.cap === undefined ? PROMO_DEFAULT_CAP : Number(body.cap);
    if (!Number.isInteger(capIn) || capIn < 1 || capIn > PROMO_MAX_CAP) return fail("cap must be 1 to 100000", 400);
    // A promo must never be a working code of any kind: refuse one that
    // exactly matches a code the relay knows (a license key or slp_ code).
    if (await env.CODES.get(`code:${code}`)) return fail("that string is already a code", 409);
    await env.CODES.put(`promo:${code}`, JSON.stringify({ cap: capIn, created: now }));
    const list = await promoIndex(env);
    if (!list.includes(code)) {
        list.push(code);
        await env.CODES.put("promos", JSON.stringify(list));
    }
    return json({ ok: true, code, cap: capIn });
}

/** Per-promo owner stats: cap, redemptions (exact, from the DO), later AI purchases (approximate). */
export async function promoStats(env: Env): Promise<{ code: string; cap: number; redemptions: number | null; aiPurchases: number }[]> {
    const out = [];
    for (const code of await promoIndex(env)) {
        let cap = PROMO_DEFAULT_CAP, redemptions: number | null = null, ai = 0;
        try { cap = Number(JSON.parse((await env.CODES.get(`promo:${code}`)) ?? "{}").cap) || PROMO_DEFAULT_CAP; } catch { /* default */ }
        try { ai = Number(await env.CODES.get(`pstat:${code}:ai`)) || 0; } catch { /* 0 */ }
        if (env.PROMO) {
            try {
                const res = await env.PROMO.get(env.PROMO.idFromName(code)).fetch("https://promo.internal/count");
                redemptions = Number((await res.json() as { claimed?: number }).claimed) || 0;
            } catch { redemptions = null; }
        }
        out.push({ code, cap, redemptions, aiPurchases: ai });
    }
    return out;
}

