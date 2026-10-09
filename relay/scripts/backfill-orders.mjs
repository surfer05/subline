#!/usr/bin/env node
/**
 * Fill the missing payment index (order:<payment_id>) of existing codes from
 * Dodo's records, so refunds and disputes can revoke them and the thanks page
 * says "You're all set". The relay asks Dodo with its own key: you never
 * paste the Dodo key here. One command (dry run, writes nothing):
 *
 *     ADMIN_TOKEN="$(pbpaste)" node scripts/backfill-orders.mjs
 *
 * Then, if the counts look right, write the rows:
 *
 *     ADMIN_TOKEN="$(pbpaste)" node scripts/backfill-orders.mjs --apply
 *
 * Prints counts only: never a key, a payment id or a token. Safe to run more
 * than once (a second run finds nothing left to do).
 */
const RELAY = process.env.RELAY_URL ?? "https://subline-relay.rahul05alok.workers.dev";
const apply = process.argv.includes("--apply");
const token = process.env.ADMIN_TOKEN;
if (!token) {
    console.error("ADMIN_TOKEN is not set. Pass the same value the relay has (npx wrangler secret put ADMIN_TOKEN).");
    process.exit(1);
}

const PAGE_SIZE = 20;
const MAX_PAGES = 500;
const total = {};
let page = 0;
for (let n = 0; n < MAX_PAGES && page !== null; n++) {
    let res;
    try {
        res = await fetch(`${RELAY}/admin/backfill-orders`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ apply, page, pageSize: PAGE_SIZE })
        });
    } catch (e) {
        console.error(`backfill failed on page ${page}: could not reach ${RELAY}: ${e?.cause?.code ?? e?.message ?? e}`);
        process.exit(1);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
        console.error(`backfill failed on page ${page}: HTTP ${res.status} ${body.error ?? ""}`.trim());
        if (res.status === 401) console.error("The token does not match the relay's ADMIN_TOKEN.");
        if (res.status === 404) console.error("This relay has no /admin/backfill-orders yet. Deploy the fix first.");
        if (res.status === 503) console.error("The relay could not ask Dodo (no DODO_API_KEY, or Dodo is down). Try again later.");
        process.exit(1);
    }
    for (const [k, v] of Object.entries(body.counts ?? {})) total[k] = (total[k] ?? 0) + (Number(v) || 0);
    page = body.nextPage;
}

console.log(apply ? "APPLIED. Rows written:" : "DRY RUN. Nothing written. With --apply it would write:");
console.log(`  payments read                 ${total.payments ?? 0}`);
console.log(`  with a license key            ${total.withLicenseKey ?? 0}`);
console.log(`  already indexed               ${total.alreadyIndexed ?? 0}`);
console.log(`  ${apply ? "indexed now " : "to index    "}                  ${total.indexed ?? 0}`);
console.log(`  conflicts (left alone)        ${total.conflict ?? 0}`);
console.log(`  key at Dodo, no code here     ${total.noCode ?? 0}`);
console.log(`  no key found at Dodo          ${total.notFoundAtDodo ?? 0}`);
console.log(`  Dodo unavailable (rerun)      ${total.dodoUnavailable ?? 0}`);
console.log(`  fully refunded, code live     ${total.refundedButLive ?? 0}`);
if ((total.refundedButLive ?? 0) > 0) {
    console.log("A fully refunded purchase still has a working code. After --apply, resend its");
    console.log("refund.succeeded webhook from the Dodo dashboard; the relay now revokes it.");
}
