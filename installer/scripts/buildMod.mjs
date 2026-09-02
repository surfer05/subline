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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const PACKAGING_DIR = join(INSTALLER_DIR, "packaging");

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

function run(command, args, cwd, { allowFailure = false } = {}) {
    log(`  $ ${command} ${args.join(" ")}`);
    try {
        execFileSync(command, args, { cwd, stdio: allowFailure ? "ignore" : "inherit" });
    } catch (cause) {
        if (!allowFailure) throw cause;
    }
}

function capture(command, args, cwd) {
    // stderr is swallowed because the only caller probes for a HEAD that may
    // legitimately not exist yet, and git is loud about that.
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/**
 * Run pnpm through corepack, so the version is the one UPSTREAM pins in its
 * `packageManager` field rather than whatever is on this machine's PATH.
 *
 * Not a nicety. Vencord pins pnpm 11; pnpm 9 reads `patchedDependencies` from
 * `package.json` while pnpm 10+ reads it from `pnpm-workspace.yaml`, so a
 * machine with pnpm 9 installed fails `--frozen-lockfile` outright. "Reproducible
 * build" has to include the tool that resolves the dependency graph.
 */
function pnpm(args) {
    run("corepack", ["pnpm", ...args], VENCORD_DIR);
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

    // Vencord's build reads `git remote get-url origin` and bakes it into the
    // user agent it sends. It is set to the CANONICAL repository even when the
    // objects were fetched from a local mirror, so an offline build does not
    // ship a bundle claiming to come from someone's home directory.
    run("git", ["remote", "remove", "origin"], VENCORD_DIR, { allowFailure: true });
    run("git", ["remote", "add", "origin", pin.repository], VENCORD_DIR);

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

    // Restore the tracked tree on EVERY run, not only when the commit changed.
    //
    // The checkout is reused between builds, and two later steps edit it:
    // prunePlugins deletes directories, brandSettings rewrites settings.tsx.
    // Without this, the second build reads the FIRST build's output as though
    // it were upstream source — and brandSettings, which asserts on upstream
    // anchors, failed with "expected exactly one section title, found 0"
    // because it had already replaced that title an hour earlier.
    //
    // prunePlugins survived this by being idempotent: delete-if-present says
    // the same thing however many times it runs. An anchored text rewrite
    // cannot be written that way — its whole purpose is to notice when the
    // source is not what it expects — so the tree it reads has to be pristine
    // instead. Every build now starts from the pinned commit and does the same
    // work, which also means "what does this script do to Vencord" has one
    // answer rather than one per build order.
    //
    // Tracked files only: src/userplugins/vcTranslate is untracked here and is
    // rewritten by installPlugin immediately after, so it is unaffected.
    run("git", ["checkout", "--force", "--", "."], VENCORD_DIR);

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


/**
 * Delete every Vencord plugin Subline does not use, before the build runs.
 *
 * WHY. Vencord ships 167 plugins. A Subline user installed a translator, and
 * was getting all of them — a settings screen listing dozens of features they
 * never asked for, each one a way to change their Discord and a support burden
 * that lands on us. Someone who wants Vencord should install Vencord.
 *
 * WHAT IS KEPT. `_api` provides the extension points the plugin registers
 * against (chat buttons, the message popover, message accessories, user
 * settings); `_core` provides the settings UI itself. Whole directories rather
 * than individual files, because the members of each are interdependent and a
 * per-file list would be a per-file guess.
 *
 * THE GUARD IS THE POINT. Vencord moves under us — this build is pinned to one
 * commit, and the day that pin is bumped a directory we rely on may have been
 * renamed or absorbed. Then the prune would silently remove nothing, or the
 * build would lose a feature quietly. So a KEPT entry that is not there is a
 * hard failure naming it, and the answer to "what does bumping Vencord cost"
 * is: run this, fix what it names.
 */
const KEPT_PLUGIN_DIRS = ["_api", "_core", "clientTheme"];

/**
 * Replace Vencord's settings section with Subline's single pane.
 *
 * WHAT A READER SEES WITHOUT THIS. Vencord adds a seven-entry section to
 * Discord's settings: Vencord, Plugins, Themes, Updater, Cloud, Backup &
 * Restore, Patch Helper. Someone who installed a translation tool opens
 * Settings, finds a client-mod control panel, and reasonably concludes they
 * were given something other than what was on the box. Pruning the PLUGINS
 * (candidate A) emptied one of those panes; it did nothing about the other six
 * or about the word "Vencord" sitting in Discord's sidebar.
 *
 * So: one entry, titled Subline, rendering the translation settings directly.
 *
 * WHY A SOURCE REWRITE AND NOT A RUNTIME PATCH. Vencord's own extension point
 * for this (`customEntries`) can only ADD an eighth entry. Nothing in its API
 * removes the seven, because nothing in Vencord expects to be shipped as
 * somebody else's product. Editing the source at build time is the honest
 * version of what we mean; a runtime monkey-patch of the layout builder would
 * be the same edit with a race condition attached.
 *
 * THE GUARDS ARE THE POINT, exactly as with prunePlugins. Each anchor below is
 * asserted to appear EXACTLY ONCE before it is replaced, and the end state is
 * re-read and checked afterwards. The day the pin is bumped and Vencord has
 * restructured its settings, this build fails naming the anchor it could not
 * find — rather than shipping a bundle that quietly puts Vencord's control
 * panel back in front of the reader. A silent no-op here is the one outcome
 * worth engineering against, because nothing downstream would catch it: the
 * bundle still builds, still verifies, still runs.
 */
function brandSettings() {
    const tabDir = join(VENCORD_DIR, "src", "components", "settings", "tabs", "subline");
    mkdirSync(tabDir, { recursive: true });
    cpSync(join(PACKAGING_DIR, "branding", "sublineTab.tsx"), join(tabDir, "index.tsx"));

    // The tab IMPLEMENTATIONS, removed from the tree rather than merely left
    // unreferenced. Dropping the entries alone made them unreachable, and
    // esbuild shipped them anyway — the first build after this function was
    // written still had Vencord's cloud-sync tab and its backup/restore
    // importer sitting in renderer.js, dead but present. "Subline does not
    // ship a cloud sync client" is a claim a stranger can check with grep, so
    // it had better be true by construction and not by tree-shaking.
    //
    // TWO LISTS, because "this pane is gone" and "this directory is gone" turn
    // out to be different claims.
    //
    // UNEXPORTED covers every pane the reader loses. Removing the barrel export
    // is what actually makes the code unreachable: the first attempt at this
    // dropped only the ENTRIES, left the barrel intact, and esbuild duly
    // shipped Vencord's cloud-sync tab and backup/restore importer into
    // renderer.js — dead, but present and greppable.
    //
    // DELETED is the subset whose directory can also go. `vencord` is exported
    // here but NOT deleted: its NotificationSettings.tsx is imported by
    // api/Notifications, which _api keeps. Deleting the directory to be tidy
    // broke the build with an unresolved import — the tidier version of this
    // function was the wrong one.
    //
    // `updater` is in neither: _core/supportHelper.tsx imports it, and the
    // build already neutralises it with --disable-updater. `plugins` likewise —
    // the Subline tab renders through its OptionComponentMap.
    const UNEXPORTED_TABS = ["themes", "sync", "patchHelper", "vencord"];
    const DELETED_TABS = ["themes", "sync", "patchHelper"];
    const tabsDir = join(VENCORD_DIR, "src", "components", "settings", "tabs");
    for (const name of DELETED_TABS) rmSync(join(tabsDir, name), { recursive: true, force: true });

    const barrelPath = join(tabsDir, "index.ts");
    const kept = readFileSync(barrelPath, "utf8").split("\n")
        .filter(line => !UNEXPORTED_TABS.some(name => line.includes(`from "./${name}`)));
    writeFileSync(barrelPath, kept.join("\n"));

    const settingsPath = join(VENCORD_DIR, "src", "plugins", "_core", "settings.tsx");
    if (!existsSync(settingsPath)) {
        fail("Vencord's checkout has no src/plugins/_core/settings.tsx — the layout has changed.");
    }
    let source = readFileSync(settingsPath, "utf8");

    const replace = (what, from, to) => {
        const seen = source.split(from).length - 1;
        if (seen !== 1) {
            fail(
                `Cannot rebrand the settings section: expected exactly one ${what} in `
                + `_core/settings.tsx, found ${seen}. The pinned Vencord commit has restructured `
                + "its settings; re-derive the anchor against the new source and rebuild."
            );
        }
        source = source.replace(from, to);
    };

    // 1. The sidebar heading Discord renders above the entries.
    replace("section title", `useTitle: () => "Vencord Settings",`, `useTitle: () => "Subline",`);

    // 2. The entries themselves. Everything from the array's opening bracket to
    //    the `.filter(isTruthy)` that closes it — which is why the anchor is
    //    the whole declaration rather than seven separate deletions: one
    //    replacement cannot half-apply, and seven can.
    const entriesStart = "const vencordEntries: SettingsLayoutNode[] = [";
    const entriesEnd = "].filter(isTruthy);";
    const from = source.indexOf(entriesStart);
    const to = source.indexOf(entriesEnd, from);
    if (from === -1 || to === -1) {
        fail(
            "Cannot rebrand the settings section: the vencordEntries array is no longer "
            + "declared the way this build expects in _core/settings.tsx."
        );
    }
    source = source.slice(0, from)
        + entriesStart + `
            buildEntry({
                key: "subline_main",
                // "Settings", not "Subline": the sidebar already says Subline
                // in the section header directly above this entry, and
                // "Subline / Subline" reading twice in a row was called out in
                // the Windows run. The pane keeps the product name in its own
                // panelTitle and footer.
                title: "Settings",
                panelTitle: "Subline",
                Component: SublineTab,
                Icon: MainSettingsIcon
            }),
            // customEntries is kept so a plugin can still register a pane —
            // vcTranslate does not, but removing an extension point we do not
            // need is a change with no upside and a maintenance cost at the
            // next pin bump. customSections (deprecated upstream) is dropped
            // with the rest.
            ...this.customEntries.map(buildEntry)
        `
        + source.slice(to);

    // 3. Import the new tab, alongside the tab imports already there.
    replace(
        "tabs import",
        `import { BackupAndRestoreTab, CloudTab, PatchHelperTab, PluginsTab, ThemesTab, UpdaterTab, VencordTab } from "@components/settings/tabs";`,
        `import SublineTab from "@components/settings/tabs/subline";`
    );

    writeFileSync(settingsPath, source);

    // END-STATE CHECK. The replacements above could each succeed and still
    // leave a pane reachable, so the result is re-read rather than assumed.
    const written = readFileSync(settingsPath, "utf8");
    const leaked = ["vencord_plugins", "vencord_themes", "vencord_updater", "vencord_cloud",
        "vencord_backup_restore", "vencord_patch_helper", "vencord_main"]
        .filter(key => written.includes(`"${key}"`));
    if (leaked.length > 0) {
        fail(`Settings section still builds ${leaked.join(", ")} after rebranding.`);
    }
    if (!written.includes(`"subline_main"`)) {
        fail("Settings section does not build subline_main after rebranding.");
    }
    return `1 entry (Subline), replacing Vencord's 7; unexported ${UNEXPORTED_TABS.join(", ")}`;
}

function prunePlugins() {
    const pluginsDir = join(VENCORD_DIR, "src", "plugins");
    if (!existsSync(pluginsDir)) fail(`Vencord's checkout has no src/plugins — the layout has changed.`);

    const present = readdirSync(pluginsDir);
    const missing = KEPT_PLUGIN_DIRS.filter(name => !present.includes(name));
    if (missing.length > 0) {
        fail(
            `Vencord no longer has src/plugins/${missing.join(", src/plugins/")}. `
            + "The pinned commit moved something Subline depends on: check what replaced it, "
            + "update KEPT_PLUGIN_DIRS, and rebuild."
        );
    }

    let removed = 0;
    for (const name of present) {
        if (KEPT_PLUGIN_DIRS.includes(name)) continue;
        // index.ts sits alongside the plugin directories and is what imports
        // them; Vencord globs the folder, so removing the folders is enough and
        // removing the index would break the build outright.
        if (name === "index.ts" || name === "index.tsx") continue;
        rmSync(join(pluginsDir, name), { recursive: true, force: true });
        removed += 1;
    }

    // Asserted on the END STATE, not on how many files this run deleted. The
    // checkout is reused between builds, so a second build legitimately has
    // nothing left to remove — an earlier version of this guard failed the
    // build for succeeding twice.
    const left = readdirSync(pluginsDir).filter(name => !name.startsWith("index."));
    const unexpected = left.filter(name => !KEPT_PLUGIN_DIRS.includes(name));
    if (unexpected.length > 0) {
        fail(`src/plugins still contains ${unexpected.join(", ")} after pruning.`);
    }
    return `${left.join(", ")} (removed ${removed} this run)`;
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

    log(`3b/6 Removing the plugins we do not ship`);
    log(`     kept ${prunePlugins()}, removed the rest`);

    log("3c/6 Rebranding the settings section");
    log(`     ${brandSettings()}`);

    log("4/6  Installing Vencord's dependencies and building");
    pnpm(["install", "--frozen-lockfile"]);
    // --standalone: the bundle must not assume it sits in a git checkout, which
    //   a local build does.
    // --disable-updater: spec §6 gives Subline's own helper the job of shipping
    //   new builds. Vencord's built-in updater would replace the code behind our
    //   back, and the build id recorded in subline-patch.json would then name a
    //   build that is no longer installed — a healthy install reporting itself
    //   foreign, which is the exact failure the build id exists to prevent.
    pnpm(["build", "--standalone", "--disable-updater"]);

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
