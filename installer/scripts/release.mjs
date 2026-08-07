#!/usr/bin/env node
/**
 * Clean checkout → signed, notarized, stapled artefacts + the release manifest.
 * One command.
 *
 *     pnpm release              macOS only, signed and notarized
 *     pnpm release --win        add the (unsigned) Windows installer
 *     pnpm release --dry-run    everything except the two signing steps
 *
 * ---------------------------------------------------------------------------
 * THE STEPS THAT NEED THE USER'S CREDENTIALS ARE MARKED, AND ONLY THOSE
 * ---------------------------------------------------------------------------
 *
 * Two of the nine steps touch a credential, and both read it from the
 * environment at the moment it is used:
 *
 *   [SIGNING]      step 5 — electron-builder signs with the Developer ID
 *                  certificate in the login keychain (or CSC_LINK/CSC_KEY_PASSWORD)
 *   [NOTARIZING]   step 5's afterSign hook and step 8 — `xcrun notarytool`, using
 *                  APPLE_KEYCHAIN_PROFILE (recommended) or an API key or an
 *                  app-specific password
 *
 * Nothing is written into the repository, nothing is cached, and no credential
 * appears in any file this script produces. `docs/RELEASING.md` names every
 * variable and the one-off commands that create them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PREFLIGHT IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * A release is the one artefact nobody can re-run. Everything this script checks
 * before it builds is something that has already gone wrong in this project:
 *
 *   · a dirty tree     — the build id is a digest of the plugin's SOURCES, so an
 *                        uncommitted edit produces a release whose id names a tree
 *                        that exists on exactly one laptop.
 *   · a stale stamp    — same failure, one step earlier.
 *   · a stale bundle   — `build/mod` is gitignored and outlives branch switches;
 *                        `packaging/hooks.mjs` explains what shipping one does.
 *   · a red suite      — obvious, and still worth the ninety seconds.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * **It does not publish.** The last thing it prints is the `gh release create`
 * command, with every artefact listed, for a human to run. Publishing is the
 * step that cannot be undone — a release URL that has been fetched once is in
 * somebody's cache forever — and it is the one that should require a person to
 * read what they are about to hand out.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { computeStamp } from "../../scripts/stampBuild.mjs";
import { inspectBundleDir } from "../src/bundle/spec.ts";
import { RELEASE_FEED_URL, RELEASE_REPOSITORY } from "../src/helper/feed.ts";
import { assertBundleIdentity } from "../packaging/bundleIdentity.ts";
import {
    buildReleaseManifest,
    CHECKSUMS_ASSET_NAME,
    digestFile,
    modArtifactName,
    parseRepository,
    releaseFeedUrl,
    RELEASE_MANIFEST_ASSET_NAME,
    releaseTagFor,
    renderChecksums,
    renderReleaseManifest
} from "../packaging/manifest.ts";
import { isNotarizationRequested, notarizeAndStaple, NOTARIZE_FLAG_VAR } from "../packaging/notarize.ts";

/**
 * The env var `electron-builder.js` reads to decide whether to sign at all.
 *
 * Its DEFAULT is not to sign — electron-builder would otherwise go looking in the
 * login keychain and sign with whatever it found, raising an authorisation prompt
 * on somebody's machine for a build nobody asked to be signed. This script is the
 * one place that turns it on, and only after the caller has already opted in with
 * ${NOTARIZE_FLAG_VAR}.
 */
const SIGN_FLAG_VAR = "SUBLINE_SIGN";

const run = promisify(execFile);

const INSTALLER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(INSTALLER_DIR);
const MOD_DIR = join(INSTALLER_DIR, "build", "mod");
const OUT_DIR = join(INSTALLER_DIR, "release");

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);

const options = {
    windows: has("--win"),
    dryRun: has("--dry-run"),
    skipTests: has("--skip-tests"),
    allowDirty: has("--allow-dirty")
};

let step = 0;

function say(message) {
    process.stdout.write(`${message}\n`);
}

function heading(title, tag = "") {
    step += 1;
    say(`\n${step}. ${title}${tag === "" ? "" : `   ${tag}`}`);
}

function fail(message) {
    process.stderr.write(`\nrelease FAILED — ${message}\n`);
    process.exit(1);
}

function sh(command, args, cwd = INSTALLER_DIR) {
    say(`   $ ${command} ${args.join(" ")}`);
    execFileSync(command, args, { cwd, stdio: "inherit" });
}

/** `sh`, with extra environment. Named variables only — never a credential. */
function shWith(env, command, args, cwd = INSTALLER_DIR) {
    say(`   $ ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")} ${command} ${args.join(" ")}`);
    execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

function capture(command, args, cwd = REPO_ROOT) {
    return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

async function main() {
    const version = JSON.parse(readFileSync(join(INSTALLER_DIR, "package.json"), "utf8")).version;
    const repository = parseRepository(RELEASE_REPOSITORY);
    const tag = releaseTagFor(version);

    // The URL a SHIPPED BUILD polls and the URL this release is published to,
    // proved equal rather than assumed. They are derived by two different
    // modules — `feed.ts` compiles into the app, `manifest.ts` only ever runs
    // here — and a release published one character away from the address every
    // installed copy is watching would look exactly like a release nobody made.
    if (releaseFeedUrl(repository) !== RELEASE_FEED_URL) {
        fail(
            `the release script would publish to ${releaseFeedUrl(repository)}, but shipped builds poll `
            + `${RELEASE_FEED_URL}. One of src/helper/feed.ts or packaging/manifest.ts is wrong.`
        );
    }

    say(`Subline ${version}  →  ${repository.owner}/${repository.name} ${tag}`);
    if (options.dryRun) say("DRY RUN: nothing will be signed or notarized.");

    /* -------------------------------------------------------------------- */
    heading("Preflight: the tree, the stamp and the suites");

    if (!options.allowDirty) {
        const dirty = capture("git", ["status", "--porcelain"]);
        if (dirty.length > 0) {
            fail(
                "the working tree is not clean, and the mod build id is a digest of the plugin's SOURCES — "
                + "a release built from uncommitted changes names a tree that exists nowhere else.\n"
                + `${dirty}\n  (--allow-dirty overrides this; do not use it for a real release.)`
            );
        }
    }
    say(`   commit ${capture("git", ["rev-parse", "HEAD"])}`);
    sh("node", [join(REPO_ROOT, "scripts", "stampBuild.mjs"), "--check"], REPO_ROOT);

    if (!options.skipTests) {
        sh("pnpm", ["typecheck"]);
        sh("pnpm", ["test"]);
        sh("npx", ["vitest", "run"], join(REPO_ROOT, "src", "userplugins", "vcTranslate"));
    }

    /* -------------------------------------------------------------------- */
    heading("Build the mod bundle (Vencord at the pinned commit + the plugin)");
    sh("pnpm", ["build:mod"]);

    /* -------------------------------------------------------------------- */
    heading("Check the bundle is the build this checkout produces");
    const stamp = computeStamp();
    const identity = assertBundleIdentity({
        bundleDir: MOD_DIR,
        expectedBuildId: stamp.buildId,
        expectedPluginVersion: stamp.version,
        inspect: inspectBundleDir
    });
    say(`   build ${identity.buildId}, plugin ${identity.pluginVersion}`);

    /* -------------------------------------------------------------------- */
    heading("Compile the app");
    sh("pnpm", ["build:app"]);

    /* -------------------------------------------------------------------- */
    heading("Package macOS", options.dryRun ? "" : "[SIGNING] [NOTARIZING]");
    // `release/` is cleared first: it is not gitignored content we want to
    // reason about, and a stale DMG from a previous version sitting next to this
    // one is how the wrong file gets uploaded.
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });

    if (options.dryRun) {
        // Nothing reaches the keychain and nothing reaches Apple. The artefact is
        // an unsigned app, which is enough to prove the packaging works.
        say("   unsigned: --dry-run");
        shWith({ CSC_IDENTITY_AUTO_DISCOVERY: "false" }, "npx", ["electron-builder", "--mac"]);
    } else {
        if (!isNotarizationRequested(process.env)) {
            fail(
                `${NOTARIZE_FLAG_VAR} is not set. A signed-but-not-notarized build makes users hit Gatekeeper BEFORE `
                + "App Management — two walls instead of one (spec §4) — so this script will not produce one by "
                + `accident. Set ${NOTARIZE_FLAG_VAR}=1 with credentials (see docs/RELEASING.md), or pass --dry-run.`
            );
        }
        // The ONLY place ${SIGN_FLAG_VAR} is set. Signing is opt-in everywhere
        // else, so no other command in this repository can reach the keychain.
        shWith({ [SIGN_FLAG_VAR]: "1" }, "npx", ["electron-builder", "--mac"]);
    }

    /* -------------------------------------------------------------------- */
    if (options.windows) {
        heading("Package Windows", "[UNSIGNED — spec §1, §10]");
        shWith({ CSC_IDENTITY_AUTO_DISCOVERY: "false" }, "npx", ["electron-builder", "--win"]);
    }

    /* -------------------------------------------------------------------- */
    heading("Archive the mod bundle — the artefact the release manifest names");
    // `--keepParent` puts everything under a single `mod/` directory, which is
    // what `findBundleRoot` looks one level down for. `--sequesterRsrc` keeps
    // extended attributes out, so the bytes are the same on any machine.
    const modArchive = join(OUT_DIR, modArtifactName(identity.buildId));
    sh("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", MOD_DIR, modArchive]);

    /* -------------------------------------------------------------------- */
    heading("Notarize and staple the disk images", options.dryRun ? "[SKIPPED]" : "[NOTARIZING]");
    const disks = readdirSync(OUT_DIR).filter(name => name.endsWith(".dmg"));
    if (disks.length === 0) fail("electron-builder produced no .dmg, so there is nothing to release.");
    for (const name of disks) {
        if (options.dryRun) {
            say(`   would notarize and staple ${name}`);
            continue;
        }
        const outcome = await notarizeAndStaple({
            path: join(OUT_DIR, name),
            env: process.env,
            exec: (file, args) => run(file, [...args]),
            log: message => say(`   ${message}`)
        });
        if (outcome.status !== "notarized") fail(`${name} was not notarized: ${outcome.reason}`);
    }

    /* -------------------------------------------------------------------- */
    heading("Write the release manifest and the checksums");
    const artifact = digestFile(modArchive);
    const manifest = buildReleaseManifest({
        repository,
        tag,
        buildId: identity.buildId,
        pluginVersion: identity.pluginVersion,
        artifact,
        publishedAt: new Date().toISOString()
    });
    writeFileSync(join(OUT_DIR, RELEASE_MANIFEST_ASSET_NAME), renderReleaseManifest(manifest), "utf8");

    // Every distributable, not only the mod bundle: the manifest is what the
    // HELPER checks, and SHA256SUMS is what a person checks.
    const distributables = readdirSync(OUT_DIR)
        .filter(name => /\.(dmg|zip|exe)$/.test(name))
        .map(name => digestFile(join(OUT_DIR, name)));
    writeFileSync(join(OUT_DIR, CHECKSUMS_ASSET_NAME), renderChecksums(distributables), "utf8");

    /* -------------------------------------------------------------------- */
    heading("Ready to publish — this script does not");
    const assets = [RELEASE_MANIFEST_ASSET_NAME, CHECKSUMS_ASSET_NAME, ...distributables.map(d => d.name)];
    for (const name of assets) say(`   ${name}`);
    say("");
    say(`   feed URL once published:  ${releaseFeedUrl(repository)}`);
    say(`   artefact URL:             ${manifest.artifact.url}`);
    say("");
    say("   Publish with:");
    say(`     gh release create ${tag} --repo ${repository.owner}/${repository.name} \\`);
    say(`       --title "Subline ${version}" --notes-file <notes.md> \\`);
    for (const name of assets) say(`       ${join("release", name)} \\`);
    say("");
    say("   Then flip RELEASE_FEED_ENABLED in src/helper/feed.ts to true and ship the NEXT build with it on.");
}

main().catch(cause => fail(String(cause?.stack ?? cause)));
