/**
 * The check that stops us shipping a bundle whose identity lies.
 *
 * ## The failure this exists to prevent
 *
 * `build/mod` is a build OUTPUT, and it is gitignored. It survives across
 * branches, rebases and plugin edits. So this is not a hypothetical:
 *
 *   1. `pnpm build:mod` produces a bundle stamped `abc123…`.
 *   2. Somebody edits `src/userplugins/vcTranslate/index.tsx` and runs
 *      `pnpm stamp`, which is now `def456…`.
 *   3. Nobody re-runs `pnpm build:mod`.
 *   4. `electron-builder` copies `build/mod` into the app.
 *
 * The shipped app now installs a bundle whose manifest, whose compiled
 * `renderer.js` and whose beacon all say `abc123…`, while the repository that
 * produced the release says `def456…`. Every internal check passes — the bundle
 * is self-consistent, it is just not the build we think we released. `bundling.md`
 * and `status-beacon.md` both rest on "the recorded identity and the shipped code
 * cannot disagree"; this is the one seam where they could, because it is the only
 * point where the repository and a stale artefact meet.
 *
 * `buildMod.mjs` already refuses to build from a stale stamp. That covers the
 * bundle it produces. It cannot cover the bundle that is already sitting there
 * when packaging starts, and packaging is the step that turns a directory into
 * something a stranger installs.
 *
 * ## Why it imports nothing of ours
 *
 * Same reason `src/bundle/spec.ts` does: `packaging/hooks.mjs` is loaded by
 * electron-builder through a raw `import()`, with no bundler and no compiler, and
 * Node's type stripping does not resolve `./x.js` onto `x.ts`. So the inspection
 * itself arrives as a parameter — the caller passes `inspectBundleDir`, which is
 * the SAME function `patchInstall` runs at install time. There are not two ideas
 * of what a valid bundle is.
 */

/** The part of `BundleFacts` this check needs. Structural, so `inspectBundleDir` fits it as-is. */
export interface BundleInspection {
    manifest: { buildId: string; pluginVersion: string } | null;
    problems: readonly string[];
}

export interface BundleIdentityReport {
    bundleDir: string;
    /** What the bundle says it is, when it says anything usable. */
    buildId: string | null;
    pluginVersion: string | null;
    expectedBuildId: string;
    /** True only when the bundle is valid AND its id is the one the repository produces. */
    agrees: boolean;
    /** Everything wrong, most fundamental first. Empty exactly when `agrees`. */
    problems: string[];
}

export interface CheckBundleIdentityOptions {
    bundleDir: string;
    /** `computeStamp().buildId` — the id the checked-in plugin sources produce right now. */
    expectedBuildId: string;
    /** `computeStamp().version`. Optional: a version mismatch is a weaker signal than an id mismatch. */
    expectedPluginVersion?: string | null;
    /** `inspectBundleDir` from `src/bundle/spec.ts`. Injected; see the header. */
    inspect: (dir: string) => BundleInspection;
}

export function checkBundleIdentity(options: CheckBundleIdentityOptions): BundleIdentityReport {
    const { bundleDir, expectedBuildId, inspect } = options;
    const expectedPluginVersion = options.expectedPluginVersion ?? null;

    let facts: BundleInspection;
    try {
        facts = inspect(bundleDir);
    } catch (cause) {
        // A throwing inspector is a broken packaging environment, not a bundle
        // verdict, and it must not read as "the bundle is fine".
        return {
            bundleDir,
            buildId: null,
            pluginVersion: null,
            expectedBuildId,
            agrees: false,
            problems: [`the mod bundle at ${bundleDir} could not be inspected (${String(cause)}).`]
        };
    }

    const problems: string[] = [...facts.problems];

    if (facts.manifest === null) {
        if (problems.length === 0) problems.push(`${bundleDir} is not a Subline mod bundle.`);
        return { bundleDir, buildId: null, pluginVersion: null, expectedBuildId, agrees: false, problems };
    }

    const { buildId, pluginVersion } = facts.manifest;

    if (buildId !== expectedBuildId) {
        problems.push(
            `the mod bundle at ${bundleDir} is build ${buildId}, but the plugin sources in this checkout `
            + `produce ${expectedBuildId}. Shipping it would put a build id in subline-patch.json that no `
            + "committed source produces. Run `pnpm build:mod` and package again."
        );
    }

    if (expectedPluginVersion !== null && pluginVersion !== expectedPluginVersion) {
        problems.push(
            `the mod bundle at ${bundleDir} says plugin version ${pluginVersion}, but this checkout is `
            + `${expectedPluginVersion}.`
        );
    }

    return { bundleDir, buildId, pluginVersion, expectedBuildId, agrees: problems.length === 0, problems };
}

/**
 * The same check, as a hard stop.
 *
 * Packaging hooks signal failure by throwing — electron-builder aborts the build
 * and prints the message. A returned `false` nobody reads is how a bundle whose
 * identity lies gets shipped anyway.
 */
export function assertBundleIdentity(options: CheckBundleIdentityOptions): BundleIdentityReport {
    const report = checkBundleIdentity(options);
    if (!report.agrees) {
        throw new Error(
            `Subline will not package this build.\n  ${report.problems.join("\n  ")}\n`
        );
    }
    return report;
}

/** Where the mod bundle ends up inside a packed app, per `extraResources`. */
export const PACKAGED_MOD_DIR_NAME = "mod";

/**
 * `Contents/Resources` on macOS, `resources` everywhere else.
 *
 * Checked rather than assumed because `afterPack` is the only place the bundle's
 * arrival can be OBSERVED. Everything before it is a promise made by the
 * configuration, and this project's recurring failure is a configuration that
 * looked right and produced nothing.
 */
export function packagedResourcesDir(options: {
    electronPlatformName: string;
    appOutDir: string;
    productName: string;
    separator?: string;
}): string {
    const separator = options.separator ?? "/";
    const parts = options.electronPlatformName === "darwin"
        ? [options.appOutDir, `${options.productName}.app`, "Contents", "Resources"]
        : [options.appOutDir, "resources"];
    return parts.join(separator);
}

export function packagedModDir(options: {
    electronPlatformName: string;
    appOutDir: string;
    productName: string;
    separator?: string;
}): string {
    return [packagedResourcesDir(options), PACKAGED_MOD_DIR_NAME].join(options.separator ?? "/");
}
