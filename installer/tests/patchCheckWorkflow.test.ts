/**
 * The daily patch check (.github/workflows/patch-check.yml) and its report
 * script (scripts/patchCheckReport.mjs). The workflow is parsed as YAML and
 * held to what the owner relies on: it runs daily and by hand, checks all
 * three channels with the shipped build, needs no secret, pins every action,
 * and opens the ONE issue the report names.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CHANNEL_ORIGINS, originFor } from "../../scripts/checkPatches.mjs";
import { channelResult, ISSUE_TITLE, renderReport } from "../../scripts/patchCheckReport.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "patch-check.yml");

// js-yaml is not a direct dependency; electron-builder carries it.
const req = createRequire(import.meta.url);
const yaml = createRequire(req.resolve("electron-builder"))("js-yaml") as { load: (s: string) => any; };

const source = readFileSync(WORKFLOW, "utf8");
const wf = yaml.load(source);
const steps: Array<Record<string, any>> = wf.jobs.check.steps;
const runs = steps.map(s => String(s.run ?? "")).join("\n");

describe("the patch check workflow", () => {
    it("parses, runs daily and by hand", () => {
        // js-yaml reads the bare `on` key as true under YAML 1.1 rules; GitHub reads it as "on".
        const on = wf.on ?? wf[true as any];
        expect(on.schedule).toHaveLength(1);
        expect(on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* \*$/);
        expect(on).toHaveProperty("workflow_dispatch");
    });

    it("asks for nothing but reading the code and writing issues", () => {
        expect(wf.permissions).toEqual({ contents: "read", issues: "write" });
        expect(source).not.toMatch(/secrets\./);
    });

    it("pins every action to a full commit SHA", () => {
        const uses = steps.filter(s => s.uses).map(s => String(s.uses));
        expect(uses.length).toBeGreaterThan(0);
        for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    });

    it("builds the shipped mod, then checks stable, ptb and canary", () => {
        expect(runs).toContain("node installer/scripts/buildMod.mjs");
        expect(runs).toMatch(/for ch in stable ptb canary; do/);
        expect(runs).toContain("scripts/checkPatches.mjs --channel \"$ch\" --json");
        expect(runs).toContain("scripts/patchCheckReport.mjs --dir patch-check");
        // The same TypeScript the installer locks, at the repo root.
        const lock = readFileSync(join(ROOT, "installer", "pnpm-lock.yaml"), "utf8");
        const tsVersion = /\n  typescript@(\d+\.\d+\.\d+):/.exec(lock)?.[1];
        expect(tsVersion).toBeDefined();
        expect(runs).toContain(`typescript@${tsVersion}`);
    });

    it("opens or updates the one issue the report names, and fails the job", () => {
        expect(runs.match(new RegExp(`title="${ISSUE_TITLE}"`, "g"))).toHaveLength(2);
        expect(runs).toContain("gh issue create --title \"$title\"");
        expect(runs).toContain("gh issue edit \"$number\"");
        const last = steps[steps.length - 1]!;
        expect(last.if).toBe("steps.report.outputs.failed == 'true'");
        expect(String(last.run)).toContain("exit 1");
        for (const s of steps.filter(x => String(x.run ?? "").includes("gh issue"))) {
            expect(s.env.GH_TOKEN).toBe("${{ github.token }}");
        }
    });
});

describe("checkPatches --channel", () => {
    it("knows the three channels' origins and nothing else", () => {
        expect(originFor("stable")).toBe("https://discord.com");
        expect(originFor("ptb")).toBe("https://ptb.discord.com");
        expect(originFor("canary")).toBe("https://canary.discord.com");
        expect(originFor("beta")).toBeNull();
        expect(originFor("__proto__")).toBeNull();
        expect(Object.keys(CHANNEL_ORIGINS)).toEqual(["stable", "ptb", "canary"]);
    });
});

describe("patchCheckReport", () => {
    let dir = "";
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

    function write(channel: string, code: number, rows: unknown[] | null, err = "") {
        writeFileSync(join(dir, `${channel}.code`), `${code}\n`);
        writeFileSync(join(dir, `${channel}.err`), err);
        writeFileSync(join(dir, `${channel}.json`), rows === null ? "" : JSON.stringify({ ok: code === 0, rows }));
    }

    const okRow = { plugin: "VcTranslate", find: "forum-tag-", ok: true, active: true, why: "" };
    const badRow = { plugin: "VcTranslate", find: "friendsSinceDate:", ok: false, active: true, why: "match had no effect" };
    const offRow = { plugin: "ServerListAPI", find: "x|y", ok: false, active: false, why: "find matched 0 modules" };

    it("passes when every channel passed", () => {
        dir = mkdtempSync(join(tmpdir(), "pcr-"));
        for (const ch of ["stable", "ptb", "canary"]) write(ch, 0, [okRow, offRow]);
        const out = renderReport(["stable", "ptb", "canary"].map(c => channelResult(dir, c)), { date: "2026-10-08" });
        expect(out.failed).toBe(false);
        expect(out.markdown).toContain("All Subline patches apply on stable, ptb, canary (2026-10-08).");
    });

    it("lists only the ACTIVE failing patches of a failing channel", () => {
        dir = mkdtempSync(join(tmpdir(), "pcr-"));
        write("stable", 0, [okRow]);
        write("canary", 1, [okRow, badRow, offRow]);
        const out = renderReport([channelResult(dir, "stable"), channelResult(dir, "canary")], { runUrl: "https://example.test/run/1" });
        expect(out.failed).toBe(true);
        expect(out.markdown).toContain("| canary | FAIL (1) | 2 |");
        expect(out.markdown).toContain("| VcTranslate | `friendsSinceDate:` | match had no effect |");
        expect(out.markdown).not.toContain("ServerListAPI");
        expect(out.markdown).toContain("Run: https://example.test/run/1");
        expect(out.markdown).not.toContain("—");
    });

    it("a check that could not run is a failure, with its error", () => {
        dir = mkdtempSync(join(tmpdir(), "pcr-"));
        write("stable", 2, null, "checkPatches: download https://discord.com/app failed: HTTP 503");
        const r = channelResult(dir, "stable");
        expect(r.state).toBe("error");
        const out = renderReport([r]);
        expect(out.failed).toBe(true);
        expect(out.markdown).toContain("check could not run");
        expect(out.markdown).toContain("HTTP 503");
    });

    it("a missing exit code reads as a failure, never as a pass", () => {
        dir = mkdtempSync(join(tmpdir(), "pcr-"));
        writeFileSync(join(dir, "stable.json"), JSON.stringify({ ok: true, rows: [okRow] }));
        expect(channelResult(dir, "stable").state).not.toBe("pass");
    });

    it("a table cell cannot break the table", () => {
        dir = mkdtempSync(join(tmpdir(), "pcr-"));
        write("ptb", 1, [{ ...badRow, find: "a|b\nc" }]);
        const out = renderReport([channelResult(dir, "ptb")]);
        expect(out.markdown).toContain("`a\\|b c`");
    });
});
