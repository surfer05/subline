/**
 * Trigger B — "a new mod build is available" (spec §6, §10: GitHub Releases).
 *
 * ## Why this half of the helper is not optional
 *
 * Re-patching repairs a wiped injection. It does nothing at all for the other
 * failure: Discord ships a new frontend, Vencord's finders stop matching, and the
 * mod loads and renders nothing. That needs new CODE. A helper that only
 * re-patches means the product dies quietly the first time Discord rewrites its
 * frontend, with no error anywhere.
 *
 * ## What is verified, and what that does and does not prove
 *
 * The feed serves a small **release manifest** — not a bare download URL — which
 * names the artefact, its byte count and its SHA-256. The helper then downloads
 * the artefact and hashes it. So:
 *
 *  - **Protected:** a truncated or corrupted download, a proxy or CDN that
 *    serves the wrong bytes, a partially-uploaded asset, and an artefact swapped
 *    for a different *published* artefact (the digest is per-release).
 *  - **NOT protected:** anybody who can serve the MANIFEST can serve a matching
 *    digest for whatever they like. The checksum proves the artefact matches what
 *    the feed said, not that WE published it. Transport authenticity rests
 *    entirely on TLS to the feed host, which is why `assertTrustedUrl` refuses
 *    anything that is not HTTPS on an allowed host. A compromised release
 *    account, or a client that trusts a hostile CA, defeats it.
 *  - **Also not protected:** the bundle at rest. Anyone who can write to
 *    `~/Library/Application Support/Subline/mod/` can replace the artefacts and
 *    re-derive the bundle manifest, exactly as `bundling.md` concern 1 says. That
 *    is a local privilege boundary this module cannot move.
 *
 * **The shape is built for the fix rather than around it.** Verification is a
 * `ReleaseVerifier` — a named list, run in order, every one of which must pass.
 * Today the list is `[checksumVerifier]`. A detached signature becomes a second
 * entry plus a `signature` field that is already parsed and carried through here;
 * no caller and no manifest format changes. `REQUIRE_SIGNATURE` is the one-line
 * switch that makes an unsigned release refuse to install once there is a key to
 * check against.
 *
 * A structurally valid manifest is still not enough on its own: what is
 * downloaded is unpacked and handed to `inspectModBundle`, which independently
 * proves the bundle's own manifest matches its bytes and that the build id is
 * present in the renderer that will actually run. A release whose declared build
 * id disagrees with the bundle's is refused before anything is installed.
 */

import { createHash } from "node:crypto";

import type { Result } from "../patcher/result.js";
import { err, ok } from "../patcher/result.js";

export const RELEASE_MANIFEST_FORMAT = 1;

/**
 * Hosts a release may be served from. Not decoration: the manifest supplies the
 * artefact URL, so without this a compromised feed could redirect the download
 * anywhere. Kept as data so a mirror is a config change, not a code change.
 */
export const ALLOWED_RELEASE_HOSTS: readonly string[] = [
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com"
];

/**
 * Flip to `true` the day releases carry a detached signature and a public key
 * ships in the app. Until then it is documented as off rather than silently
 * absent — see the header for exactly what that costs.
 */
export const REQUIRE_SIGNATURE = false;

export interface ReleaseSignature {
    algorithm: string;
    keyId: string;
    /** Base64 detached signature over the canonical manifest bytes. */
    value: string;
}

export interface ReleaseArtifact {
    name: string;
    url: string;
    bytes: number;
    sha256: string;
}

export interface ReleaseManifest {
    format: number;
    product: "subline";
    /** The mod build id this release ships — compared against what is installed. */
    buildId: string;
    pluginVersion: string;
    publishedAt: string;
    artifact: ReleaseArtifact;
    /** Present when the release is signed. Parsed today, checked when there is a key. */
    signature: ReleaseSignature | null;
}

const BUILD_ID_PATTERN = /^[0-9a-f]{8,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function sha256Of(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Refuse a URL we are not willing to fetch from.
 *
 * Both halves matter. `https:` alone would let a hostile DNS answer serve a
 * matching digest for its own manifest; the host allow-list alone would let
 * `http://github.com/...` be intercepted outright.
 */
export function assertTrustedUrl(url: string, what: string): Result<URL> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return err<URL>("RELEASE_MALFORMED", `The ${what} URL is not a URL: ${url}`);
    }
    if (parsed.protocol !== "https:") {
        return err<URL>("RELEASE_UNVERIFIED", `The ${what} URL is not https, so it will not be fetched: ${url}`);
    }
    if (!ALLOWED_RELEASE_HOSTS.includes(parsed.hostname)) {
        return err<URL>(
            "RELEASE_UNVERIFIED",
            `The ${what} URL points at ${parsed.hostname}, which is not one of Subline's release hosts.`
        );
    }
    return ok(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a release manifest, or say precisely why not.
 *
 * Strict where the patcher's readers are lenient, and for the opposite reason:
 * a beacon is evidence we may fail to interpret, but this document decides which
 * code gets installed. A field we do not understand is a reason to install
 * nothing.
 */
export function parseReleaseManifest(text: string, source: string): Result<ReleaseManifest> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (cause) {
        return err<ReleaseManifest>("RELEASE_MALFORMED", "The release feed did not return readable JSON.", {
            path: source,
            cause
        });
    }
    if (!isRecord(parsed)) {
        return err<ReleaseManifest>("RELEASE_MALFORMED", "The release feed did not return an object.", {
            path: source
        });
    }
    if (parsed.product !== "subline") {
        return err<ReleaseManifest>("RELEASE_MALFORMED", "The release manifest is not one of ours.", { path: source });
    }
    if (parsed.format !== RELEASE_MANIFEST_FORMAT) {
        return err<ReleaseManifest>(
            "RELEASE_MALFORMED",
            `The release manifest is format ${String(parsed.format)}, and this helper understands ${RELEASE_MANIFEST_FORMAT}. Update Subline itself.`,
            { path: source }
        );
    }
    if (typeof parsed.buildId !== "string" || !BUILD_ID_PATTERN.test(parsed.buildId)) {
        // An id that cannot match a bundle's would make every comparison say
        // "new build available" forever, re-downloading on every run.
        return err<ReleaseManifest>("RELEASE_MALFORMED", "The release manifest has no usable build id.", {
            path: source
        });
    }

    const artifact = parsed.artifact;
    if (!isRecord(artifact)) {
        return err<ReleaseManifest>("RELEASE_MALFORMED", "The release manifest names no artefact.", { path: source });
    }
    if (typeof artifact.name !== "string" || artifact.name.length === 0) {
        return err<ReleaseManifest>("RELEASE_MALFORMED", "The release artefact has no name.", { path: source });
    }
    if (typeof artifact.url !== "string") {
        return err<ReleaseManifest>("RELEASE_MALFORMED", "The release artefact has no URL.", { path: source });
    }
    if (typeof artifact.sha256 !== "string" || !SHA256_PATTERN.test(artifact.sha256)) {
        // Refused rather than downloaded-and-hoped: an artefact with no usable
        // digest is one we have no way to check at all, and this is the only
        // check there is.
        return err<ReleaseManifest>(
            "RELEASE_MALFORMED",
            "The release artefact has no SHA-256, so nothing about the download could be verified.",
            { path: source }
        );
    }
    if (typeof artifact.bytes !== "number" || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
        return err<ReleaseManifest>("RELEASE_MALFORMED", "The release artefact has no usable byte count.", {
            path: source
        });
    }

    const trusted = assertTrustedUrl(artifact.url, "release artefact");
    if (!trusted.ok) return trusted as Result<ReleaseManifest>;

    const rawSignature = parsed.signature;
    const signature: ReleaseSignature | null =
        isRecord(rawSignature)
        && typeof rawSignature.algorithm === "string"
        && typeof rawSignature.keyId === "string"
        && typeof rawSignature.value === "string"
            ? { algorithm: rawSignature.algorithm, keyId: rawSignature.keyId, value: rawSignature.value }
            : null;

    if (REQUIRE_SIGNATURE && signature === null) {
        return err<ReleaseManifest>(
            "RELEASE_UNVERIFIED",
            "The release is not signed, and this build of Subline only installs signed releases.",
            { path: source }
        );
    }

    return ok({
        format: RELEASE_MANIFEST_FORMAT,
        product: "subline",
        buildId: parsed.buildId,
        pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : "unknown",
        publishedAt: typeof parsed.publishedAt === "string" ? parsed.publishedAt : "",
        artifact: {
            name: artifact.name,
            url: artifact.url,
            bytes: artifact.bytes,
            sha256: artifact.sha256
        },
        signature
    });
}

/**
 * One check a downloaded artefact must pass.
 *
 * A list rather than a boolean so that adding a signature check is adding an
 * entry — the call site, the manifest parser and the download path all stay as
 * they are. Every verifier in the list must pass; there is no "any of".
 */
export interface ReleaseVerifier {
    name: string;
    verify(input: { manifest: ReleaseManifest; bytes: Uint8Array }): Result<true>;
}

export const checksumVerifier: ReleaseVerifier = {
    name: "sha256",
    verify({ manifest, bytes }) {
        if (bytes.byteLength !== manifest.artifact.bytes) {
            // Named separately from the digest because the DIAGNOSIS differs:
            // "702 KB arrived as 12 KB" is a truncated download or an error page,
            // where a digest mismatch alone is indistinguishable from tampering.
            return err<true>(
                "RELEASE_UNVERIFIED",
                `${manifest.artifact.name} should be ${manifest.artifact.bytes} bytes but ${bytes.byteLength} arrived.`
            );
        }
        const digest = sha256Of(bytes);
        if (digest !== manifest.artifact.sha256) {
            return err<true>(
                "RELEASE_UNVERIFIED",
                `${manifest.artifact.name} does not match the checksum published with it (expected ${manifest.artifact.sha256}, got ${digest}).`
            );
        }
        return ok(true);
    }
};

/** The checks applied today. A signature verifier is appended here, not woven in. */
export const DEFAULT_VERIFIERS: readonly ReleaseVerifier[] = [checksumVerifier];

export interface VerifiedRelease {
    manifest: ReleaseManifest;
    bytes: Uint8Array;
    /** Which checks passed, by name — logged, so the record says what was proved. */
    verifiedBy: string[];
}

export function verifyDownload(
    manifest: ReleaseManifest,
    bytes: Uint8Array,
    verifiers: readonly ReleaseVerifier[] = DEFAULT_VERIFIERS
): Result<VerifiedRelease> {
    if (verifiers.length === 0) {
        // Refusing an empty list is what stops "verification" from becoming a
        // no-op the day somebody passes a filtered array.
        return err<VerifiedRelease>(
            "RELEASE_UNVERIFIED",
            "No verification was configured, so the download was not installed."
        );
    }
    const verifiedBy: string[] = [];
    for (const verifier of verifiers) {
        const result = verifier.verify({ manifest, bytes });
        if (!result.ok) return result as Result<VerifiedRelease>;
        verifiedBy.push(verifier.name);
    }
    return ok({ manifest, bytes, verifiedBy });
}

/** Is `manifest` offering something other than what is installed? */
export function isNewerBuild(manifest: ReleaseManifest, installedBuildId: string | null): boolean {
    // Compared by identity, never by ordering. Build ids are digests, so "newer"
    // is not a thing they can express — and a rolled-back release that we must
    // move BACK to is exactly as different as a forward one.
    return manifest.buildId !== installedBuildId;
}
