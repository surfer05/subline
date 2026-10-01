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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THANKS_JS = readFileSync(join(ROOT, "design", "site", "thanks", "thanks.js"), "utf8");
const PAGE = readFileSync(join(ROOT, "site", "index.html"), "utf8");
const BUILD_SITE = join(ROOT, "scripts", "buildSite.mjs");
const PLACEHOLDER = "pdt_AUTOMATIC_PENDING";
/** The design source still has the placeholder Automatic product id. */
const PLACEHOLDER_IN_DESIGN = readFileSync(join(ROOT, "design", "site", "pricing", "index.html"), "utf8").includes(PLACEHOLDER);

type Return = { state: "ok" | "pending" | "failed"; keys: string[]; fromDiscord: boolean; fromInstaller: boolean; fallbackKeys?: string[] } | null;
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

    it("opens on #thanks with no key", () => {
        expect(parse("", "#thanks")).toEqual({ state: "ok", keys: [], fromDiscord: false, fromInstaller: false });
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

    it("a bare from=discord or from=installer (as after a refresh) keeps its own view, in the ok state", () => {
        expect(parse("?from=discord", "")).toEqual({ state: "ok", keys: [], fromDiscord: true, fromInstaller: false });
        expect(parse("?from=discord", "#thanks")).toEqual({ state: "ok", keys: [], fromDiscord: true, fromInstaller: false });
        expect(parse("?from=discord&payment_id=pay_1", "")).toEqual({ state: "ok", keys: [], fromDiscord: true, fromInstaller: false });
        expect(parse("?from=installer", "#thanks")).toEqual({ state: "ok", keys: [], fromDiscord: false, fromInstaller: true });
    });

    it("an unrelated from= value is not a Discord return", () => {
        expect(parse("?from=twitter", "")).toBeNull();
        expect(parse("?from=installer&subscription_id=sub_1&status=active&license_key=LK-001", ""))
            .toEqual({ state: "ok", keys: [], fromDiscord: false, fromInstaller: true, fallbackKeys: ["LK-001"] });
        expect(parse("?from=installer", "")).toEqual({ state: "ok", keys: [], fromDiscord: false, fromInstaller: true });
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
            new Function("location", "document", "history", "parseCheckoutReturn", "copyText", iife)(loc, doc, hist, parse, () => {});
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
        expect(d.replaced).toBe("/subline/?from=discord#thanks");
        expect(run("?from=discord&subscription_id=sub_1&status=pending").shown).toEqual(["discord-pending"]);
        const s = run("?subscription_id=sub_1&status=active&license_key=LK-001");
        expect(s.shown).toEqual(["ok", "keys"]);
        expect(s.code).toBe("LK-001");
        expect(s.replaced).toBe("/subline/#thanks");
        // A refresh after the clean-up: the Discord view again, in its ok state.
        expect(run(d.replaced.slice("/subline/".length, d.replaced.indexOf("#"))).shown).toEqual(["discord"]);
        // A checkout started in the installer says to go back to it, never the code.
        const i = run("?from=installer&payment_id=pay_1&status=succeeded&license_key=LK-001");
        expect(i.shown).toEqual(["installer", "fallback"]);
        expect(i.code).toBe("");
        expect(i.fallbackCode).toBe("LK-001");
        expect(i.fallbackLine).toBe("installer");
        expect(i.replaced).toBe("/subline/?from=installer#thanks");
        expect(run("?from=installer&payment_id=pay_1&status=processing").shown).toEqual(["installer-pending"]);
        expect(run("?from=installer").shown).toEqual(["installer"]);
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
        expect(PAGE).toContain('var keep = d ? "?from=discord" : inst ? "?from=installer" : "";');
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
        expect(text).toContain("2 months free AI yearly $19.99 /yr ✦ on everything. Needs Automatic.");
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
        // The one exception is the yearly badge, "2 months free", which is a
        // discount, not a free plan. It is counted so a second "free" still fails.
        expect(visible.match(/\b2 months free\b/g)).toHaveLength(1);
        expect(visible.replace("2 months free", " ")).not.toMatch(/\b(free|trial)\b/i);
        expect(visible).not.toMatch(/7 days/i);
        // Settings live in Discord's own Subline section, never "Plugins".
        expect(visible).not.toMatch(/Plugins|VcTranslate/);
    });

    it("has no em dashes", () => {
        expect(PAGE).not.toContain("—");
    });

    it("says in the privacy table what the install id, computers and server codes send and keep", () => {
        const rows = section("privacy").replace(/<span class="gl-inline">(.*?)<\/span>/g, "$1");
        expect(rows).toContain("<tr><td>Install id</td><td>A random id made when you install. It ties your purchase or code "
            + "to this computer. If you buy from Subline, a scrambled form of it goes to Dodo with the purchase, so Subline "
            + "can switch on by itself. The relay reads its record of this id's first use to give early users Automatic at "
            + "no charge. Your IP is counted to stop abuse.</td>"
            + "<td>Daily counts for 2 days. First use for 90 days. The link to your purchase for 30 days.</td></tr>");
        expect(rows).toContain("<tr><td>Your account</td><td>Your codes and computers are linked into one account. "
            + "AI works on the computers where you bought it or entered its code.</td>"
            + "<td>Until you ask us to delete it.</td></tr>");
        expect(rows).toContain("<tr><td>Computers</td><td>A code works on up to 3 computers. The relay keeps a scrambled id "
            + "for each one, and when it was last used, to count them. One unused for 30 days can be replaced. "
            + "If you got early-user Automatic, the relay remembers that for this computer.</td>"
            + "<td>Until you ask us to delete it.</td></tr>");
        expect(rows).toContain("<tr><td>Server codes</td><td>When you use a server code, the relay records that your install "
            + "claimed it, to count its claims. Tries from your network are counted each day to stop guessing.</td>"
            + "<td>Claims: until you ask us to delete them. Tries: 2 days.</td></tr>");
        expect(rows).toContain("<tr><td>Your code</td><td>Unlocks Subline. The relay never sees your name or email.</td>");
        expect(rows).not.toContain("Free installs");
        for (const kept of ["<td>Messages</td>", "<td>Usernames</td>", "<td>Profiles and embeds</td>", "<td>Stats</td>"]) {
            expect(rows).toContain(kept);
        }
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
