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
 */

export const REDEEM_IP_DAILY_SUCCESSES = 3;
export const REDEEM_IP_DAILY_FAILURES = 20;

export interface PromoState { claimed: number; installs: Set<string> }
export type ClaimResult = "ok" | "claimed" | "already";

/** Pure decision, unit-tested. Mutates `state` only when the claim succeeds. */
export function applyClaim(state: PromoState, install: string, cap: number): ClaimResult {
    if (state.installs.has(install)) return "already";
    if (state.claimed >= cap) return "claimed";
    state.claimed += 1;
    state.installs.add(install);
    return "ok";
}

/** Undo one claim (the redemption failed after the slot was taken). */
export function applyRelease(state: PromoState, install: string): boolean {
    if (!state.installs.has(install)) return false;
    state.installs.delete(install);
    state.claimed = Math.max(0, state.claimed - 1);
    return true;
}

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

export class Promo {
    private state: PromoState = { claimed: 0, installs: new Set() };
    private ip: IpState = { ok: 0, fail: 0, inflight: 0 };
    private ready: Promise<void>;

    constructor(private ctx: DurableObjectState) {
        this.ready = ctx.blockConcurrencyWhile(async () => {
            this.state.claimed = (await ctx.storage.get<number>("claimed")) ?? 0;
            const list = (await ctx.storage.get<string[]>("installs")) ?? [];
            this.state.installs = new Set(list);
            this.ip.ok = (await ctx.storage.get<number>("ipOk")) ?? 0;
            this.ip.fail = (await ctx.storage.get<number>("ipFail")) ?? 0;
        });
    }

    async fetch(req: Request): Promise<Response> {
        await this.ready;
        const path = new URL(req.url).pathname;
        if (path === "/ip/begin") {
            return Response.json({ allowed: applyIpBegin(this.ip) });
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
            const body = await req.json() as { install?: unknown; cap?: unknown };
            const install = typeof body.install === "string" ? body.install : "";
            if (!/^[0-9a-f]{16}$/.test(install)) return Response.json({ error: "bad install" }, { status: 400 });
            if (path === "/claim") {
                const cap = Number(body.cap);
                if (!Number.isFinite(cap) || cap < 1) return Response.json({ error: "bad cap" }, { status: 400 });
                // Decide synchronously, then persist (see the header).
                const result = applyClaim(this.state, install, cap);
                if (result === "ok") await this.persist();
                return Response.json({ result, claimed: this.state.claimed });
            }
            const released = applyRelease(this.state, install);
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
    }

    private async persist(): Promise<void> {
        await this.ctx.storage.put("claimed", this.state.claimed);
        await this.ctx.storage.put("installs", [...this.state.installs]);
    }
}
