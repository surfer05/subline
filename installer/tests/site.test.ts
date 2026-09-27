/**
 * The website (site/index.html, built by scripts/buildSite.mjs from design/).
 *
 * Two things matter after checkout, and both are tested on the SHIPPED text:
 *  - the return from Dodo shows the thanks view, with the license key when Dodo
 *    appended one (the parser in design/site/thanks/thanks.js is inlined into
 *    the page verbatim, so the file run here is the code that ships);
 *  - pricing leads with the free download, and Buy sends the buyer back to the
 *    site root so that view can appear.
 * No browser is launched: the page is read as text.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THANKS_JS = readFileSync(join(ROOT, "design", "site", "thanks", "thanks.js"), "utf8");
const PAGE = readFileSync(join(ROOT, "site", "index.html"), "utf8");

type Return = { state: "ok" | "pending" | "failed"; keys: string[]; fromDiscord: boolean } | null;
const parse = new Function(`${THANKS_JS}\nreturn parseCheckoutReturn;`)() as (search: string, hash: string) => Return;

function section(id: string): string {
    const start = PAGE.indexOf(`<section id="${id}"`);
    expect(start, id).toBeGreaterThanOrEqual(0);
    return PAGE.slice(start, PAGE.indexOf("</section>", start));
}

describe("the checkout return", () => {
    it("is not a return on a plain visit", () => {
        expect(parse("", "")).toBeNull();
        expect(parse("?status=succeeded", "")).toBeNull();
        expect(parse("?payment_id=pay_1", "")).toBeNull();
        expect(parse("?utm_source=x", "#pricing")).toBeNull();
    });

    it("shows the key Dodo appended to a subscription return", () => {
        expect(parse("?subscription_id=sub_1&status=active&license_key=LK-001&email=a%40b.c", ""))
            .toEqual({ state: "ok", keys: ["LK-001"], fromDiscord: false });
    });

    it("shows every key when there are several, in order, without repeats", () => {
        expect(parse("?payment_id=pay_1&status=succeeded&license_key=LK-001,LK-002,LK-001", ""))
            .toEqual({ state: "ok", keys: ["LK-001", "LK-002"], fromDiscord: false });
    });

    it("thanks without a key when the product issued none", () => {
        expect(parse("?payment_id=pay_1&status=succeeded", "")).toEqual({ state: "ok", keys: [], fromDiscord: false });
    });

    it("says plainly when the payment failed, and shows no key", () => {
        expect(parse("?payment_id=pay_1&status=failed&license_key=LK-001", "")).toEqual({ state: "failed", keys: [], fromDiscord: false });
        expect(parse("?subscription_id=sub_1&status=cancelled", "")?.state).toBe("failed");
    });

    it("treats an unknown status as still processing, never as failed or paid", () => {
        expect(parse("?payment_id=pay_1&status=processing", "")?.state).toBe("pending");
        expect(parse("?payment_id=pay_1&status=something_new", "")?.state).toBe("pending");
    });

    it("puts only key-shaped text on the page", () => {
        expect(parse("?payment_id=p&status=succeeded&license_key=%3Cimg%20src%3Dx%3E,ok-key-1", "")?.keys)
            .toEqual(["ok-key-1"]);
    });

    it("opens on #thanks with no key", () => {
        expect(parse("", "#thanks")).toEqual({ state: "ok", keys: [], fromDiscord: false });
    });

    it("a checkout from Discord says go back to Discord, and never puts the key on the page", () => {
        expect(parse("?from=discord&subscription_id=sub_1&status=active&license_key=LK-001", ""))
            .toEqual({ state: "ok", keys: [], fromDiscord: true });
        expect(parse("?from=discord&payment_id=pay_1&status=succeeded", "")).toEqual({ state: "ok", keys: [], fromDiscord: true });
    });

    it("a pending checkout from Discord says it is being confirmed", () => {
        expect(parse("?from=discord&subscription_id=sub_1&status=pending", "")).toEqual({ state: "pending", keys: [], fromDiscord: true });
        expect(parse("?from=discord&payment_id=pay_1&status=processing", "")?.state).toBe("pending");
    });

    it("a failed checkout from Discord still says it failed", () => {
        expect(parse("?from=discord&payment_id=pay_1&status=failed", "")).toEqual({ state: "failed", keys: [], fromDiscord: true });
    });

    it("the Discord view survives the refresh after the address is cleaned", () => {
        expect(parse("?from=discord", "#thanks")).toEqual({ state: "ok", keys: [], fromDiscord: true });
        expect(parse("?from=discord", "")).toEqual({ state: "ok", keys: [], fromDiscord: true });
    });

    it("an unrelated from= value is not a Discord return", () => {
        expect(parse("?from=twitter", "")).toBeNull();
        expect(parse("?from=twitter&payment_id=pay_1&status=succeeded&license_key=LK-001", ""))
            .toEqual({ state: "ok", keys: ["LK-001"], fromDiscord: false });
    });
});

describe("the built page", () => {
    it("inlines the tested parser verbatim", () => {
        const body = THANKS_JS.slice(THANKS_JS.indexOf("function parseCheckoutReturn"));
        const shipped = PAGE.replace(/\n {2}/g, "\n");
        expect(shipped).toContain(body.trim());
    });

    it("ships the thanks view hidden, first on the page, with a Copy button and downloads", () => {
        expect(PAGE).toContain('<section id="thanks" hidden>');
        expect(PAGE.indexOf('<section id="thanks"')).toBeLessThan(PAGE.indexOf('<section id="hero"'));
        const thanks = section("thanks");
        expect(thanks).toContain("data-thanks-copy");
        expect(thanks).toContain("Bought from Discord? It's already on.");
        expect(thanks).toContain('data-dl="mac"');
        expect(thanks).toContain('data-dl="win"');
    });

    it("has a Discord view with only its title and one line, and a Discord pending view", () => {
        const thanks = section("thanks");
        const block = (attr: string) => {
            const start = thanks.indexOf(`<div ${attr} hidden>`);
            expect(start, attr).toBeGreaterThanOrEqual(0);
            return thanks.slice(start, thanks.indexOf("</div>", start));
        };
        const discord = block("data-thanks-discord");
        expect(discord).toContain("<h2 class=\"sec\">You're all set.</h2>");
        expect(discord).toContain("<p class=\"lead\">Go back to Discord. Subline is already on.</p>");
        expect(discord.match(/<p /g)).toHaveLength(2); // the kicker and the one line
        expect(discord).not.toMatch(/data-dl|data-thanks-code|data-thanks-copy/);
        const pending = block("data-thanks-discord-pending");
        expect(pending.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "))
            .toContain("Payment is being confirmed. Subline switches on in Discord by itself, usually within a few minutes.");
    });

    it("shows only the Discord view on a Discord return, and only the code view on a site return", () => {
        const script = PAGE.slice(PAGE.lastIndexOf("<script>") + 8, PAGE.lastIndexOf("</script>"));
        const start = script.indexOf("(function () {\n    var ret = parseCheckoutReturn");
        expect(start).toBeGreaterThanOrEqual(0);
        const iife = script.slice(start, script.indexOf("})();", start) + 5);
        const run = (search: string) => {
            const names = ["ok", "pending", "failed", "discord", "discord-pending", "keys", "key"];
            const parts: Record<string, any> = {};
            const codeNode = { textContent: "" };
            for (const n of names) parts[n] = { hidden: true, parentNode: { insertBefore() {} } };
            parts.key.querySelector = (sel: string) => sel === "[data-thanks-code]" ? codeNode : { addEventListener() {} };
            const section = { hidden: true, querySelector: (sel: string) => parts[sel.slice("[data-thanks-".length, -1)] ?? null };
            const doc = { getElementById: (id: string) => id === "thanks" ? section : null };
            const loc = { search, hash: "", pathname: "/subline/" };
            let replaced = "";
            const hist = { replaceState: (_a: unknown, _b: string, url: string) => { replaced = url; } };
            new Function("location", "document", "history", "parseCheckoutReturn", "copyText", iife)(loc, doc, hist, parse, () => {});
            const shown = names.filter(n => !parts[n].hidden && n !== "key");
            return { shown, code: codeNode.textContent, replaced };
        };
        const d = run("?from=discord&subscription_id=sub_1&status=active&license_key=LK-001");
        expect(d.shown).toEqual(["discord"]);
        expect(d.code).toBe("");
        expect(d.replaced).toBe("/subline/?from=discord#thanks");
        expect(run("?from=discord&subscription_id=sub_1&status=pending").shown).toEqual(["discord-pending"]);
        const s = run("?subscription_id=sub_1&status=active&license_key=LK-001");
        expect(s.shown).toEqual(["ok", "keys"]);
        expect(s.code).toBe("LK-001");
        expect(s.replaced).toBe("/subline/#thanks");
    });

    it("drops the key from the address bar once it is read, and never sends it", () => {
        expect(PAGE).toContain('history.replaceState(null, "", location.pathname + (ret.fromDiscord ? "?from=discord" : "") + "#thanks")');
        const script = PAGE.slice(PAGE.lastIndexOf("<script>"));
        // The only network call on the page is the GitHub release lookup.
        expect(script.match(/fetch\(/g)).toHaveLength(1);
        expect(script).toContain('fetch("https://api.github.com/repos/"');
    });

    it("has a page script that parses", () => {
        const script = PAGE.slice(PAGE.lastIndexOf("<script>") + 8, PAGE.lastIndexOf("</script>"));
        expect(() => new Function(script)).not.toThrow();
    });

    it("leads pricing with the free download and keeps Buy secondary", () => {
        const pricing = section("pricing");
        const primaries = pricing.match(/<a class="btn btn-primary"[^>]*>[^<]*<\/a>/g) ?? [];
        expect(primaries).toEqual(['<a class="btn btn-primary" href="#downloads">Download free</a>']);
        const buys = pricing.match(/<a [^>]*data-buy[^>]*>Buy<\/a>/g) ?? [];
        expect(buys).toHaveLength(2);
        for (const buy of buys) expect(buy).toContain("btn-secondary");
    });

    it("sends buyers back to the site root, where the thanks view reads Dodo's params", () => {
        const root = encodeURIComponent("https://surfer05.github.io/subline/");
        expect(section("pricing")).toContain(
            `https://checkout.dodopayments.com/buy/pdt_0No1xmbcAqHdYAvt1RNPR?quantity=1&amp;redirect_url=${root}`);
        expect(section("pricing")).toContain(
            `https://checkout.dodopayments.com/buy/pdt_0No1yAve1ozdxryVGZvf6?quantity=1&amp;redirect_url=${root}`);
    });

    it("has no em dashes", () => {
        expect(PAGE).not.toContain("—");
    });

    it("says in the privacy table what a purchase from Discord sends and keeps", () => {
        const rows = section("privacy").replace(/<span class="gl-inline">(.*?)<\/span>/g, "$1");
        expect(rows).toContain("<tr><td>Free installs</td><td>A random id that times your 7 days. Your IP is counted to stop abuse. "
            + "If you buy inside Discord, a scrambled form of this id goes to Dodo with the purchase, so Subline can switch on by itself.</td>"
            + "<td>Daily counts for 2 days. First use for 90 days. The link to your purchase for 30 days.</td></tr>");
        expect(rows).toContain("<tr><td>Your code</td><td>Unlocks ✦. The relay never sees your name or email.</td>");
        for (const kept of ["<td>Messages</td>", "<td>Usernames</td>", "<td>Profiles and embeds</td>", "<td>Stats</td>"]) {
            expect(rows).toContain(kept);
        }
    });
});
