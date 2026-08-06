/**
 * "Did this install actually work?" — spec §7's post-install verification.
 *
 * THE RULE THIS MODULE ENFORCES. Spec §7: "Do not declare success on 'the file
 * was written'. If step 4 cannot be confirmed, say so honestly rather than
 * showing a green tick. A false success is worse than a clear 'installed, but
 * we could not confirm it is working'."
 *
 * So exactly one thing sets `confirmed`: the plugin reported, from inside a
 * Discord we launched, that a translated subtitle was PAINTED. Not that we
 * patched. Not that Discord started. Not that the mod loaded. Not even that a
 * translation was produced — spec §6 names the install where the mod loads,
 * translates, and renders nothing, and that install is dead to the user.
 *
 * STALENESS OUTRANKS PRESENCE. A beacon from last week proves nothing about the
 * install that just happened, and after a reinstall it is exactly the file that
 * would be lying most convincingly. Every timestamp is therefore compared
 * against a REFERENCE INSTANT the installer knows: when it patched, and when it
 * launched Discord.
 *
 * AND IDENTITY OUTRANKS RECENCY. A fresh, healthy, well-timed beacon still only
 * proves "a vcTranslate is running" — not "the vcTranslate WE just patched in is
 * running". A machine that already had Vencord with this plugin would produce
 * exactly that beacon while our patch sat inert, and every signal we have would
 * be green on an install that does nothing. So the plugin stamps its own build
 * id into the beacon, the patcher records the id it expects in
 * `subline-patch.json` (spec §3c), and a beacon that reports a DIFFERENT id — or
 * NO id — is refused here in the same class as a stale one. Never guessed at,
 * in either direction.
 *
 * "NOTHING TO TRANSLATE YET" IS NOT A FAILURE. Someone may open Discord to a
 * channel where everyone speaks their language. That install is fine and must
 * not be reported as broken — but it must not be reported as confirmed either.
 * It is its own outcome, distinct from "loaded and erroring".
 */
import { readBeacon, readBeaconAt, toBuildId } from "./beacon.js";
export const DEFAULT_VERIFY_TIMEOUT_MS = 90_000;
export const DEFAULT_SKEW_TOLERANCE_MS = 2_000;
/**
 * The instant everything is measured against.
 *
 * `max`, not "launchedAt", so that a caller who patched AFTER launching (or
 * mixed the two up) cannot accidentally accept a beacon written before the
 * patch went in. Taking the later of the two is always the safe direction: it
 * can only make this reader harder to convince.
 */
function referenceInstant(options) {
    return Math.max(options.patchedAt, options.launchedAt);
}
function report(partial) {
    return {
        confirmed: false,
        loaded: false,
        pending: false,
        stale: false,
        identity: "unknown",
        tier: "none",
        errorCode: null,
        beacon: null,
        problem: null,
        ...partial
    };
}
/**
 * Ask the beacon, once, whether this install is working.
 *
 * Pure: it takes the times as arguments and reads one file. Poll it with
 * `awaitVerification` below, or call it directly for the diagnostics screen.
 */
export function verifyOnce(options) {
    const now = options.now ?? Date.now();
    const reference = referenceInstant(options);
    const skew = options.skewToleranceMs ?? DEFAULT_SKEW_TOLERANCE_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    const withinWaitingPeriod = now - reference < timeoutMs;
    const read = options.beaconPath !== undefined
        ? readBeaconAt(options.beaconPath)
        : readBeacon(options.platform, options.env, options.home);
    if (!read.ok) {
        return report({
            status: "unreadable-beacon",
            // Still `pending` inside the window: the commonest cause is reading
            // a file that is being written, and the next poll usually succeeds.
            pending: withinWaitingPeriod,
            problem: { code: read.error.code, message: read.error.message },
            summary: "Subline is installed, but its status file could not be read, so we cannot confirm "
                + "translation is working."
        });
    }
    const beacon = read.value;
    if (beacon === null) {
        return report({
            status: "not-loaded",
            pending: withinWaitingPeriod,
            summary: withinWaitingPeriod
                ? "Waiting for Discord to start and load Subline."
                : "Subline is installed, but it never reported in from Discord, so we cannot confirm "
                    + "it is working. Open Discord and check for a translated message underneath a "
                    + "foreign-language one."
        });
    }
    // Whose build is this? Computed before anything in the file is believed,
    // for the same reason staleness is: a beacon that is not ours describes an
    // install that is not ours, however healthy every field in it looks.
    //
    // An expectation we cannot use is checked FIRST and reads as "not ours",
    // never as "cannot tell": a caller with a placeholder instead of a real
    // build id has nothing to confirm against, and letting that fall through to
    // the beacon's own field would let two unusable values agree with each
    // other. There is no value of `expectedBuildId` that means "skip the check".
    const expectedBuildId = toBuildId(options.expectedBuildId);
    const identity = expectedBuildId === null
        ? "mismatch"
        : beacon.buildId === null
            ? "absent"
            : beacon.buildId === expectedBuildId
                ? "match"
                : "mismatch";
    // THE STALENESS GATE, before anything in the file is believed. A beacon
    // whose load predates this install is a previous install's, and every
    // count, timestamp and engine id in it belongs to that one.
    if (beacon.loadedAt < reference - skew) {
        return report({
            status: "stale-beacon",
            stale: true,
            identity,
            pending: withinWaitingPeriod,
            beacon,
            summary: withinWaitingPeriod
                ? "Waiting for Discord to start — the status file is still the previous installation's."
                : "Subline is installed, but the only status we can find predates this installation, "
                    + "so we cannot confirm it is working. Quit Discord completely and reopen it."
        });
    }
    // THE IDENTITY GATE. Same class as staleness, and for the same reason: what
    // follows only means anything if the thing that wrote it is the thing we
    // installed. `loaded` stays FALSE in both branches — something loaded, but
    // not our patch, and this report's `loaded` means ours.
    //
    // Both stay `pending` inside the window: the commonest way to see a foreign
    // beacon is that the OTHER install's plugin reported in first and ours has
    // not started yet, which the next poll may well resolve.
    if (identity === "mismatch") {
        return report({
            status: "foreign-beacon",
            identity,
            pending: withinWaitingPeriod,
            beacon,
            summary: withinWaitingPeriod
                ? "Waiting for Discord to load Subline — the status file is currently another copy of the "
                    + "plugin's."
                : "Discord is running a different copy of this plugin, not the one Subline installed, so we "
                    + "cannot confirm this installation is working. Remove any existing Vencord or vcTranslate "
                    + "setup and install again."
        });
    }
    if (identity === "absent") {
        return report({
            status: "unidentified-beacon",
            identity,
            pending: withinWaitingPeriod,
            beacon,
            summary: withinWaitingPeriod
                ? "Waiting for Discord to load Subline — the status file does not say which build wrote it."
                : "Something reported in from Discord, but it did not identify itself as the build Subline "
                    + "installed, so we cannot confirm this installation is working."
        });
    }
    const rendered = beacon.lastRenderedAt !== null && beacon.lastRenderedAt >= reference - skew;
    const translated = beacon.lastTranslationAt !== null && beacon.lastTranslationAt >= reference - skew;
    const recentError = beacon.lastError !== null && beacon.lastError.at >= reference - skew
        ? beacon.lastError
        : null;
    const erroring = recentError !== null;
    const errorCode = recentError === null ? null : recentError.code;
    const tier = beacon.counts.upgraded > 0 ? "upgraded" : beacon.counts.approx > 0 ? "approx" : "none";
    if (rendered) {
        // The only branch that confirms. Spec §7 step 4.
        return tier === "upgraded"
            ? report({
                status: "translating-upgraded",
                confirmed: true,
                loaded: true,
                identity,
                tier,
                errorCode,
                beacon,
                summary: "Working: translations are appearing in Discord, with the ✦ quality upgrade."
            })
            : report({
                status: "translating-approx",
                confirmed: true,
                loaded: true,
                identity,
                tier: "approx",
                errorCode,
                beacon,
                summary: errorCode === null
                    ? "Working: translations are appearing in Discord (≈ Google)."
                    : "Working: translations are appearing in Discord (≈ Google). The ✦ quality "
                        + "upgrade is not arriving — check the engine settings in Discord."
            });
    }
    if (translated) {
        // Loaded, translating, and nothing on screen. Spec §6: after a Discord
        // frontend change the mod "loads and silently renders nothing", and no
        // amount of re-patching fixes it — it needs a new build. This is the
        // one state that looks healthy on every signal except this one.
        return report({
            status: "translating-not-rendering",
            loaded: true,
            identity,
            tier,
            errorCode,
            beacon,
            // Never `pending`: waiting does not fix it, so telling the user to
            // wait would only delay the one thing that helps.
            summary: "Subline is running and translating, but nothing is reaching the screen. Discord has "
                + "probably changed and Subline needs an update — this cannot be fixed by reinstalling."
        });
    }
    if (erroring) {
        return report({
            status: "loaded-erroring",
            loaded: true,
            identity,
            errorCode,
            beacon,
            pending: withinWaitingPeriod,
            summary: `Subline loaded in Discord but reported a problem (${errorCode}), and no `
                + "translation has appeared yet."
        });
    }
    return report({
        status: "loaded-idle",
        loaded: true,
        identity,
        beacon,
        pending: withinWaitingPeriod,
        // NOT a failure, and worded so it does not read as one. A channel where
        // everyone already speaks the reader's language has nothing to
        // translate, and that install is perfectly healthy.
        summary: withinWaitingPeriod
            ? "Subline is loaded in Discord. Waiting for a message to translate."
            : "Subline is loaded in Discord, but nothing has needed translating yet, so we could not "
                + "confirm it end to end. Open a channel with a foreign-language message to check."
    });
}
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
/**
 * Poll until the install is confirmed working, or until waiting stops being
 * useful — then return the most honest report available.
 *
 * Returns the LAST report either way, so the caller always has something
 * specific to show. There is no "throw on failure": every outcome here is a
 * screen, and several of them are not failures at all.
 */
export async function awaitVerification(options) {
    const clock = options.clock ?? Date.now;
    const sleep = options.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
    const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let latest = verifyOnce({ ...options, now: clock() });
    // `pending` is the poll condition rather than a bare deadline, so a state
    // that waiting cannot improve — a mod that loads and renders nothing —
    // stops the loop immediately instead of burning the whole timeout on a
    // question already answered.
    while (!latest.confirmed && latest.pending) {
        await sleep(interval);
        latest = verifyOnce({ ...options, now: clock() });
    }
    return latest;
}
//# sourceMappingURL=verify.js.map