#!/usr/bin/env node
/**
 * Replace a leaked code. The old code stops working, a new code with the same
 * plan and expiry takes its place on the same account, and every computer on
 * the account is forgotten, so whoever holds the old code gets nothing. Send
 * the new code to the customer. One command:
 *
 *     ADMIN_TOKEN="$(pbpaste)" node scripts/reissue.mjs <code>
 *
 * <code> is the leaked code: the license key from their email, or the slp_
 * code Subline shows in settings. Prints only the new code. The token is read
 * from the environment only and never printed.
 */
const RELAY = process.env.RELAY_URL ?? "https://subline-relay.rahul05alok.workers.dev";

const code = (process.argv[2] ?? "").trim();
const token = process.env.ADMIN_TOKEN;
if (!token) {
    console.error("ADMIN_TOKEN is not set. Pass the same value the relay has (npx wrangler secret put ADMIN_TOKEN).");
    process.exit(1);
}
if (!code) {
    console.error("Usage: ADMIN_TOKEN=... node scripts/reissue.mjs <code>");
    process.exit(1);
}

let res;
try {
    res = await fetch(`${RELAY}/admin/reissue`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ code })
    });
} catch (e) {
    console.error(`reissue failed: could not reach ${RELAY}: ${e?.cause?.code ?? e?.message ?? e}`);
    process.exit(1);
}
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.ok) {
    console.error(`reissue failed: HTTP ${res.status} ${body.error ?? ""}`.trim());
    if (res.status === 401) console.error("The token does not match the relay's ADMIN_TOKEN.");
    if (res.status === 404) console.error("No account has that code. Check it, or ask the customer for the code in their settings.");
    if (res.status === 409) console.error("That code no longer works, so there is nothing to reissue.");
    process.exit(1);
}
console.log(body.code);
