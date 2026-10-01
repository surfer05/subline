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

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CODE_SCREEN_COPY } from "../src/app/codeScreen";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THANKS_JS = readFileSync(join(ROOT, "design", "site", "thanks", "thanks.js"), "utf8");
const PAGE = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const BUILD_SITE = join(ROOT, "scripts", "buildSite.mjs");
const PLACEHOLDER = "pdt_AUTOMATIC_PENDING";
/** The design source still has the placeholder Automatic product id. */
const PLACEHOLDER_IN_DESIGN = readFileSync(join(ROOT, "design", "site", "pricing", "index.html"), "utf8").includes(PLACEHOLDER);

type Return = { state: "ok" | "pending" | "failed"; keys: string[]; fromDiscord: boolean; fromInstaller: boolean; fallbackKeys?: string[] } | null;
const parse = new Function(`${THANKS_JS}\nreturn parseCheckoutReturn;`)() as (search: string, hash: string) => Return;
/** The address the page keeps after reading a return (thanks.js), looked up on use. */
const cleaned = (ret: NonNullable<Return>): string =>
    (new Function(`${THANKS_JS}\nreturn cleanedReturnSearch;`)() as (r: NonNullable<Return>) => string)(ret);

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
            .toEqual({ state: "ok", keys: ["LK-001"], fromDiscord: false, fromInstaller: false });
    });

    it("shows every key when there are several, in order, without repeats", () => {
        expect(parse("?payment_id=pay_1&status=succeeded&license_key=LK-001,LK-002,LK-001", ""))
            .toEqual({ state: "ok", keys: ["LK-001", "LK-002"], fromDiscord: false, fromInstaller: false });
    });

    it("thanks without a key when the product issued none", () => {
        expect(parse("?payment_id=pay_1&status=succeeded", "")).toEqual({ state: "ok", keys: [], fromDiscord: false, fromInstaller: false });
    });

    it("says plainly when the payment failed, and shows no key", () => {
        expect(parse("?payment_id=pay_1&status=failed&license_key=LK-001", "")).toEqual({ state: "failed", keys: [], fromDiscord: false, fromInstaller: false });
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

    it("opens on a bare #thanks with no key, and never claims the payment went through", () => {
        expect(parse("", "#thanks")).toEqual({ state: "pending", keys: [], fromDiscord: false, fromInstaller: false });
    });

    it("a checkout from Discord says go back to Discord; its key is only a collapsed fallback", () => {
        expect(parse("?from=discord&subscription_id=sub_1&status=active&license_key=LK-001", ""))
            .toEqual({ state: "ok", keys: [], fromDiscord: true, fromInstaller: false, fallbackKeys: ["LK-001"] });
        // A failed payment offers no key at all.
        expect(parse("?from=discord&payment_id=pay_1&status=failed&license_key=LK-001", ""))
            .toEqual({ state: "failed", keys: [], fromDiscord: true, fromInstaller: false });
        expect(parse("?from=discord&payment_id=pay_1&status=succeeded", "")).toEqual({ state: "ok", keys: [], fromDiscord: true, fromInstaller: false });
    });

    it("a pending checkout from Discord says it is being confirmed", () => {
        expect(parse("?from=discord&subscription_id=sub_1&status=pending", "")).toEqual({ state: "pending", keys: [], fromDiscord: true, fromInstaller: false });
        expect(parse("?from=discord&payment_id=pay_1&status=processing", "")?.state).toBe("pending");
    });

    it("a failed checkout from Discord still says it failed", () => {
        expect(parse("?from=discord&payment_id=pay_1&status=failed", "")).toEqual({ state: "failed", keys: [], fromDiscord: true, fromInstaller: false });
    });

    it("a bare from=discord or from=installer with no outcome keeps its own view, but only says it is being confirmed", () => {
        expect(parse("?from=discord", "")).toEqual({ state: "pending", keys: [], fromDiscord: true, fromInstaller: false });
        expect(parse("?from=discord", "#thanks")).toEqual({ state: "pending", keys: [], fromDiscord: true, fromInstaller: false });
        expect(parse("?from=discord&payment_id=pay_1", "")).toEqual({ state: "pending", keys: [], fromDiscord: true, fromInstaller: false });
        expect(parse("?from=installer", "#thanks")).toEqual({ state: "pending", keys: [], fromDiscord: false, fromInstaller: true });
    });

    it("reads the outcome the page kept in a cleaned address, with or without #thanks", () => {
        expect(parse("?result=failed", "#thanks")?.state).toBe("failed");
        expect(parse("?result=failed", "")).toEqual({ state: "failed", keys: [], fromDiscord: false, fromInstaller: false });
        expect(parse("?from=discord&result=pending", "")).toEqual({ state: "pending", keys: [], fromDiscord: true, fromInstaller: false });
        expect(parse("?from=installer&result=ok", "#thanks")).toEqual({ state: "ok", keys: [], fromDiscord: false, fromInstaller: true });
        // Only the three outcomes; anything else is not a claim of success.
        expect(parse("?result=paid", "#thanks")?.state).toBe("pending");
        expect(parse("?result=paid", "")).toBeNull();
        // A cleaned address never carries a key, even a crafted one.
        expect(parse("?result=ok&license_key=LK-001", "#thanks")?.keys).toEqual([]);
    });

    it("a refresh after the clean-up shows the same outcome, for every return", () => {
        for (const from of ["", "from=discord&", "from=installer&"]) {
            for (const status of ["failed", "cancelled", "processing", "pending", "succeeded", "active"]) {
                const first = parse(`?${from}payment_id=pay_1&status=${status}&license_key=LK-001`, "");
                expect(first, `${from}${status}`).not.toBeNull();
                const again = parse(cleaned(first!), "#thanks");
                expect(again?.state, `${from}${status}`).toBe(first!.state);
                expect(again?.fromDiscord).toBe(first!.fromDiscord);
                expect(again?.fromInstaller).toBe(first!.fromInstaller);
                // No key or Dodo id survives in the address.
                expect(cleaned(first!)).not.toMatch(/LK-001|pay_1|license_key|payment_id/);
            }
        }
    });

    it("an unrelated from= value is not a Discord return", () => {
        expect(parse("?from=twitter", "")).toBeNull();
        expect(parse("?from=installer&subscription_id=sub_1&status=active&license_key=LK-001", ""))
            .toEqual({ state: "ok", keys: [], fromDiscord: false, fromInstaller: true, fallbackKeys: ["LK-001"] });
        expect(parse("?from=installer", "")).toEqual({ state: "pending", keys: [], fromDiscord: false, fromInstaller: true });
        expect(parse("?from=twitter&payment_id=pay_1&status=succeeded&license_key=LK-001", ""))
            .toEqual({ state: "ok", keys: ["LK-001"], fromDiscord: false, fromInstaller: false });
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
        expect(discord).toContain("<p class=\"fine\">Your code is also in your email from Dodo Payments.</p>");
        expect(discord.match(/<p /g)).toHaveLength(3); // the kicker, the one line, the email line
        expect(discord).not.toMatch(/data-dl|data-thanks-code|data-thanks-copy/);
        const pending = block("data-thanks-discord-pending");
        expect(pending.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "))
            .toContain("Payment is being confirmed. Subline switches on in Discord by itself, usually within a few minutes.");
        expect(pending).toContain("<p class=\"fine\">Your code is also in your email from Dodo Payments.</p>");
    });

    it("shows only the Discord view on a Discord return, and only the code view on a site return", () => {
        const script = PAGE.slice(PAGE.lastIndexOf("<script>") + 8, PAGE.lastIndexOf("</script>"));
        const start = script.indexOf("(function () {\n    var ret = parseCheckoutReturn");
        expect(start).toBeGreaterThanOrEqual(0);
        const iife = script.slice(start, script.indexOf("})();", start) + 5);
        const run = (search: string) => {
            const names = ["ok", "pending", "failed", "discord", "discord-pending", "installer", "installer-pending", "keys", "key", "fallback"];
            const parts: Record<string, any> = {};
            const codeNode = { textContent: "" };
            for (const n of names) parts[n] = { hidden: true, parentNode: { insertBefore() {} } };
            parts.key.querySelector = (sel: string) => sel === "[data-thanks-code]" ? codeNode : { addEventListener() {} };
            const fbNodes: Record<string, any> = {
                "[data-thanks-fallback-discord]": { hidden: false }, "[data-thanks-fallback-installer]": { hidden: true },
                "[data-thanks-fallback-code]": { textContent: "" }, "[data-thanks-fallback-copy]": { addEventListener() {} }
            };
            parts.fallback.querySelector = (sel: string) => fbNodes[sel] ?? null;
            const section = { hidden: true, querySelector: (sel: string) => parts[sel.slice("[data-thanks-".length, -1)] ?? null };
            const doc = { getElementById: (id: string) => id === "thanks" ? section : null };
            const loc = { search, hash: "", pathname: "/subline/" };
            let replaced = "";
            const hist = { replaceState: (_a: unknown, _b: string, url: string) => { replaced = url; } };
            new Function("location", "document", "history", "parseCheckoutReturn", "cleanedReturnSearch", "copyText", iife)(loc, doc, hist, parse, cleaned, () => {});
            const shown = names.filter(n => !parts[n].hidden && n !== "key");
            return {
                shown, code: codeNode.textContent, replaced,
                fallbackCode: parts.fallback.hidden ? "" : fbNodes["[data-thanks-fallback-code]"].textContent,
                fallbackLine: parts.fallback.hidden ? null : fbNodes["[data-thanks-fallback-discord]"].hidden ? "installer" : "discord"
            };
        };
        const d = run("?from=discord&subscription_id=sub_1&status=active&license_key=LK-001");
        expect(d.shown).toEqual(["discord", "fallback"]);
        expect(d.code).toBe("");
        // The key only in the collapsed fallback, with the Discord sentence.
        expect(d.fallbackCode).toBe("LK-001");
        expect(d.fallbackLine).toBe("discord");
        // No key in the address: no fallback.
        expect(run("?from=discord&subscription_id=sub_1&status=active").shown).toEqual(["discord"]);
        expect(d.replaced).toBe("/subline/?from=discord&result=ok#thanks");
        expect(run("?from=discord&subscription_id=sub_1&status=pending").shown).toEqual(["discord-pending"]);
        const s = run("?subscription_id=sub_1&status=active&license_key=LK-001");
        expect(s.shown).toEqual(["ok", "keys"]);
        expect(s.code).toBe("LK-001");
        expect(s.replaced).toBe("/subline/?result=ok#thanks");
        // A refresh after the clean-up: the Discord view again, in its ok state.
        expect(run(d.replaced.slice("/subline/".length, d.replaced.indexOf("#"))).shown).toEqual(["discord"]);
        // A checkout started in the installer says to go back to it, never the code.
        const i = run("?from=installer&payment_id=pay_1&status=succeeded&license_key=LK-001");
        expect(i.shown).toEqual(["installer", "fallback"]);
        expect(i.code).toBe("");
        expect(i.fallbackCode).toBe("LK-001");
        expect(i.fallbackLine).toBe("installer");
        expect(i.replaced).toBe("/subline/?from=installer&result=ok#thanks");
        expect(run("?from=installer&payment_id=pay_1&status=processing").shown).toEqual(["installer-pending"]);
        expect(run("?from=installer").shown).toEqual(["installer-pending"]);
        // A failed or pending return, then a refresh: never "You're all set".
        for (const [search, view] of [
            ["?payment_id=pay_1&status=failed", "failed"], ["?payment_id=pay_1&status=processing", "pending"],
            ["?from=discord&payment_id=pay_1&status=failed", "failed"], ["?from=discord&payment_id=pay_1&status=processing", "discord-pending"],
            ["?from=installer&payment_id=pay_1&status=cancelled", "failed"], ["?from=installer&payment_id=pay_1&status=processing", "installer-pending"]
        ] as const) {
            const first = run(search);
            expect(first.shown, search).toEqual([view]);
            expect(first.replaced, search).toMatch(/result=(failed|pending)#thanks$/);
            const refreshed = run(first.replaced.slice("/subline/".length, first.replaced.indexOf("#")));
            expect(refreshed.shown, search).toEqual([view]);
        }
    });

    it("has an installer view that says to go back to the installer, and its pending view", () => {
        const thanks = section("thanks");
        const block = (attr: string) => {
            const start = thanks.indexOf(`<div ${attr} hidden>`);
            expect(start, attr).toBeGreaterThanOrEqual(0);
            return thanks.slice(start, thanks.indexOf("</div>", start));
        };
        const installer = block("data-thanks-installer");
        expect(installer).toContain("<h2 class=\"sec\">You're all set.</h2>");
        expect(installer).toContain("<p class=\"lead\">Go back to the Subline installer. It carries on by itself.</p>");
        expect(installer).toContain("<p class=\"fine\">Your code is also in your email from Dodo Payments.</p>");
        expect(installer).not.toMatch(/data-dl|data-thanks-code|data-thanks-copy/);
        const pending = block("data-thanks-installer-pending");
        expect(pending.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "))
            .toContain("Payment is being confirmed. The Subline installer carries on by itself, usually within a few minutes.");
    });

    it("drops the key from the address bar once it is read, and never sends it", () => {
        expect(PAGE).toContain('history.replaceState(null, "", location.pathname + keep + "#thanks")');
        expect(PAGE).toContain("var keep = cleanedReturnSearch(ret);");
        const script = PAGE.slice(PAGE.lastIndexOf("<script>"));
        // The only network call on the page is the GitHub release lookup.
        expect(script.match(/fetch\(/g)).toHaveLength(1);
        expect(script).toContain('fetch("https://api.github.com/repos/"');
    });

    it("has a page script that parses", () => {
        const script = PAGE.slice(PAGE.lastIndexOf("<script>") + 8, PAGE.lastIndexOf("</script>"));
        expect(() => new Function(script)).not.toThrow();
    });

    it("shows two plans: Automatic once, and AI on top of it, with Download as the one filled button", () => {
        const pricing = section("pricing");
        const primaries = pricing.match(/<a class="btn btn-primary"[^>]*>[^<]*<\/a>/g) ?? [];
        expect(primaries).toEqual(['<a class="btn btn-primary" href="#downloads">Download Subline</a>']);
        const buys = pricing.match(/<a [^>]*data-buy[^>]*>[^<]*<\/a>/g) ?? [];
        // Only Automatic has a button; AI is added from inside Discord.
        expect(buys).toHaveLength(1);
        for (const buy of buys) expect(buy).toContain("btn-secondary");
        const text = pricing.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        expect(text).toContain("Automatic $4.99 once");
        expect(text).toContain("$1.99 /mo");
        expect(text).toContain("$19.99 /yr");
        expect(text.match(/Needs Automatic\./g)).toHaveLength(2);
    });

    it("uses the owner's exact pricing copy", () => {
        const pricing = section("pricing").replace(/<span class="gl-inline">(.*?)<\/span>/g, "$1");
        const text = pricing.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        expect(text).toContain("Automatic puts ≈ under every message, for good. AI adds ✦ on top.");
        expect(text).toContain("≈ on every message, profile and embed. Decodes Morse and more. 5 ✦ previews a day.");
        expect(text).toContain("$1.99 /mo ✦ on everything. Needs Automatic. Cancel anytime.");
        expect(text).toContain("Save 16% AI yearly $19.99 /yr ✦ on everything. Needs Automatic.");
        expect(text).toContain("Up to 2,000 ✦ a day. Very long messages count as more than one.");
        expect(text).not.toMatch(/2\.49|4 months/);
    });

    it("sends buyers back to the site root, where the thanks view reads Dodo's params", () => {
        const root = encodeURIComponent("https://surfer05.github.io/subline/");
        if (!PLACEHOLDER_IN_DESIGN) {
            // Once the real Automatic id is in, its card buys like the AI cards.
            const automatic = section("pricing").match(/<a [^>]*data-buy="automatic"[^>]*>[^<]*<\/a>/)?.[0] ?? "";
            expect(automatic).toMatch(/href="https:\/\/checkout\.dodopayments\.com\/buy\/pdt_\w+\?quantity=1&amp;redirect_url=/);
            expect(automatic).toContain(`redirect_url=${root}"`);
        }
    });

    it("never links the AI plans to Dodo: they say to add AI from inside Discord, and keep their prices", () => {
        const pricing = section("pricing");
        expect(pricing).not.toContain("pdt_0No1xmbcAqHdYAvt1RNPR");
        expect(pricing).not.toContain("pdt_0No1yAve1ozdxryVGZvf6");
        expect(pricing.split("<p class=\"fine\" data-ai-note>Add AI from inside Discord, after Automatic.</p>").length - 1).toBe(2);
        const text = pricing.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        expect(text).toContain("$1.99 /mo");
        expect(text).toContain("$19.99 /yr");
    });

    it("never ships the placeholder Automatic product id: the card says Download and points to #downloads", () => {
        expect(PAGE).not.toContain(PLACEHOLDER);
        const automatic = section("pricing").match(/<a [^>]*data-buy="automatic"[^>]*>[^<]*<\/a>/)?.[0];
        if (PLACEHOLDER_IN_DESIGN) {
            expect(automatic).toBe('<a class="btn btn-secondary" data-buy="automatic" href="#downloads">Download</a>');
        } else {
            expect(automatic).toMatch(/href="https:\/\/checkout\.dodopayments\.com\/buy\/pdt_\w+\?/);
            expect(automatic).toContain(">Buy</a>");
        }
    });

    it("refuses to build the site with the placeholder unless SUBLINE_ALLOW_PLACEHOLDER=1", () => {
        if (!PLACEHOLDER_IN_DESIGN) return;
        const env = { ...process.env };
        delete env.SUBLINE_ALLOW_PLACEHOLDER;
        // --check writes nothing, so running it here is safe.
        const refused = spawnSync(process.execPath, [BUILD_SITE, "--check"], { env, encoding: "utf8" });
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("placeholder Automatic product id");
        expect(refused.stderr).toContain("SUBLINE_ALLOW_PLACEHOLDER=1");
        const allowed = spawnSync(process.execPath, [BUILD_SITE, "--check"], { env: { ...env, SUBLINE_ALLOW_PLACEHOLDER: "1" }, encoding: "utf8" });
        expect(allowed.status).toBe(0);
    });

    it("never says free or trial anywhere a visitor can read", () => {
        // Visible text only: scripts, styles, comments and tags are stripped
        // (a CSS class or a code comment is not something a visitor reads).
        const visible = PAGE
            .replace(/<script[\s\S]*?<\/script>/g, " ")
            .replace(/<style[\s\S]*?<\/style>/g, " ")
            .replace(/<!--[\s\S]*?-->/g, " ")
            .replace(/<[^>]+>/g, " ");
        expect(visible).not.toMatch(/\b(free|trial)\b/i);
        expect(visible).not.toMatch(/7 days/i);
        // Settings live in Discord's own Subline section, never "Plugins".
        expect(visible).not.toMatch(/Plugins|VcTranslate/);
    });

    it("has no em dashes", () => {
        expect(PAGE).not.toContain("—");
    });

    it("says in the privacy table what the install id, computers and server codes send and keep", () => {
        const rows = section("privacy").replace(/<span class="gl-inline">(.*?)<\/span>/g, "$1");
        expect(rows).toContain("<tr><td>Install id</td><td data-k=\"Goes to\">A random id made when you install. It ties your purchase or code "
            + "to this computer. If you buy from Subline, a scrambled form of it goes to Dodo with the purchase, so Subline "
            + "can switch on by itself. The relay reads its record of this id's first use to give early users Automatic at "
            + "no charge. Your IP is counted to stop abuse.</td>"
            + "<td data-k=\"Kept\">Daily counts for 2 days. First use for 90 days. The link to your purchase for 30 days.</td></tr>");
        expect(rows).toContain("<tr><td>Your account</td><td data-k=\"Goes to\">Your codes and computers are linked into one account. "
            + "AI works on the computers where you bought it or entered its code.</td>"
            + "<td data-k=\"Kept\">Until you ask us to delete it.</td></tr>");
        expect(rows).toContain("<tr><td>Computers</td><td data-k=\"Goes to\">A code works on up to 3 computers. The relay keeps a scrambled id "
            + "for each one, and when it was last used, to count them. One unused for 30 days can be replaced. "
            + "If you got early-user Automatic, the relay remembers that for this computer.</td>"
            + "<td data-k=\"Kept\">Until you ask us to delete it.</td></tr>");
        expect(rows).toContain("<tr><td>Server codes</td><td data-k=\"Goes to\">When you use a server code, the relay records that your install "
            + "claimed it, to count its claims. Tries from your network are counted each day to stop guessing.</td>"
            + "<td data-k=\"Kept\">Claims: until you ask us to delete them. Tries: 2 days.</td></tr>");
        expect(rows).toContain("<tr><td>Your code</td><td data-k=\"Goes to\">Unlocks Subline. The relay never sees your name or email.</td>");
        expect(rows).not.toContain("Free installs");
        for (const kept of ["<td>Messages</td>", "<td>Usernames</td>", "<td>Profiles and embeds</td>", "<td>Stats</td>"]) {
            expect(rows).toContain(kept);
        }
    });
});

describe("worst cases on the site", () => {
    const DESIGN_STEPS = readFileSync(join(ROOT, "design", "site", "security-warning", "index.html"), "utf8");
    const css = (PAGE.match(/<style>[\s\S]*?<\/style>/g) ?? []).join("\n");

    it("the install steps name the installer's real buttons, once in each panel", () => {
        for (const [where, html] of [["design", DESIGN_STEPS], ["site", section("security-warning")]] as const) {
            expect(html, where).not.toContain("without a code");
            for (const panel of ["macos", "windows"]) {
                const start = html.indexOf(`<div data-panel="${panel}"`);
                expect(start, `${where} ${panel}`).toBeGreaterThanOrEqual(0);
                const body = html.slice(start, html.indexOf("</ol>", start));
                expect(body.split(`<b>${CODE_SCREEN_COPY.buy}</b>`).length - 1, `${where} ${panel}`).toBe(1);
                expect(body.split(`<b>${CODE_SCREEN_COPY.haveCode}</b>`).length - 1, `${where} ${panel}`).toBe(1);
            }
        }
    });

    it("labels the Goes to and Kept answers on phones, where the table header is hidden", () => {
        const privacy = section("privacy");
        const body = privacy.slice(privacy.indexOf("<tbody>"), privacy.indexOf("</tbody>"));
        const rows = body.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
        expect(rows.length).toBe(9);
        for (const row of rows) {
            expect(row).toContain('<td data-k="Goes to">');
            expect(row).toContain('<td data-k="Kept">');
        }
        const phone = css.slice(css.indexOf("@media (max-width:600px)"));
        const block = phone.slice(0, phone.indexOf("\n}") + 2);
        expect(block).toContain("table.pv thead{display:none}");
        expect(block).toMatch(/table\.pv td\[data-k\]::before\{content:attr\(data-k\);display:block/);
    });

    it("lets the privacy markers grow with large text instead of overlapping it", () => {
        const rule = css.match(/ul\.off li\{[^}]*\}/)?.[0] ?? "";
        expect(rule).toContain("grid-template-columns:");
        expect(rule).not.toMatch(/grid-template-columns:\s*\d+px\s/);
        expect(css).toMatch(/ul\.off \.t\{[^}]*white-space:nowrap/);
    });

    it("never claims a bigger yearly saving than the prices give", () => {
        const pricing = section("pricing");
        const monthly = Number(/\$(\d+\.\d\d)<span class="per">\/mo<\/span>/.exec(pricing)?.[1]);
        const annual = Number(/\$(\d+\.\d\d)<span class="per">\/yr<\/span>/.exec(pricing)?.[1]);
        expect(monthly).toBeGreaterThan(0);
        expect(annual).toBeGreaterThan(0);
        const yearOfMonths = Math.round(monthly * 1200);
        const saved = yearOfMonths - Math.round(annual * 100);
        const badge = /<span class="badge">([^<]*)<\/span>/.exec(pricing)?.[1] ?? "";
        const months = /(\d+) months? free/.exec(badge);
        if (months) expect(saved).toBeGreaterThanOrEqual(Number(months[1]) * Math.round(monthly * 100));
        // The badge is the saving, rounded down: never more than the real one.
        expect(badge).toBe(`Save ${Math.floor(saved * 100 / yearOfMonths)}%`);
    });

    it("gives Intel Mac buyers their link on the thanks view, only on a Mac", () => {
        const thanks = section("thanks");
        expect(thanks).toContain('<p class="fine" data-thanks-intel hidden>Intel Mac? <a data-dl="mac-intel" '
            + 'href="https://github.com/surfer05/subline/releases/latest">Get the Intel version.</a></p>');
    });

    it("puts the Windows download first and filled on the thanks view for a Windows buyer", () => {
        const script = PAGE.slice(PAGE.lastIndexOf("<script>") + 8, PAGE.lastIndexOf("</script>"));
        const start = script.indexOf("(function thanksDownloads() {");
        expect(start).toBeGreaterThanOrEqual(0);
        const iife = script.slice(start, script.indexOf("})();", start) + 5);
        const run = (os: string) => {
            const order: any[] = [];
            const btn = (name: string, cls: string) => {
                const classes = new Set(["btn", cls]);
                return { name, classes, classList: { replace(a: string, b: string) { if (classes.delete(a)) classes.add(b); } } };
            };
            const mac = btn("mac", "btn-primary"), win = btn("win", "btn-secondary");
            order.push(mac, win);
            const parent = { insertBefore(a: any, b: any) { order.splice(order.indexOf(a), 1); order.splice(order.indexOf(b), 0, a); } };
            Object.assign(mac, { parentNode: parent });
            Object.assign(win, { parentNode: parent });
            const intel = { hidden: true };
            const doc = {
                querySelector: (sel: string) => sel === '#thanks [data-dl="win"]' ? win
                    : sel === '#thanks [data-dl="mac"]' ? mac
                    : sel === "#thanks [data-thanks-intel]" ? intel : null
            };
            new Function("document", "os", iife)(doc, os);
            return { first: order[0].name, winPrimary: win.classes.has("btn-primary"), macPrimary: mac.classes.has("btn-primary"), intel: !intel.hidden };
        };
        expect(run("windows")).toEqual({ first: "win", winPrimary: true, macPrimary: false, intel: false });
        expect(run("mac")).toEqual({ first: "mac", winPrimary: false, macPrimary: true, intel: true });
        expect(run("unknown")).toEqual({ first: "mac", winPrimary: false, macPrimary: true, intel: false });
    });
});

describe("the v0.2.0 release notes", () => {
    it("say exactly who gets Automatic at no charge", () => {
        const notes = readFileSync(join(ROOT, "docs", "release-notes", "v0.2.0.md"), "utf8");
        expect(notes).toContain("Early users get Automatic at no charge: anyone whose Subline used ✦ AI at least once "
            + "before September 29, 2026, and every AI subscriber active at release.");
        expect(notes).not.toContain("—");
    });

    it("tell anyone who thinks they were early where to ask", () => {
        const notes = readFileSync(join(ROOT, "docs", "release-notes", "v0.2.0.md"), "utf8");
        expect(notes).toContain("Think you were early but Subline asks you to pay? Ask on GitHub: https://github.com/surfer05/subline/issues.");
    });
});

describe("the v0.2.0 release day checklist", () => {
    it("lists every release-day step in docs/RELEASING.md", () => {
        const doc = readFileSync(join(ROOT, "docs", "RELEASING.md"), "utf8");
        const day = doc.slice(doc.indexOf("## v0.2.0 release day"));
        expect(day.length).toBeGreaterThan(20);
        for (const must of [
            "relay/wrangler.jsonc", "src/userplugins/vcTranslate/checkout.ts", "installer/src/app/activation.ts",
            "design/site/pricing/index.html", "npx wrangler deploy", "$1.99", "2026-09-29T11:56:40Z",
            "before", "SUBLINE_ALLOW_PLACEHOLDER", "--notes-file ../docs/release-notes/v0.2.0.md", "monthly", "payment page"
        ]) expect(day, must).toContain(must);
    });
});
