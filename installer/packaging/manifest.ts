/**
 * The release manifest and the checksum file — the two documents a release IS,
 * as far as an installed copy of Subline is concerned.
 *
 * ## What the manifest is for
 *
 * `src/helper/release.ts` is the reader. Its header states what the document
 * proves and what it does not; this module is the writer, and it exists so the
 * two are produced by one pipeline rather than by hand at 2am. Everything about
 * the shape lives there — `parseReleaseManifest` is strict, and the tests here
 * round-trip through it rather than re-stating its rules, so a change to the
 * format breaks the writer instead of quietly shipping a document nothing
 * accepts.
 *
 * ## Where it lives (spec §10: GitHub Releases)
 *
 * Two URLs, both on `github.com`, which is why `ALLOWED_RELEASE_HOSTS` starts
 * there:
 *
 *   feed      https://github.com/<owner>/<repo>/releases/latest/download/subline-release.json
 *   artefact  https://github.com/<owner>/<repo>/releases/download/<tag>/<name>
 *
 * The feed URL is the load-bearing one. `/releases/latest/download/<asset>` is a
 * GitHub redirect that always resolves to the newest published release's asset of
 * that name, so the URL compiled into a shipped app never has to change and a
 * release is published rather than deployed. The redirect lands on
 * `objects.githubusercontent.com` / `release-assets.githubusercontent.com`, both
 * already on the allow-list, which is the only reason `redirect: "follow"` in
 * `helper/ports.ts` is safe.
 *
 * ## What the ARTEFACT is
 *
 * The mod bundle, not the app. Trigger B ships new plugin/Vencord code to an
 * already-installed Subline (spec §6); the app itself updates by the user
 * downloading a new DMG. So the release carries both, and only the mod bundle is
 * named by the manifest.
 *
 * ## Imports nothing of ours
 *
 * `scripts/release.mjs` loads this through raw Node, so — as in
 * `src/bundle/spec.ts` — every import is a builtin.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

/**
 * Must equal `RELEASE_MANIFEST_FORMAT` in `src/helper/release.ts`.
 *
 * Restated rather than imported because that module imports our `Result` helpers
 * and therefore cannot be loaded by the raw-Node build scripts. `manifest.test.ts`
 * asserts the two are equal AND round-trips a generated manifest through
 * `parseReleaseManifest`, so a bump on one side fails the suite rather than
 * shipping a document the shipped helper refuses.
 */
export const RELEASE_MANIFEST_FORMAT_WRITTEN = 1;

/** The asset name the feed URL resolves to. Fixed: a shipped app looks for this name. */
export const RELEASE_MANIFEST_ASSET_NAME = "subline-release.json";

/** `shasum -a 256 -c SHA256SUMS` — every artefact in the release, for a human to check. */
export const CHECKSUMS_ASSET_NAME = "SHA256SUMS";

export interface Repository {
    owner: string;
    name: string;
}

/**
 * Accept `owner/name`, an https clone URL, or an ssh one.
 *
 * Strict about the result: an owner or name containing a slash would silently
 * produce a URL pointing at a different repository, and the artefact URL is
 * something the helper will download and execute.
 */
export function parseRepository(spec: string): Repository {
    const trimmed = spec.trim().replace(/\.git$/, "");
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)?([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
    if (match === null) {
        throw new Error(`"${spec}" is not a GitHub repository ("owner/name" or an https/ssh GitHub URL).`);
    }
    return { owner: match[1] as string, name: match[2] as string };
}

export function releaseTagFor(version: string): string {
    return version.startsWith("v") ? version : `v${version}`;
}

/** `subline-mod-<buildId>.zip` — the build id is in the NAME so a stale asset is visible. */
export function modArtifactName(buildId: string): string {
    return `subline-mod-${buildId}.zip`;
}

function repoPath(repository: Repository): string {
    return `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

export function releaseAssetUrl(repository: Repository, tag: string, name: string): string {
    return `https://github.com/${repoPath(repository)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/**
 * The URL a shipped app polls. Deliberately has no tag in it: see the header.
 */
export function releaseFeedUrl(repository: Repository): string {
    return `https://github.com/${repoPath(repository)}/releases/latest/download/${RELEASE_MANIFEST_ASSET_NAME}`;
}

export interface FileDigest {
    name: string;
    bytes: number;
    sha256: string;
}

export function sha256OfFile(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function digestFile(path: string): FileDigest {
    return { name: basename(path), bytes: statSync(path).size, sha256: sha256OfFile(path) };
}

export interface BuildReleaseManifestOptions {
    repository: Repository;
    tag: string;
    /** The mod bundle's build id — must be the one inside the artefact. */
    buildId: string;
    pluginVersion: string;
    artifact: FileDigest;
    publishedAt: string;
    /** Absent until there is a key to sign with; `REQUIRE_SIGNATURE` in `release.ts` is the switch. */
    signature?: { algorithm: string; keyId: string; value: string } | null;
}

export interface ReleaseManifestDocument {
    format: number;
    product: "subline";
    buildId: string;
    pluginVersion: string;
    publishedAt: string;
    artifact: { name: string; url: string; bytes: number; sha256: string };
    signature: { algorithm: string; keyId: string; value: string } | null;
}

export function buildReleaseManifest(options: BuildReleaseManifestOptions): ReleaseManifestDocument {
    const { repository, tag, artifact } = options;
    if (artifact.bytes <= 0) {
        // `parseReleaseManifest` refuses this anyway; failing here names the real
        // cause ("the zip step produced nothing") instead of "malformed manifest".
        throw new Error(`${artifact.name} is ${artifact.bytes} bytes — there is nothing to release.`);
    }
    return {
        format: RELEASE_MANIFEST_FORMAT_WRITTEN,
        product: "subline",
        buildId: options.buildId,
        pluginVersion: options.pluginVersion,
        publishedAt: options.publishedAt,
        artifact: {
            name: artifact.name,
            url: releaseAssetUrl(repository, tag, artifact.name),
            bytes: artifact.bytes,
            sha256: artifact.sha256
        },
        signature: options.signature ?? null
    };
}

export function renderReleaseManifest(manifest: ReleaseManifestDocument): string {
    return `${JSON.stringify(manifest, null, 4)}\n`;
}

/**
 * `SHA256SUMS`, in the format `shasum -a 256 -c` reads.
 *
 * Two spaces between digest and name, and never a path — a checksum file whose
 * names carry the build machine's directory layout cannot be checked by anyone
 * who downloaded the assets.
 */
export function renderChecksums(digests: readonly FileDigest[]): string {
    if (digests.length === 0) throw new Error("A release with no artefacts has nothing to checksum.");
    return `${[...digests]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(digest => `${digest.sha256}  ${digest.name}`)
        .join("\n")}\n`;
}
