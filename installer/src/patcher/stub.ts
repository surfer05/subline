/**
 * The two-file stub archive that replaces Discord's `app.asar`.
 *
 * Reproduced byte-for-byte in *form* from the live Vencord-patched install on
 * this machine (`/Applications/Discord.app/Contents/Resources/app.asar`,
 * 199 bytes):
 *
 *   index.js      require("/Users/surfer/dev/Vencord/dist/patcher.js")   (52 B, no trailing newline)
 *   package.json  {\n\t"name": "discord",\n\t"main": "index.js"\n}       (43 B)
 *
 * Entry order matters only for byte-identity, not for Electron, but we keep
 * index.js first exactly as the real one has it.
 *
 * We deliberately do NOT add a marker comment to index.js. Electron's loader
 * is not the only thing that reads this file — keeping it to the single
 * `require()` call is the shape every existing tool expects. Ownership is
 * recorded in a sidecar marker file instead (see marker.ts).
 */

import { buildAsar, readAsarDirectory, readAsarFiles } from "./asar.js";
import type { Result } from "./result.js";
import { ok } from "./result.js";

export const STUB_INDEX_NAME = "index.js";
export const STUB_PACKAGE_NAME = "package.json";

/** Exactly what the real patched install contains, tabs and newlines included. */
export const STUB_PACKAGE_JSON = '{\n\t"name": "discord",\n\t"main": "index.js"\n}';

/** A stub is tiny; anything much bigger is Discord's real archive. */
export const MAX_STUB_BYTES = 64 * 1024;

export function stubIndexSource(loaderPath: string): string {
    return `require(${JSON.stringify(loaderPath)})`;
}

export function buildStubAsar(loaderPath: string): Buffer {
    return buildAsar([
        { name: STUB_INDEX_NAME, content: Buffer.from(stubIndexSource(loaderPath), "utf8") },
        { name: STUB_PACKAGE_NAME, content: Buffer.from(STUB_PACKAGE_JSON, "utf8") }
    ]);
}

export interface StubContents {
    indexSource: string;
    packageJson: string;
    /** The absolute path the stub `require()`s, if it is a plain single require. */
    loaderPath: string | null;
}

/** `require("…")` or `require('…')`, optionally with a trailing semicolon/newline. */
const REQUIRE_RE = /^\s*require\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)\s*;?\s*$/;

export function parseRequirePath(indexSource: string): string | null {
    const match = REQUIRE_RE.exec(indexSource);
    if (!match) return null;
    const quote = match[1]!;
    const raw = match[2]!;
    if (quote === '"') {
        // Our own stub is JSON.stringify output, so JSON.parse round-trips it.
        try {
            return JSON.parse(`"${raw}"`) as string;
        } catch {
            return null;
        }
    }
    // Single-quoted (other tools do this): undo only the escapes a path can carry.
    return raw.replace(/\\(['\\])/g, "$1");
}

/**
 * Read an `app.asar` as a loader stub. Returns `null` (not an error) when the
 * archive is a real Discord asar rather than a stub, so callers can tell
 * "unpatched" apart from "unreadable".
 */
export function readStub(asarPath: string): Result<StubContents | null> {
    const dir = readAsarDirectory(asarPath);
    if (!dir.ok) return dir;

    const names = new Set(dir.value.names);
    const isStubShape =
        names.size === 2 && names.has(STUB_INDEX_NAME) && names.has(STUB_PACKAGE_NAME);
    if (!isStubShape) return ok(null);

    const totalSize = dir.value.files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > MAX_STUB_BYTES) return ok(null);

    const contents = readAsarFiles(asarPath, dir.value, [STUB_INDEX_NAME, STUB_PACKAGE_NAME], MAX_STUB_BYTES);
    if (!contents.ok) return contents;

    const indexSource = contents.value.get(STUB_INDEX_NAME)!.toString("utf8");
    const packageJson = contents.value.get(STUB_PACKAGE_NAME)!.toString("utf8");
    return ok({ indexSource, packageJson, loaderPath: parseRequirePath(indexSource) });
}

/** True when the archive at `asarPath` is Discord's own (not a loader stub). */
export function readIsOriginalAsar(asarPath: string): Result<boolean> {
    const stub = readStub(asarPath);
    if (!stub.ok) return stub;
    return ok(stub.value === null);
}
