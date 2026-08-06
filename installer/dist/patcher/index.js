/**
 * Subline patcher core.
 *
 * A pure, testable module that manipulates a Discord installation. No GUI, no
 * Electron, no signing — those sit on top of this.
 *
 * Every export returns a `Result`, never throws for an expected condition, and
 * every failure carries a `PatcherErrorCode` the GUI can map to a specific
 * screen (spec §7).
 */
export { buildAsar, readAsarDirectory, readAsarFiles } from "./asar.js";
export { inspectModBundle, removeModBundle } from "../bundle/bundle.js";
export { MOD_DIR_NAME, modBundleDirFor, PRODUCT_DIR_NAME, productDirFor } from "../bundle/layout.js";
export { digestEntries, inspectBundleDir, LOADER_ENTRY_NAME, loaderPathFor, manifestPathFor, MOD_MANIFEST_FILENAME, MOD_MANIFEST_FORMAT, parseManifest, renderManifest, REQUIRED_ENTRIES, SOURCE_NOTICE_NAME, STAMPED_ENTRY_NAME } from "../bundle/spec.js";
export { branchFromPath, BRANCHES, DEFAULT_BRANCHES, defaultSearchRoots, findWindowsAppDirs, locateDiscordInstalls, resourcesDirFor } from "./locate.js";
export { MARKER_FILENAME, MARKER_FORMAT, markerPathFor, readMarker, removeMarker, writeMarker } from "./marker.js";
export { patchInstall, unpatchInstall, verifyPatch } from "./patch.js";
export { err, errnoOf, fsError, ok } from "./result.js";
export { hasUnpackedAppDir, identifyModFromLoaderPath, inspectInstall } from "./state.js";
export { buildStubAsar, MAX_STUB_BYTES, parseRequirePath, readIsOriginalAsar, readStub, STUB_INDEX_NAME, STUB_PACKAGE_JSON, STUB_PACKAGE_NAME, stubIndexSource } from "./stub.js";
export { readDiscordVersion } from "./version.js";
//# sourceMappingURL=index.js.map