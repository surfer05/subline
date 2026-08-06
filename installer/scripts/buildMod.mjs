#!/usr/bin/env node
/**
 * Build the shippable mod bundle: Vencord + vcTranslate, pre-built, plus a
 * manifest that says exactly what it is.
 *
 * Run: `pnpm build:mod` from `installer/`.
 * Output: `installer/build/mod/` — a self-contained directory ready to package,
 * and the thing `patchInstall({ modBundleDir })` installs.
 *
 * ---------------------------------------------------------------------------
 * HOW THE VENCORD SOURCE IS OBTAINED, AND WHY THIS WAY
 * ---------------------------------------------------------------------------
 *
 * A pinned commit, fetched into a throwaway working directory under
 * `installer/build/vencord/`. `vencord.pin.json` holds the repository and the
 * full object id; this script refuses to build if the checkout's `HEAD` is not
 * exactly that commit.
 *
 * **Not "whatever Vencord is on this machine."** The previous stub required
 * `/Users/surfer/dev/Vencord/dist/patcher.js` — a path on one developer's
 * laptop. Depending on a checkout that happens to exist is the precise class of
 * bug that works locally and ships broken, and it also makes "which Vencord are
 * we shipping" unanswerable, which spec §6 needs answered the first time
 * Discord rewrites its frontend and the patches stop matching.
 *
 * **Not a git submodule.** Two concrete problems, not stylistic ones. First, a
 * submodule is empty unless the consumer cloned `--recursive` or remembered
 * `submodule update --init`; the failure is a silently missing directory, which
 * is the same shape of failure we are trying to eliminate. Second, our plugin
 * has to be copied INTO the Vencord tree at `src/userplugins/`, so building
 * would dirty the submodule's working tree on every run — a tracked tree that
 * is always dirty is a tracked tree whose dirtiness stops being informative.
 *
 * **Not a tarball.** GitHub's generated archives are not byte-stable across
 * server-side git versions, so a checksum pin of one is a build that breaks for
 * reasons unrelated to us. A commit id is stable by construction — it *is* a
 * checksum of the tree.
 *
 * `SUBLINE_VENCORD_REMOTE` may point the fetch at a local clone or mirror, for
 * offline or air-gapped builds. It changes only WHERE the objects come from;
 * the pinned commit is still checked out and still verified, so an offline
 * build produces the same bundle rather than a different one. It is never read
 * as a source of truth about which Vencord to use.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BUNDLE IS VERIFIED BEFORE IT IS DECLARED BUILT
 * ---------------------------------------------------------------------------
 *
 * "A directory of files proves nothing." The last step runs `inspectBundleDir`
 * — the SAME function `patchInstall` runs at install time — so the build fails
 * here rather than producing a bundle that the installer will reject on a
 * stranger's machine. In particular it proves the build id in the manifest
 * literally appears in the compiled `renderer.js`, which is what makes the
 * recorded identity and the shipped code incapable of disagreeing.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
    computeStamp,
    renderStamp,
    shippedSources,
    STAMP_PATH
} from "../../scripts/stampBuild.mjs";
import {
    digestEntries,
    inspectBundleDir,
    manifestPathFor,
    MOD_MANIFEST_FORMAT,
    renderManifest,
    SOURCE_NOTICE_NAME
} from "../src/bundle/spec.ts";

const INSTALLER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(INSTALLER_DIR);
const PLUGIN_DIR = join(REPO_ROOT, "src", "userplugins", "vcTranslate");

const BUILD_DIR = join(INSTALLER_DIR, "build");
const VENCORD_DIR = join(BUILD_DIR, "vencord");
const OUT_DIR = join(BUILD_DIR, "mod");
const PIN_PATH = join(INSTALLER_DIR, "vencord.pin.json");

/**
 * Copied out of Vencord's `dist/` into the bundle.
 *
 * The `.map` files are deliberately left behind: they are 7 MB of the 8 MB
 * build and nothing at runtime reads them. The `.LEGAL.txt` files are NOT
 * optional — they carry the licence notices esbuild extracted from the bundled
 * dependencies, and dropping them while redistributing the output is exactly
 * the attribution failure GPL-3.0 §5 is about.
 */
const DIST_FILES = [
    "patcher.js",
    "patcher.js.LEGAL.txt",
    "preload.js",
    "renderer.js",
    "renderer.js.LEGAL.txt",
    "renderer.css"
];

function log(message) {
    process.stdout.write(`${message}\n`);
}

function fail(message) {
    process.stderr.write(`\nbuild:mod FAILED — ${message}\n`);
    process.exit(1);
}

function run(command, args, cwd) {
    log(`  $ ${command} ${args.join(" ")}`);
    execFileSync(command, args, { cwd, stdio: "inherit" });
}

function capture(command, args, cwd) {
    return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

function readPin() {
    const pin = JSON.parse(readFileSync(PIN_PATH, "utf8"));
    if (typeof pin.commit !== "string" || !/^[0-9a-f]{40}$/.test(pin.commit)) {
        fail(`vencord.pin.json does not pin a full 40-character commit id.`);
    }
    if (typeof pin.repository !== "string" || pin.repository.length === 0) {
        fail("vencord.pin.json does not name a repository.");
    }
    return pin;
}

/**
 * Fetch exactly the pinned commit into a scratch checkout.
 *
 * `init` + `fetch <remote> <sha>` rather than `clone`, because it is the only
 * form that works identically for a URL and for a local mirror, and because it
 * never writes to whatever it fetches from — a local clone used as a remote
 * stays untouched.
 */
function prepareVencord(pin) {
    const remote = process.env.SUBLINE_VENCORD_REMOTE || pin.repository;
    if (remote !== pin.repository) {
        log(`  (fetching from ${remote} instead of ${pin.repository}; the pinned commit is unchanged)`);
    }

    if (!existsSync(join(VENCORD_DIR, ".git"))) {
        rmSync(VENCORD_DIR, { recursive: true, force: true });
        mkdirSync(VENCORD_DIR, { recursive: true });
        run("git", ["init", "--quiet"], VENCORD_DIR);
    }

    let head = "";
    try {
        head = capture("git", ["rev-parse", "HEAD"], VENCORD_DIR);
    } catch {
        // A freshly `init`ed repository has no HEAD yet. Not an error — it is
        // the first run.
    }

    if (head !== pin.commit) {
        run("git", ["fetch", "--quiet", "--depth", "1", remote, pin.commit], VENCORD_DIR);
        run("git", ["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], VENCORD_DIR);
    }

    // Re-read rather than trust the checkout we just did. This is the pin.
    const actual = capture("git", ["rev-parse", "HEAD"], VENCORD_DIR);
    if (actual !== pin.commit) {
        fail(`the Vencord checkout is at ${actual}, not the pinned ${pin.commit}.`);
    }

    const upstreamVersion = JSON.parse(readFileSync(join(VENCORD_DIR, "package.json"), "utf8")).version;
    if (typeof pin.version === "string" && pin.version !== upstreamVersion) {
        // A pin whose halves disagree means somebody bumped one and not the
        // other, and the manifest would then tell users a version that is not
        // what they have.
        fail(`vencord.pin.json says version ${pin.version}, but commit ${pin.commit} is version ${upstreamVersion}.`);
    }

    return upstreamVersion;
}

/**
 * Copy the plugin in — the exact set `stampBuild.mjs` calls "shipped", so the
 * build id and the built code describe the same files by construction. A
 * symlink would build too, but it would make the artefact depend on a path
 * outside the build tree.
 */
function installPlugin() {
    const target = join(VENCORD_DIR, "src", "userplugins", "vcTranslate");
    rmSync(target, { recursive: true, force: true });

    const files = [...shippedSources(), STAMP_PATH];
    for (const source of files) {
        const destination = join(target, relative(PLUGIN_DIR, source));
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(source, destination);
    }
    return files.length;
}

function sourceNotice(pin, upstreamVersion, stamp) {
    return `Subline mod bundle — corresponding source
=========================================

This directory contains the compiled output of two GPL-3.0 works.

1. Vencord (GPL-3.0-or-later), by Vendicated and contributors.
   Repository: ${pin.repository}
   Commit:     ${pin.commit}
   Version:    ${upstreamVersion}

   The complete corresponding source is that repository at that exact commit.
   Licence notices for the third-party code esbuild inlined into these bundles
   are in patcher.js.LEGAL.txt and renderer.js.LEGAL.txt.

2. vcTranslate (the Subline translation plugin), GPL-3.0-or-later.
   Repository: https://github.com/surfer05/vctranslate
   Version:    ${stamp.version}
   Build id:   ${stamp.buildId}

   The build id is a SHA-256 over the plugin's shipped sources, so the sources
   corresponding to this bundle are identifiable rather than merely claimed.

Built at ${new Date().toISOString()} by installer/scripts/buildMod.mjs.
`;
}

function main() {
    const pin = readPin();

    log("1/6  Checking the plugin's build stamp is current");
    const stamp = computeStamp();
    const onDisk = existsSync(STAMP_PATH) ? readFileSync(STAMP_PATH, "utf8") : null;
    if (onDisk !== renderStamp(stamp)) {
        // Failing here rather than stamping silently: the stamp is checked in
        // and the plugin's own test suite asserts it is current, so a stale one
        // means the working tree and the committed identity disagree — and a
        // bundle built from that would carry an id no committed source produces.
        fail("buildStamp.ts is stale. Run `pnpm stamp` at the repo root and commit it, then build again.");
    }
    log(`     plugin ${stamp.version}, build ${stamp.buildId}`);

    log(`2/6  Fetching pinned Vencord ${pin.commit.slice(0, 12)}`);
    const upstreamVersion = prepareVencord(pin);
    log(`     Vencord ${upstreamVersion} at ${pin.commit}`);

    log("3/6  Copying the plugin into src/userplugins/vcTranslate");
    log(`     ${installPlugin()} files`);

    log("4/6  Installing Vencord's dependencies and building");
    run("pnpm", ["install", "--frozen-lockfile"], VENCORD_DIR);
    // --standalone: the bundle must not assume it sits in a git checkout, which
    //   a local build does.
    // --disable-updater: spec §6 gives Subline's own helper the job of shipping
    //   new builds. Vencord's built-in updater would replace the code behind our
    //   back, and the build id recorded in subline-patch.json would then name a
    //   build that is no longer installed — a healthy install reporting itself
    //   foreign, which is the exact failure the build id exists to prevent.
    run("pnpm", ["build", "--standalone", "--disable-updater"], VENCORD_DIR);

    log("5/6  Assembling the bundle");
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    for (const name of DIST_FILES) {
        const source = join(VENCORD_DIR, "dist", name);
        if (!existsSync(source)) fail(`Vencord's build produced no dist/${name}.`);
        cpSync(source, join(OUT_DIR, name));
    }
    cpSync(join(VENCORD_DIR, "LICENSE"), join(OUT_DIR, "LICENSE"));
    writeFileSync(join(OUT_DIR, SOURCE_NOTICE_NAME), sourceNotice(pin, upstreamVersion, stamp), "utf8");

    writeFileSync(
        manifestPathFor(OUT_DIR),
        renderManifest({
            format: MOD_MANIFEST_FORMAT,
            product: "subline",
            buildId: stamp.buildId,
            pluginVersion: stamp.version,
            vencord: { repository: pin.repository, commit: pin.commit, version: upstreamVersion },
            builtAt: new Date().toISOString(),
            entries: digestEntries(OUT_DIR)
        }),
        "utf8"
    );

    log("6/6  Verifying the bundle is usable, not merely present");
    const facts = inspectBundleDir(OUT_DIR);
    if (facts.manifest === null || facts.problems.length > 0) {
        fail(`the bundle this build just produced is not installable:\n  ${facts.problems.join("\n  ")}`);
    }

    log(`\nBuilt ${OUT_DIR}`);
    log(`  build id      ${facts.manifest.buildId}  (present in renderer.js)`);
    log(`  plugin        ${facts.manifest.pluginVersion}`);
    log(`  Vencord       ${facts.manifest.vencord.version} @ ${facts.manifest.vencord.commit}`);
    log(`  loader path   ${facts.loaderPath}`);
}

main();
