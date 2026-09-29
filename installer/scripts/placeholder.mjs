/**
 * The Automatic product id placeholder must never ship.
 *
 * Until the owner creates the Dodo product for Automatic, its id is the
 * placeholder below in four places (the relay's VARIANTS, the plugin's
 * checkout.ts, the installer's activation.ts and the site's Buy link). A build
 * carrying it sells nothing: the relay answers "checkout unavailable" and a
 * static link would be a Dodo 404. So a release refuses to build while it is
 * anywhere in a shipped file, and a test fails on it too.
 *
 * DOGFOOD ESCAPE HATCH: SUBLINE_ALLOW_PLACEHOLDER=1 lets a test build through.
 * It is an explicit, named environment variable on purpose: nothing sets it by
 * accident, and a real release is never built with it.
 *
 * The needle is assembled from two pieces so this file is not itself a match.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const PLACEHOLDER = "pdt_AUTOMATIC_" + "PENDING";
export const ALLOW_ENV = "SUBLINE_ALLOW_PLACEHOLDER";

/**
 * What ships, relative to the repository root. Directories are walked; tests,
 * node_modules and build output are not shipped and are skipped.
 */
export const SHIPPED_PATHS = [
    "installer/src",
    "src/userplugins/vcTranslate",
    "design/site",
    "site",
    "relay/src",
    "relay/wrangler.jsonc"
];

const SKIP_DIRS = new Set(["tests", "test", "node_modules", "dist", "build", "release", ".vite", ".vite-temp"]);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|jsonc|html|css|md|txt)$/;

function walk(path, out) {
    if (!existsSync(path)) return;
    const st = statSync(path);
    if (st.isDirectory()) {
        for (const name of readdirSync(path)) {
            if (SKIP_DIRS.has(name)) continue;
            walk(join(path, name), out);
        }
        return;
    }
    if (TEXT_EXT.test(path)) out.push(path);
}

/** Every shipped file that still holds the placeholder, relative to `root`, with its line numbers. */
export function findPlaceholders(root, paths = SHIPPED_PATHS) {
    const files = [];
    for (const p of paths) walk(join(root, p), files);
    const found = [];
    for (const file of files) {
        const lines = readFileSync(file, "utf8").split("\n");
        const hits = [];
        lines.forEach((line, i) => { if (line.includes(PLACEHOLDER)) hits.push(i + 1); });
        if (hits.length > 0) found.push({ file: relative(root, file), lines: hits });
    }
    return found;
}

/** True when the escape hatch is set, for dogfood builds only. */
export function placeholderAllowed(env = process.env) {
    return env[ALLOW_ENV] === "1";
}

/** The message a refused release prints. */
export function placeholderMessage(found) {
    return `the Automatic product id is still the placeholder ${PLACEHOLDER} in:\n`
        + found.map(f => `   ${f.file} (line ${f.lines.join(", ")})`).join("\n")
        + "\n  Put the real Dodo product id in each of these files first."
        + `\n  (${ALLOW_ENV}=1 lets a dogfood build through; never use it for a real release.)`;
}
