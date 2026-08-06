/**
 * What a shippable mod bundle IS — the single definition, shared by the thing
 * that builds one and the thing that installs one.
 *
 * WHY THIS FILE IMPORTS NOTHING OF OURS. `scripts/buildMod.mjs` loads this
 * module directly (Node strips the types), so that the checks the build runs
 * and the checks the patcher runs are the SAME CODE rather than two lists of
 * rules that agree today. Node's type stripping does not resolve `./x.js` onto
 * `x.ts`, so every import here is a Node builtin and every result is a plain
 * object. `bundle.ts` is the thin layer that wraps these into `Result`s.
 *
 * WHY VERIFICATION EXISTS AT ALL. "A directory of files proves nothing" is the
 * lesson this project keeps relearning: a week was lost to an install that was
 * present, verified, and completely inert. So a bundle is not "a folder that
 * exists" — it is a folder whose entry points are present AND non-trivial AND
 * byte-for-byte what the manifest says AND whose compiled renderer literally
 * contains the build id the manifest claims. That last check is the one that
 * makes the recorded identity and the shipped code incapable of disagreeing:
 * the id is not asserted by whoever packaged it, it is read back out of the
 * bytes that will run.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The manifest the build writes beside the artefacts. */
export const MOD_MANIFEST_FILENAME = "subline-mod.json";

/** 1 — first shipped format. */
export const MOD_MANIFEST_FORMAT = 1;

/**
 * What the Discord stub `require()`s. It is Vencord's own main-process entry,
 * and it resolves `preload.js` / `renderer.js` / `renderer.css` relative to
 * ITSELF — which is why those three are required here too: a bundle missing any
 * of them loads and then does nothing, the exact failure this project keeps
 * hitting.
 */
export const LOADER_ENTRY_NAME = "patcher.js";

/**
 * The artefact the plugin's `BUILD_ID` is compiled into.
 *
 * `statusBeacon.ts` runs in the renderer, so esbuild inlines the stamp there
 * and nowhere else — the main-process bundle only ever validates a beacon
 * someone else wrote and states no identity of its own.
 */
export const STAMPED_ENTRY_NAME = "renderer.js";

/**
 * Attribution and the GPL-3.0 offer of corresponding source, written by the
 * build. Required, not optional: we redistribute Vencord's build output, so the
 * notice naming the exact upstream commit is part of what makes the bundle
 * shippable. A gate fails loudly; a promise goes stale.
 */
export const SOURCE_NOTICE_NAME = "SOURCE.txt";

/**
 * Every file the bundle must contain, with the size below which it is not a
 * real artefact.
 *
 * The floors are an order of magnitude under the real build (patcher 52 KB,
 * preload 2.4 KB, renderer 760 KB, renderer.css 42 KB as of Vencord 1.15.0), so
 * they catch a truncated, empty or placeholder file without breaking every time
 * upstream trims a few bytes.
 */
export const REQUIRED_ENTRIES: readonly { name: string; minBytes: number }[] = [
    { name: LOADER_ENTRY_NAME, minBytes: 8_192 },
    { name: "preload.js", minBytes: 512 },
    { name: STAMPED_ENTRY_NAME, minBytes: 65_536 },
    { name: "renderer.css", minBytes: 4_096 },
    { name: SOURCE_NOTICE_NAME, minBytes: 128 }
];

/** A build id is a hex digest — see the plugin's `buildStamp.ts`. */
export const BUILD_ID_PATTERN = /^[0-9a-f]{8,64}$/;

/** A full git object id. Nothing shorter is a pin. */
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export interface ModEntryDigest {
    bytes: number;
    sha256: string;
}

export interface VencordProvenance {
    /** Clone URL of the upstream we built. */
    repository: string;
    /** The exact commit, which is what makes the GPL "corresponding source" answerable. */
    commit: string;
    /** Upstream's own `package.json` version, for humans. */
    version: string;
}

export interface ModManifest {
    format: number;
    product: "subline";
    /** The plugin build id — the same value `buildStamp.ts` compiles into the bundle. */
    buildId: string;
    pluginVersion: string;
    vencord: VencordProvenance;
    builtAt: string;
    /** Every shipped file, so a truncated or swapped artefact is detectable. */
    entries: Record<string, ModEntryDigest>;
}

export function manifestPathFor(bundleDir: string): string {
    return join(bundleDir, MOD_MANIFEST_FILENAME);
}

export function loaderPathFor(bundleDir: string): string {
    return join(bundleDir, LOADER_ENTRY_NAME);
}

export function sha256File(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Measure and digest every required entry — what the build records in the manifest. */
export function digestEntries(bundleDir: string): Record<string, ModEntryDigest> {
    const entries: Record<string, ModEntryDigest> = {};
    for (const { name } of REQUIRED_ENTRIES) {
        const path = join(bundleDir, name);
        entries[name] = { bytes: statSync(path).size, sha256: sha256File(path) };
    }
    return entries;
}

export function renderManifest(manifest: ModManifest): string {
    return `${JSON.stringify(manifest, null, 4)}\n`;
}

function isDigest(value: unknown): value is ModEntryDigest {
    if (value === null || typeof value !== "object") return false;
    const raw = value as Record<string, unknown>;
    return (
        typeof raw.bytes === "number"
        && Number.isSafeInteger(raw.bytes)
        && raw.bytes >= 0
        && typeof raw.sha256 === "string"
        && /^[0-9a-f]{64}$/.test(raw.sha256)
    );
}

export interface ParsedManifest {
    manifest: ModManifest | null;
    /** Why it is not usable, when it is not. */
    problem: string | null;
}

/**
 * Validate a manifest document.
 *
 * Validated rather than deserialised, for the same reason the beacon is: it is
 * a file on disk that decides which build the installer will claim to have
 * installed. A field this reader merely copied would be a field an editor could
 * use to make the installer lie about itself.
 */
export function parseManifest(text: string): ParsedManifest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { manifest: null, problem: `${MOD_MANIFEST_FILENAME} is not readable JSON.` };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { manifest: null, problem: `${MOD_MANIFEST_FILENAME} is not a JSON object.` };
    }
    const raw = parsed as Record<string, unknown>;

    if (raw.product !== "subline") {
        return { manifest: null, problem: `${MOD_MANIFEST_FILENAME} was not written by Subline.` };
    }
    if (raw.format !== MOD_MANIFEST_FORMAT) {
        return {
            manifest: null,
            problem: `${MOD_MANIFEST_FILENAME} is format ${String(raw.format)}, and this installer understands ${MOD_MANIFEST_FORMAT}.`
        };
    }
    if (typeof raw.buildId !== "string" || !BUILD_ID_PATTERN.test(raw.buildId)) {
        return {
            manifest: null,
            problem: `${MOD_MANIFEST_FILENAME} does not record a usable build id.`
        };
    }
    if (typeof raw.pluginVersion !== "string" || raw.pluginVersion.length === 0) {
        return { manifest: null, problem: `${MOD_MANIFEST_FILENAME} does not record a plugin version.` };
    }

    const vencord = (raw.vencord ?? null) as Record<string, unknown> | null;
    if (
        vencord === null
        || typeof vencord !== "object"
        || typeof vencord.commit !== "string"
        || !COMMIT_PATTERN.test(vencord.commit)
        || typeof vencord.repository !== "string"
        || vencord.repository.length === 0
    ) {
        // Spec §6 turns "which Vencord are we shipping" into an operational
        // question the moment Discord changes its frontend, and GPL-3.0 turns it
        // into a legal one the moment we hand someone the build output. A bundle
        // that cannot answer it is not shippable.
        return {
            manifest: null,
            problem: `${MOD_MANIFEST_FILENAME} does not pin the Vencord commit it was built from.`
        };
    }

    const rawEntries = (raw.entries ?? null) as Record<string, unknown> | null;
    if (rawEntries === null || typeof rawEntries !== "object" || Array.isArray(rawEntries)) {
        return { manifest: null, problem: `${MOD_MANIFEST_FILENAME} lists no file digests.` };
    }
    const entries: Record<string, ModEntryDigest> = {};
    for (const [name, value] of Object.entries(rawEntries)) {
        if (!isDigest(value)) {
            return { manifest: null, problem: `${MOD_MANIFEST_FILENAME} has no usable digest for ${name}.` };
        }
        entries[name] = { bytes: value.bytes, sha256: value.sha256 };
    }

    return {
        manifest: {
            format: MOD_MANIFEST_FORMAT,
            product: "subline",
            buildId: raw.buildId,
            pluginVersion: raw.pluginVersion,
            vencord: {
                repository: vencord.repository,
                commit: vencord.commit,
                version: typeof vencord.version === "string" ? vencord.version : "unknown"
            },
            builtAt: typeof raw.builtAt === "string" ? raw.builtAt : "",
            entries
        },
        problem: null
    };
}

export interface BundleFacts {
    /** The manifest, when it is usable. */
    manifest: ModManifest | null;
    /** What the stub would `require()`. */
    loaderPath: string;
    /** Everything wrong with this directory, most fundamental first. */
    problems: string[];
}

/**
 * Is this directory a usable mod bundle?
 *
 * Stops at the first problem that makes the rest meaningless (no manifest means
 * no expected digests and no id to look for), but otherwise collects everything
 * so a broken build reports all of it at once instead of one round per file.
 */
export function inspectBundleDir(bundleDir: string): BundleFacts {
    const loaderPath = loaderPathFor(bundleDir);
    const manifestPath = manifestPathFor(bundleDir);

    if (!existsSync(manifestPath)) {
        return {
            manifest: null,
            loaderPath,
            problems: [`${bundleDir} has no ${MOD_MANIFEST_FILENAME}, so it is not a Subline mod bundle.`]
        };
    }

    let text: string;
    try {
        text = readFileSync(manifestPath, "utf8");
    } catch (cause) {
        return {
            manifest: null,
            loaderPath,
            problems: [`${MOD_MANIFEST_FILENAME} could not be read (${String(cause)}).`]
        };
    }

    const { manifest, problem } = parseManifest(text);
    if (manifest === null) return { manifest: null, loaderPath, problems: [problem ?? "unknown"] };

    const problems: string[] = [];

    for (const { name, minBytes } of REQUIRED_ENTRIES) {
        const path = join(bundleDir, name);
        if (!existsSync(path)) {
            problems.push(`${name} is missing from the mod bundle.`);
            continue;
        }

        let size: number;
        try {
            size = statSync(path).size;
        } catch (cause) {
            problems.push(`${name} could not be read (${String(cause)}).`);
            continue;
        }
        if (size < minBytes) {
            // A zero-byte or stub artefact is the shape a half-finished build
            // leaves behind, and it installs perfectly.
            problems.push(`${name} is ${size} bytes, too small to be a real build artefact.`);
            continue;
        }

        const digest = manifest.entries[name];
        if (digest === undefined) {
            problems.push(`${MOD_MANIFEST_FILENAME} does not record ${name}.`);
            continue;
        }
        if (digest.bytes !== size) {
            problems.push(`${name} is ${size} bytes but the manifest records ${digest.bytes}.`);
            continue;
        }
        if (sha256File(path) !== digest.sha256) {
            problems.push(`${name} does not match the digest in ${MOD_MANIFEST_FILENAME}.`);
        }
    }

    // THE CHECK THAT CLOSES THE HOLE. Everything above proves the bundle is
    // intact; only this proves it is the build the manifest NAMES. Without it
    // the installer would still be asserting an identity rather than observing
    // one, and a correct bundle carrying a stale recorded id would report a
    // working install as dead.
    const stampedPath = join(bundleDir, STAMPED_ENTRY_NAME);
    if (existsSync(stampedPath)) {
        let carriesStamp: boolean;
        try {
            carriesStamp = readFileSync(stampedPath).includes(manifest.buildId, 0, "utf8");
        } catch (cause) {
            carriesStamp = false;
            problems.push(`${STAMPED_ENTRY_NAME} could not be read (${String(cause)}).`);
        }
        if (!carriesStamp) {
            problems.push(
                `${STAMPED_ENTRY_NAME} does not contain build id ${manifest.buildId}, so ${MOD_MANIFEST_FILENAME} `
                + "names a different build from the one in this bundle."
            );
        }
    }

    return { manifest, loaderPath, problems };
}
