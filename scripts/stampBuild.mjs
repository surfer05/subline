#!/usr/bin/env node
/**
 * Stamps the plugin's build identity into `src/userplugins/vcTranslate/buildStamp.ts`.
 *
 * WHY A STAMP AND NOT A CONSTANT. Two separate holes closed by one mechanism:
 *
 *  1. `PLUGIN_VERSION` used to be a hand-edited literal. Spec §6 makes "which
 *     build is actually running" the thing that distinguishes a stale-patch
 *     diagnosis from a mechanical re-patch — and a constant nobody remembers to
 *     bump answers that question wrongly, silently, forever.
 *  2. The status beacon could say "a vcTranslate is running" but not "the
 *     vcTranslate WE installed is running". A machine that already had Vencord
 *     with this plugin would produce a healthy beacon while our patch sat inert.
 *     The beacon needs an identity that TRAVELS WITH THE BUNDLE, so that a
 *     different build — Vencord's own, an older Subline, a hand-built userplugin
 *     — yields a different value or none at all.
 *
 * So `BUILD_ID` is a SHA-256 over the plugin's shipped sources (paths and
 * contents both) plus the product version. That makes "a different build has a
 * different id" a property of the bytes rather than a promise about process:
 * there is no way to change what the plugin does and keep the id, and no way for
 * an unrelated build to collide with ours by accident.
 *
 * The generated file is CHECKED IN, because the bundle is produced by Vencord's
 * own esbuild run over a symlinked plugin directory and we do not own that build
 * — there is no pre-build hook of ours to attach to. `tests/buildStamp.test.ts`
 * runs this script in `--check` mode, so a stale stamp fails the suite instead of
 * shipping quietly. That is the whole point: the previous failure mode was never
 * "we made a wrong decision", it was "nothing anywhere said this is wrong".
 *
 * Usage:
 *   node scripts/stampBuild.mjs           rewrite buildStamp.ts
 *   node scripts/stampBuild.mjs --check   exit 1 if buildStamp.ts is stale
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_DIR = join(ROOT, "src", "userplugins", "vcTranslate");

export const STAMP_PATH = join(PLUGIN_DIR, "buildStamp.ts");

/** Never part of the shipped bundle, so never part of its identity. */
const SKIP_DIRS = new Set(["tests", "node_modules"]);
const SKIP_FILES = new Set(["buildStamp.ts", "vitest.config.ts"]);

/** Hex only, 16 characters — see BUILD_ID_PATTERN in statusShape.ts. */
const BUILD_ID_LENGTH = 16;

/**
 * Every source file that ends up in the bundle, as repo-relative paths, sorted.
 *
 * Sorted because `readdirSync` order is a filesystem detail, and a build id that
 * depended on it would differ between two checkouts of identical code — a false
 * mismatch, which reads as "the install is not ours" and is the one direction
 * this must never fail in.
 */
export function shippedSources(dir = PLUGIN_DIR, found = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) shippedSources(join(dir, entry.name), found);
            continue;
        }
        if (SKIP_FILES.has(entry.name)) continue;
        if (!/\.tsx?$/.test(entry.name)) continue;
        found.push(join(dir, entry.name));
    }
    return found.sort();
}

export function readVersion() {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    if (typeof pkg.version !== "string" || pkg.version.length === 0) {
        throw new Error("package.json has no version to stamp.");
    }
    return pkg.version;
}

export function computeStamp() {
    const version = readVersion();
    const hash = createHash("sha256");
    // The version participates so that a release bump alone produces a new
    // identity: two builds that differ only in what they call themselves are
    // still two builds, and the installer compares ids to decide whether the
    // thing that reported in is the thing it just installed.
    hash.update(`version:${version}\n`);
    for (const file of shippedSources()) {
        const relativePath = relative(ROOT, file).split("\\").join("/");
        // The path is hashed alongside the bytes: moving code between files
        // changes the bundle even when the bytes are collectively identical.
        hash.update(`file:${relativePath}\n`);
        hash.update(createHash("sha256").update(readFileSync(file)).digest("hex"));
        hash.update("\n");
    }
    return { version, buildId: hash.digest("hex").slice(0, BUILD_ID_LENGTH) };
}

export function renderStamp({ version, buildId }) {
    return `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by \`scripts/stampBuild.mjs\` (run \`pnpm stamp\`). \`BUILD_ID\` is a
 * digest of the plugin's shipped sources, which is what makes it an IDENTITY:
 * a different build of this plugin — Vencord's own copy, an older Subline
 * install, a hand-built userplugin — cannot produce this value.
 *
 * The installer records the id it expects in \`subline-patch.json\` at patch
 * time and refuses to confirm a beacon that reports any other one, so "a
 * vcTranslate is running" can no longer be mistaken for "the vcTranslate we
 * just installed is running".
 *
 * \`tests/buildStamp.test.ts\` re-runs the generator and fails if this file is
 * stale, so the two can never drift silently.
 */

export const PLUGIN_VERSION = ${JSON.stringify(version)};

export const BUILD_ID = ${JSON.stringify(buildId)};
`;
}

function main(argv) {
    const stamp = computeStamp();
    const expected = renderStamp(stamp);
    const check = argv.includes("--check");
    const actual = existsSync(STAMP_PATH) ? readFileSync(STAMP_PATH, "utf8") : null;

    if (actual === expected) {
        if (!check) process.stdout.write(`buildStamp.ts is already current (${stamp.buildId}).\n`);
        return 0;
    }

    if (check) {
        process.stderr.write(
            `buildStamp.ts is STALE.\n`
            + `  expected version ${stamp.version}, build ${stamp.buildId}\n`
            + `  run: pnpm stamp\n`
        );
        return 1;
    }

    writeFileSync(STAMP_PATH, expected, "utf8");
    process.stdout.write(`Stamped ${stamp.version} / ${stamp.buildId}.\n`);
    return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(main(process.argv.slice(2)));
}
