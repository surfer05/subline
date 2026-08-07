import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildAsar, readAsarDirectory, readAsarFiles } from "../src/patcher/asar.js";
import { buildStubAsar, parseRequirePath, readStub, STUB_PACKAGE_JSON } from "../src/patcher/stub.js";
import {
    badEntryTypesAsarBytes,
    buildOriginalDiscordAsar,
    FOREIGN_BUNDLE_JS,
    FOREIGN_ORIGINAL_HEADER_JSON,
    FOREIGN_PACKAGE_JSON,
    foreignOriginalAsarBytes,
    noFileTableAsarBytes,
    REAL_STUB_HEADER_JSON,
    REAL_STUB_INDEX_JS,
    REAL_STUB_PACKAGE_JSON,
    REAL_VENCORD_LOADER_PATH,
    realVencordStubBytes,
    realVencordStubWithPrefix,
    threeEntryAsarBytes
} from "./fixture.js";

/**
 * The actual 199 bytes of `/Applications/Discord.app/Contents/Resources/app.asar`
 * as written by Vencord's own installer on this machine, captured 2026-08-06.
 *
 * This is the golden test for the whole format: if `buildStubAsar` can
 * reproduce these bytes exactly for the same loader path, we are producing a
 * real asar and not something that merely looks plausible.
 */
const REAL_VENCORD_STUB_BASE64 =
    "BAAAAGAAAABcAAAAWAAAAHsiZmlsZXMiOnsiaW5kZXguanMiOnsic2l6ZSI6NTIsIm9mZnNldCI6IjAifSwicGFja2FnZS5qc29u" +
    "Ijp7InNpemUiOjQzLCJvZmZzZXQiOiI1MiJ9fX1yZXF1aXJlKCIvVXNlcnMvc3VyZmVyL2Rldi9WZW5jb3JkL2Rpc3QvcGF0Y2hl" +
    "ci5qcyIpewoJIm5hbWUiOiAiZGlzY29yZCIsCgkibWFpbiI6ICJpbmRleC5qcyIKfQ==";

let dir: string;
const paths: string[] = [];

function tempFile(name: string, content: Buffer): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    paths.push(path);
    return path;
}

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "subline-asar-"));
});
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

/**
 * The reader, driven only by bytes the writer did not make.
 *
 * These are the tests the suite was missing. `buildAsar` was verified against
 * the live stub byte for byte, and then every reader test was fed `buildAsar`
 * output — so the reader was pinned to the writer rather than to the format,
 * and a real archive could break it with the suite still green.
 */
describe("the reader, on archives our writer did not produce", () => {
    it("the literal fixture really is the bytes captured from the live install", () => {
        // Pins the hand-assembled constants against the independently captured
        // base64. If either drifts, both of the tests below are worthless, so
        // this must fail first and loudly.
        const literal = realVencordStubBytes();
        expect(literal).toHaveLength(199);
        expect(literal.equals(Buffer.from(REAL_VENCORD_STUB_BASE64, "base64"))).toBe(true);
        // And the literals describe the bytes they claim to.
        expect(Buffer.byteLength(REAL_STUB_HEADER_JSON, "utf8")).toBe(88);
        expect(Buffer.byteLength(REAL_STUB_INDEX_JS, "utf8")).toBe(52);
        expect(Buffer.byteLength(REAL_STUB_PACKAGE_JSON, "utf8")).toBe(43);
    });

    it("reads the real Vencord stub's directory without going through buildAsar", () => {
        const path = tempFile("real-vencord.asar", realVencordStubBytes());
        const result = readAsarDirectory(path);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(`reader rejected a real archive: ${result.error.message}`);

        expect(result.value.names).toEqual(["index.js", "package.json"]);
        expect(result.value.files).toEqual([
            { name: "index.js", size: 52, offset: 0 },
            { name: "package.json", size: 43, offset: 52 }
        ]);
        expect(result.value.dataOffset).toBe(104);
        expect(result.value.headerJson).toBe(REAL_STUB_HEADER_JSON);
    });

    it("reads the real Vencord stub as a foreign loader stub, not as damage", () => {
        // The whole point: this archive is healthy and belongs to Vencord.
        // Reporting it as unreadable would tell every existing Vencord user
        // their Discord is broken (spec §3 step 4).
        const path = tempFile("real-vencord-stub.asar", realVencordStubBytes());
        const result = readStub(path);
        expect(result.ok).toBe(true);
        if (!result.ok || result.value === null) throw new Error("expected a stub");
        expect(result.value.loaderPath).toBe(REAL_VENCORD_LOADER_PATH);
        expect(result.value.indexSource).toBe(REAL_STUB_INDEX_JS);
        expect(result.value.packageJson).toBe(REAL_STUB_PACKAGE_JSON);
    });

    it("the foreign-original literal describes the bytes it claims to", () => {
        expect(Buffer.byteLength(FOREIGN_ORIGINAL_HEADER_JSON, "utf8")).toBe(318);
        expect(Buffer.byteLength(FOREIGN_ORIGINAL_HEADER_JSON, "utf8") % 4).not.toBe(0);
        expect(Buffer.byteLength(FOREIGN_BUNDLE_JS, "utf8")).toBe(18);
        expect(Buffer.byteLength(FOREIGN_PACKAGE_JSON, "utf8")).toBe(37);
        const buf = foreignOriginalAsarBytes();
        expect(buf).toHaveLength(393);
        // The two pad bytes between the JSON and the data must be zero, not payload.
        expect(buf[334]).toBe(0);
        expect(buf[335]).toBe(0);
    });

    it("reads a foreign archive with padding, nested dirs, integrity, unpacked and link entries", () => {
        const path = tempFile("foreign-original.asar", foreignOriginalAsarBytes());
        const result = readAsarDirectory(path);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(`reader rejected a real archive: ${result.error.message}`);

        // Directories and non-file nodes stay in `names` but must never appear
        // in `files` — nothing here has readable bytes at an offset.
        expect(result.value.names).toEqual([
            "bundle.js",
            "data",
            "native.node",
            "shortcut.js",
            "package.json"
        ]);
        expect(result.value.files).toEqual([
            { name: "bundle.js", size: 18, offset: 0 },
            { name: "package.json", size: 37, offset: 20 }
        ]);
        // 8 + 328, i.e. the padded header — the number an alignment bug gets wrong.
        expect(result.value.dataOffset).toBe(336);
    });

    it("reads payload out of a foreign archive at the padded data offset", () => {
        // Proves dataOffset is not merely a plausible number: the bytes it
        // points at have to be the right bytes.
        const path = tempFile("foreign-payload.asar", foreignOriginalAsarBytes());
        const dirResult = readAsarDirectory(path);
        expect(dirResult.ok).toBe(true);
        if (!dirResult.ok) return;

        const files = readAsarFiles(path, dirResult.value, ["bundle.js", "package.json"]);
        expect(files.ok).toBe(true);
        if (!files.ok) throw new Error(files.error.message);
        expect(files.value.get("bundle.js")!.toString("utf8")).toBe(FOREIGN_BUNDLE_JS);
        expect(files.value.get("package.json")!.toString("utf8")).toBe(FOREIGN_PACKAGE_JSON);
    });

    it("treats a foreign Discord-shaped archive as an original, not a stub", () => {
        const path = tempFile("foreign-not-stub.asar", foreignOriginalAsarBytes());
        const result = readStub(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBeNull();
    });
});

/**
 * Each rejection gate, isolated.
 *
 * A first mutation pass killed the offset arithmetic and the alignment rule but
 * left every one of these alive: a malformed file usually trips several gates
 * at once, so "the suite still says INVALID_ASAR" was being satisfied by
 * whichever gate happened to fire second. Each test below constructs a file
 * that ONLY the named gate rejects, and asserts the specific message — so
 * deleting that gate changes an observable, and `broken` cannot quietly become
 * unreachable.
 */
describe("the reader's rejection gates, one at a time", () => {
    it("rejects a bad size pickle even when every other word is consistent", () => {
        // Byte-for-byte the real stub apart from word 0. Nothing else is wrong,
        // so no other gate can account for the rejection.
        const path = tempFile("badsizepickle.asar", realVencordStubWithPrefix(0, 8));
        const result = readAsarDirectory(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("INVALID_ASAR");
        expect(result.error.message).toContain("size pickle");
    });

    it("rejects an implausibly large declared header rather than allocating it", () => {
        const path = tempFile("huge.asar", realVencordStubWithPrefix(12, 64 * 1024 * 1024));
        const result = readAsarDirectory(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("INVALID_ASAR");
        expect(result.error.message).toContain("implausible");
    });

    it("rejects a zero-length declared header", () => {
        const path = tempFile("zerolen.asar", realVencordStubWithPrefix(12, 0));
        const result = readAsarDirectory(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("INVALID_ASAR");
        expect(result.error.message).toContain("implausible");
    });

    it("rejects a file too small to hold a prefix, by that name", () => {
        const path = tempFile("tiny.asar", realVencordStubBytes().subarray(0, 8));
        const result = readAsarDirectory(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("INVALID_ASAR");
        expect(result.error.message).toContain("too small");
    });

    it("rejects a truncated header, by that name", () => {
        // A well-formed prefix promising 88 bytes of JSON, in a file that stops
        // partway through it.
        const path = tempFile("cutshort.asar", realVencordStubBytes().subarray(0, 60));
        const result = readAsarDirectory(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("INVALID_ASAR");
        expect(result.error.message).toContain("truncated");
    });

    it("rejects a header that parses but has no file table, without throwing", () => {
        // Without the explicit check this reaches Object.keys(undefined) and
        // comes back as a generic IO_ERROR — the wrong named failure (spec §7).
        const path = tempFile("nofiletable.asar", noFileTableAsarBytes());
        const result = readAsarDirectory(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("INVALID_ASAR");
        expect(result.error.message).toContain("file table");
    });

    it("ignores entries whose size or offset are the wrong type", () => {
        // Every well-formed archive agrees with these checks, so only a
        // deliberately ill-typed one can show they are load-bearing.
        const path = tempFile("badtypes.asar", badEntryTypesAsarBytes());
        const result = readAsarDirectory(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.names).toEqual(["ok.js", "numoff.js", "strsize.js"]);
        // A numeric offset and a string size are both refused; only the
        // well-typed entry becomes a readable file.
        expect(result.value.files).toEqual([{ name: "ok.js", size: 2, offset: 0 }]);
    });

    it("refuses to read entries the archive does not contain", () => {
        const path = tempFile("forfiles.asar", realVencordStubBytes());
        const dirResult = readAsarDirectory(path);
        expect(dirResult.ok).toBe(true);
        if (!dirResult.ok) return;

        const files = readAsarFiles(path, dirResult.value, ["index.js", "absent.js"]);
        expect(files.ok).toBe(false);
        if (files.ok) return;
        expect(files.error.code).toBe("INVALID_ASAR");
        expect(files.error.message).toContain("absent.js");
    });

    it("does not call a three-entry archive a loader stub", () => {
        // A stub is exactly index.js + package.json. An archive that merely
        // contains both is somebody's real app, and claiming it is an injection
        // would report a clean install as modified.
        const path = tempFile("three.asar", threeEntryAsarBytes());
        const result = readStub(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBeNull();
    });
});

describe("asar format", () => {
    it("reproduces the real Vencord-written app.asar byte for byte", () => {
        const expected = Buffer.from(REAL_VENCORD_STUB_BASE64, "base64");
        expect(expected).toHaveLength(199);
        expect(buildStubAsar(REAL_VENCORD_LOADER_PATH).equals(expected)).toBe(true);
    });

    it("reads back entry names, sizes and offsets", () => {
        const path = tempFile(
            "roundtrip.asar",
            buildAsar([
                { name: "a.js", content: Buffer.from("hello") },
                { name: "b.json", content: Buffer.from("{}") }
            ])
        );

        const dirResult = readAsarDirectory(path);
        expect(dirResult.ok).toBe(true);
        if (!dirResult.ok) return;

        expect(dirResult.value.names).toEqual(["a.js", "b.json"]);
        expect(dirResult.value.files).toEqual([
            { name: "a.js", size: 5, offset: 0 },
            { name: "b.json", size: 2, offset: 5 }
        ]);

        const files = readAsarFiles(path, dirResult.value, ["a.js", "b.json"]);
        expect(files.ok).toBe(true);
        if (!files.ok) return;
        expect(files.value.get("a.js")!.toString()).toBe("hello");
        expect(files.value.get("b.json")!.toString()).toBe("{}");
    });

    it("pads the header JSON to a 4-byte boundary the way real archives do", () => {
        // Discord's own _app.asar proves the rule: its header JSON is 2958
        // bytes (not a multiple of 4) and its declared payload length is 2964
        // = 4 + align4(2958) = 4 + 2960 — not 4 + 2958. Reproduce that here.
        //
        // The entry below yields exactly:
        //   {"files":{"q":{"size":7,"offset":"0"}}}   → 39 bytes
        // so align4(39) = 40, payload = 44, pickle = 48, data starts at 56.
        const buf = buildAsar([{ name: "q", content: Buffer.from("PAYLOAD") }]);

        expect(buf.readUInt32LE(0)).toBe(4);
        expect(buf.readUInt32LE(12)).toBe(39);
        expect(buf.readUInt32LE(8)).toBe(44);
        expect(buf.readUInt32LE(4)).toBe(48);
        expect(buf).toHaveLength(56 + 7);
        // The one pad byte after the JSON must be a zero, not payload.
        expect(buf[16 + 39]).toBe(0);
        expect(buf.subarray(56).toString()).toBe("PAYLOAD");
    });

    it("finds the data offset correctly for a header needing padding", () => {
        // A one-character name makes the header JSON length not a multiple of 4,
        // which is exactly where an alignment bug would show up.
        const path = tempFile("pad.asar", buildAsar([{ name: "q", content: Buffer.from("PAYLOAD") }]));
        const dirResult = readAsarDirectory(path);
        expect(dirResult.ok).toBe(true);
        if (!dirResult.ok) return;
        const files = readAsarFiles(path, dirResult.value, ["q"]);
        expect(files.ok).toBe(true);
        if (!files.ok) return;
        expect(files.value.get("q")!.toString()).toBe("PAYLOAD");
    });

    it("rejects a file that is not an asar with INVALID_ASAR", () => {
        const path = tempFile("garbage.asar", Buffer.from("this is definitely not an asar archive at all"));
        const result = readAsarDirectory(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("INVALID_ASAR");
    });

    it("rejects a header whose declared sizes disagree with each other", () => {
        // Well-formed prefix, but headerPickleLength does not match the payload
        // it claims to introduce — a truncated or tampered archive.
        const good = buildAsar([{ name: "a.js", content: Buffer.from("hello") }]);
        const bad = Buffer.from(good);
        bad.writeUInt32LE(bad.readUInt32LE(4) + 4, 4);

        const result = readAsarDirectory(tempFile("inconsistent.asar", bad));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("INVALID_ASAR");
    });

    it("reports a missing file as an IO error rather than throwing", () => {
        const result = readAsarDirectory(join(dir, "nope.asar"));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("IO_ERROR");
    });
});

describe("stub", () => {
    it("has exactly the package.json the real install has", () => {
        expect(STUB_PACKAGE_JSON).toBe('{\n\t"name": "discord",\n\t"main": "index.js"\n}');
    });

    it("readStub returns the loader path for a stub archive", () => {
        const path = tempFile("stub.asar", buildStubAsar("/Applications/Subline.app/Contents/Resources/loader.js"));
        const result = readStub(path);
        expect(result.ok).toBe(true);
        if (!result.ok || result.value === null) throw new Error("expected a stub");
        expect(result.value.loaderPath).toBe("/Applications/Subline.app/Contents/Resources/loader.js");
        expect(result.value.packageJson).toBe(STUB_PACKAGE_JSON);
    });

    it("readStub returns null for Discord's real archive", () => {
        const path = tempFile("original.asar", buildOriginalDiscordAsar());
        const result = readStub(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBeNull();
    });

    it("does not treat a large two-file archive as a loader stub", () => {
        // Same entry names as a stub, but far too big to be one — this is how a
        // real app that happens to ship index.js + package.json avoids being
        // mistaken for someone's injection.
        const path = tempFile(
            "bigtwo.asar",
            buildAsar([
                { name: "index.js", content: Buffer.alloc(200 * 1024, 0x61) },
                { name: "package.json", content: Buffer.from(STUB_PACKAGE_JSON) }
            ])
        );
        const result = readStub(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBeNull();
    });

    it("parses single-quoted and semicolon-terminated require lines from other tools", () => {
        expect(parseRequirePath("require('/opt/other/mod.js');")).toBe("/opt/other/mod.js");
        expect(parseRequirePath('require("/opt/other/mod.js")\n')).toBe("/opt/other/mod.js");
    });

    it("returns null for an index.js that is not a bare require", () => {
        expect(parseRequirePath("console.log(1); require('/x.js')")).toBeNull();
        expect(parseRequirePath("module.exports = {}")).toBeNull();
    });
});
