/**
 * Repair the CRC electron-builder's macOS uninstaller path breaks.
 *
 * On macOS Catalina+, electron-builder cannot execute the 32-bit NSIS stub
 * that would write the uninstaller properly. (The stored CRC is precomputed
 * by makensis at BUILD time over the icon-patched exehead - build.cpp:3159;
 * the slicer skips the icon patch, which is the actual byte difference.)
 * Instead it byte-slices the BUILD_UNINSTALLER installer and
 * concatenates stub + inner archive (UninstallerReader in app-builder-lib).
 * The result carries the CRC of a file it is not, and every Windows machine
 * that runs it says "Installer integrity check has failed". Observed live,
 * three installs in a row, before this existed.
 *
 * NSIS's integrity rule, learned empirically against a known-good installer
 * and verified in both directions (installer PASS, sliced uninstaller FAIL):
 * the last 4 bytes store crc32 over bytes [512, length-4).
 *
 * This hook rides electron-builder's signing pipeline, which is invoked for
 * the uninstaller right before it is embedded into the final installer. It
 * touches only files that carry the NSIS signature AND have a mismatched
 * CRC, so on a build where upstream fixes the slicer it becomes a no-op,
 * and it can never corrupt a file that was already right.
 */
const { readFileSync, writeFileSync } = require("node:fs");
const zlib = require("node:zlib");

const NSIS_SIG = Buffer.from("EFBEADDE4E756C6C736F6674496E7374", "hex");

exports.default = async function fixNsisCrc(configuration) {
    const path = configuration.path;
    if (!path || !path.toLowerCase().endsWith(".exe")) return;

    const bytes = readFileSync(path);
    const sigAt = bytes.indexOf(NSIS_SIG);
    if (sigAt < 4) return; // not an NSIS file (the app exe)

    // Signed exe (nonzero PE security directory): never touch it. A mistake
    // here corrupts a signature, and signed builds have no business being
    // CRC-patched by us anyway.
    const peAt = bytes.readUInt32LE(0x3c);
    const optMagic = bytes.readUInt16LE(peAt + 24);
    const certDirAt = peAt + 24 + (optMagic === 0x20b ? 144 : 128);
    if (bytes.readUInt32LE(certDirAt) !== 0 || bytes.readUInt32LE(certDirAt + 4) !== 0) return;

    // The CRC position comes from the FIRSTHEADER, not from EOF: NSIS covers
    // [512, fhOffset+loafd-4) and stores the value at fhOffset+loafd-4
    // (fileform.c loadHeaders). EOF-4 merely coincides while nothing is
    // appended after the overlay.
    const fhOffset = sigAt - 4;
    if (fhOffset % 512 !== 0) return; // not where the exehead 512-stride scan looks
    // firstheader layout (fileform.h): flags u32, signature 16 bytes,
    // length_of_header u32 at +20, length_of_all_following_data u32 at +24.
    // Reading +20 here once wrote four bytes into the middle of a datablock -
    // caught by the overlay-ends-at-EOF check below before anything shipped.
    const loafd = bytes.readUInt32LE(fhOffset + 24);
    const crcAt = fhOffset + loafd - 4;
    if (crcAt <= 512 || crcAt + 4 > bytes.length) return;
    // Belt: for OUR artifacts the overlay always ends at EOF (nothing is
    // appended to unsigned builds). A loafd that does not reach EOF means the
    // header was misread or the file is a shape this hook has never seen -
    // either way, writing would be guessing. Refuse.
    if (fhOffset + loafd !== bytes.length) return;

    const stored = bytes.readUInt32LE(crcAt);
    const computed = zlib.crc32(bytes.subarray(512, crcAt)) >>> 0;
    if (stored === computed) return;

    bytes.writeUInt32LE(computed, crcAt);
    writeFileSync(path, bytes);
    console.log(`  [subline] repaired NSIS CRC of ${path.split("/").pop()} (${stored.toString(16)} -> ${computed.toString(16)})`);
};
