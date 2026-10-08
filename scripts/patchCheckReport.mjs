#!/usr/bin/env node
/**
 * Turn the daily patch check's per-channel results into one Markdown report:
 * the job summary, and the body of the "Discord patch check failing" issue
 * (.github/workflows/patch-check.yml).
 *
 * Input: a directory holding, per channel, what the workflow captured from
 * `node scripts/checkPatches.mjs --channel <ch> --json`:
 *   <ch>.json  stdout (the rows), <ch>.err  stderr, <ch>.code  exit code.
 * A channel FAILS when its exit code is not 0: 1 means an active patch no
 * longer applies, 2 means the check itself could not run (network, build).
 * Both need the owner, so both fail the job.
 *
 * Usage:
 *   node scripts/patchCheckReport.mjs --dir DIR [--out FILE]
 * Writes the report to FILE (or stdout). Exit code 1 when any channel failed,
 * 0 when all passed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHANNELS = ["stable", "ptb", "canary"];
export const ISSUE_TITLE = "Discord patch check failing";

function readOr(path, fallback) {
    try { return existsSync(path) ? readFileSync(path, "utf8") : fallback; } catch { return fallback; }
}

/** One channel's outcome from its three files. */
export function channelResult(dir, channel) {
    // Strict: an empty or missing file must never read as exit code 0.
    const rawCode = readOr(join(dir, `${channel}.code`), "").trim();
    const code = /^\d+$/.test(rawCode) ? Number(rawCode) : -1;
    const err = readOr(join(dir, `${channel}.err`), "").trim();
    let rows = null;
    try {
        const parsed = JSON.parse(readOr(join(dir, `${channel}.json`), ""));
        if (parsed && Array.isArray(parsed.rows)) rows = parsed.rows;
    } catch { /* no JSON: the check did not get that far */ }
    const failing = (rows ?? []).filter(r => r && r.active && !r.ok);
    const ok = code === 0;
    const state = ok ? "pass" : code === 1 && rows !== null ? "fail" : "error";
    return { channel, state, failing, error: ok ? "" : err.split("\n").slice(-5).join("\n"), checked: (rows ?? []).filter(r => r?.active).length };
}

const cell = s => String(s ?? "").replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 160);

/** The Markdown report for a list of channel results. */
export function renderReport(results, { runUrl = "", date = new Date().toISOString().slice(0, 10) } = {}) {
    const bad = results.filter(r => r.state !== "pass");
    const lines = [];
    lines.push(bad.length === 0
        ? `All Subline patches apply on ${results.map(r => r.channel).join(", ")} (${date}).`
        : `Subline patches no longer apply to Discord's current web code (${date}). Translations may be missing for users on the channels below.`);
    lines.push("");
    lines.push("| Channel | Result | Active checks |");
    lines.push("|---|---|---|");
    for (const r of results) lines.push(`| ${r.channel} | ${r.state === "pass" ? "pass" : r.state === "fail" ? `FAIL (${r.failing.length})` : "check could not run"} | ${r.checked} |`);
    for (const r of bad) {
        lines.push("");
        lines.push(`### ${r.channel}`);
        if (r.state === "fail") {
            lines.push("");
            lines.push("| Plugin | Find | Why |");
            lines.push("|---|---|---|");
            for (const f of r.failing) lines.push(`| ${cell(f.plugin)} | \`${cell(f.find)}\` | ${cell(f.why)} |`);
        } else {
            lines.push("");
            lines.push("The check itself failed. Last lines of its error output:");
            lines.push("");
            lines.push("```");
            lines.push(r.error || "(no output)");
            lines.push("```");
        }
    }
    lines.push("");
    lines.push("Reproduce locally: `pnpm --dir installer build:mod && pnpm check:patches --channel <channel>`.");
    if (runUrl) lines.push(`Run: ${runUrl}`);
    return { failed: bad.length > 0, markdown: lines.join("\n") + "\n" };
}

function main(argv) {
    const arg = name => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
    const dir = resolve(arg("--dir") ?? ".");
    const out = arg("--out");
    const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "";
    const results = CHANNELS.filter(ch => existsSync(join(dir, `${ch}.code`))).map(ch => channelResult(dir, ch));
    if (results.length === 0) {
        console.error(`patchCheckReport: no <channel>.code files in ${dir}`);
        return 1;
    }
    const { failed, markdown } = renderReport(results, { runUrl });
    if (out) writeFileSync(out, markdown, "utf8");
    else process.stdout.write(markdown);
    return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
