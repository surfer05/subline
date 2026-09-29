import { describe, expect, it } from "vitest";

// The relay typechecks against the Workers types only (no @types/node), so the
// two Node APIs this test needs are declared here and loaded at run time.
declare const process: { env: Record<string, string | undefined> };
declare global { interface ImportMeta { url: string } }
const { readFileSync } = await import("node:" + "fs") as { readFileSync: (p: URL, enc: string) => string };

/**
 * NOTHING PENDING SHIPS. The Automatic product id and the launch moment are
 * placeholders until the owner supplies them. A relay deployed with the
 * placeholder product cannot sell Automatic (checkout answers 503), and one
 * deployed with the placeholder LAUNCH_AT gives no early-user grants. So this
 * test fails while either is still in wrangler.jsonc.
 *
 * Dogfood builds only: run with SUBLINE_ALLOW_PLACEHOLDER=1 to skip it.
 */
const allowed = process.env.SUBLINE_ALLOW_PLACEHOLDER === "1";
const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
    // Comments may name the placeholders; only live values count.
    .split("\n").map((l: string) => l.replace(/^\s*\/\/.*$/, "")).join("\n");

describe.skipIf(allowed)("no placeholder ships", () => {
    it("VARIANTS has the real Automatic product id", () => {
        expect(config).not.toContain("pdt_AUTOMATIC_PENDING");
    });
    it("LAUNCH_AT is a real date", () => {
        expect(config).not.toMatch(/"LAUNCH_AT"\s*:\s*"SET_AT_RELEASE"/);
    });
});

describe("the placeholder guard itself", () => {
    it("sees the live values in wrangler.jsonc", () => {
        expect(config).toMatch(/"VARIANTS"\s*:/);
        expect(config).toMatch(/"LAUNCH_AT"\s*:/);
    });
});
