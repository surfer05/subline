#!/usr/bin/env node
/**
 * Free the computers on a customer's account, so they can start again on new
 * machines (a code works on at most 3). One command:
 *
 *     ADMIN_TOKEN="$(pbpaste)" node scripts/reset-installs.mjs <code>
 *
 * <code> is any code on the account: the license key from their email, or the
 * slp_ code Subline shows in settings. Codes and grants stay; each computer
 * joins again on its next check. Prints how many computers were cleared.
 * The token is read from the environment only and never printed.
 */
const RELAY = process.env.RELAY_URL ?? "https://subline-relay.rahul05alok.workers.dev";

const code = (process.argv[2] ?? "").trim();
const token = process.env.ADMIN_TOKEN;
if (!token) {
    console.error("ADMIN_TOKEN is not set. Pass the same value the relay has (npx wrangler secret put ADMIN_TOKEN).");
    process.exit(1);
}
if (!code) {
    console.error("Usage: ADMIN_TOKEN=... node scripts/reset-installs.mjs <code>");
    process.exit(1);
}

let res;
try {
    res = await fetch(`${RELAY}/admin/reset-installs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ code })
    });
} catch (e) {
    console.error(`reset failed: could not reach ${RELAY}: ${e?.cause?.code ?? e?.message ?? e}`);
    process.exit(1);
}
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.ok) {
    console.error(`reset failed: HTTP ${res.status} ${body.error ?? ""}`.trim());
    if (res.status === 401) console.error("The token does not match the relay's ADMIN_TOKEN.");
    if (res.status === 404) console.error("No account has that code. Check it, or ask the customer for the code in their settings.");
    process.exit(1);
}
console.log(`cleared ${body.cleared} computer(s)`);
