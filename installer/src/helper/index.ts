/**
 * The background helper (spec §6) — a re-patcher AND an updater.
 *
 * Shipping only the re-patcher would mean the product dies quietly the first
 * time Discord rewrites its frontend, with no error anywhere. `helper.ts` states
 * the reasoning; this file is only the public surface.
 */

export {
    ALERTS_FILENAME, ALERTS_FORMAT, alertsPathFor, DEFAULT_REPEAT_MS, pendingAlertCodes,
    raiseAlert, readPendingAlerts, resolveAlert
} from "./alerts.js";
export type { Alert, AlertCode, AlertPorts, AlertRaised } from "./alerts.js";

export {
    RELEASE_FEED_ENABLED, RELEASE_FEED_URL, RELEASE_MANIFEST_ASSET_NAME, RELEASE_REPOSITORY,
    releaseManifestUrl
} from "./feed.js";

export {
    MIN_OBSERVATIONS, MIN_WINDOW_MS, observeHealth
} from "./health.js";
export type { HealthObservation, HealthStatus, ObserveHealthOptions } from "./health.js";

export {
    DEFAULT_UPDATE_INTERVAL_MS, REPATCH_FAILURES_BEFORE_ALERT, runHelperOnce, UPDATE_FAILURES_BEFORE_ALERT
} from "./helper.js";
export type { DecisionKind, HelperDecision, HelperPorts, HelperRunOptions, HelperRunReport } from "./helper.js";

export {
    DEFAULT_INTERVAL_SECONDS, HELPER_FLAG, HELPER_LABEL, helperLaunchAgentSpec, helperProgramArguments,
    installLaunchAgent, LAUNCH_AGENTS_DIR_NAME, launchAgentPlistPath, readLaunchAgentPlist,
    removeLaunchAgent, renderLaunchAgentPlist
} from "./launchAgent.js";
export type { InstallLaunchAgentOptions, LaunchAgentReport, LaunchAgentSpec, LaunchctlPort } from "./launchAgent.js";

export { createHelperPorts, createLaunchctl, findBundleRoot, notifyMac, unpackArchive } from "./ports.js";
export type { Exec, RealHelperPortsOptions } from "./ports.js";

export {
    ALLOWED_RELEASE_HOSTS, assertTrustedUrl, checksumVerifier, DEFAULT_VERIFIERS, isNewerBuild,
    parseReleaseManifest, RELEASE_MANIFEST_FORMAT, REQUIRE_SIGNATURE, sha256Of, verifyDownload
} from "./release.js";
export type {
    ReleaseArtifact, ReleaseManifest, ReleaseSignature, ReleaseVerifier, VerifiedRelease
} from "./release.js";

export {
    awaitDiscordSettled, DEFAULT_CONFIRM_MS, DEFAULT_MAX_WAIT_MS, DEFAULT_POLL_MS, DEFAULT_QUIET_MS,
    watchedPaths
} from "./settle.js";
export type { SettleOptions, SettlePorts, SettleReport, SettleStatus } from "./settle.js";

export {
    emptyHelperState, HELPER_STATE_FILENAME, HELPER_STATE_FORMAT, helperStatePathFor, parseHelperState,
    readHelperState, writeHelperState
} from "./state.js";
export type { AlertMemory, HealthMemory, HelperState, InstallMemory } from "./state.js";
