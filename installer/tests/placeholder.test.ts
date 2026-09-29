/**
 * The Automatic product id placeholder never ships (scripts/placeholder.mjs).
 *
 * The first test is the guard itself: it FAILS while the placeholder is in a
 * shipped file, which is the point. A dogfood build that knowingly carries it
 * runs the suite with SUBLINE_ALLOW_PLACEHOLDER=1, the same switch the release
 * script honours; nothing else skips it.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
    ALLOW_ENV, findPlaceholders, PLACEHOLDER, placeholderAllowed, placeholderMessage, SHIPPED_PATHS
} from "../scripts/placeholder.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the placeholder product id", () => {
    it.skipIf(process.env[ALLOW_ENV] === "1")("appears in no shipped file (set the real Dodo product id first)", () => {
        const found = findPlaceholders(REPO_ROOT);
        expect(found, placeholderMessage(found)).toEqual([]);
    });

    it("covers the relay config, the plugin, the installer and the site", () => {
        expect(SHIPPED_PATHS).toEqual(expect.arrayContaining([
            "relay/wrangler.jsonc", "src/userplugins/vcTranslate", "installer/src", "design/site", "site"
        ]));
    });

    it("finds it in shipped files and not in tests", () => {
        const root = mkdtempSync(join(tmpdir(), "subline-placeholder-"));
        try {
            const write = (rel: string, text: string) => {
                mkdirSync(dirname(join(root, rel)), { recursive: true });
                writeFileSync(join(root, rel), text);
            };
            write("installer/src/app/activation.ts", `export const ID = "${PLACEHOLDER}";\n`);
            write("site/index.html", `<a href="https://checkout.dodopayments.com/buy/${PLACEHOLDER}">Buy</a>\n`);
            write("relay/wrangler.jsonc", `{\n  "a": 1,\n  "${PLACEHOLDER}": {}\n}\n`);
            write("src/userplugins/vcTranslate/tests/checkout.test.ts", `"${PLACEHOLDER}"\n`);
            write("installer/src/app/other.ts", "nothing here\n");
            const found = findPlaceholders(root);
            expect(found.map(f => f.file).sort()).toEqual([
                "installer/src/app/activation.ts", "relay/wrangler.jsonc", "site/index.html"
            ]);
            expect(found.find(f => f.file === "relay/wrangler.jsonc")?.lines).toEqual([3]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("lets a build through only with the explicit switch", () => {
        expect(placeholderAllowed({})).toBe(false);
        expect(placeholderAllowed({ [ALLOW_ENV]: "true" })).toBe(false);
        expect(placeholderAllowed({ [ALLOW_ENV]: "1" })).toBe(true);
    });

    it("the release script refuses to build with it, before anything is built", () => {
        const script = readFileSync(join(REPO_ROOT, "installer", "scripts", "release.mjs"), "utf8");
        const check = script.indexOf("findPlaceholders(REPO_ROOT)");
        expect(check).toBeGreaterThan(0);
        expect(script.slice(check, check + 300)).toContain("if (!placeholderAllowed()) fail(placeholderMessage(placeholders));");
        // Before the first build step.
        expect(check).toBeLessThan(script.indexOf('sh("pnpm", ["build:mod"])'));
    });
});
