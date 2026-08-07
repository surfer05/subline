/**
 * Trigger B's front door: what the helper will and will not install.
 *
 * The manifest decides which code runs inside Discord's main process, so this
 * reader is deliberately strict where the beacon reader is lenient. A field it
 * does not understand is a reason to install nothing.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
    ALLOWED_RELEASE_HOSTS, assertTrustedUrl, checksumVerifier, DEFAULT_VERIFIERS, isNewerBuild,
    parseReleaseManifest, RELEASE_MANIFEST_FORMAT, sha256Of, verifyDownload
} from "../src/helper/release.js";
import type { ReleaseManifest, ReleaseVerifier } from "../src/helper/release.js";

const BYTES = new TextEncoder().encode("a plausible mod bundle archive");
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
const FEED = "https://github.com/subline/subline/releases/latest/download/subline-release.json";

function manifestDocument(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        format: RELEASE_MANIFEST_FORMAT,
        product: "subline",
        buildId: "1f2e3d4c5b6a7980",
        pluginVersion: "0.2.0",
        publishedAt: "2026-08-07T00:00:00.000Z",
        artifact: {
            name: "subline-mod.zip",
            url: "https://github.com/subline/subline/releases/download/v0.2.0/subline-mod.zip",
            bytes: BYTES.byteLength,
            sha256: DIGEST
        },
        ...overrides
    });
}

function parsed(overrides: Record<string, unknown> = {}): ReleaseManifest {
    const result = parseReleaseManifest(manifestDocument(overrides), FEED);
    if (!result.ok) throw new Error(`fixture manifest did not parse: ${result.error.message}`);
    return result.value;
}

describe("the release manifest", () => {
    it("reads a well-formed release", () => {
        const manifest = parsed();
        expect(manifest.buildId).toBe("1f2e3d4c5b6a7980");
        expect(manifest.pluginVersion).toBe("0.2.0");
        expect(manifest.artifact.sha256).toBe(DIGEST);
        expect(manifest.signature).toBeNull();
    });

    it("carries a detached signature through when one is present, ready to be checked", () => {
        const manifest = parsed({ signature: { algorithm: "ed25519", keyId: "subline-1", value: "AAAA" } });
        expect(manifest.signature).toEqual({ algorithm: "ed25519", keyId: "subline-1", value: "AAAA" });
    });

    it("refuses a document that is not readable JSON", () => {
        const result = parseReleaseManifest("{ not json", FEED);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("RELEASE_MALFORMED");
    });

    it("refuses a document that PARSES but is not an object", () => {
        for (const document of ["[1,2,3]", '"a string"', "42", "null"]) {
            const result = parseReleaseManifest(document, FEED);
            expect(result.ok).toBe(false);
        }
    });

    it("refuses somebody else's manifest", () => {
        const result = parseReleaseManifest(manifestDocument({ product: "something-else" }), FEED);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("not one of ours");
    });

    it("refuses a format it does not understand rather than best-guessing it", () => {
        const result = parseReleaseManifest(manifestDocument({ format: RELEASE_MANIFEST_FORMAT + 1 }), FEED);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("Update Subline itself");
    });

    it("refuses a build id that could never match a bundle's", () => {
        // An unusable id would compare unequal to everything forever, so the
        // helper would re-download on every single run.
        for (const buildId of ["", "not-hex", "1F2E3D4C5B6A7980", "abc", 42, null]) {
            const result = parseReleaseManifest(manifestDocument({ buildId }), FEED);
            expect(result.ok).toBe(false);
        }
    });

    it("refuses an artefact with no checksum, because that is the only check there is", () => {
        for (const overrides of [
            { artifact: { name: "a.zip", url: "https://github.com/x/a.zip", bytes: 10 } },
            { artifact: { name: "a.zip", url: "https://github.com/x/a.zip", bytes: 10, sha256: "short" } },
            { artifact: { name: "a.zip", url: "https://github.com/x/a.zip", bytes: 10, sha256: DIGEST.toUpperCase() } }
        ]) {
            const result = parseReleaseManifest(manifestDocument(overrides), FEED);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error.code).toBe("RELEASE_MALFORMED");
        }
    });

    it("refuses an artefact with no usable byte count", () => {
        for (const bytes of [0, -1, 1.5, "10", undefined]) {
            const result = parseReleaseManifest(
                manifestDocument({ artifact: { name: "a.zip", url: "https://github.com/x/a.zip", bytes, sha256: DIGEST } }),
                FEED
            );
            expect(result.ok).toBe(false);
        }
    });

    it("refuses an artefact URL that is not one we would fetch from", () => {
        for (const url of [
            "http://github.com/x/a.zip",
            "https://evil.example.com/a.zip",
            "file:///tmp/a.zip",
            "not a url"
        ]) {
            const result = parseReleaseManifest(
                manifestDocument({ artifact: { name: "a.zip", url, bytes: 10, sha256: DIGEST } }),
                FEED
            );
            expect(result.ok).toBe(false);
        }
    });
});

describe("which URLs are fetched at all", () => {
    it("accepts every host releases are actually served from", () => {
        for (const host of ALLOWED_RELEASE_HOSTS) {
            expect(assertTrustedUrl(`https://${host}/subline/mod.zip`, "release artefact").ok).toBe(true);
        }
    });

    it("refuses plain http even on an allowed host", () => {
        // Without TLS, the checksum proves only that the bytes match a manifest
        // an interceptor also supplied.
        const result = assertTrustedUrl("http://github.com/subline/mod.zip", "release artefact");
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("RELEASE_UNVERIFIED");
    });

    it("refuses https on a host that is not ours", () => {
        const result = assertTrustedUrl("https://github.com.evil.example/mod.zip", "release artefact");
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("not one of Subline's release hosts");
    });
});

describe("verifying a download", () => {
    it("accepts bytes that match the published checksum", () => {
        const result = verifyDownload(parsed(), BYTES);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.verifiedBy).toEqual(["sha256"]);
    });

    it("refuses bytes of the right length whose digest differs", () => {
        // Same length, different content: only the digest can catch this.
        const swapped = new TextEncoder().encode("A plausible mod bundle archive");
        expect(swapped.byteLength).toBe(BYTES.byteLength);

        const result = verifyDownload(parsed(), swapped);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("RELEASE_UNVERIFIED");
            expect(result.error.message).toContain("does not match the checksum");
        }
    });

    it("names the byte counts when a download arrives short, rather than only 'digest mismatch'", () => {
        // "702 KB arrived as 12 KB" is a truncated download or an error page;
        // "the digest does not match" is indistinguishable from tampering.
        const result = verifyDownload(parsed(), BYTES.slice(0, 4));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.message).toContain(String(BYTES.byteLength));
            expect(result.error.message).toContain("4 arrived");
        }
    });

    it("refuses an empty verifier list rather than treating it as 'everything passed'", () => {
        const result = verifyDownload(parsed(), BYTES, []);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("No verification was configured");
    });

    it("requires EVERY verifier to pass, so adding a signature check cannot be an 'any of'", () => {
        const refuse: ReleaseVerifier = {
            name: "signature",
            verify: () => ({ ok: false, error: { code: "RELEASE_UNVERIFIED", message: "no signature" } })
        };
        const result = verifyDownload(parsed(), BYTES, [checksumVerifier, refuse]);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("no signature");
    });

    it("records which checks were applied, so the log says what was proved", () => {
        const extra: ReleaseVerifier = { name: "signature", verify: () => ({ ok: true, value: true }) };
        const result = verifyDownload(parsed(), BYTES, [...DEFAULT_VERIFIERS, extra]);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.verifiedBy).toEqual(["sha256", "signature"]);
    });

    it("hashes the way the manifest says it does", () => {
        expect(sha256Of(BYTES)).toBe(DIGEST);
    });
});

describe("deciding whether a release is worth installing", () => {
    it("treats any different build id as something to install, in either direction", () => {
        // Build ids are digests, so "newer" is not something they can express —
        // and a release that ROLLS BACK to a previous build must still be applied.
        expect(isNewerBuild(parsed(), "0011223344556677")).toBe(true);
        expect(isNewerBuild(parsed(), null)).toBe(true);
        expect(isNewerBuild(parsed(), "1f2e3d4c5b6a7980")).toBe(false);
    });
});
