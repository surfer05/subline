/**
 * Promo code claims: the one counter that must be exact.
 *
 * A server gets a code like "LEAKCLUB" worth Automatic for its first 100
 * installs. KV cannot count that: two redemptions racing both read 99 and both
 * write 100, and "the first 100" quietly becomes 110. One Durable Object per
 * promo code (idFromName(code)) serialises its claims, and the decision below
 * reads and updates the in-memory count with NO await in between, so even two
 * fetches interleaving inside the object cannot both take the last slot. The
 * storage writes after it only persist what was already decided.
 *
 * It also remembers which installs (by install hash) claimed, so one install
 * can never take two of the 100.
 *
 * THE SAME CLASS COUNTS ADDRESSES. An object named `ip:<address>:<UTC day>`
 * (IPv4, or the IPv6 /64) holds that address's redemption attempts for the day
 * (/ip/begin, /ip/end): at most REDEEM_IP_DAILY_SUCCESSES successful claims and
 * REDEEM_IP_DAILY_FAILURES failed attempts. begin takes an in-flight slot with
 * the same no-await decision, and counts in-flight attempts against both
 * limits, so a burst of concurrent attempts cannot slip past either. A refused
 * attempt is not counted (it would only extend the lockout).
 *
 * WHY THE SUCCESS CAP IS LOOSE (30). Many Discord users are always on a VPN,
 * some because Discord is blocked where they live, and thousands share one VPN
 * exit address. A server drive (the first 100 installs) can put dozens of real
 * members on one exit in a day; a cap of 3 refused them. Abuse is bounded
 * elsewhere: each install claims a promo once (below), every promo has a cap,
 * and the drain alerts fire. So the address cap only stops one address from
 * taking more than 30 Automatic codes a day, under a third of a 100 drive. The
 * failure cap stays at 20: guessing codes is the real abuse, and a real member
 * rarely mistypes more than once or twice.
 *
 * ONE PROMO PER INSTALL, EVER. An object named `inst:<install hash>`
 * (/inst/begin, /inst/end) lets one redemption of an install run at a time, and
 * remembers for good that the install claimed a promo. Without it, one install
 * firing five different codes at once got several Automatic codes: each request
 * saw "no Automatic yet" before any grant landed (KV is not read-your-writes).
 * Ever, not per day: a promo gives Automatic for good, so a second is never
 * needed, and an install whose promo code was revoked must not just take
 * another. Only a success is stored (one storage write); a failed or refused try
 * leaves nothing behind.
 *
 * PER NETWORK, PER PROMO. Install ids are made by the client, so each fresh id
 * is a new claimant, and the per-address limit above is per IPv6 /64. One
 * person with a /48 (a free tunnel, many VPS hosts) holds 65,536 of those and
 * could drain "the first 100" in seconds. So a promo also counts its claims per
 * IPv6 /48 (see promoNetKey) and allows at most netLimitFor(cap) from one.
 * That limit is never below the address cap, so an IPv6 VPN exit gets the same
 * room as an IPv4 one, and a /48 holder gets no more than one IPv4 address.
 * IPv4 is not counted per network: carrier-grade NAT and campus networks put
 * many real people behind one /24. A genuine burst spread over many networks is not
 * slowed. Residential proxy pools cannot be fully stopped without proof of
 * server membership: the owner's remedy for a drain is a new promo code, and
 * the drain alerts below make one visible while it happens.
 */

export const REDEEM_IP_DAILY_SUCCESSES = 30;
export const REDEEM_IP_DAILY_FAILURES = 20;

export interface PromoState { claimed: number; installs: Set<string>; nets?: Map<string, number> }
export type ClaimResult = "ok" | "claimed" | "already" | "net_limited";

/** Claims of one promo allowed from one wide network (an IPv6 /48): never
 *  below the per-address daily cap (see the header), else 5% of a large cap. */
export function netLimitFor(cap: number): number {
    return Math.max(REDEEM_IP_DAILY_SUCCESSES, Math.ceil(cap * 0.05));
}

/** Pure decision, unit-tested. Mutates `state` only when the claim succeeds.
 *  `net` (a wide network key) is optional: without it there is no per-network
 *  limit (a request not fronted by Cloudflare). */
export function applyClaim(state: PromoState, install: string, cap: number, net?: string): ClaimResult {
    if (state.installs.has(install)) return "already";
    if (state.claimed >= cap) return "claimed";
    if (net) {
        state.nets ??= new Map();
        if ((state.nets.get(net) ?? 0) >= netLimitFor(cap)) return "net_limited";
        state.nets.set(net, (state.nets.get(net) ?? 0) + 1);
    }
    state.claimed += 1;
    state.installs.add(install);
    return "ok";
}

/** Undo one claim (the redemption failed after the slot was taken). */
export function applyRelease(state: PromoState, install: string, net?: string): boolean {
    if (!state.installs.has(install)) return false;
    state.installs.delete(install);
    state.claimed = Math.max(0, state.claimed - 1);
    if (net && state.nets?.has(net)) state.nets.set(net, Math.max(0, state.nets.get(net)! - 1));
    return true;
}

/** A short, stable tag for a network key in a log line (FNV-1a), so a drain
 *  from one network is recognisable across lines without logging the address. */
export function netTag(net: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < net.length; i++) { h ^= net.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0");
}

/** Drain alerts fire when this share of the cap is claimed within an hour. */
export const DRAIN_SHARES = [0.5, 0.9] as const;
const HOUR_MS = 3_600_000;

export interface IpState { ok: number; fail: number; inflight: number }

/** Pure: may another attempt start? Takes an in-flight slot when it may. */
export function applyIpBegin(s: IpState): boolean {
    if (s.ok + s.inflight >= REDEEM_IP_DAILY_SUCCESSES) return false;
    if (s.fail + s.inflight >= REDEEM_IP_DAILY_FAILURES) return false;
    s.inflight += 1;
    return true;
}

/** Pure: an attempt finished. "none" (an outage, a bad request) counts as neither. */
export function applyIpEnd(s: IpState, outcome: "ok" | "fail" | "none"): void {
    s.inflight = Math.max(0, s.inflight - 1);
    if (outcome === "ok") s.ok += 1;
    else if (outcome === "fail") s.fail += 1;
}

/** An install's redemption still in flight after this long is taken as lost
 *  (the worker died before /inst/end), so the install is not locked out. */
export const INSTALL_INFLIGHT_STALE_MS = 60_000;

export interface InstallState { done: boolean; inflightAt: number | null }
export type InstallBegin = "go" | "done" | "busy";

/** Pure: may this install start a redemption? Takes the slot when it may. */
export function applyInstallBegin(s: InstallState, now: number): InstallBegin {
    if (s.done) return "done";
    if (s.inflightAt !== null && now - s.inflightAt < INSTALL_INFLIGHT_STALE_MS) return "busy";
    s.inflightAt = now;
    return "go";
}

/** Pure: the install's redemption finished. True when `done` must be stored. */
export function applyInstallEnd(s: InstallState, ok: boolean): boolean {
    s.inflightAt = null;
    if (!ok || s.done) return false;
    s.done = true;
    return true;
}

/**
 * CHECKOUT LOCK (G1). An object named `cko:<install hash>:<kind>` serialises
 * the check-and-create of a checkout session for that install and kind
 * (checkout.ts createSession), and holds the sessions it opened. KV cannot do
 * this: two checkouts arriving at the same moment through different Cloudflare
 * locations both read "no open session" (KV is eventually consistent, up to
 * ~60 s between locations) and both create one, so the buyer holds two payable
 * sessions. Here the lock is taken and the list read with no await in between,
 * and the list is strongly consistent, so the second request waits, then sees
 * the first one's session and reopens it.
 *
 * The lock is in memory only: a worker that dies holding it loses it after
 * CKO_LOCK_STALE_MS, so a crash never locks a buyer out for longer.
 */
export const CKO_LOCK_STALE_MS = 60_000;
/** Most sessions one object keeps (checkout.ts CKO_MAX is lower). */
const CKO_LIST_MAX = 10;

export interface CkoLock { token: string | null; at: number }

/** Pure: take the lock when it is free or stale. Returns the token, or null (busy). */
export function applyCkoBegin(l: CkoLock, now: number, token: string): string | null {
    if (l.token !== null && now - l.at < CKO_LOCK_STALE_MS) return null;
    l.token = token;
    l.at = now;
    return token;
}

/** Pure: release the lock if `token` still holds it. */
export function applyCkoEnd(l: CkoLock, token: string): boolean {
    if (l.token === null || l.token !== token) return false;
    l.token = null;
    return true;
}

/** Pure: one more hit on an address's per-minute counter (GET /v1/purchase-status). */
export interface RlState { n: number }
export function applyRlHit(s: RlState, limit: number): boolean {
    if (s.n >= limit) return false;
    s.n += 1;
    return true;
}

export class Promo {
    private state: PromoState = { claimed: 0, installs: new Set(), nets: new Map() };
    private cko: unknown[] = [];
    private ckoLock: CkoLock = { token: null, at: 0 };
    private rl: RlState = { n: 0 };
    /** Claim times in the last hour, and the drain alerts already raised. */
    private recent: number[] = [];
    private alerted = new Set<number>();
    private ip: IpState = { ok: 0, fail: 0, inflight: 0 };
    private inst: InstallState = { done: false, inflightAt: null };
    private ready: Promise<void>;

    constructor(private ctx: DurableObjectState) {
        this.ready = ctx.blockConcurrencyWhile(async () => {
            this.state.claimed = (await ctx.storage.get<number>("claimed")) ?? 0;
            const list = (await ctx.storage.get<string[]>("installs")) ?? [];
            this.state.installs = new Set(list);
            this.ip.ok = (await ctx.storage.get<number>("ipOk")) ?? 0;
            this.ip.fail = (await ctx.storage.get<number>("ipFail")) ?? 0;
            this.inst.done = (await ctx.storage.get<boolean>("instDone")) === true;
            this.state.nets = new Map(Object.entries((await ctx.storage.get<Record<string, number>>("nets")) ?? {}));
            const cko = await ctx.storage.get<unknown[]>("cko");
            this.cko = Array.isArray(cko) ? cko : [];
        });
    }

    async fetch(req: Request): Promise<Response> {
        await this.ready;
        const path = new URL(req.url).pathname;
        if (path === "/rl/hit") {
            // In memory only: the object is named for one address and one
            // minute, so nothing is stored.
            const body = await req.json().catch(() => ({})) as { limit?: unknown };
            const limit = Number(body.limit);
            return Response.json({ allowed: Number.isFinite(limit) && limit > 0 && applyRlHit(this.rl, limit) });
        }
        if (path === "/cko/begin") {
            // Take the lock and read the list with no await in between (see CHECKOUT LOCK).
            const token = applyCkoBegin(this.ckoLock, Date.now(), crypto.randomUUID());
            return Response.json(token === null ? { result: "busy" } : { result: "go", token, open: this.cko });
        }
        if (path === "/cko/end") {
            const body = await req.json().catch(() => ({})) as { token?: unknown; add?: unknown; ttlMs?: unknown };
            const token = typeof body.token === "string" ? body.token : "";
            if (token === "" || this.ckoLock.token !== token) return Response.json({ released: false });
            if (body.add && typeof body.add === "object") {
                this.cko = [body.add, ...this.cko].slice(0, CKO_LIST_MAX);
                await this.ctx.storage.put("cko", this.cko);
                // Clear the object once its sessions can no longer be paid.
                const ttl = Number(body.ttlMs);
                const storage = this.ctx.storage as DurableObjectStorage & { setAlarm?: (t: number) => Promise<void> };
                if (storage.setAlarm && Number.isFinite(ttl) && ttl > 0) await storage.setAlarm(Date.now() + ttl);
            }
            return Response.json({ released: applyCkoEnd(this.ckoLock, token) });
        }
        if (path === "/cko/list") {
            return Response.json({ open: this.cko });
        }
        if (path === "/cko/remove") {
            // One refunded session leaves; the others (maybe paid, webhook not
            // yet here) stay (checkout.ts clearBuying).
            const body = await req.json().catch(() => ({})) as { s?: unknown };
            const s = typeof body.s === "string" ? body.s : "";
            const left = s ? this.cko.filter(o => !(o && typeof o === "object" && (o as { s?: unknown }).s === s)) : this.cko;
            const removed = left.length !== this.cko.length;
            if (removed) {
                this.cko = left;
                await this.ctx.storage.put("cko", this.cko);
            }
            return Response.json({ removed });
        }
        if (path === "/cko/clear") {
            this.cko = [];
            await this.ctx.storage.put("cko", []);
            return Response.json({ cleared: true });
        }
        if (path === "/ip/begin") {
            return Response.json({ allowed: applyIpBegin(this.ip) });
        }
        if (path === "/inst/begin") {
            return Response.json({ result: applyInstallBegin(this.inst, Date.now()) });
        }
        if (path === "/inst/end") {
            const body = await req.json().catch(() => ({})) as { ok?: unknown };
            if (applyInstallEnd(this.inst, body.ok === true)) await this.ctx.storage.put("instDone", true);
            return Response.json({ done: this.inst.done });
        }
        if (path === "/ip/end") {
            const body = await req.json().catch(() => ({})) as { outcome?: unknown };
            const outcome = body.outcome === "ok" || body.outcome === "fail" ? body.outcome : "none";
            applyIpEnd(this.ip, outcome);
            if (outcome !== "none") {
                await this.ctx.storage.put("ipOk", this.ip.ok);
                await this.ctx.storage.put("ipFail", this.ip.fail);
                // A day's address counter is useless after the day: clear it
                // two days on, so these objects do not pile up.
                const storage = this.ctx.storage as DurableObjectStorage & { setAlarm?: (t: number) => Promise<void>; getAlarm?: () => Promise<number | null> };
                if (storage.setAlarm && storage.getAlarm && (await storage.getAlarm()) === null) {
                    await storage.setAlarm(Date.now() + 2 * 86_400_000);
                }
            }
            return Response.json({ ok: this.ip.ok, fail: this.ip.fail });
        }
        if (path === "/claim" || path === "/release") {
            const body = await req.json() as { install?: unknown; cap?: unknown; net?: unknown; promo?: unknown };
            const install = typeof body.install === "string" ? body.install : "";
            if (!/^[0-9a-f]{16}$/.test(install)) return Response.json({ error: "bad install" }, { status: 400 });
            const net = typeof body.net === "string" && body.net !== "" ? body.net.slice(0, 64) : undefined;
            const promo = typeof body.promo === "string" ? body.promo.slice(0, 16) : "";
            if (path === "/claim") {
                const cap = Number(body.cap);
                if (!Number.isFinite(cap) || cap < 1) return Response.json({ error: "bad cap" }, { status: 400 });
                // Decide synchronously, then persist (see the header).
                const result = applyClaim(this.state, install, cap, net);
                if (result === "net_limited") {
                    // A short tag of the network, never the address itself.
                    console.warn("promo: network limit reached", {
                        promo, network: netTag(net!), count: this.state.nets?.get(net!) ?? 0, claimed: this.state.claimed, cap
                    });
                }
                if (result === "ok") {
                    await this.persist();
                    this.watchDrain(promo, cap);
                }
                return Response.json({ result, claimed: this.state.claimed });
            }
            const released = applyRelease(this.state, install, net);
            if (released) await this.persist();
            return Response.json({ released, claimed: this.state.claimed });
        }
        if (path === "/count") return Response.json({ claimed: this.state.claimed });
        return new Response("not found", { status: 404 });
    }

    /** Clears a finished day's address counter (see /ip/end). */
    async alarm(): Promise<void> {
        await this.ctx.storage.deleteAll();
        this.ip = { ok: 0, fail: 0, inflight: 0 };
        this.cko = [];
    }

    private async persist(): Promise<void> {
        await this.ctx.storage.put("claimed", this.state.claimed);
        await this.ctx.storage.put("installs", [...this.state.installs]);
        await this.ctx.storage.put("nets", Object.fromEntries(this.state.nets ?? new Map()));
    }

    /** Log once when a promo fills fast: half, then nine tenths of the cap
     *  claimed within one hour. The owner's cue to rotate the code. */
    private watchDrain(promo: string, cap: number): void {
        const now = Date.now();
        this.recent.push(now);
        while (this.recent.length && now - this.recent[0]! > HOUR_MS) this.recent.shift();
        for (const share of DRAIN_SHARES) {
            if (!this.alerted.has(share) && this.recent.length >= Math.ceil(cap * share)) {
                this.alerted.add(share);
                console.warn("promo: draining fast", { promo, claimedLastHour: this.recent.length, claimed: this.state.claimed, cap, share });
            }
        }
    }
}
