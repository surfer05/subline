/**
 * ENTITLEMENTS (v2 clients): what an install may use, and who it belongs to.
 *
 * THE MODEL (paid only, no free tier). Automatic ($4.99 once) is Google on the
 * client plus 3 ✦ previews a day; AI (monthly/annual) is ✦ on everything, sold
 * only on top of Automatic. A v2 client says so with `x-subline-api: 2` and
 * sends its install id in `x-subline-install` on every request. Anything
 * without that header is an older client and is answered exactly as before
 * (index.ts routes it to the legacy code untouched).
 *
 * ACCOUNTS. One per buyer. An account joins every code linked to its installs
 * (the Automatic license key, a promo or early-user code, an AI subscription
 * key) and every install that presented one of them, at most MAX_INSTALLS.
 * What an install may use is the UNION over the account's live codes, so any
 * linked key unlocks everything the buyer owns.
 *
 *   acct:<id>   → Account JSON (installs = install hashes, codes, flags)
 *   ia:<hash>   → account id of an install
 *   ca:<code>   → account id of a code
 *
 * WRITES STAY RARE. Resolving is read-only unless something new is learnt: an
 * install or code joining an account, a purchase link, the one-time
 * grandfather or early-user grant. A status call from an install already in
 * its account writes nothing. (The relay once hit KV's daily write limit.)
 *
 * GRANTS.
 *   • An AI code active on an account gives Automatic too, and the first time
 *     that is seen the account remembers it (`grandfather` = that code), so an
 *     early subscriber keeps Automatic after the subscription ends. A refund
 *     (terminal) of that code takes the grandfathered Automatic with it.
 *   • An install whose trial:<id> record is older than LAUNCH_AT existed
 *     before launch: it gets Automatic free, as an slp_ code (note "early") the
 *     app can show in settings.
 *   • Promo redemptions mint an slp_ code (plan automatic, note "promo:<CODE>").
 *
 * REFUNDS need nothing here: a refund revokes the code it paid for
 * (codes.ts), and the union simply stops counting that code. Refunding
 * Automatic leaves AI, refunding AI leaves Automatic.
 */
import { authCode, isTasteBearer, mintCode, type CodeRecord, type Env } from "./codes";
import { installHash } from "./checkout";

export const MAX_INSTALLS = 3;
export const PREVIEW_DAILY_CAP = 3;
export const TOKEN_TTL_MS = 7 * 86_400_000;
export const PROMO_RE = /^[A-Z0-9]{4,16}$/;

export interface Account {
    v: 1;
    installs: string[];
    codes: string[];
    /** The promo this account redeemed, for per-promo stats. */
    promo?: string;
    /** The AI code whose presence granted Automatic (see GRANTS). */
    grandfather?: string;
    /** An early-user code was minted for this account. */
    early?: boolean;
    created: number;
}

/** Plans that are not AI: the automatic product and the synthetic keyless plans. */
const NOT_AI = new Set(["automatic", "taste", "trial"]);
export function isAiPlan(plan: CodeRecord["plan"]): boolean {
    return !NOT_AI.has(plan ?? "free");
}

export function isApiV2(req: Request): boolean {
    return req.headers.get("x-subline-api") === "2";
}

/** The install id a v2 request carries, or null when missing or malformed. */
export function installOf(req: Request): string | null {
    const v = (req.headers.get("x-subline-install") || "").trim();
    return isTasteBearer(v) ? v : null;
}

function randomId(): string {
    const b = crypto.getRandomValues(new Uint8Array(8));
    return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function today(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}
export function previewKey(acctId: string, now: number): string {
    return `use:pv:${acctId}:${today(now)}`;
}

/** LAUNCH_AT as epoch ms: a number, or an ISO date. NaN when unset or unreadable (no early grants). */
export function launchAt(env: Env): number {
    const raw = env.LAUNCH_AT;
    if (raw === undefined || raw === null || raw === "") return NaN;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(String(raw));
    return Number.isFinite(t) ? t : NaN;
}

export type Resolved =
    | {
        ok: true;
        hash: string;
        acctId: string | null;
        acct: Account | null;
        automatic: boolean;
        ai: boolean;
        aiUntil?: number;
        /** A live AI code on the account, and its record: what ✦ is charged to. */
        aiCode?: string;
        aiRec?: CodeRecord;
        /** A code this install should save (it presented only its install id). */
        saveCode?: string;
    }
    | { ok: false; error: "device_limit" | "invalid_code" | "unavailable"; status: number };

interface Work {
    hash: string;
    acctId: string | null;
    acct: Account | null;
    dirty: boolean;
    puts: Map<string, string>;
}

async function loadAccount(env: Env, id: string | null): Promise<Account | null> {
    if (!id) return null;
    const raw = await env.CODES.get(`acct:${id}`);
    if (!raw) return null;
    try {
        const a = JSON.parse(raw) as Account;
        return Array.isArray(a.installs) && Array.isArray(a.codes) ? a : null;
    } catch { return null; }
}

function ensureAccount(w: Work, now: number): Account {
    if (!w.acct) {
        w.acctId = randomId();
        w.acct = { v: 1, installs: [], codes: [], created: now };
        w.dirty = true;
    }
    return w.acct;
}

/** Put this install in the working account. False when it would be a 4th computer. */
function joinInstall(w: Work, now: number): boolean {
    const a = ensureAccount(w, now);
    if (a.installs.includes(w.hash)) return true;
    if (a.installs.length >= MAX_INSTALLS) return false;
    a.installs.push(w.hash);
    w.dirty = true;
    w.puts.set(`ia:${w.hash}`, w.acctId!);
    return true;
}

function joinCode(w: Work, code: string, now: number): void {
    const a = ensureAccount(w, now);
    if (a.codes.includes(code)) return;
    a.codes.push(code);
    w.dirty = true;
    w.puts.set(`ca:${code}`, w.acctId!);
}

/**
 * Move the working state onto the account that owns `code`, when that is a
 * different account from the one this install is in. The install then belongs
 * to the code's account (subject to the device limit).
 */
async function adoptCodeAccount(env: Env, w: Work, code: string): Promise<void> {
    const owner = await env.CODES.get(`ca:${code}`);
    if (!owner || owner === w.acctId) return;
    const other = await loadAccount(env, owner);
    if (!other) return;
    // Leaving the old account frees its slot.
    if (w.acct && w.acctId) {
        const i = w.acct.installs.indexOf(w.hash);
        if (i >= 0) {
            w.acct.installs.splice(i, 1);
            w.puts.set(`acct:${w.acctId}`, JSON.stringify(w.acct));
        }
    }
    w.acctId = owner;
    w.acct = other;
    w.dirty = false;
}

async function live(env: Env, code: string): Promise<CodeRecord | null> {
    const a = await authCode(env, code);
    return a.ok ? a.record : null;
}

/**
 * Resolve a v2 request's entitlements. `credential` is the bearer: the saved
 * code, or the install id when there is none. Writes only what is new (see the
 * header). Never throws; KV trouble is `unavailable`.
 */
export async function resolveEntitlement(env: Env, install: string, credential: string | null, now: number): Promise<Resolved> {
    try {
        const hash = await installHash(install);
        const iaAcct = await env.CODES.get(`ia:${hash}`);
        const w: Work = { hash, acctId: iaAcct, acct: await loadAccount(env, iaAcct), dirty: false, puts: new Map() };
        if (!w.acct) w.acctId = null;
        const code = credential && !credential.startsWith("free_") ? credential : null;
        let saveCode: string | undefined;

        if (code) {
            if (!(await live(env, code))) return { ok: false, error: "invalid_code", status: 401 };
            await adoptCodeAccount(env, w, code);
            if (!joinInstall(w, now)) return { ok: false, error: "device_limit", status: 403 };
            joinCode(w, code, now);
        }

        // A purchase started from this install (checkout → webhooks → paid:).
        const paidKey = await env.CODES.get(`paid:${hash}`);
        if (paidKey && !(w.acct?.codes.includes(paidKey)) && await live(env, paidKey)) {
            await adoptCodeAccount(env, w, paidKey);
            if (!joinInstall(w, now)) return { ok: false, error: "device_limit", status: 403 };
            joinCode(w, paidKey, now);
            if (!code) saveCode = paidKey;
        }

        // Union over the account's live codes.
        let automatic = false, ai = false, aiUntil: number | undefined, aiCode: string | undefined, aiRec: CodeRecord | undefined;
        let noExpiry = false;
        let firstLive: string | undefined, firstAutomatic: string | undefined;
        const newlyAi: string[] = [];
        for (const c of w.acct?.codes ?? []) {
            const rec = await live(env, c);
            if (!rec) continue;
            firstLive ??= c;
            if (isAiPlan(rec.plan)) {
                ai = true;
                if (!aiCode) { aiCode = c; aiRec = rec; }
                if (typeof rec.expiresAt === "number") aiUntil = Math.max(aiUntil ?? 0, rec.expiresAt);
                else noExpiry = true;
                newlyAi.push(c);
            } else if (rec.plan === "automatic") {
                automatic = true;
                firstAutomatic ??= c;
            }
        }
        if (noExpiry) aiUntil = undefined;
        // Grandfathering: an AI code made before launch (no createdAt, or one
        // older than LAUNCH_AT) gives its account Automatic, remembered once.
        if (ai && w.acct && !w.acct.grandfather && !automatic) {
            const start = launchAt(env);
            const created = aiRec?.createdAt;
            if (created === undefined || (Number.isFinite(start) && created < start)) {
                w.acct.grandfather = aiCode;
                w.dirty = true;
            }
        }
        if (!automatic && w.acct?.grandfather) {
            // Granted by an AI code: kept after it lapses, lost if it was refunded.
            const raw = await env.CODES.get(`code:${w.acct.grandfather}`);
            let refunded = !raw;
            try { if (raw) refunded = (JSON.parse(raw) as CodeRecord).terminal === true; } catch { refunded = true; }
            if (!refunded) automatic = true;
        }

        // Early users: this install existed before launch.
        if (!automatic && !(w.acct?.early)) {
            const start = launchAt(env);
            if (Number.isFinite(start)) {
                const raw = await env.CODES.get(`trial:${install.slice("free_".length)}`);
                const first = raw === null ? NaN : Number(raw);
                if (Number.isFinite(first) && first < start) {
                    if (!joinInstall(w, now)) return { ok: false, error: "device_limit", status: 403 };
                    const minted = mintCode();
                    const rec: CodeRecord = { status: "active", plan: "automatic", dailyCap: PREVIEW_DAILY_CAP, note: "early" };
                    await env.CODES.put(`code:${minted}`, JSON.stringify(rec));
                    joinCode(w, minted, now);
                    w.acct!.early = true;
                    automatic = true;
                    firstAutomatic = minted;
                    firstLive ??= minted;
                }
            }
        }

        if (!code && !saveCode && w.acct) saveCode = aiCode ?? firstAutomatic ?? firstLive;
        // Per-promo stat: an AI purchase joining an account that redeemed a promo.
        if (w.acct?.promo && ai && paidKey && newlyAi.includes(paidKey) && w.puts.has(`ca:${paidKey}`)) {
            await bumpPromoAi(env, w.acct.promo);
        }

        if (w.dirty && w.acct && w.acctId) w.puts.set(`acct:${w.acctId}`, JSON.stringify(w.acct));
        for (const [k, v] of w.puts) await env.CODES.put(k, v);
        return {
            ok: true, hash, acctId: w.acctId, acct: w.acct, automatic, ai,
            ...(ai && aiUntil !== undefined ? { aiUntil } : {}),
            ...(aiCode ? { aiCode, aiRec } : {}),
            ...(saveCode ? { saveCode } : {})
        };
    } catch (e) {
        console.warn("entitlement lookup failed", { error: String((e as any)?.message ?? e).slice(0, 200) });
        return { ok: false, error: "unavailable", status: 503 };
    }
}

/**
 * Attach a freshly minted code to the install's account (creating it), as a
 * promo redemption does. Returns false on the device limit.
 */
export async function grantCode(env: Env, install: string, code: string, promo: string | null, now: number): Promise<boolean> {
    const hash = await installHash(install);
    const iaAcct = await env.CODES.get(`ia:${hash}`);
    const w: Work = { hash, acctId: iaAcct, acct: await loadAccount(env, iaAcct), dirty: false, puts: new Map() };
    if (!w.acct) w.acctId = null;
    if (!joinInstall(w, now)) return false;
    joinCode(w, code, now);
    if (promo) { w.acct!.promo = promo; w.dirty = true; }
    w.puts.set(`acct:${w.acctId}`, JSON.stringify(w.acct));
    for (const [k, v] of w.puts) await env.CODES.put(k, v);
    return true;
}

/* ------------------------------------------------------------------ token -- */

function b64url(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface TokenPayload { v: 1; i: string; a: boolean; ai: boolean; exp: number }

async function hmac(secret: string, data: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}

/**
 * The entitlement token: base64url(JSON payload) + "." + base64url(HMAC-SHA256
 * of that first part, keyed with ENTITLEMENT_SECRET). Without the secret the
 * signature part is empty: the client can still read its expiry, and AI is
 * enforced here on the relay either way.
 */
export async function signToken(env: Env, p: TokenPayload): Promise<string> {
    const body = b64url(new TextEncoder().encode(JSON.stringify(p)));
    const secret = env.ENTITLEMENT_SECRET;
    return `${body}.${secret ? await hmac(secret, body) : ""}`;
}

/** Verify a token this relay signed. Null when unsigned, forged, malformed or expired. */
export async function verifyToken(env: Env, token: string, now: number): Promise<TokenPayload | null> {
    const secret = env.ENTITLEMENT_SECRET;
    if (!secret) return null;
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const want = await hmac(secret, body);
    if (want.length !== sig.length) return null;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff !== 0) return null;
    try {
        const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
        const p = JSON.parse(json) as TokenPayload;
        return typeof p.exp === "number" && p.exp > now ? p : null;
    } catch { return null; }
}

/* ------------------------------------------------------------ promo stats -- */

export async function bumpPromoAi(env: Env, promo: string): Promise<void> {
    try {
        const key = `pstat:${promo}:ai`;
        const n = Number(await env.CODES.get(key)) || 0;
        await env.CODES.put(key, String(n + 1));
    } catch { /* approximate owner metric only */ }
}

export async function promoIndex(env: Env): Promise<string[]> {
    try {
        const raw = await env.CODES.get("promos");
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((x: unknown) => typeof x === "string") : [];
    } catch { return []; }
}
