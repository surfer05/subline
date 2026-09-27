import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    CHECKOUT_RETURN_URL, createCheckoutFlow, installHash, isDodoCheckoutUrl, PLAN_PRODUCTS, POLL_EVERY_MS,
    POLL_FOR_MS, SLOW_POLL_EVERY_MS, SLOW_POLL_FOR_MS, staticCheckoutUrl, type CheckoutDeps
} from "../checkout";

const BEARER = "free_" + "0".repeat(32);
// sha256("free_000...0") computed independently with node:crypto.
const HASH = "60cb7cc2bec25509";
const SESSION_URL = "https://checkout.dodopayments.com/session/cks_abc";

async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function deps(over: Partial<CheckoutDeps> = {}) {
    const d = {
        bearer: vi.fn(async () => BEARER),
        createCheckout: vi.fn(async () => ({ ok: true as const, url: SESSION_URL })),
        status: vi.fn(async () => ({ ok: true })),
        openExternal: vi.fn(),
        onPurchase: vi.fn(),
        ...over
    };
    return d;
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
        expect(CHECKOUT_RETURN_URL).toBe("https://surfer05.github.io/subline/?from=discord");
        expect(staticCheckoutUrl("monthly", HASH)).toContain(`redirect_url=${encodeURIComponent("https://surfer05.github.io/subline/?from=discord")}`);
    });

    it("uses the live product ids", () => {
        expect(PLAN_PRODUCTS).toEqual({ monthly: "pdt_0No1xmbcAqHdYAvt1RNPR", annual: "pdt_0No1yAve1ozdxryVGZvf6" });
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
        ["the relay refuses", vi.fn(async () => ({ ok: false as const, error: "relay checkout: HTTP 503 checkout unavailable" }))],
        ["the relay call throws", vi.fn(async () => { throw new Error("IPC gone"); })],
        ["the relay returns a non-Dodo URL", vi.fn(async () => ({ ok: true as const, url: "https://evil.example/pay" }))]
    ] as const) {
        it(`falls back to the static link with the install hash when ${why}`, async () => {
            const d = deps({ createCheckout: createCheckout as any });
            await createCheckoutFlow(d).start("annual");
            expect(d.openExternal).toHaveBeenCalledTimes(1);
            expect(d.openExternal.mock.calls[0][0]).toBe(staticCheckoutUrl("annual", HASH));
        });
    }

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
