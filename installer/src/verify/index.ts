/**
 * Post-install verification (spec §7).
 *
 * The counterpart to `patcher/`: that module changes the install, this one asks
 * whether the change did anything. They are deliberately separate, because the
 * patcher's own success — the file was written, read back, byte-perfect — is
 * exactly the signal that has repeatedly been true of an install that does not
 * work.
 */

export {
    BEACON_ERROR_CODES, BEACON_FILENAME, beaconDirFor, beaconPathFor, PRODUCT_DIR_NAME,
    readBeacon, readBeaconAt, SUPPORTED_BEACON_FORMAT, validateBeacon
} from "./beacon.js";
export type { Beacon, BeaconError, BeaconErrorCode, BeaconTier } from "./beacon.js";

export {
    awaitVerification, DEFAULT_POLL_INTERVAL_MS, DEFAULT_SKEW_TOLERANCE_MS,
    DEFAULT_VERIFY_TIMEOUT_MS, verifyOnce
} from "./verify.js";
export type { AwaitVerifyOptions, VerificationReport, VerificationStatus, VerifyOptions } from "./verify.js";
