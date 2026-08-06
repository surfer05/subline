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
export type { AsarDirectory, AsarFileEntry } from "./asar.js";

export {
    branchFromPath,
    BRANCHES,
    DEFAULT_BRANCHES,
    defaultSearchRoots,
    findWindowsAppDirs,
    locateDiscordInstalls,
    resourcesDirFor
} from "./locate.js";
export type { BranchDefinition, DiscordBranch, DiscordInstall, LocateOptions, SupportedPlatform } from "./locate.js";

export { MARKER_FILENAME, MARKER_FORMAT, markerPathFor, readMarker, removeMarker, writeMarker } from "./marker.js";
export type { PatchMarker } from "./marker.js";

export { patchInstall, unpatchInstall, verifyPatch } from "./patch.js";
export type { PatchHooks, PatchOptions, PatchReport, UnpatchOptions, UnpatchReport } from "./patch.js";

export { err, errnoOf, fsError, ok } from "./result.js";
export type { PatcherError, PatcherErrorCode, Result } from "./result.js";

export { hasUnpackedAppDir, identifyModFromLoaderPath, inspectInstall } from "./state.js";
export type { BrokenReason, InstallState, InstallStateKind, KnownMod, StateWarning } from "./state.js";

export {
    buildStubAsar,
    MAX_STUB_BYTES,
    parseRequirePath,
    readIsOriginalAsar,
    readStub,
    STUB_INDEX_NAME,
    STUB_PACKAGE_JSON,
    STUB_PACKAGE_NAME,
    stubIndexSource
} from "./stub.js";
export type { StubContents } from "./stub.js";

export { readDiscordVersion } from "./version.js";
export type { DiscordBuildInfo } from "./version.js";
