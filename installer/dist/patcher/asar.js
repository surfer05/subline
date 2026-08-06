/**
 * Minimal asar reader/writer.
 *
 * Deliberately dependency-free rather than using the `asar` npm package:
 * Vencord does not use it either — `pnpm inject` downloads the Go
 * `VencordInstaller` binary (scripts/runInstaller.mjs), which writes the
 * archive itself. The layout below was derived by hexdumping the real patched
 * `/Applications/Discord.app/Contents/Resources/app.asar` (199 bytes) and the
 * preserved original `_app.asar` (3.6 MB), not from documentation.
 *
 * Byte layout (all little-endian uint32, this is Chromium's Pickle format):
 *
 *   [0]  4                      payload size of the "size" pickle
 *   [4]  headerPickleLength     4 + payload size of the header pickle
 *   [8]  headerPayloadLength    4 + align4(jsonLength)
 *   [12] jsonLength             byte length of the header JSON
 *   [16] <json> <padding to 4>
 *   [8 + headerPickleLength] … file data, concatenated in header order
 *
 * Confirmed against the real stub: `04 00 00 00 | 60 00 00 00 | 5c 00 00 00 |
 * 58 00 00 00` then 88 bytes of JSON, data starting at 0x68 = 104 = 8 + 96.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { err, fsError, ok } from "./result.js";
const PICKLE_ALIGNMENT = 4;
/** Sanity ceiling on the header JSON, so a non-asar file cannot make us allocate wildly. */
const MAX_HEADER_BYTES = 16 * 1024 * 1024;
function align4(n) {
    const rem = n % PICKLE_ALIGNMENT;
    return rem === 0 ? n : n + (PICKLE_ALIGNMENT - rem);
}
/** Serialise a flat set of files into an asar archive buffer. */
export function buildAsar(files) {
    const header = {};
    let offset = 0;
    for (const file of files) {
        header[file.name] = { size: file.content.length, offset: String(offset) };
        offset += file.content.length;
    }
    const json = Buffer.from(JSON.stringify({ files: header }), "utf8");
    const paddedJsonLength = align4(json.length);
    const headerPayloadLength = 4 + paddedJsonLength;
    const headerPickleLength = 4 + headerPayloadLength;
    const head = Buffer.alloc(16 + paddedJsonLength);
    head.writeUInt32LE(4, 0);
    head.writeUInt32LE(headerPickleLength, 4);
    head.writeUInt32LE(headerPayloadLength, 8);
    head.writeUInt32LE(json.length, 12);
    json.copy(head, 16);
    // The padding bytes are already zero from Buffer.alloc.
    return Buffer.concat([head, ...files.map(f => f.content)]);
}
/**
 * Read only the header of an asar. Safe on the 3.6 MB original — it reads
 * 16 bytes plus the header JSON (about 3 KB there), never the file data.
 */
export function readAsarDirectory(path) {
    let fd;
    try {
        fd = openSync(path, "r");
    }
    catch (cause) {
        return fsError(cause, path, `open ${path}`);
    }
    try {
        const prefix = Buffer.alloc(16);
        const readPrefix = readSync(fd, prefix, 0, 16, 0);
        if (readPrefix < 16) {
            return err("INVALID_ASAR", "File is too small to be an asar archive.", { path });
        }
        const sizePickleLength = prefix.readUInt32LE(0);
        const headerPickleLength = prefix.readUInt32LE(4);
        const headerPayloadLength = prefix.readUInt32LE(8);
        const jsonLength = prefix.readUInt32LE(12);
        if (sizePickleLength !== 4) {
            return err("INVALID_ASAR", "Not an asar archive (bad size pickle).", { path });
        }
        if (jsonLength === 0 || jsonLength > MAX_HEADER_BYTES) {
            return err("INVALID_ASAR", "Not an asar archive (implausible header length).", { path });
        }
        if (headerPickleLength !== 4 + headerPayloadLength || headerPayloadLength !== 4 + align4(jsonLength)) {
            return err("INVALID_ASAR", "Not an asar archive (inconsistent header sizes).", { path });
        }
        const jsonBuf = Buffer.alloc(jsonLength);
        const readJson = readSync(fd, jsonBuf, 0, jsonLength, 16);
        if (readJson < jsonLength) {
            return err("INVALID_ASAR", "asar header is truncated.", { path });
        }
        const headerJson = jsonBuf.toString("utf8");
        let parsed;
        try {
            parsed = JSON.parse(headerJson);
        }
        catch (cause) {
            return err("INVALID_ASAR", "asar header is not valid JSON.", { path, cause });
        }
        const filesNode = parsed?.files;
        if (typeof filesNode !== "object" || filesNode === null) {
            return err("INVALID_ASAR", "asar header has no file table.", { path });
        }
        const names = Object.keys(filesNode);
        const files = [];
        for (const name of names) {
            const node = filesNode[name];
            if (typeof node !== "object" || node === null)
                continue;
            const { size, offset } = node;
            if (typeof size !== "number" || typeof offset !== "string")
                continue; // a directory or link
            const parsedOffset = Number(offset);
            if (!Number.isFinite(parsedOffset))
                continue;
            files.push({ name, size, offset: parsedOffset });
        }
        return ok({ names, files, dataOffset: 8 + headerPickleLength, headerJson });
    }
    catch (cause) {
        return fsError(cause, path, `read ${path}`);
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Read the contents of the named top-level files.
 *
 * `maxBytes` guards against being pointed at Discord's real 3 MB `bundle.js`:
 * this is only ever used on the tiny stub.
 */
export function readAsarFiles(path, directory, names, maxBytes = 64 * 1024) {
    const wanted = directory.files.filter(f => names.includes(f.name));
    const missing = names.filter(n => !wanted.some(f => f.name === n));
    if (missing.length > 0) {
        return err("INVALID_ASAR", `asar is missing ${missing.join(", ")}.`, { path });
    }
    const total = wanted.reduce((sum, f) => sum + f.size, 0);
    if (total > maxBytes) {
        return err("INVALID_ASAR", "asar entries are larger than expected.", { path });
    }
    let fd;
    try {
        fd = openSync(path, "r");
    }
    catch (cause) {
        return fsError(cause, path, `open ${path}`);
    }
    try {
        const out = new Map();
        for (const entry of wanted) {
            const buf = Buffer.alloc(entry.size);
            const read = readSync(fd, buf, 0, entry.size, directory.dataOffset + entry.offset);
            if (read < entry.size) {
                return err("INVALID_ASAR", `asar entry ${entry.name} is truncated.`, { path });
            }
            out.set(entry.name, buf);
        }
        return ok(out);
    }
    catch (cause) {
        return fsError(cause, path, `read ${path}`);
    }
    finally {
        closeSync(fd);
    }
}
//# sourceMappingURL=asar.js.map