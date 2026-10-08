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
import { err, ok } from "./result.js";

export const STUB_INDEX_NAME = "index.js";
export const STUB_PACKAGE_NAME = "package.json";

/** Exactly what the real patched install contains, tabs and newlines included. */
export const STUB_PACKAGE_JSON = '{\n\t"name": "discord",\n\t"main": "index.js"\n}';

/** A stub is tiny; anything much bigger is Discord's real archive. */
export const MAX_STUB_BYTES = 64 * 1024;

/**
 * The stub's index.js. FAIL-OPEN: it loads Subline only when this user can
 * read the loader, and otherwise boots Discord's own archive (`_app.asar`,
 * which sits beside it in Resources and every user can read) exactly the way
 * Vencord's patcher.js does: point require.main and the app path at it, then
 * require its main script.
 *
 * Why: the old one-line `require("<loader>")` threw when the loader could not
 * be read, and Discord did not start at all. Two accounts on one Mac (the
 * loader is in the other account's private home folder), a bundle deleted or
 * left aside by a failed update: each one was a Discord that would not open.
 * Now the worst case is Discord without translation, which the helper repairs.
 *
 * The loader path is the first statement (`const L=<json>;`), so it parses
 * back without running anything (parseRequirePath).
 *
 * IS THIS STUB DISCORD'S ENTRY POINT? Electron loads the app's main script
 * with `Module._load(main, Module, true)` (the `true` is isMain; read out of
 * the Electron 33.4.11 binary: `i._load(s.join(c,f),i,!0)`), which makes
 * `require.main === module` here. Vencord's own patcher.js relies on the same
 * thing (it sets require.main.filename). The check exists for one case only:
 * another mod's resources/app in front of us, which require()s app.asar from
 * its own module (audit #9); then Discord's own code must load, not the
 * loader. So the check is widened in the SAFE direction: any sign that we are
 * the entry (require.main is us, is missing, has our filename, or no user
 * module required us: Electron passes the Module constructor as the parent,
 * which has no filename) loads Subline. Only a real module that required us
 * (a filename on module.parent) and is not us means "someone is in front".
 * If the isMain check were ever wrong, Subline still loads instead of Discord
 * silently starting without it. Every use of require.main also tolerates it
 * being missing.
 */
export function stubIndexSource(loaderPath: string): string {
    return `const L=${JSON.stringify(loaderPath)};`
        + "const f=require(\"fs\");let ok=false;try{f.accessSync(L,f.constants.R_OK);ok=true}catch{}"
        + "const r=require.main,q=module.parent,"
        + "top=r===module||!r||r.filename===__filename||!(q&&typeof q.filename===\"string\");"
        + "const b=()=>{const p=require(\"path\"),a=p.join(__dirname,\"..\",\"_app.asar\"),"
        + "m=p.join(a,require(p.join(a,\"package.json\")).main);if(require.main)require.main.filename=m;"
        + "require(\"electron\").app.setAppPath(a);require(m)};"
        + "if(ok&&top){try{require(L)}catch(e){if(require.main&&require.main.filename!==__filename)throw e;"
        + "console.error(\"[Subline] loader failed\",e);b()}}else{b()}";
}

/**
 * The stub of the first 0.2.3 builds (owner dogfood only): the same, with a
 * bare `require.main===module` check. Still ours, still verifies; rewritten
 * when Discord is closed, like any older form.
 */
export function interimStubIndexSource(loaderPath: string): string {
    return `const L=${JSON.stringify(loaderPath)};`
        + "const f=require(\"fs\");let ok=false;try{f.accessSync(L,f.constants.R_OK);ok=true}catch{}"
        + "const b=()=>{const p=require(\"path\"),a=p.join(__dirname,\"..\",\"_app.asar\"),"
        + "m=p.join(a,require(p.join(a,\"package.json\")).main);require.main.filename=m;"
        + "require(\"electron\").app.setAppPath(a);require(m)};"
        + "if(ok&&require.main===module){try{require(L)}catch(e){if(require.main.filename!==__filename)throw e;"
        + "console.error(\"[Subline] loader failed\",e);b()}}else{b()}";
}

/**
 * The 0.2.1 and 0.2.2 fail-open stub. It guarded only a loader it could not
 * read: a loader that threw (truncated, a syntax error) stopped Discord, and
 * with another mod (BetterDiscord) in front it required itself in a circle.
 * Still ours, still verifies; rewritten when Discord is closed.
 */
export function previousStubIndexSource(loaderPath: string): string {
    return `const L=${JSON.stringify(loaderPath)};`
        + "const f=require(\"fs\");let ok=false;try{f.accessSync(L,f.constants.R_OK);ok=true}catch{}"
        + "if(ok){require(L)}else{const p=require(\"path\"),a=p.join(__dirname,\"..\",\"_app.asar\"),"
        + "m=p.join(a,require(p.join(a,\"package.json\")).main);require.main.filename=m;"
        + "require(\"electron\").app.setAppPath(a);require(m)}";
}

/** The pre-0.2.1 stub: a bare require. Still recognised, so existing installs verify. */
export function legacyStubIndexSource(loaderPath: string): string {
    return `require(${JSON.stringify(loaderPath)})`;
}

/** `indexSource` is injectable so the format can be checked against the real Vencord-written archive. */
export function buildStubAsar(loaderPath: string, indexSource: (loaderPath: string) => string = stubIndexSource): Buffer {
    return buildAsar([
        { name: STUB_INDEX_NAME, content: Buffer.from(indexSource(loaderPath), "utf8") },
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

/** Subline's fail-open stub: the loader path is the first statement. */
const FAIL_OPEN_RE = /^const L=("(?:[^"\\]|\\.)*");/;

export function parseRequirePath(indexSource: string): string | null {
    const failOpen = FAIL_OPEN_RE.exec(indexSource);
    if (failOpen) {
        try {
            const path = JSON.parse(failOpen[1]!) as unknown;
            return typeof path === "string" ? path : null;
        } catch {
            return null;
        }
    }
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

/** Which of our stub forms an index.js is, for this loader; null when it is none of them. */
export type StubForm = "current" | "previous" | "legacy";

export function stubFormOf(indexSource: string, loaderPath: string): StubForm | null {
    if (indexSource === stubIndexSource(loaderPath)) return "current";
    if (indexSource === previousStubIndexSource(loaderPath)) return "previous";
    if (indexSource === interimStubIndexSource(loaderPath)) return "previous";
    if (indexSource === legacyStubIndexSource(loaderPath)) return "legacy";
    return null;
}

/**
 * What an archive IS, judged by what its entry point does (audit 2026-10-06
 * #6). The old test was "exactly index.js and package.json, under 64 KB", so a
 * loader with a third file (a LICENSE, a README, a future Vencord layout) read
 * as Discord's original, and patching then moved it into _app.asar over the
 * real backup. Now:
 *
 *  - no package.json, or one that does not parse: unrecognised (Electron could
 *    not start it either), never "original";
 *  - the main entry (package.json main, default index.js) is missing:
 *    unrecognised;
 *  - the main entry is small and is a single require of an ABSOLUTE path:
 *    a loader stub, whatever else the archive holds;
 *  - anything else: Discord's own code. Discord's layout is not hardcoded
 *    (macOS main is bundle.js, Windows app_bootstrap/index.js, OpenAsar a
 *    real index.js), only "is the entry point a loader".
 */
export type AsarKind =
    | { kind: "original" }
    | { kind: "stub"; stub: StubContents }
    | { kind: "unrecognised"; why: string };

/** A require of a relative path is an app requiring its own code, never a loader stub. */
function isAbsoluteLoaderPath(path: string): boolean {
    return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function classifyAsar(asarPath: string): Result<AsarKind> {
    const dir = readAsarDirectory(asarPath);
    if (!dir.ok) return dir;
    const files = new Map(dir.value.files.map(file => [file.name, file]));

    const pkgEntry = files.get(STUB_PACKAGE_NAME);
    if (pkgEntry === undefined) return ok({ kind: "unrecognised", why: "it has no package.json" });
    // A package.json this big is no loader stub's.
    if (pkgEntry.size > MAX_STUB_BYTES) return ok({ kind: "original" });
    const pkgRead = readAsarFiles(asarPath, dir.value, [STUB_PACKAGE_NAME], MAX_STUB_BYTES);
    if (!pkgRead.ok) return pkgRead;
    const packageJson = pkgRead.value.get(STUB_PACKAGE_NAME)!.toString("utf8");
    let main: string;
    try {
        const parsed = JSON.parse(packageJson) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return ok({ kind: "unrecognised", why: "its package.json is not an object" });
        }
        const declared = (parsed as { main?: unknown }).main;
        main = typeof declared === "string" && declared.trim() !== "" ? declared.trim() : STUB_INDEX_NAME;
    } catch {
        return ok({ kind: "unrecognised", why: "its package.json does not parse" });
    }
    main = main.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
    const top = main.split("/")[0] ?? main;
    if (main.includes("/")) {
        // Nested (Windows Discord: app_bootstrap/index.js). The folder must be there.
        return dir.value.names.includes(top)
            ? ok({ kind: "original" })
            : ok({ kind: "unrecognised", why: `its main entry ${main} is missing` });
    }
    let entryName = main;
    if (!files.has(entryName) && files.has(`${main}.js`)) entryName = `${main}.js`;
    const entry = files.get(entryName);
    if (entry === undefined) {
        return dir.value.names.includes(main)
            ? ok({ kind: "original" })
            : ok({ kind: "unrecognised", why: `its main entry ${main} is missing` });
    }
    if (entry.size > MAX_STUB_BYTES) return ok({ kind: "original" });
    const read = readAsarFiles(asarPath, dir.value, [entryName], MAX_STUB_BYTES);
    if (!read.ok) return read;
    const indexSource = read.value.get(entryName)!.toString("utf8");
    const loaderPath = parseRequirePath(indexSource);
    if (loaderPath === null || !isAbsoluteLoaderPath(loaderPath)) return ok({ kind: "original" });
    return ok({ kind: "stub", stub: { indexSource, packageJson, loaderPath } });
}

/**
 * Read an `app.asar` as a loader stub. Returns `null` (not an error) when the
 * archive is a real Discord asar rather than a stub, so callers can tell
 * "unpatched" apart from "unreadable". An archive that is neither (see
 * classifyAsar) is an INVALID_ASAR error: never "original".
 */
export function readStub(asarPath: string): Result<StubContents | null> {
    const kind = classifyAsar(asarPath);
    if (!kind.ok) return kind;
    if (kind.value.kind === "stub") return ok(kind.value.stub);
    if (kind.value.kind === "original") return ok(null);
    return err<StubContents | null>("INVALID_ASAR", `The archive is not Discord's and not a loader: ${kind.value.why}.`, { path: asarPath });
}

/** True when the archive at `asarPath` is Discord's own (not a loader stub). */
export function readIsOriginalAsar(asarPath: string): Result<boolean> {
    const stub = readStub(asarPath);
    if (!stub.ok) return stub;
    return ok(stub.value === null);
}
