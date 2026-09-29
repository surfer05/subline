import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * NO PLACEHOLDER PRODUCT IN A SHIPPED BUILD. Until the owner gives the real
 * Dodo product id for Automatic, the code carries a placeholder, and a build
 * with it would sell nothing (the relay answers "checkout unavailable"). This
 * test fails while the placeholder is anywhere in the plugin's shipped
 * sources. A dogfood build may set SUBLINE_ALLOW_PLACEHOLDER=1 to run the
 * rest of the suite anyway; a release must not.
 */

// Built, not written out, so this file is never itself a hit for a search.
const PLACEHOLDER = ["pdt", "AUTOMATIC", "PENDING"].join("_");
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function shippedSources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "tests" || name === "node_modules" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) shippedSources(path, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
    return out;
}

describe("the Automatic product id", () => {
    it.skipIf(process.env.SUBLINE_ALLOW_PLACEHOLDER === "1")("is set: no placeholder in any shipped source", () => {
        const hits = shippedSources(ROOT).filter(f => readFileSync(f, "utf8").includes(PLACEHOLDER));
        expect(hits.map(f => f.slice(ROOT.length))).toEqual([]);
    });

    it("the scan sees the plugin's sources (so an empty result means something)", () => {
        const files = shippedSources(ROOT).map(f => f.slice(ROOT.length));
        expect(files).toContain("checkout.ts");
        expect(files).toContain("index.tsx");
        expect(files.some(f => f.startsWith("tests"))).toBe(false);
    });
});
