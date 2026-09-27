#!/usr/bin/env node
/**
 * Run eval-set.json through the LIVE relay, one item per request, and write the
 * results as JSON (for a side-by-side human judgement of meaning).
 *
 *   node scripts/eval.mjs <out.json>
 *
 * Sent exactly as the plugin sends it: a fresh random free_ install id for the
 * whole run (a trial id, so this uses trial calls, never a paid code), the
 * x-subline-client header, mode "auto", target "en". Chat items carry an author
 * and any context; surface items (status, bio, embed, poll, topic, title,
 * event) carry no author, no context, and their `kind`, as the plugin's
 * surfaces do. A relay that does not know `kind` ignores it.
 *
 * Paced under the trial's 20 requests a minute. Prints no id, key or code.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELAY = process.env.RELAY_URL || "https://subline-relay.rahul05alok.workers.dev";
const out = process.argv[2];
if (!out) { console.error("Usage: node scripts/eval.mjs <out.json>"); process.exit(1); }

const set = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "eval-set.json"), "utf8"));
const bearer = `free_${randomBytes(16).toString("hex")}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
for (const item of set.items) {
    const surface = item.kind !== "chat";
    const msg = { id: "0", author: surface ? "" : item.author, text: item.text };
    if (surface) msg.kind = item.kind;
    const body = { messages: [msg], context: surface ? [] : (item.context ?? []), targetLang: "en", mode: "auto" };
    let row = { id: item.id, lang: item.lang, kind: item.kind, text: item.text };
    try {
        const res = await fetch(`${RELAY}/v1/translate`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, "x-subline-client": "vcTranslate/0.1.9" },
            body: JSON.stringify(body)
        });
        const j = await res.json().catch(() => null);
        const r = j?.results?.[0];
        row.out = !j?.ok ? `ERROR ${res.status} ${j?.error ?? ""}` : r?.skip ? "(skip)" : r?.failed ? "(failed)" : r?.text;
        row.detected = r?.lang;
    } catch (e) {
        row.out = `ERROR ${String(e?.message ?? e)}`;
    }
    results.push(row);
    console.log(`${item.id.padEnd(4)} ${row.out}`);
    await sleep(3_500);
}
writeFileSync(out, JSON.stringify(results, null, 2));
