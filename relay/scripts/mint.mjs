#!/usr/bin/env node
/**
 * Mint a Subline code for a friend (or yourself). One command:
 *
 *     ADMIN_TOKEN="$(pbpaste)" node scripts/mint.mjs carito
 *     ADMIN_TOKEN=... node scripts/mint.mjs zehra 2000
 *
 * The token is read from the environment only; it is never written anywhere by
 * this script. Set/rotate it with `npx wrangler secret put ADMIN_TOKEN` (no
 * deploy needed). The code printed is the thing the friend pastes at the
 * installer's code screen (or later in Subline's settings inside Discord).
 */
const RELAY = process.env.RELAY_URL ?? "https://subline-relay.rahul05alok.workers.dev";

const [note, capArg] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
if (!token) {
    console.error("ADMIN_TOKEN is not set. Run:  npx wrangler secret put ADMIN_TOKEN   then pass the same value here.");
    process.exit(1);
}
if (!note) {
    console.error("Usage: ADMIN_TOKEN=... node scripts/mint.mjs <who-is-this-for> [dailyCap]");
    process.exit(1);
}
const dailyCap = Number(capArg ?? 2000);

const res = await fetch(`${RELAY}/admin/codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "mint", plan: "free", dailyCap, note })
});
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.ok) {
    console.error(`mint failed: HTTP ${res.status} ${body.error ?? ""}`.trim());
    if (res.status === 401) console.error("The token does not match the relay's ADMIN_TOKEN. Rotate it: npx wrangler secret put ADMIN_TOKEN");
    process.exit(1);
}
console.log(`\n  code for ${note}:  ${body.code}\n  plan ${body.record.plan}, ${body.record.dailyCap} messages/day\n`);
