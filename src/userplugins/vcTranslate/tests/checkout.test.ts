import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
    AUTOMATIC_PRODUCT_ID, CHECKOUT_RETURN_URL, createCheckoutFlow, installHash, isConfiguredProduct, isDodoCheckoutUrl, PLAN_PRODUCTS, POLL_EVERY_MS,
    PENDING_SHOWN_FOR_MS, POLL_FOR_MS, SLOW_POLL_EVERY_MS, SLOW_POLL_FOR_MS, staticCheckoutUrl, type CheckoutDeps
} from "../checkout";

const BEARER = "free_" + "0".repeat(32);
// sha256("free_000...0") computed independently with node:crypto.
const HASH = "60cb7cc2bec25509";
const SESSION_URL = "https://checkout.dodopayments.com/session/cks_abc";

async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

type Fns = Pick<CheckoutDeps, "bearer" | "createCheckout" | "status" | "openExternal" | "onPurchase">;
/** The flow's dependencies as mocks, so a test can read their calls. */
type MockDeps = { [K in keyof Fns]: Mock<Fns[K]> } & Pick<CheckoutDeps, "onPendingChange">;

function deps(over: Partial<MockDeps> = {}): MockDeps {
    return {
        bearer: vi.fn<Fns["bearer"]>(async () => BEARER),
        createCheckout: vi.fn<Fns["createCheckout"]>(async () => ({ ok: true, url: SESSION_URL })),
        status: vi.fn<Fns["status"]>(async () => ({ ok: true })),
        openExternal: vi.fn<Fns["openExternal"]>(),
        onPurchase: vi.fn<Fns["onPurchase"]>(() => true),
        ...over
    };
}

describe("the install hash", () => {
    it("is the first 16 hex of SHA-256 of the full bearer", async () => {
        expect(await installHash(BEARER)).toBe(HASH);
    });
});

describe("the static checkout link", () => {
    it("carries the product, the install hash as metadata and the return URL", () => {
        const url = new URL(staticCheckoutUrl("annual", HASH));
        expect(url.origin + url.pathname).toBe(`https://checkout.dodopayments.com/buy/${PLAN_PRODUCTS.annual}`);
        expect(url.searchParams.get("quantity")).toBe("1");
        expect(url.searchParams.get("metadata_install")).toBe(HASH);
        expect(url.searchParams.get("redirect_url")).toBe(CHECKOUT_RETURN_URL);
        // Marked as started from Discord, so the site says "go back to Discord".
        expect(CHECKOUT_RETURN_URL).toBe("https://subline.page/?from=discord");
        expect(staticCheckoutUrl("monthly", HASH)).toContain(`redirect_url=${encodeURIComponent("https://subline.page/?from=discord")}`);
    });

    it("uses the live product ids, and one constant for Automatic", () => {
        expect(PLAN_PRODUCTS).toEqual({
            automatic: AUTOMATIC_PRODUCT_ID, monthly: "pdt_0No1xmbcAqHdYAvt1RNPR", annual: "pdt_0No1yAve1ozdxryVGZvf6"
        });
        expect(staticCheckoutUrl("automatic", HASH)).toContain(`/buy/${AUTOMATIC_PRODUCT_ID}?`);
    });
});

describe("which relay URLs may be opened", () => {
    it("accepts only https on a dodopayments.com host", () => {
        expect(isDodoCheckoutUrl(SESSION_URL)).toBe(true);
        expect(isDodoCheckoutUrl("https://test.checkout.dodopayments.com/session/x")).toBe(true);
        expect(isDodoCheckoutUrl("http://checkout.dodopayments.com/x")).toBe(false);
        expect(isDodoCheckoutUrl("https://evil.example/dodopayments.com")).toBe(false);
        expect(isDodoCheckoutUrl("https://dodopayments.com.evil.example/")).toBe(false);
        expect(isDodoCheckoutUrl("file:///etc/passwd")).toBe(false);
        expect(isDodoCheckoutUrl(42)).toBe(false);
    });
});

describe("the checkout flow", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("opens the session URL the relay returns", async () => {
        const d = deps();
        await createCheckoutFlow(d).start("monthly");
        expect(d.createCheckout).toHaveBeenCalledWith(BEARER, "monthly");
        expect(d.openExternal).toHaveBeenCalledWith(SESSION_URL);
    });

    for (const [why, createCheckout] of [
        ["the relay cannot be reached", vi.fn(async () => ({ ok: false as const, error: "fetch failed" }))],
        ["the relay call throws", vi.fn(async () => { throw new Error("IPC gone"); })]
    ] as const) {
        it(`falls back to the static link with the install hash when ${why}`, async () => {
            const d = deps({ createCheckout: createCheckout as any });
            await createCheckoutFlow(d).start("annual");
            expect(d.openExternal).toHaveBeenCalledTimes(1);
            expect(d.openExternal.mock.calls[0][0]).toBe(staticCheckoutUrl("annual", HASH));
        });
    }

    for (const [why, createCheckout] of [
        ["the relay answers checkout unavailable",
            vi.fn(async () => ({ ok: false as const, error: "relay checkout: HTTP 503", errorCode: "checkout_unavailable", status: 503 }))],
        ["the relay answers any other error", vi.fn(async () => ({ ok: false as const, error: "relay checkout: HTTP 500", status: 500 }))],
        ["the relay returns a non-Dodo URL", vi.fn(async () => ({ ok: true as const, url: "https://evil.example/pay" }))]
    ] as const) {
        it(`opens nothing and says buying is unavailable when ${why}`, async () => {
            const d = deps({ createCheckout: createCheckout as any });
            const flow = createCheckoutFlow(d);
            expect(await flow.start("annual")).toBe("unavailable");
            expect(d.openExternal).not.toHaveBeenCalled();
            expect(flow.isPolling()).toBe(false);
        });
    }

    it("a payment still being confirmed (purchase_pending): opens nothing, never the static link, and waits for it", async () => {
        const d = deps({
            createCheckout: vi.fn(async () => ({ ok: false as const, error: "relay checkout: HTTP 409 purchase_pending", errorCode: "purchase_pending", status: 409 })) as any
        });
        const flow = createCheckoutFlow(d);
        expect(await flow.start("annual")).toBe("purchase_pending");
        expect(d.openExternal).not.toHaveBeenCalled();
        expect(flow.isPolling()).toBe(true);
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        expect(d.status).toHaveBeenCalledTimes(1);
    });

    it("purchase_pending while already waiting keeps the first wait's deadlines", async () => {
        let pending = false;
        const d = deps({
            createCheckout: vi.fn(async () => pending
                ? { ok: false as const, error: "relay checkout: HTTP 409 purchase_pending", errorCode: "purchase_pending", status: 409 }
                : { ok: true as const, url: SESSION_URL }) as any
        });
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        await vi.advanceTimersByTimeAsync(POLL_FOR_MS - POLL_EVERY_MS);
        pending = true;
        expect(await flow.start("annual")).toBe("purchase_pending");
        expect(d.openExternal).toHaveBeenCalledTimes(1);
        // Past the first 30 minutes: the slow cadence, not a fresh fast phase.
        const before = d.status.mock.calls.length;
        await vi.advanceTimersByTimeAsync(2 * POLL_EVERY_MS);
        await vi.advanceTimersByTimeAsync(SLOW_POLL_EVERY_MS);
        expect(d.status.mock.calls.length - before).toBeLessThanOrEqual(2);
    });

    it("never opens the static link for a product that is still the placeholder", async () => {
        expect(isConfiguredProduct(PLAN_PRODUCTS.monthly)).toBe(true);
        expect(isConfiguredProduct("pdt_SOMETHING_PENDING")).toBe(false);
        const d = deps({ createCheckout: vi.fn(async () => ({ ok: false as const, error: "fetch failed" })) as any });
        const flow = createCheckoutFlow(d);
        const result = await flow.start("automatic");
        if (isConfiguredProduct(PLAN_PRODUCTS.automatic)) {
            expect(result).toBe(true);
        } else {
            expect(result).toBe("unavailable");
            expect(d.openExternal).not.toHaveBeenCalled();
        }
    });

    it("asks for the purchase every 5 seconds and hands it over once", async () => {
        let linked = false;
        const d = deps({
            status: vi.fn(async () => linked ? { ok: true, purchase: { code: " LK-1 ", plan: "monthly" } } : { ok: true })
        });
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        expect(d.status).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        expect(d.status).toHaveBeenCalledTimes(1);
        expect(d.status).toHaveBeenCalledWith(BEARER);
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        expect(d.status).toHaveBeenCalledTimes(2);
        linked = true;
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        expect(d.onPurchase).toHaveBeenCalledTimes(1);
        expect(d.onPurchase).toHaveBeenCalledWith({ code: "LK-1", plan: "monthly" });
        expect(flow.isPolling()).toBe(false);
        await vi.advanceTimersByTimeAsync(10 * POLL_EVERY_MS);
        expect(d.status).toHaveBeenCalledTimes(3);
    });

    it("keeps polling when a purchase is not saved, and stops once one is", async () => {
        let code = "LK-K1";
        const d = deps({
            status: vi.fn(async () => ({ ok: true, purchase: { code, plan: "monthly" as const } })),
            onPurchase: vi.fn((p: { code: string }) => p.code !== "LK-K1")
        });
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        await vi.advanceTimersByTimeAsync(3 * POLL_EVERY_MS);
        expect(d.onPurchase).toHaveBeenCalledTimes(3);
        expect(flow.isPolling()).toBe(true);
        code = "LK-K2";
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        expect(d.onPurchase).toHaveBeenLastCalledWith({ code: "LK-K2", plan: "monthly" });
        expect(flow.isPolling()).toBe(false);
        await vi.advanceTimersByTimeAsync(5 * POLL_EVERY_MS);
        expect(d.onPurchase).toHaveBeenCalledTimes(4);
    });

    it("keeps polling through a failed status call", async () => {
        const d = deps({ status: vi.fn(async () => { throw new Error("offline"); }) });
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        await vi.advanceTimersByTimeAsync(3 * POLL_EVERY_MS);
        expect(d.status).toHaveBeenCalledTimes(3);
        expect(flow.isPolling()).toBe(true);
        flow.stop();
    });

    it("polls after the static fallback too", async () => {
        const d = deps({ createCheckout: vi.fn(async () => ({ ok: false as const, error: "down" })) });
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        expect(d.status).toHaveBeenCalledTimes(1);
        flow.stop();
    });

    it("slows to every 5 minutes after 30 minutes, for a purchase still pending", async () => {
        const d = deps();
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        await vi.advanceTimersByTimeAsync(POLL_FOR_MS);
        const n = d.status.mock.calls.length;
        expect(n).toBe(POLL_FOR_MS / POLL_EVERY_MS);
        expect(flow.isPolling()).toBe(true);
        await vi.advanceTimersByTimeAsync(SLOW_POLL_EVERY_MS - 1);
        expect(d.status.mock.calls.length).toBe(n);
        await vi.advanceTimersByTimeAsync(1);
        expect(d.status.mock.calls.length).toBe(n + 1);
        flow.stop();
    });

    it("still saves a purchase that lands an hour later, in the slow phase", async () => {
        let linked = false;
        const d = deps({ status: vi.fn(async () => linked ? { ok: true, purchase: { code: "LK-LATE", plan: "monthly" } } : { ok: true }) });
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(d.onPurchase).not.toHaveBeenCalled();
        linked = true;
        await vi.advanceTimersByTimeAsync(SLOW_POLL_EVERY_MS);
        expect(d.onPurchase).toHaveBeenCalledWith({ code: "LK-LATE", plan: "monthly" });
        expect(flow.isPolling()).toBe(false);
    });

    it("gives up after 48 hours", async () => {
        const d = deps();
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        await vi.advanceTimersByTimeAsync(SLOW_POLL_FOR_MS + SLOW_POLL_EVERY_MS);
        const n = d.status.mock.calls.length;
        expect(flow.isPolling()).toBe(false);
        await vi.advanceTimersByTimeAsync(10 * SLOW_POLL_EVERY_MS);
        expect(d.status.mock.calls.length).toBe(n);
    });

    it("stops on stop(), even with a status call in flight", async () => {
        let release!: (v: any) => void;
        const d = deps({ status: vi.fn(() => new Promise<any>(r => { release = r; })) });
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        flow.stop();
        release({ ok: true, purchase: { code: "LK-1", plan: "monthly" } });
        await flush();
        await vi.advanceTimersByTimeAsync(10 * POLL_EVERY_MS);
        expect(d.onPurchase).not.toHaveBeenCalled();
        expect(d.status).toHaveBeenCalledTimes(1);
    });

    it("runs one poller at a time: choosing again restarts it", async () => {
        const d = deps();
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        await flow.start("annual");
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        expect(d.status).toHaveBeenCalledTimes(1);
        flow.stop();
    });
});

/**
 * P4. "Payment being confirmed" replaces the buy links while a payment is on
 * its way: from the moment a checkout opens, and whenever the relay answers
 * purchase_pending, for PENDING_SHOWN_FOR_MS. Never for 48 hours: an
 * abandoned checkout must not hide Add AI for two days.
 */
describe("the checkout flow says when a payment is on its way (P4)", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const pendingDeps = (over: Partial<MockDeps> = {}) => {
        const seen: boolean[] = [];
        const d = deps({ ...over, onPendingChange: v => { seen.push(v); } });
        return { d, seen };
    };

    it("is pending from the moment a checkout opens, until the purchase lands", async () => {
        let linked = false;
        const { d, seen } = pendingDeps({
            status: vi.fn<Fns["status"]>(async () => linked ? { ok: true, purchase: { code: "LK-1", plan: "monthly" } } : { ok: true })
        });
        const flow = createCheckoutFlow(d);
        expect(flow.isPending()).toBe(false);
        await flow.start("monthly");
        expect(flow.isPending()).toBe(true);
        expect(seen).toEqual([true]);
        await vi.advanceTimersByTimeAsync(3 * POLL_EVERY_MS);
        expect(flow.isPending()).toBe(true);
        linked = true;
        await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
        expect(flow.isPending()).toBe(false);
        expect(seen).toEqual([true, false]);
    });

    it("stops saying so after PENDING_SHOWN_FOR_MS, while the slow poll goes on", async () => {
        const { d, seen } = pendingDeps();
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        await vi.advanceTimersByTimeAsync(PENDING_SHOWN_FOR_MS - 1);
        expect(flow.isPending()).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(flow.isPending()).toBe(false);
        expect(seen).toEqual([true, false]);
        expect(flow.isPolling()).toBe(true);
        flow.stop();
    });

    it("the relay's purchase_pending says so again, even late in the slow poll", async () => {
        let refuse = false;
        const { d } = pendingDeps({
            createCheckout: vi.fn<Fns["createCheckout"]>(async () => refuse
                ? { ok: false, error: "relay checkout: HTTP 409 purchase_pending", errorCode: "purchase_pending", status: 409 }
                : { ok: true, url: SESSION_URL })
        });
        const flow = createCheckoutFlow(d);
        await flow.start("monthly");
        await vi.advanceTimersByTimeAsync(2 * PENDING_SHOWN_FOR_MS);
        expect(flow.isPending()).toBe(false);
        refuse = true;
        expect(await flow.start("monthly")).toBe("purchase_pending");
        expect(flow.isPending()).toBe(true);
        expect(d.openExternal).toHaveBeenCalledTimes(1);
        flow.stop();
        expect(flow.isPending()).toBe(false);
    });

    it("a refusal that opens nothing and waits for nothing is never pending", async () => {
        for (const errorCode of ["automatic_required", "already_owned"]) {
            const { d, seen } = pendingDeps({
                createCheckout: vi.fn<Fns["createCheckout"]>(async () => ({ ok: false, error: `relay checkout: HTTP 409 ${errorCode}`, errorCode, status: 409 }))
            });
            const flow = createCheckoutFlow(d);
            expect(await flow.start("annual")).toBe(errorCode);
            expect(flow.isPending()).toBe(false);
            expect(seen).toEqual([]);
        }
        const { d, seen } = pendingDeps({
            createCheckout: vi.fn<Fns["createCheckout"]>(async () => ({ ok: false, error: "relay checkout: HTTP 503", status: 503 }))
        });
        expect(await createCheckoutFlow(d).start("monthly")).toBe("unavailable");
        expect(seen).toEqual([]);
    });
});
