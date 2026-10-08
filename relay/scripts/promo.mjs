#!/usr/bin/env node
/**
 * Make a server promo code: Automatic free for the first N installs that
 * redeem it (default 100). One command:
 *
 *     ADMIN_TOKEN="$(pbpaste)" node scripts/promo.mjs LEAKCLUB 100
 *
 * The code is 4 to 16 uppercase letters or digits. Installs redeem it in the
 * installer ("I have a code") or in Discord. Each install gets its own Subline
 * code; the relay counts claims exactly (a Durable Object per promo code). One
 * install gets one promo, ever. One address (a shared VPN exit too) gets at
 * most 30 successful claims a day and 20 wrong codes a day; an IPv6 /48 at
 * most max(30, 5% of the cap) claims of one promo. Running it again for the
 * same code changes its cap. Prints the code and cap.
 * The token is read from the environment only and never printed.
 */
const RELAY = process.env.RELAY_URL ?? "https://subline-relay.rahul05alok.workers.dev";

const [codeArg, capArg] = process.argv.slice(2);
const code = (codeArg ?? "").trim().toUpperCase();
const cap = capArg === undefined ? 100 : Number(capArg);
const token = process.env.ADMIN_TOKEN;
if (!token) {
    console.error("ADMIN_TOKEN is not set. Pass the same value the relay has (npx wrangler secret put ADMIN_TOKEN).");
    process.exit(1);
}
if (!/^[A-Z0-9]{4,16}$/.test(code) || !Number.isInteger(cap) || cap < 1 || cap > 100000) {
    console.error("Usage: ADMIN_TOKEN=... node scripts/promo.mjs <CODE: 4-16 letters or digits> [cap=100]");
    process.exit(1);
}

let res;
try {
    res = await fetch(`${RELAY}/admin/promo`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ code, cap })
    });
} catch (e) {
    console.error(`promo failed: could not reach ${RELAY}: ${e?.cause?.code ?? e?.message ?? e}`);
    process.exit(1);
}
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.ok) {
    console.error(`promo failed: HTTP ${res.status} ${body.error ?? ""}`.trim());
    if (res.status === 401) console.error("The token does not match the relay's ADMIN_TOKEN.");
    process.exit(1);
}
console.log(`${body.code} (first ${body.cap} installs)`);
