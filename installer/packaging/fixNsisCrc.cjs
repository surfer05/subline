/**
 * Repair the CRC electron-builder's macOS uninstaller path breaks.
 *
 * On macOS Catalina+, electron-builder cannot execute the 32-bit NSIS stub
 * that would write the uninstaller properly (WriteUninstaller fixes the CRC
 * as it writes). Instead it byte-slices the BUILD_UNINSTALLER installer and
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
    if (bytes.indexOf(NSIS_SIG) < 0) return; // not an NSIS file (the app exe)

    const stored = bytes.readUInt32LE(bytes.length - 4);
    const computed = zlib.crc32(bytes.subarray(512, bytes.length - 4)) >>> 0;
    if (stored === computed) return;

    bytes.writeUInt32LE(computed, bytes.length - 4);
    writeFileSync(path, bytes);
    console.log(`  [subline] repaired NSIS CRC of ${path.split("/").pop()} (${stored.toString(16)} -> ${computed.toString(16)})`);
};
