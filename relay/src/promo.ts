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
 */

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

export class Promo {
    private state: PromoState = { claimed: 0, installs: new Set() };
    private ready: Promise<void>;

    constructor(private ctx: DurableObjectState) {
        this.ready = ctx.blockConcurrencyWhile(async () => {
            this.state.claimed = (await ctx.storage.get<number>("claimed")) ?? 0;
            const list = (await ctx.storage.get<string[]>("installs")) ?? [];
            this.state.installs = new Set(list);
        });
    }

    async fetch(req: Request): Promise<Response> {
        await this.ready;
        const path = new URL(req.url).pathname;
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

    private async persist(): Promise<void> {
        await this.ctx.storage.put("claimed", this.state.claimed);
        await this.ctx.storage.put("installs", [...this.state.installs]);
    }
}
