/**
 * ENTITLEMENTS (v2 clients): what an install may use, and who it belongs to.
 *
 * THE MODEL (paid only, no free tier). Automatic ($4.99 once) is Google on the
 * client plus 5 ✦ previews a day; AI (monthly/annual) is ✦ on everything, sold
 * only on top of Automatic. A v2 client says so with `x-subline-api: 2` and
 * sends its install id in `x-subline-install` on every request. Anything
 * without that header is an older client and is answered exactly as before
 * (index.ts routes it to the legacy code untouched).
 *
 * ACCOUNTS. One per buyer. An account joins every code linked to its installs
 * (the Automatic license key, a promo or early-user code, an AI subscription
 * key) and every install that presented one of them, at most MAX_INSTALLS.
 * Automatic is the UNION over the account's live codes, so any linked key
 * unlocks it on every one of the account's computers.
 *
 *   acct:<id>   → Account JSON (installs, codes, lastSeen, AI installs, flags)
 *   ia:<hash>   → account id of an install
 *   ca:<code>   → account id of a code
 *
 * AI IS PER INSTALL (sharing). An install gets AI only when it bought AI itself
 * (the checkout started on that install: paid:<hash>) or presented an AI code
 * itself. A friend who types the owner's Automatic key gets Automatic only, and
 * spends none of the AI code's daily cap. `aiInstalls` records the installs that
 * earned AI by a purchase; presenting an AI code needs no record.
 *
 * A DEAD CODE never locks an install out of what else it owns. When the
 * presented code is lapsed, refunded, revoked or unknown, the account is still
 * resolved from the install (ia:<hash>) and its live codes still count; the
 * answer names the dead code (`deadCode`) and hands back a live code to save,
 * the Automatic one first.
 *
 * COMPUTERS. At most MAX_INSTALLS per account. Each install's last-seen day is
 * kept on the account (written at most once a day per install). A new install
 * that would be the 4th evicts the least recently seen one if it has not been
 * seen for EVICT_AFTER_MS; otherwise it is refused (device_limit). The owner
 * can clear an account's computers with POST /admin/reset-installs.
 *
 * WRITES STAY RARE. Resolving is read-only unless something new is learnt: an
 * install or code joining an account, a purchase link, a grant, or the first
 * sighting of an install on a new UTC day. A second status call on the same
 * day writes nothing. (The relay once hit KV's daily write limit.)
 *
 * GRANTS (both are facts about the ACCOUNT, not about any one code).
 *   • Grandfathering: an AI code made before launch (no createdAt, or one older
 *     than LAUNCH_AT), seen live on the account, grants Automatic for good. The
 *     grant survives that code's cancel, expiry and refund: refunding AI takes
 *     only AI.
 *   • Early users: an install that was used before launch gets Automatic free,
 *     as an slp_ code (note "early") the app can show. The evidence is a relay
 *     record of that install id from before LAUNCH_AT: its trial:<id> record
 *     (kept 90 days) or, when the client says it was used before
 *     (`x-subline-prior: 1`), a usage counter or seen: marker for it dated
 *     before launch. The client's hint alone is never enough.
 *   • Promo redemptions mint an slp_ code (plan automatic, note "promo:<CODE>").
 *
 * LAUNCH_AT must be a real date for grandfathering-by-date, early grants and the
 * legacy trial cut-off (codes.ts). While it is the placeholder (or unset) all
 * three are off: no early grants, no new-code grandfathering, trials unchanged.
 *
 * REFUNDS need nothing here: a refund revokes the code it paid for
 * (codes.ts), and the union simply stops counting that code. Refunding
 * Automatic leaves AI, refunding AI leaves Automatic.
 */
import { authCode, isTasteBearer, LAUNCH_AT_PLACEHOLDER, launchAtMs, mintCode, type CodeRecord, type Env } from "./codes";
import { installHash } from "./checkout";

export const MAX_INSTALLS = 3;
export const PREVIEW_DAILY_CAP = 5;
export const TOKEN_TTL_MS = 7 * 86_400_000;
export const PROMO_RE = /^[A-Z0-9]{4,16}$/;
const DAY_MS = 86_400_000;
/** An install unseen this long gives up its slot to a new computer. */
export const EVICT_AFTER_MS = 30 * DAY_MS;

export interface Account {
    v: 1;
    installs: string[];
    codes: string[];
    /** Last UTC day (epoch day number) each install was seen. */
    seen?: Record<string, number>;
    /** Installs that bought AI themselves (see AI IS PER INSTALL). */
    aiInstalls?: string[];
    /** The promo this account redeemed, for per-promo stats. */
    promo?: string;
    /** The pre-launch AI code that granted Automatic (see GRANTS). */
    grandfather?: string;
    /** An early-user code was minted for this account. */
    early?: boolean;
    created: number;
}

/**
 * The plans that are AI, listed explicitly. "free" is the admin-minted slp_
 * beta code (POST /admin/codes): deliberately AI, so friends set up by hand
 * keep ✦. Everything else, including "automatic", the keyless "taste"/"trial"
 * and any plan this list does not know, is not AI (fail closed).
 */
export const AI_PLANS: ReadonlySet<string> = new Set(["monthly", "annual", "paid", "lifetime", "free"]);
export function isAiPlan(plan: CodeRecord["plan"]): boolean {
    return AI_PLANS.has(plan ?? "free");
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
function epochDay(now: number): number {
    return Math.floor(now / DAY_MS);
}
export function previewKey(acctId: string, now: number): string {
    return `use:pv:${acctId}:${today(now)}`;
}

/** LAUNCH_AT as epoch ms (codes.ts launchAtMs). NaN when unset or the placeholder. */
export function launchAt(env: Env): number {
    return launchAtMs(env);
}
export { LAUNCH_AT_PLACEHOLDER };

export interface ResolveOptions {
    /** Compute the answer but write nothing and mint nothing (x-subline-check). */
    dryRun?: boolean;
    /** The client says this install was used before 0.2.0 (x-subline-prior: 1). */
    prior?: boolean;
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
        /** A code this install should save (it presented no live code of its own). */
        saveCode?: string;
        /** The presented code is dead (lapsed, refunded, revoked or unknown). */
        deadCode?: string;
        /** This answer granted early-user Automatic for the first time. */
        grant?: "early";
    }
    | { ok: false; error: "device_limit" | "unavailable"; status: number };

interface Work {
    hash: string;
    acctId: string | null;
    acct: Account | null;
    dirty: boolean;
    puts: Map<string, string>;
    deletes: Set<string>;
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

/** When an install was last seen (epoch ms), falling back to when the account was made. */
function lastSeen(a: Account, hash: string): number {
    const d = a.seen?.[hash];
    return typeof d === "number" ? d * DAY_MS : a.created;
}

/** Drop an install from an account (eviction or reset). */
function dropInstall(a: Account, hash: string): void {
    a.installs = a.installs.filter(h => h !== hash);
    if (a.aiInstalls) a.aiInstalls = a.aiInstalls.filter(h => h !== hash);
    if (a.seen) delete a.seen[hash];
}

/**
 * Would `hash` fit on account `a`? "in" when it is already there, "free" when
 * there is an empty slot, the hash to evict when the least recently seen
 * install has been away EVICT_AFTER_MS, or null when all 3 are in use.
 */
export function slotFor(a: Account, hash: string, now: number): "in" | "free" | string | null {
    if (a.installs.includes(hash)) return "in";
    if (a.installs.length < MAX_INSTALLS) return "free";
    let oldest: string | null = null;
    for (const h of a.installs) {
        if (oldest === null || lastSeen(a, h) < lastSeen(a, oldest)) oldest = h;
    }
    return oldest !== null && now - lastSeen(a, oldest) >= EVICT_AFTER_MS ? oldest : null;
}

/** Put this install in the working account. False when it would be a 4th computer. */
function joinInstall(w: Work, now: number): boolean {
    const a = ensureAccount(w, now);
    const slot = slotFor(a, w.hash, now);
    if (slot === "in") return true;
    if (slot === null) return false;
    if (slot !== "free") {
        dropInstall(a, slot);
        w.deletes.add(`ia:${slot}`);
    }
    a.installs.push(w.hash);
    a.seen = { ...(a.seen ?? {}), [w.hash]: epochDay(now) };
    w.dirty = true;
    w.puts.set(`ia:${w.hash}`, w.acctId!);
    w.deletes.delete(`ia:${w.hash}`);
    return true;
}

function joinCode(w: Work, code: string, now: number): void {
    const a = ensureAccount(w, now);
    if (a.codes.includes(code)) return;
    a.codes.push(code);
    w.dirty = true;
    w.puts.set(`ca:${code}`, w.acctId!);
}

function markAiInstall(w: Work): void {
    const a = w.acct!;
    if (a.aiInstalls?.includes(w.hash)) return;
    a.aiInstalls = [...(a.aiInstalls ?? []), w.hash];
    w.dirty = true;
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
        if (w.acct.installs.includes(w.hash)) {
            dropInstall(w.acct, w.hash);
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
 * THE EARLY-USER CUTOFF, fixed and already past. Early-user evidence counts
 * only when it predates this moment, never LAUNCH_AT: LAUNCH_AT moves with the
 * release, and anything written between the cutoff and a later LAUNCH_AT
 * (for example a trial started by a fresh random id today) must not be able to
 * mint a free Automatic code.
 */
export const EARLY_CUTOFF_MS = Date.parse("2026-09-29T00:00:00Z");

/**
 * THE LEGACY (0.1.x, no `x-subline-api: 2`) FREE TIER AFTER LAUNCH. Before
 * LAUNCH_AT (or while it is unset) every free_ id is served as it always was.
 * From LAUNCH_AT on, the old taste/trial allowance goes only to an id with a
 * trial record dated before the fixed early-user cutoff: a real early user
 * whose client has not updated yet. Anyone else (a fresh random id, an id whose
 * trial began after the cutoff, a header-less 0.1.5 client) gets nothing:
 * legacy translate answers 402 "not activated", legacy status reports cap 0.
 * Paid codes are never affected. One KV read, only for a free_ id after launch.
 */
export async function legacyFreeAllowed(env: Env, bearer: string | null, now: number): Promise<boolean> {
    if (!isTasteBearer(bearer)) return true;
    const launch = launchAtMs(env);
    if (!Number.isFinite(launch) || now < launch) return true;
    const raw = await env.CODES.get(`trial:${bearer!.slice("free_".length)}`);
    const first = raw === null ? NaN : Number(raw);
    return Number.isFinite(first) && first < EARLY_CUTOFF_MS;
}

/**
 * Was this install used before the early-user cutoff? Its trial:<id> record,
 * dated before the cutoff, says so. With the client's prior-use hint, a usage
 * counter or seen: marker does too, but only for a UTC day that ENDED before
 * the cutoff (those keep only a couple of days, so this matters only right
 * after the cutoff). Only the three whole days before the cutoff are read.
 */
export async function usedBeforeCutoff(env: Env, install: string, hash: string, prior: boolean, cutoff: number = EARLY_CUTOFF_MS): Promise<boolean> {
    const trial = await env.CODES.get(`trial:${install.slice("free_".length)}`);
    const first = trial === null ? NaN : Number(trial);
    if (Number.isFinite(first) && first < cutoff) return true;
    if (!prior) return false;
    for (let back = 1; back <= 3; back++) {
        const dayStart = Math.floor(cutoff / DAY_MS) * DAY_MS - back * DAY_MS;
        // The whole UTC day must have ended before the cutoff.
        if (dayStart + DAY_MS > cutoff) continue;
        const day = today(dayStart);
        for (const key of [`use:${install}:${day}`, `seen:free:${day}:${hash}`, `seen:trial:${day}:${hash}`]) {
            if (await env.CODES.get(key) !== null) return true;
        }
    }
    return false;
}

/**
 * Resolve a v2 request's entitlements. `credential` is the bearer: the saved
 * code, or the install id when there is none. Writes only what is new (see the
 * header), and nothing at all with `dryRun`. Never throws; KV trouble is
 * `unavailable`.
 */
export async function resolveEntitlement(
    env: Env, install: string, credential: string | null, now: number, opts: ResolveOptions = {}
): Promise<Resolved> {
    try {
        const hash = await installHash(install);
        const iaAcct = await env.CODES.get(`ia:${hash}`);
        const w: Work = { hash, acctId: iaAcct, acct: await loadAccount(env, iaAcct), dirty: false, puts: new Map(), deletes: new Set() };
        if (!w.acct) w.acctId = null;
        let code = credential && !credential.startsWith("free_") ? credential : null;
        let deadCode: string | undefined;
        let saveCode: string | undefined;
        let presentedAi = false;

        if (code) {
            const rec = await live(env, code);
            if (!rec) {
                // Dead: fall back to what the install itself owns.
                deadCode = code;
                code = null;
            } else {
                await adoptCodeAccount(env, w, code);
                if (!joinInstall(w, now)) return { ok: false, error: "device_limit", status: 403 };
                joinCode(w, code, now);
                presentedAi = isAiPlan(rec.plan);
            }
        }

        // A purchase started from this install (checkout → webhooks → paid:).
        const paidKey = await env.CODES.get(`paid:${hash}`);
        if (paidKey) {
            const paidRec = await live(env, paidKey);
            if (paidRec) {
                if (!(w.acct?.codes.includes(paidKey))) {
                    await adoptCodeAccount(env, w, paidKey);
                    if (!joinInstall(w, now)) return { ok: false, error: "device_limit", status: 403 };
                    joinCode(w, paidKey, now);
                }
                // Bought here: AI from this purchase belongs to this install.
                if (isAiPlan(paidRec.plan) && w.acct && w.acct.installs.includes(hash)) markAiInstall(w);
            }
        }

        // First sighting today: remember it (at most one write a day per install).
        if (w.acct && w.acct.installs.includes(hash) && w.acct.seen?.[hash] !== epochDay(now)) {
            w.acct.seen = { ...(w.acct.seen ?? {}), [hash]: epochDay(now) };
            w.dirty = true;
        }

        // Union over the account's live codes.
        const aiHere = presentedAi || !!w.acct?.aiInstalls?.includes(hash);
        let automatic = false, aiAny = false, aiUntil: number | undefined, aiCode: string | undefined, aiRec: CodeRecord | undefined;
        let noExpiry = false;
        let firstLive: string | undefined, firstAutomatic: string | undefined;
        const newlyAi: string[] = [];
        for (const c of w.acct?.codes ?? []) {
            const rec = await live(env, c);
            if (!rec) continue;
            firstLive ??= c;
            if (isAiPlan(rec.plan)) {
                aiAny = true;
                // The presented AI code is what ✦ is charged to, when there is one.
                if (!aiCode || c === credential) { aiCode = c; aiRec = rec; }
                if (typeof rec.expiresAt === "number") aiUntil = Math.max(aiUntil ?? 0, rec.expiresAt);
                else noExpiry = true;
                newlyAi.push(c);
            } else if (rec.plan === "automatic") {
                automatic = true;
                firstAutomatic ??= c;
            }
        }
        if (noExpiry) aiUntil = undefined;
        const ai = aiAny && aiHere;

        // Grandfathering: an AI code made before launch gives its account
        // Automatic for good, remembered once (see GRANTS). INTENDED: the grant
        // is a gift to people who paid before launch and it survives that AI
        // code's refund, cancel and expiry. Refunding AI takes only AI.
        if (aiAny && w.acct && !w.acct.grandfather && !automatic) {
            const start = launchAt(env);
            const created = aiRec?.createdAt;
            if (created === undefined || (Number.isFinite(start) && created < start)) {
                w.acct.grandfather = aiCode;
                w.dirty = true;
            }
        }
        if (w.acct?.grandfather) automatic = true;

        // Early users: this install was used before the fixed early-user
        // cutoff (never LAUNCH_AT, see EARLY_CUTOFF_MS).
        let grant: "early" | undefined;
        if (!automatic && !(w.acct?.early)) {
            if (await usedBeforeCutoff(env, install, hash, opts.prior === true)) {
                automatic = true;
                grant = "early";
                if (!opts.dryRun) {
                    if (!joinInstall(w, now)) return { ok: false, error: "device_limit", status: 403 };
                    const minted = mintCode();
                    const rec: CodeRecord = { status: "active", plan: "automatic", dailyCap: PREVIEW_DAILY_CAP, note: "early", createdAt: now };
                    await env.CODES.put(`code:${minted}`, JSON.stringify(rec));
                    joinCode(w, minted, now);
                    w.acct!.early = true;
                    firstAutomatic = minted;
                    firstLive ??= minted;
                }
            }
        }

        // A code to save, when the install presented none that works: the
        // Automatic one first (it never lapses), then AI if this install has it.
        if (!code && w.acct) saveCode = firstAutomatic ?? (ai ? aiCode : undefined) ?? firstLive;
        if (saveCode && saveCode === deadCode) saveCode = undefined;
        // Per-promo stat: an AI purchase joining an account that redeemed a promo.
        if (!opts.dryRun && w.acct?.promo && aiAny && paidKey && newlyAi.includes(paidKey) && w.puts.has(`ca:${paidKey}`)) {
            await bumpPromoAi(env, w.acct.promo);
        }

        if (!opts.dryRun) {
            if (w.dirty && w.acct && w.acctId) w.puts.set(`acct:${w.acctId}`, JSON.stringify(w.acct));
            for (const [k, v] of w.puts) await env.CODES.put(k, v);
            for (const k of w.deletes) await env.CODES.delete(k);
        }
        return {
            ok: true, hash, acctId: w.acctId, acct: w.acct, automatic, ai,
            ...(ai && aiUntil !== undefined ? { aiUntil } : {}),
            ...(ai && aiCode ? { aiCode, aiRec } : {}),
            ...(saveCode ? { saveCode } : {}),
            ...(deadCode ? { deadCode } : {}),
            ...(grant ? { grant } : {})
        };
    } catch (e) {
        console.warn("entitlement lookup failed", { error: String((e as any)?.message ?? e).slice(0, 200) });
        return { ok: false, error: "unavailable", status: 503 };
    }
}

/**
 * What a typed code would give this install, WITHOUT linking it: no account
 * change, no slot used, no write (x-subline-check). `valid` is false for a
 * dead or unknown code. A code whose account already has 3 recently seen
 * computers (none of them this one) is a device_limit.
 */
export async function checkCode(
    env: Env, install: string, code: string, now: number
): Promise<{ ok: true; valid: boolean; automatic: boolean; ai: boolean } | { ok: false; error: "device_limit" | "unavailable"; status: number }> {
    try {
        const rec = await live(env, code);
        if (!rec) return { ok: true, valid: false, automatic: false, ai: false };
        const hash = await installHash(install);
        const acct = await loadAccount(env, await env.CODES.get(`ca:${code}`));
        if (acct && slotFor(acct, hash, now) === null) return { ok: false, error: "device_limit", status: 403 };
        let automatic = rec.plan === "automatic" || !!acct?.grandfather;
        for (const c of acct?.codes ?? []) {
            if (automatic) break;
            if (c === code) continue;
            const r = await live(env, c);
            if (r?.plan === "automatic") automatic = true;
        }
        const ai = isAiPlan(rec.plan);
        // A pre-launch AI code grandfathers Automatic on first use.
        if (ai && !automatic) {
            const start = launchAt(env);
            if (rec.createdAt === undefined || (Number.isFinite(start) && rec.createdAt < start)) automatic = true;
        }
        return { ok: true, valid: true, automatic, ai };
    } catch (e) {
        console.warn("code check failed", { error: String((e as any)?.message ?? e).slice(0, 200) });
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
    const w: Work = { hash, acctId: iaAcct, acct: await loadAccount(env, iaAcct), dirty: false, puts: new Map(), deletes: new Set() };
    if (!w.acct) w.acctId = null;
    if (!joinInstall(w, now)) return false;
    joinCode(w, code, now);
    if (promo) { w.acct!.promo = promo; w.dirty = true; }
    w.puts.set(`acct:${w.acctId}`, JSON.stringify(w.acct));
    for (const [k, v] of w.puts) await env.CODES.put(k, v);
    for (const k of w.deletes) await env.CODES.delete(k);
    return true;
}

/**
 * POST /admin/reset-installs {code}: forget every computer on the account that
 * owns `code`, so the owner's customer can start again on new machines. Codes
 * and grants stay; each computer rejoins on its next status call.
 */
export async function resetInstalls(env: Env, code: string): Promise<{ ok: true; cleared: number } | { ok: false; error: string; status: number }> {
    const acctId = await env.CODES.get(`ca:${code}`);
    const acct = await loadAccount(env, acctId);
    if (!acctId || !acct) return { ok: false, error: "no account for that code", status: 404 };
    const cleared = acct.installs.length;
    for (const h of acct.installs) await env.CODES.delete(`ia:${h}`);
    acct.installs = [];
    acct.seen = {};
    acct.aiInstalls = [];
    await env.CODES.put(`acct:${acctId}`, JSON.stringify(acct));
    return { ok: true, cleared };
}

/**
 * POST /admin/reissue {code}: for a leaked key. The old code is revoked, a new
 * slp_ code takes its place on the same account with the same record (plan,
 * daily cap, expiry, notes such as promo:/early, createdAt, so grandfathering
 * by date is unchanged), and every computer on the account is forgotten, so
 * whoever holds the old code gets nothing (v2 status reports it as deadCode)
 * while the owner types the new one. The purchase's webhook reverse index
 * (order:<subscription or payment id>) is pointed at the new code, so renewals
 * and refunds keep reaching it. A dead code cannot be reissued.
 */
export async function reissueCode(env: Env, code: string, now: number): Promise<{ ok: true; code: string } | { ok: false; error: string; status: number }> {
    const acctId = await env.CODES.get(`ca:${code}`);
    const acct = await loadAccount(env, acctId);
    if (!acctId || !acct) return { ok: false, error: "no account for that code", status: 404 };
    const rec = await live(env, code);
    if (!rec) return { ok: false, error: "that code is not live", status: 409 };

    const fresh = mintCode();
    const note = rec.note ? `${rec.note}; reissued` : "reissued";
    await env.CODES.put(`code:${fresh}`, JSON.stringify({ ...rec, status: "active", note }));
    for (const id of new Set([rec.mor_subscription_id, rec.orderRef, rec.mor_order_id].filter((x): x is string => !!x))) {
        if (await env.CODES.get(`order:${id}`) === code) await env.CODES.put(`order:${id}`, fresh);
    }
    await env.CODES.put(`ca:${fresh}`, acctId);
    await env.CODES.delete(`ca:${code}`);
    await env.CODES.put(`code:${code}`, JSON.stringify({ ...rec, status: "revoked", revokedAt: now, note: "reissued" }));

    acct.codes = acct.codes.map(c => c === code ? fresh : c);
    if (acct.grandfather === code) acct.grandfather = fresh;
    for (const h of acct.installs) await env.CODES.delete(`ia:${h}`);
    acct.installs = [];
    acct.seen = {};
    acct.aiInstalls = [];
    await env.CODES.put(`acct:${acctId}`, JSON.stringify(acct));
    return { ok: true, code: fresh };
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
 * signature part is empty.
 *
 * WHAT IT PROTECTS: NOTHING ON THE CLIENT. The client cannot verify an HMAC (it
 * does not hold the secret), and Automatic runs client-side from GPL source, so
 * a determined user can switch it on locally whatever this says. The client
 * uses the token only for its expiry (the 7-day offline grace). The signature
 * lets only THIS relay recognise a token it issued, if a future endpoint ever
 * accepts one back (verifyToken; nothing does today). Everything that costs
 * money, AI and previews, is decided here on every request, never from a token.
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
