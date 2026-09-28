#!/usr/bin/env node
/**
 * Make a personal coupon: 100% off the monthly plan for 3 billing cycles,
 * usable once. One command:
 *
 *     ADMIN_TOKEN="$(pbpaste)" node scripts/coupon.mjs alex
 *
 * Prints only the code: the name uppercased, letters and digits only, plus 5
 * random characters (no 0/O/1/I), at most 16 in all, e.g. RAHUL05K7Q2M. The
 * suffix stops anyone guessing a friend's code from their name. The friend
 * types it into the discount box at checkout.
 * The token is read from the environment only and never printed. The relay
 * needs the DODO_API_KEY secret for this to work.
 */
const RELAY = process.env.RELAY_URL ?? "https://subline-relay.rahul05alok.workers.dev";

const name = process.argv.slice(2).join(" ").trim();
const token = process.env.ADMIN_TOKEN;
if (!token) {
    console.error("ADMIN_TOKEN is not set. Pass the same value the relay has (npx wrangler secret put ADMIN_TOKEN).");
    process.exit(1);
}
if (!name) {
    console.error("Usage: ADMIN_TOKEN=... node scripts/coupon.mjs <name>");
    process.exit(1);
}

let res;
try {
    res = await fetch(`${RELAY}/admin/coupon`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name })
    });
} catch (e) {
    console.error(`coupon failed: could not reach ${RELAY}: ${e?.cause?.code ?? e?.message ?? e}`);
    process.exit(1);
}
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.ok) {
    console.error(`coupon failed: HTTP ${res.status} ${body.error ?? ""}`.trim());
    if (res.status === 401) console.error("The token does not match the relay's ADMIN_TOKEN.");
    if (res.status === 503) console.error("The relay has no DODO_API_KEY. Run: npx wrangler secret put DODO_API_KEY");
    process.exit(1);
}
console.log(body.code);
