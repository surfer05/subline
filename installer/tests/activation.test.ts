/**
 * The installer's relay client and install id: what is sent, and how each
 * answer is read. No request leaves the suite; `fetch` is a script.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    AUTOMATIC_PRODUCT_ID, createActivationRelay, installHash, isDodoCheckoutUrl, looksLikeCoupon, newInstallId,
    PLACEHOLDER_PRODUCT_ID, promoCode, staticAutomaticCheckoutUrl, staticCheckoutAllowed
} from "../src/app/activation.js";
import { ensureInstallId, readClearedCode, readInstallId, readPriorUse } from "../src/app/language.js";

const ID = "0123456789abcdef0123456789abcdef";

interface Sent { url: string; method: string; headers: Record<string, string>; body?: string }

function relayAnswering(status: number, body: unknown) {
    const sent: Sent[] = [];
    const relay = createActivationRelay({
        version: "0.2.0",
        fetch: async (url, init) => {
            sent.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
            return { status, json: async () => body };
        }
    });
    return { relay, sent };
}

describe("the relay client", () => {
    it("checkout: POST /v1/checkout {plan:automatic} with the v2 headers and the install bearer", async () => {
        const { relay, sent } = relayAnswering(200, { ok: true, url: "https://checkout.dodopayments.com/session/cks_1" });
        expect(await relay.checkout(ID)).toEqual({ kind: "ok", url: "https://checkout.dodopayments.com/session/cks_1" });
        expect(sent[0]!.url).toBe("https://subline-relay.rahul05alok.workers.dev/v1/checkout");
        expect(sent[0]!.method).toBe("POST");
        // The site sends the buyer back to its "go back to the installer" view.
        expect(JSON.parse(sent[0]!.body!)).toEqual({ plan: "automatic", return: "installer" });
        expect(sent[0]!.headers).toEqual({
            authorization: `Bearer free_${ID}`,
            "x-subline-install": `free_${ID}`,
            "x-subline-client": "subline-installer/0.2.0",
            "x-subline-api": "2",
            "content-type": "application/json"
        });
    });

    it("checkout: a URL that is not Dodo's, or an error, is a failure", async () => {
        expect((await relayAnswering(200, { ok: true, url: "https://evil.example/" }).relay.checkout(ID)).kind).toBe("failed");
        expect((await relayAnswering(400, { ok: false, error: "bad request" }).relay.checkout(ID)).kind).toBe("failed");
    });

    it("checkout: 503 is \"buying unavailable\", 409 is already owned, a network error is its own answer", async () => {
        expect(await relayAnswering(503, { ok: false, error: "checkout unavailable" }).relay.checkout(ID))
            .toEqual({ kind: "unavailable", cause: "HTTP 503 checkout unavailable" });
        expect(await relayAnswering(409, { ok: false, error: "already_owned" }).relay.checkout(ID)).toEqual({ kind: "already_owned" });
        // A payment still being confirmed: its own answer, never "failed" (which could fall back to a link).
        expect(await relayAnswering(409, { ok: false, error: "purchase_pending" }).relay.checkout(ID)).toEqual({ kind: "purchase_pending" });
        const down = createActivationRelay({ version: "0.2.0", fetch: async () => { throw new Error("ECONNRESET"); } });
        expect(await down.checkout(ID)).toEqual({ kind: "network", cause: "ECONNRESET" });
    });

    it("status check: x-subline-check: 1 is sent, and the check verdict is read", async () => {
        const { relay, sent } = relayAnswering(200, { ok: true, automatic: false, ai: false, check: { valid: true, automatic: true, ai: false } });
        expect(await relay.status("LK-1", ID, { check: true }))
            .toEqual({ kind: "ok", automatic: false, ai: false, code: null, check: { valid: true, automatic: true, ai: false } });
        expect(sent[0]!.headers["x-subline-check"]).toBe("1");
        const plain = relayAnswering(200, { ok: true, automatic: true, ai: false });
        await plain.relay.status("LK-1", ID);
        expect(plain.sent[0]!.headers["x-subline-check"]).toBeUndefined();
    });

    it("status: bearer is the credential given, the install header is the install", async () => {
        const { relay, sent } = relayAnswering(200, { ok: true, automatic: true, ai: false, code: " LK-1 " });
        expect(await relay.status("LK-1", ID)).toEqual({ kind: "ok", automatic: true, ai: false, code: "LK-1" });
        expect(sent[0]!.url).toBe("https://subline-relay.rahul05alok.workers.dev/v1/status");
        expect(sent[0]!.method).toBe("GET");
        expect(sent[0]!.headers.authorization).toBe("Bearer LK-1");
        expect(sent[0]!.headers["x-subline-install"]).toBe(`free_${ID}`);
        expect(sent[0]!.headers["x-subline-api"]).toBe("2");
    });

    it("status: reads device_limit, invalid and server errors", async () => {
        expect(await relayAnswering(403, { ok: false, error: "device_limit" }).relay.status("c", ID)).toEqual({ kind: "device_limit" });
        expect(await relayAnswering(401, { ok: false, error: "invalid_code" }).relay.status("c", ID)).toEqual({ kind: "invalid" });
        expect(await relayAnswering(503, { ok: false, error: "unavailable" }).relay.status("c", ID))
            .toEqual({ kind: "unreachable", cause: "HTTP 503" });
        expect(await relayAnswering(200, { ok: true, automatic: false, ai: false }).relay.status("c", ID))
            .toEqual({ kind: "ok", automatic: false, ai: false, code: null });
    });

    it("redeem: POST /v1/redeem {code}; each error code maps to its own answer", async () => {
        const ok = relayAnswering(200, { ok: true, code: "slp_minted" });
        expect(await ok.relay.redeem(ID, "MYSERVER")).toEqual({ kind: "ok", code: "slp_minted" });
        expect(JSON.parse(ok.sent[0]!.body!)).toEqual({ code: "MYSERVER" });
        expect(ok.sent[0]!.url).toBe("https://subline-relay.rahul05alok.workers.dev/v1/redeem");
        for (const [status, error] of [[404, "not_found"], [410, "claimed"], [409, "already"], [429, "rate_limited"]] as const) {
            expect((await relayAnswering(status, { ok: false, error }).relay.redeem(ID, "X1Y2")).kind).toBe(error);
        }
        expect((await relayAnswering(503, { ok: false, error: "unavailable" }).relay.redeem(ID, "X1Y2")).kind).toBe("unreachable");
        // Too many claims of a promo from one network: the relay says why in `reason`.
        expect((await relayAnswering(429, { ok: false, error: "rate_limited", reason: "net_limited" }).relay.redeem(ID, "X1Y2")).kind).toBe("net_limited");
    });

    it("a network failure is unreachable, with the cause and never the code", async () => {
        const relay = createActivationRelay({
            version: "0.2.0",
            fetch: async () => { throw new Error("getaddrinfo ENOTFOUND"); }
        });
        const answer = await relay.status("slp_SECRETCODE", ID);
        expect(answer).toEqual({ kind: "unreachable", cause: "getaddrinfo ENOTFOUND" });
        expect(JSON.stringify(answer)).not.toContain("SECRETCODE");
    });

    it("a request that hangs times out as unreachable", async () => {
        const relay = createActivationRelay({
            version: "0.2.0",
            timeoutMs: 10,
            fetch: (_url, init) => new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            })
        });
        expect(await relay.redeem(ID, "ABCD")).toEqual({ kind: "unreachable", cause: "timed out after 10 ms" });
    });
});

describe("codes and links", () => {
    it("tells a promo code from a license key or a Subline code", () => {
        expect(promoCode("  myServer1 ")).toBe("MYSERVER1");
        expect(promoCode("ABCD")).toBe("ABCD");
        expect(promoCode("ABC")).toBeNull();
        expect(promoCode("A".repeat(17))).toBeNull();
        expect(promoCode("slp_abcdefghijklmnop")).toBeNull();
        expect(promoCode("ABCD-EFGH-IJKL")).toBeNull();
    });

    it("opens only https Dodo checkout URLs", () => {
        expect(isDodoCheckoutUrl("https://checkout.dodopayments.com/session/x")).toBe(true);
        expect(isDodoCheckoutUrl("https://test.checkout.dodopayments.com/x")).toBe(true);
        expect(isDodoCheckoutUrl("http://checkout.dodopayments.com/x")).toBe(false);
        expect(isDodoCheckoutUrl("https://dodopayments.com.evil.example/")).toBe(false);
        expect(isDodoCheckoutUrl(null)).toBe(false);
    });

    it("the static link carries the Automatic product, the install hash and the installer return", () => {
        const url = new URL(staticAutomaticCheckoutUrl(ID, "pdt_Real123"));
        expect(url.origin + url.pathname).toBe("https://checkout.dodopayments.com/buy/pdt_Real123");
        expect(url.searchParams.get("quantity")).toBe("1");
        expect(url.searchParams.get("metadata_install")).toBe(installHash(ID));
        expect(url.searchParams.get("redirect_url")).toBe("https://surfer05.github.io/subline/?from=installer");
        expect(new URL(staticAutomaticCheckoutUrl(ID)).pathname).toBe(`/buy/${AUTOMATIC_PRODUCT_ID}`);
    });

    it("the static link is never allowed for the placeholder product id", () => {
        expect(staticCheckoutAllowed(PLACEHOLDER_PRODUCT_ID)).toBe(false);
        expect(staticCheckoutAllowed("pdt_Real123")).toBe(true);
        expect(staticCheckoutAllowed("")).toBe(false);
        expect(staticCheckoutAllowed("not-a-product")).toBe(false);
    });

    it("recognises the shape of the owner's Dodo coupons, not short server codes", () => {
        // relay/scripts/coupon.mjs: a name plus 5 characters with no 0, O, 1 or I.
        expect(looksLikeCoupon("SURFERK7Q2M")).toBe(true);
        expect(looksLikeCoupon("RAHUL05K7Q2M")).toBe(true);
        expect(looksLikeCoupon("MYSRV")).toBe(false);
        expect(looksLikeCoupon("LEAKCLUB")).toBe(true);
        expect(looksLikeCoupon("SERVER01")).toBe(false);
        expect(looksLikeCoupon("slp_abcdefghijk")).toBe(false);
    });

    it("hashes the full bearer like the relay and the plugin do", () => {
        // sha256("free_" + 32 zeros), first 16 hex, computed independently in the plugin's tests.
        expect(installHash("0".repeat(32))).toBe("60cb7cc2bec25509");
    });

    it("makes install ids of 32 lowercase hex, never the same twice", () => {
        const a = newInstallId(), b = newInstallId();
        expect(a).toMatch(/^[0-9a-f]{32}$/);
        expect(a).not.toBe(b);
    });
});

describe("the install id in Vencord's settings", () => {
    let dir: string;
    let path: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "subline-install-id-"));
        path = join(dir, "settings.json");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("creates one when there is none, merged into the existing settings", () => {
        writeFileSync(path, JSON.stringify({ theme: "dark", plugins: { VcTranslate: { targetLang: "tr" }, Other: { on: true } } }));
        const made = ensureInstallId(path, () => ID);
        expect(made).toEqual({ ok: true, value: ID });
        const saved = JSON.parse(readFileSync(path, "utf8"));
        expect(saved.theme).toBe("dark");
        expect(saved.plugins.Other).toEqual({ on: true });
        expect(saved.plugins.VcTranslate).toEqual({ targetLang: "tr", installId: ID });
        expect(readInstallId(path)).toBe(ID);
    });

    it("keeps the one already there", () => {
        writeFileSync(path, JSON.stringify({ plugins: { VcTranslate: { installId: ID } } }));
        let generated = 0;
        expect(ensureInstallId(path, () => { generated += 1; return "f".repeat(32); })).toEqual({ ok: true, value: ID });
        expect(generated).toBe(0);
    });

    it("sees earlier Subline use in the settings, but not an install id alone", () => {
        expect(readPriorUse(path)).toBe(false);
        writeFileSync(path, JSON.stringify({ plugins: { VcTranslate: { installId: ID } } }));
        expect(readPriorUse(path)).toBe(false);
        writeFileSync(path, JSON.stringify({ plugins: { VcTranslate: { installId: ID, freeTrialStartedAt: 1_700_000_000_000 } } }));
        expect(readPriorUse(path)).toBe(true);
        writeFileSync(path, JSON.stringify({ plugins: { VcTranslate: { targetLang: "tr" } } }));
        expect(readPriorUse(path)).toBe(true);
        writeFileSync(path, JSON.stringify({ plugins: { VcTranslate: { clearedPurchaseCode: "X" } } }));
        expect(readPriorUse(path)).toBe(true);
        writeFileSync(path, JSON.stringify({ plugins: { Other: { targetLang: "tr" } } }));
        expect(readPriorUse(path)).toBe(false);
        writeFileSync(path, "not json");
        expect(readPriorUse(path)).toBe(false);
    });

    it("reads the code the reader cleared, and nothing else", () => {
        writeFileSync(path, JSON.stringify({ plugins: { VcTranslate: { clearedPurchaseCode: " LICENSE-OLD ", sublineCode: "" } } }));
        expect(readClearedCode(path)).toBe("LICENSE-OLD");
        writeFileSync(path, JSON.stringify({ plugins: { VcTranslate: { clearedPurchaseCode: "" } } }));
        expect(readClearedCode(path)).toBeNull();
        writeFileSync(path, "not json");
        expect(readClearedCode(path)).toBeNull();
    });

    it("replaces a malformed one", () => {
        writeFileSync(path, JSON.stringify({ plugins: { VcTranslate: { installId: "free_nothex" } } }));
        expect(readInstallId(path)).toBeNull();
        expect(ensureInstallId(path, () => ID)).toEqual({ ok: true, value: ID });
    });

    it("creates the settings file when there is none", () => {
        expect(ensureInstallId(path, () => ID)).toEqual({ ok: true, value: ID });
        expect(JSON.parse(readFileSync(path, "utf8")).plugins.VcTranslate.installId).toBe(ID);
    });

    it("never overwrites settings it cannot parse", () => {
        writeFileSync(path, "{ not json");
        const result = ensureInstallId(path, () => ID);
        expect(result.ok).toBe(false);
        expect(readFileSync(path, "utf8")).toBe("{ not json");
    });
});
