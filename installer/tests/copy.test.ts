/**
 * No em dashes in anything a user reads.
 *
 * A product-owner rule, stated verbatim: "they really give the vibe coded
 * feel." Every user-facing sentence uses ordinary punctuation instead: a
 * period, a comma, a colon. Comments may punctuate however they like; this
 * test strips them before looking, because comments are for maintainers and
 * this rule is about what ships.
 *
 * The check is a heuristic (a line containing a quote character and an em
 * dash, after comment-stripping), which errs toward flagging: a false
 * positive costs a minute of rewording, a false negative ships the vibe.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALLER = dirname(dirname(fileURLToPath(import.meta.url)));

function offendingLines(file: string): string[] {
    const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/([^:])\/\/[^"'`\n]*$/gm, "$1");
    return src.split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => line.includes("—") && /["'`]/.test(line))
        .map(({ line, i }) => `${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
}

describe("user-facing copy", () => {
    it("contains no em dashes", () => {
        const files = execSync("find src -name '*.ts' -o -name '*.cts'", {
            cwd: INSTALLER, encoding: "utf8"
        }).trim().split("\n").map(f => join(INSTALLER, f));

        expect(files.flatMap(offendingLines)).toEqual([]);
    });

    it("keeps the install note clean too", () => {
        const note = readFileSync(join(INSTALLER, "..", "docs", "INSTALL-NOTE.md"), "utf8");
        expect(note.includes("—")).toBe(false);
    });
});
