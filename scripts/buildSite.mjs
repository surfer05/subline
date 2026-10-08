#!/usr/bin/env node
/**
 * Assemble site/index.html from the design system.
 *
 * The sections in `design/site/` are standalone previews — each is a whole HTML
 * document that links `../../tokens.css`, so a designer can open any one of them
 * on its own. The shipped site is one file with no external requests. This
 * script is the join between those two facts.
 *
 * WHY A SCRIPT AND NOT A COPY-PASTE. `docs/DESIGN-SYSTEM.md` says adopting a
 * design change should be "drop in the new files, rebuild". Hand-merging four
 * documents into one breaks that the first time anything is revised: the copy
 * in site/ silently stops matching design/, and there is no way to tell by
 * looking. Here the generated file carries a banner saying not to edit it, and
 * regenerating is one command.
 *
 * `--check` re-runs the build and fails if the result differs from what is on
 * disk, so CI (or a person) can catch a hand-edited site/index.html.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN = join(ROOT, "design");
const OUT = join(ROOT, "site", "index.html");
/** The /buy page: Automatic on any device. Its own file, so subline.page/buy works. */
const BUY_OUT = join(ROOT, "site", "buy", "index.html");

/** Order on the page. Not alphabetical — this is the argument the page makes. */
const SECTIONS = ["thanks", "hero", "pricing", "downloads", "security-warning", "privacy"];

/**
 * Sections that ship HIDDEN and are shown by the page script. "thanks" is the
 * return from checkout: it only makes sense when Dodo sent the buyer back
 * (or the address ends in #thanks), so it is first on the page and hidden.
 */
const HIDDEN_SECTIONS = new Set(["thanks"]);

/**
 * The pure checkout-return parser, inlined into the page script. It lives in
 * its own file so tests can run the exact same text in node.
 */
const THANKS_JS = readFileSync(join(DESIGN, "site", "thanks", "thanks.js"), "utf8").trim();

const REPO = "surfer05/subline";

/** Where the site lives. Canonical and og:url point here (the old github.io address redirects). */
const SITE = "https://subline.page/";

/**
 * The relay's public purchase check (relay R7). The thanks view asks it, for a
 * pending return, whether the purchase went through. It answers with a state
 * only, never personal data. A relay without it (404, CORS, offline) is fine:
 * the view then says where to look instead of showing an error.
 */
const STATUS_URL = "https://subline-relay.rahul05alok.workers.dev/v1/purchase-status";

/** Everything between the outermost <style> tags. */
function styleOf(html) {
    const match = /<style>([\s\S]*?)<\/style>/.exec(html);
    return match ? match[1].trim() : "";
}

/** Everything inside <body>. buildSite wraps each section in .wrap itself (the previews don't). */
function bodyOf(html) {
    const match = /<body>([\s\S]*?)<\/body>/.exec(html);
    if (!match) throw new Error("no <body>");
    return match[1].trim();
}

/**
 * Merge the section stylesheets, keeping the first definition of each rule.
 *
 * Every preview repeats the same base rules so that it can stand alone. Emitting
 * all four copies would trade a readable stylesheet for nothing; keeping the
 * FIRST occurrence (rather than the last) means the shared base wins and a
 * section's own additions still follow it.
 */
function mergeStyles(styles) {
    const seen = new Set();
    const out = [];
    for (const sheet of styles) {
        for (const rule of topLevelRules(sheet)) {
            const trimmed = rule.trim();
            if (trimmed === "") continue;
            const key = trimmed.replace(/\s+/g, " ");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(trimmed);
        }
    }
    return out.join("\n");
}

/**
 * Split a stylesheet into TOP-LEVEL rules, respecting brace depth.
 *
 * The obvious `split(/(?<=\})/)` (split after every `}`) is wrong for any
 * nested at-rule: it cuts `@media (...) { .x {} }` in half at the inner
 * brace, and the dedup below then drops or reorders the orphaned outer `}`,
 * leaving the sheet permanently unbalanced. That is the source of every
 * "unstyled screen" and "boxes with no padding" this project has hit - the
 * installer's design.css carried two lost braces this way, hand-patched in
 * the output; this fixes it in the generator so both outputs are correct.
 *
 * A top-level rule is everything from one depth-0 position to the next: emit a
 * chunk each time the brace depth returns to zero.
 */
function topLevelRules(sheet) {
    const rules = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < sheet.length; i++) {
        const ch = sheet[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                rules.push(sheet.slice(start, i + 1));
                start = i + 1;
            }
        }
    }
    // Trailing content with no closing brace (a comment, or a syntax error we
    // would rather surface than swallow) rides along as its own chunk.
    if (start < sheet.length && sheet.slice(start).trim() !== "") {
        rules.push(sheet.slice(start));
    }
    return rules;
}

const tokens = readFileSync(join(DESIGN, "tokens.css"), "utf8").trim();

/**
 * THE AUTOMATIC PRODUCT ID PLACEHOLDER.
 *
 * Until the owner creates the Dodo product, design/site/pricing carries
 * `pdt_AUTOMATIC_PENDING` in the Automatic card's Buy link. That link would be
 * a Dodo 404, so the build never ships it:
 *   - without SUBLINE_ALLOW_PLACEHOLDER=1 the build (and `--check`) refuses,
 *     naming the file, so a release can never be built with it by accident;
 *   - with it (dogfood builds), the Automatic card's button is rewritten to
 *     point at #downloads with the text "Download", because the installer is
 *     where Automatic is bought anyway.
 * `--check` rebuilds the same way the build did, so run both with the same
 * setting: with the override while the placeholder is there, plain once the
 * real id is in. Once the real id replaces the placeholder the card links to
 * checkout with no change here.
 */
const AUTOMATIC_PLACEHOLDER = "pdt_AUTOMATIC_PENDING";
const ALLOW_PLACEHOLDER = process.env.SUBLINE_ALLOW_PLACEHOLDER === "1";

function withoutPlaceholderBuy(name, body) {
    if (!body.includes(AUTOMATIC_PLACEHOLDER)) return body;
    if (!ALLOW_PLACEHOLDER) {
        console.error(
            `design/site/${name}/index.html still has the placeholder Automatic product id (${AUTOMATIC_PLACEHOLDER}). ` +
            "Put the real Dodo product id in, or set SUBLINE_ALLOW_PLACEHOLDER=1 for a dogfood build " +
            "(the Automatic button then points to #downloads)."
        );
        process.exit(1);
    }
    const out = body.replace(
        /<a ([^>]*)data-buy="automatic"([^>]*)href="[^"]*pdt_AUTOMATIC_PENDING[^"]*"([^>]*)>[^<]*<\/a>/,
        '<a $1data-buy="automatic"$2href="#downloads"$3>Download</a>'
    );
    // The design comment names the placeholder too; drop it from the page.
    return out.replace(/<!--[\s\S]*?pdt_AUTOMATIC_PENDING[\s\S]*?-->\s*/g, "");
}

const parts = SECTIONS.map(name => {
    const html = readFileSync(join(DESIGN, "site", name, "index.html"), "utf8");
    return { name, style: styleOf(html), body: withoutPlaceholderBuy(name, bodyOf(html)) };
});

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Subline: read Discord in your language</title>
<meta name="description" content="Subline puts a translation underneath any Discord message written in a language you don't read. It runs inside the Discord you already have.">
<meta property="og:title" content="Subline">
<meta property="og:description" content="Read what your friends are actually saying.">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}">
<link rel="canonical" href="${SITE}">

<!-- GENERATED by scripts/buildSite.mjs from design/. Do not edit by hand:
     the next \`pnpm build:site\` will overwrite it. Change design/ instead. -->

<style>
${tokens}
</style>

<style>
${mergeStyles(parts.map(p => p.style))}
</style>
</head>
<body>

${parts.map(p => `<!-- ${p.name} -->\n<section id="${p.name}"${HIDDEN_SECTIONS.has(p.name) ? " hidden" : ""}>\n<div class="wrap">\n${p.body}\n</div>\n</section>`).join("\n\n")}

<script>
(function () {
  "use strict";

  var REPO = ${JSON.stringify(REPO)};
  var STATUS_URL = ${JSON.stringify(STATUS_URL)};

  ${THANKS_JS.split("\n").join("\n  ")}

  // Back from checkout: show the thanks view, and only it (no hero, pricing or
  // downloads under it). The key is written with textContent only and never
  // sent anywhere. Then the address is cut back to "?result=<state>#thanks"
  // (keeping any from=) with history.replaceState, so the key does not sit in
  // the address bar, the history list, or a link someone copies to share the
  // page. A refresh then shows the same view without the key; it is also in
  // the receipt email.
  // A pending return is checked with the relay (watchPurchase) for about 3
  // minutes. Only the payment or subscription id is sent, never the key. The
  // view switches to "You're all set." or "Payment didn't go through." when
  // the relay knows; if it never does, the Discord view says where to look.
  (function () {
    var ret = parseCheckoutReturn(location.search, location.hash);
    var section = document.getElementById("thanks");
    if (!ret || !section) return;
    // Read before the address is cleaned: the status check needs the id.
    var purchase = purchaseOf(location.search);
    section.hidden = false;
    [].forEach.call(document.querySelectorAll("body > section"), function (s) { if (s !== section) s.hidden = true; });
    function part(name) { return section.querySelector("[data-thanks-" + name + "]"); }
    function each(name, fn) { [].forEach.call(section.querySelectorAll("[data-thanks-" + name + "]"), fn); }
    var d = ret.fromDiscord, inst = ret.fromInstaller, buy = !!ret.fromBuy;
    var site = !d && !inst;
    // The code is in the email only after a one-time purchase. AI is a
    // subscription and does not change the code, so its view leaves that out.
    var oneTime = !!purchase && purchase.param === "payment_id";
    var fb = part("fallback");
    function show(state) {
      ret.state = state;
      var views = {
        "ok": site && state === "ok", "pending": site && state === "pending",
        "discord": d && state === "ok", "discord-pending": d && state === "pending",
        "installer": inst && state === "ok", "installer-pending": inst && state === "pending",
        "failed": state === "failed"
      };
      for (var name in views) { var el = part(name); if (el) el.hidden = !views[name]; }
      if (fb && state === "failed") fb.hidden = true;
    }
    show(ret.state);
    each("site-only", function (el) { el.hidden = buy; });
    each("buy-only", function (el) { el.hidden = !buy; });
    each("email", function (el) { el.hidden = !oneTime; });
    var nokey = part("buy-nokey");
    if (nokey) nokey.hidden = !buy || ret.keys.length > 0;
    var retry = part("retry");
    if (retry && buy) retry.setAttribute("href", "buy/");
    // A Discord or installer return that carried a key: offer it collapsed,
    // only as the way out if the purchase has not switched on by itself.
    if (fb) {
      var fk = (d || inst) && ret.state !== "failed" && ret.fallbackKeys && ret.fallbackKeys.length ? ret.fallbackKeys[0] : null;
      fb.hidden = !fk;
      if (fk) {
        var fbD = fb.querySelector("[data-thanks-fallback-discord]"), fbI = fb.querySelector("[data-thanks-fallback-installer]");
        if (fbD) fbD.hidden = !d;
        if (fbI) fbI.hidden = !inst;
        var fbCode = fb.querySelector("[data-thanks-fallback-code]"), fbBtn = fb.querySelector("[data-thanks-fallback-copy]");
        if (fbCode) fbCode.textContent = fk;
        if (fbCode && fbBtn) fbBtn.addEventListener("click", function () { copyText(fk, fbCode, fbBtn); });
      }
    }
    var keysBox = part("keys"), row = part("key");
    if (keysBox && row) {
      keysBox.hidden = ret.keys.length === 0;
      var list = row.parentNode, last = row;
      ret.keys.forEach(function (key, i) {
        var r = i === 0 ? row : row.cloneNode(true);
        if (i > 0) { list.insertBefore(r, last.nextSibling); last = r; }
        r.querySelector("[data-thanks-code]").textContent = key;
        var btn = r.querySelector("[data-thanks-copy]");
        btn.addEventListener("click", function () { copyText(key, r.querySelector("[data-thanks-code]"), btn); });
      });
    }
    function clean() {
      try {
        // The key and Dodo's parameters leave the address; the from= and the
        // outcome stay, so a refresh shows the same view and the same outcome.
        var keep = cleanedReturnSearch(ret);
        if (location.search !== keep && history.replaceState) history.replaceState(null, "", location.pathname + keep + "#thanks");
      } catch (e) { /* the view still shows */ }
    }
    clean();
    if (ret.state !== "pending") return;
    function notYet() { each("timeout", function (el) { el.hidden = false; }); }
    if (!purchase || typeof fetch !== "function") { notYet(); return; }
    watchPurchase(STATUS_URL, purchase, {
      fetch: function (url, opts) { return fetch(url, opts); },
      setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
      now: function () { return Date.now(); }
    }, function (how) {
      if (how === "ok" || how === "failed") {
        show(how);
        // The relay's answer replaces the outcome Dodo's return gave, so a
        // refresh keeps it. location.search is already the cleaned one.
        clean();
      } else {
        notYet();
      }
    });
  })();

  function copyText(text, node, btn) {
    function done() { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 2000); }
    function fallback() {
      // Select the code so Cmd/Ctrl+C works, and try the old copy command.
      try {
        var range = document.createRange();
        range.selectNodeContents(node);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        if (document.execCommand("copy")) done();
      } catch (e) { /* the code stays selected */ }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }
  var RELEASES = "https://github.com/" + REPO + "/releases/latest";
  document.documentElement.classList.add("js");

  // ONE place decides the visitor's OS. The hero button, the download card
  // order, the Mac chip pick and the install tab all read it, so they cannot
  // disagree. An iPad in desktop mode reports "MacIntel", so a touch screen on
  // a "Mac" is treated as unknown: it must never be handed a .dmg.
  function detectOS() {
    var ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod|Android/i.test(ua)) return "unknown";
    var uad = navigator.userAgentData;
    var p = (uad && uad.platform) || navigator.platform || ua;
    if (/Win/i.test(p)) return "windows";
    if (/Mac/i.test(p) && !(navigator.maxTouchPoints > 1)) return "mac";
    return "unknown";
  }
  var os = detectOS();

  // Hero. Without JS (or on an unknown OS) both buttons go to #downloads.
  // Windows: the primary button downloads the .exe and Mac becomes the
  // secondary link. Mac: the primary button downloads the .dmg, with an Intel
  // link under it. The data-dl hook lets the release lookup below fill in the
  // exact file; until it does, the button still goes to #downloads.
  var heroPrimary = document.querySelector('[data-hero="primary"]');
  var heroSecondary = document.querySelector('[data-hero="secondary"]');
  if (heroPrimary && heroSecondary && os === "windows") {
    heroPrimary.textContent = "Download for Windows";
    heroPrimary.setAttribute("data-dl", "win");
    heroSecondary.textContent = "Mac";
  } else if (heroPrimary && os === "mac") {
    heroPrimary.setAttribute("data-dl", "mac");
    var heroIntel = document.querySelector('[data-hero="intel"]');
    if (heroIntel) heroIntel.hidden = false;
  }

  // Download cards: the visitor's OS comes first and gets the filled button.
  if (os === "windows") {
    var winCard = document.querySelector('[data-os="win"]');
    var macCard = document.querySelector('[data-os="mac"]');
    if (winCard && macCard) {
      macCard.parentNode.insertBefore(winCard, macCard);
      var winBtn = winCard.querySelector('[data-dl="win"]');
      var macBtn = macCard.querySelector('[data-dl="mac"]');
      if (winBtn) winBtn.classList.replace("btn-secondary", "btn-primary");
      if (macBtn) macBtn.classList.replace("btn-primary", "btn-secondary");
    }
  }

  // The thanks view's downloads follow the same rule: Windows first and filled
  // on Windows, and the Intel line only on a Mac (Safari can't tell Intel
  // from Apple Silicon, so a buyer there needs the manual link right here).
  (function thanksDownloads() {
    var tWin = document.querySelector('#thanks [data-dl="win"]');
    var tMac = document.querySelector('#thanks [data-dl="mac"]');
    if (os === "windows" && tWin && tMac) {
      tMac.parentNode.insertBefore(tWin, tMac);
      tWin.classList.replace("btn-secondary", "btn-primary");
      tMac.classList.replace("btn-primary", "btn-secondary");
    }
    var tIntel = document.querySelector("#thanks [data-thanks-intel]");
    if (tIntel) tIntel.hidden = os !== "mac";
  })();

  // Every download link starts pointed at the releases page (in the HTML, so
  // it works with JS off) and is only ever REPLACED with something more
  // specific. A blocked request, a rate-limited API or an offline visitor
  // therefore still lands somewhere that works.
  var links = [].slice.call(document.querySelectorAll("[data-dl]"));
  links.forEach(function (a) { if (!a.getAttribute("href") || a.getAttribute("href") === "#") a.href = RELEASES; });

  function set(kind, url) {
    links.filter(function (a) { return a.getAttribute("data-dl") === kind; })
         .forEach(function (a) { a.href = url; });
  }

  // ONE Mac button. It links the Apple Silicon build unless the browser gives
  // positive evidence of an Intel Mac. Apple Silicon is the default because
  // every Mac sold since 2020 has it, and a detection that fails or is blocked
  // should land on the common case. The "Intel version" line under the button
  // is the manual override, so a wrong guess costs one click.
  var mac = { arch: "arm", arm: null, intel: null };
  function applyMac() {
    var url = mac.arch === "intel" ? mac.intel : mac.arm;
    if (url) set("mac", url);
  }
  function rendererSaysIntel() {
    // Chrome and Firefox expose the real GPU: "Apple M1" on Apple Silicon,
    // "Intel", "AMD Radeon" and so on on an Intel Mac. Safari reports "Apple GPU"
    // on every Mac, which is not evidence either way, so it stays on the default.
    try {
      var gl = document.createElement("canvas").getContext("webgl");
      if (!gl) return false;
      var info = gl.getExtension("WEBGL_debug_renderer_info");
      var r = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      return !/Apple (M\\d|GPU)/i.test(r) && /Intel|AMD|Radeon|NVIDIA|GeForce/i.test(r);
    } catch (e) {
      return false;
    }
  }
  if (os === "mac") {
    var uad = navigator.userAgentData;
    if (uad && uad.getHighEntropyValues) {
      // Chromium browsers answer "arm" or "x86" directly.
      uad.getHighEntropyValues(["architecture"])
        .then(function (v) { mac.arch = v.architecture === "x86" ? "intel" : v.architecture === "arm" ? "arm" : (rendererSaysIntel() ? "intel" : "arm"); })
        .catch(function () { mac.arch = rendererSaysIntel() ? "intel" : "arm"; })
        .then(applyMac);
    } else if (rendererSaysIntel()) {
      mac.arch = "intel";
    }
  }

  // GitHub's /releases/latest/download/<name> shortcut needs the literal asset
  // name, and ours carry the version, so anything hardcoded here would keep
  // serving an old build forever. Resolve at runtime instead.
  // The unauthenticated API allows 60 calls an hour per IP, so a shared
  // network can run out. Keep the answer for 10 minutes per tab.
  var CACHE_KEY = "subline-release";
  function getRelease() {
    try {
      var cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
      if (cached && cached.r && Date.now() - cached.t < 600000) return Promise.resolve(cached.r);
    } catch (e) { /* storage blocked: just fetch */ }
    return fetch("https://api.github.com/repos/" + REPO + "/releases/latest", {
      headers: { Accept: "application/vnd.github+json" }
    })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(res.status); })
      .then(function (release) {
        var slim = {
          tag_name: release.tag_name,
          assets: (release.assets || []).map(function (a) { return { name: a.name, browser_download_url: a.browser_download_url }; })
        };
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), r: slim })); } catch (e) { /* fine */ }
        return slim;
      });
  }

  getRelease()
    .then(function (release) {
      var assets = release.assets || [];
      function find(test) {
        for (var i = 0; i < assets.length; i++) if (test(assets[i].name)) return assets[i];
        return null;
      }
      var exe = find(function (n) { return /\\.exe$/i.test(n); });
      var arm = find(function (n) { return /arm64.*\\.dmg$/i.test(n); });
      var intel = find(function (n) { return /(x64|x86_64|intel).*\\.dmg$/i.test(n); });
      var anyDmg = find(function (n) { return /\\.dmg$/i.test(n); });

      if (exe) set("win", exe.browser_download_url);
      if (intel) set("mac-intel", intel.browser_download_url);
      // A build with no matching asset keeps pointing at the releases page
      // rather than at the other architecture, which would not open.
      mac.arm = arm ? arm.browser_download_url : anyDmg ? anyDmg.browser_download_url : null;
      mac.intel = intel ? intel.browser_download_url : null;
      applyMac();

      if (release.tag_name) {
        [].forEach.call(document.querySelectorAll("[data-version]"), function (el) {
          el.textContent = release.tag_name;
          el.setAttribute("data-state", "resolved");
        });
      }
    })
    .catch(function () {
      // Links already point at the releases page. That page lists several
      // files, so show the line that says which one to pick.
      [].forEach.call(document.querySelectorAll("[data-fallback]"), function (el) { el.hidden = false; });
      [].forEach.call(document.querySelectorAll("[data-version]"), function (el) { el.setAttribute("data-state", "failed"); });
    });

  // Install tabs: swap the macOS / Windows step panels, and preselect the
  // visitor's own OS so the right steps show without a click.
  var tabs = [].slice.call(document.querySelectorAll("[data-tab]"));
  var panels = [].slice.call(document.querySelectorAll("[data-panel]"));
  function showTab(name) {
    tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t.getAttribute("data-tab") === name)); });
    panels.forEach(function (pnl) { pnl.hidden = pnl.getAttribute("data-panel") !== name; });
  }
  tabs.forEach(function (t) { t.addEventListener("click", function () { showTab(t.getAttribute("data-tab")); }); });
  // The tabs ship hidden: with JS off both step lists show, each with its own
  // label, and there are no buttons that do nothing.
  var tablist = document.querySelector('[role="tablist"]');
  if (tablist) {
    tablist.hidden = false;
    var winTab = tablist.querySelector('[data-tab="windows"]');
    if (os === "windows" && winTab) tablist.insertBefore(winTab, tablist.firstChild);
  }
  showTab(os === "windows" ? "windows" : "macos");
})();
</script>

</body>
</html>
`;

/* ---------------------------------------------------------------------- *
 * The /buy page
 *
 * For a buyer who cannot pay from the computer (a VPN that must stay on, a
 * blocked card page): it starts the same Dodo static checkout as the pricing
 * card, and returns to the site root with ?from=buy, where the thanks view
 * shows the code and says to enter it under "I have a code". One page, so it
 * is built from design/site/buy on its own, not merged into index.html.
 * ---------------------------------------------------------------------- */

const buyHtml = readFileSync(join(DESIGN, "site", "buy", "index.html"), "utf8");
// With the placeholder allowed, the Buy button becomes a link to the
// downloads on the main page (one level up), like the pricing card.
const buyBody = withoutPlaceholderBuy("buy", bodyOf(buyHtml)).replace('href="#downloads"', 'href="../#downloads"');

const buyPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Buy Subline</title>
<meta name="description" content="Buy Subline Automatic on any device. $4.99, once.">
<meta property="og:title" content="Buy Subline">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}buy/">
<link rel="canonical" href="${SITE}buy/">

<!-- GENERATED by scripts/buildSite.mjs from design/site/buy. Do not edit by hand. -->

<style>
${tokens}
</style>

<style>
${mergeStyles([styleOf(buyHtml)])}
</style>
</head>
<body>

<section id="buy">
<div class="wrap">
${buyBody}
</div>
</section>

</body>
</html>
`;

/* ---------------------------------------------------------------------- *
 * The installer stylesheet
 *
 * Same join, different target. Every screen preview in design/screens/ repeats
 * the whole shell stylesheet so it can be opened standalone; the renderer needs
 * one file. Merging by first-occurrence gives the shared shell once, followed by
 * whatever each screen adds.
 *
 * Emitted into installer/src/renderer/ because that is what copyRenderer.mjs
 * ships into dist/. The renderer declares no colour of its own — docs/DESIGN-SYSTEM.md §5.
 * ---------------------------------------------------------------------- */

const SCREEN_CSS = join(ROOT, "installer", "src", "renderer", "design.css");

const screenDirs = readdirSync(join(DESIGN, "screens")).filter(name => !name.startsWith("."));
const componentDirs = readdirSync(join(DESIGN, "components")).filter(name => !name.startsWith("."));

const screenStyles = [
    ...screenDirs.map(name => styleOf(readFileSync(join(DESIGN, "screens", name, "index.html"), "utf8"))),
    ...componentDirs.map(name => styleOf(readFileSync(join(DESIGN, "components", name, "index.html"), "utf8")))
];

const rendererCss = `/* GENERATED by scripts/buildSite.mjs from design/. Do not edit by hand.
   Tokens plus the merged shell and component rules, in one file because the
   renderer loads no external stylesheet. Change design/ and rebuild. */

${tokens}

${mergeStyles(screenStyles)}
`;

if (process.argv.includes("--check")) {
    const stale = [];
    if (readFileSync(OUT, "utf8") !== page) stale.push("site/index.html");
    let buyOnDisk = null;
    try { buyOnDisk = readFileSync(BUY_OUT, "utf8"); } catch { /* missing counts as stale */ }
    if (buyOnDisk !== buyPage) stale.push("site/buy/index.html");
    if (readFileSync(SCREEN_CSS, "utf8") !== rendererCss) stale.push("installer/src/renderer/design.css");
    if (stale.length > 0) {
        console.error("Out of date with design/: " + stale.join(", ") + ". Run `pnpm build:site`.");
        process.exit(1);
    }
    console.log("site/ and installer renderer match design/.");
} else {
    writeFileSync(OUT, page);
    mkdirSync(dirname(BUY_OUT), { recursive: true });
    writeFileSync(BUY_OUT, buyPage);
    writeFileSync(SCREEN_CSS, rendererCss);
    console.log(`Wrote site/buy/index.html — ${(buyPage.length / 1024).toFixed(1)} KB.`);
    console.log(`Wrote site/index.html — ${SECTIONS.length} sections, ${(page.length / 1024).toFixed(1)} KB.`);
    console.log(`Wrote installer/src/renderer/design.css — ${(rendererCss.length / 1024).toFixed(1)} KB.`);
}
