/**
 * Notarization and stapling (spec §4).
 *
 * ## Why this is a step and not a checkbox
 *
 * Spec §4: "without notarization users hit Gatekeeper *before* App Management —
 * two walls instead of one." The first wall has no Allow button and no
 * explanation; the second is the one the whole install flow was designed around.
 * A build that is signed but not notarized is therefore not a shippable build,
 * and the release script treats a skipped notarization as a failure rather than
 * a warning.
 *
 * ## Nothing here ever holds a credential
 *
 * Every secret is read from the environment at the moment it is used and is
 * never written anywhere. There is no credential in this repository and no code
 * path that would put one there. The RECOMMENDED form is a keychain profile —
 * `xcrun notarytool store-credentials` once, then only a profile NAME is ever
 * passed — because `--password` and `--key` appear in the process table, where
 * any other process on the machine can read them for the duration of the
 * submission.
 *
 * ## The app is stapled BEFORE the DMG is built
 *
 * A stapled ticket is what lets Gatekeeper approve the app on a machine that is
 * offline or behind a captive portal. Notarizing only the DMG leaves the app
 * inside it without one, so it is stapled in `afterSign` — after electron-builder
 * has signed the bundle, before it wraps it — and the DMG is notarized and
 * stapled afterwards by the release script. Two submissions, and both are cheap
 * compared with a user who cannot open the thing.
 *
 * ## Imports nothing of ours, and executes nothing by itself
 *
 * `exec` is a parameter. Every test in this suite constructs commands and asserts
 * on them; not one of them runs `xcrun`, submits anything to Apple, or touches a
 * credential.
 */

/** Set to `1` (or `true`) to notarize. Absent means "this is a local build". */
export const NOTARIZE_FLAG_VAR = "SUBLINE_NOTARIZE";

/** `xcrun notarytool store-credentials <name>` — the recommended, non-leaking form. */
export const KEYCHAIN_PROFILE_VAR = "APPLE_KEYCHAIN_PROFILE";

export const APPLE_ID_VARS = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"] as const;
export const API_KEY_VARS = ["APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_API_KEY"] as const;

export type NotarizeAuth =
    | { kind: "keychain-profile"; profile: string }
    | { kind: "api-key"; keyId: string; issuer: string; keyPath: string }
    | { kind: "apple-id"; appleId: string; password: string; teamId: string };

export interface AuthLookup {
    auth: NotarizeAuth | null;
    /** Which variables would have to be set, when none of the three forms is complete. */
    missing: string[];
}

function present(env: NodeJS.ProcessEnv, name: string): boolean {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * Which credential form the environment supplies.
 *
 * Ordered by how much they leak: a keychain profile passes only a name, an API
 * key passes a path to a file, and an Apple ID passes the password itself in
 * argv. First complete form wins, so a machine set up properly never falls back
 * to the leaky one by accident.
 */
export function readNotarizeAuth(env: NodeJS.ProcessEnv): AuthLookup {
    if (present(env, KEYCHAIN_PROFILE_VAR)) {
        return { auth: { kind: "keychain-profile", profile: env[KEYCHAIN_PROFILE_VAR] as string }, missing: [] };
    }
    if (API_KEY_VARS.every(name => present(env, name))) {
        return {
            auth: {
                kind: "api-key",
                keyId: env.APPLE_API_KEY_ID as string,
                issuer: env.APPLE_API_ISSUER as string,
                keyPath: env.APPLE_API_KEY as string
            },
            missing: []
        };
    }
    if (APPLE_ID_VARS.every(name => present(env, name))) {
        return {
            auth: {
                kind: "apple-id",
                appleId: env.APPLE_ID as string,
                password: env.APPLE_APP_SPECIFIC_PASSWORD as string,
                teamId: env.APPLE_TEAM_ID as string
            },
            missing: []
        };
    }
    return {
        auth: null,
        missing: [KEYCHAIN_PROFILE_VAR, ...API_KEY_VARS, ...APPLE_ID_VARS]
    };
}

export function authArgs(auth: NotarizeAuth): string[] {
    switch (auth.kind) {
        case "keychain-profile":
            return ["--keychain-profile", auth.profile];
        case "api-key":
            return ["--key-id", auth.keyId, "--issuer", auth.issuer, "--key", auth.keyPath];
        case "apple-id":
            return ["--apple-id", auth.appleId, "--password", auth.password, "--team-id", auth.teamId];
    }
}

/**
 * `--wait` is not optional: without it the command returns a submission id and
 * exits 0 while the build carries on and staples a ticket that does not exist
 * yet, which fails with a message about the ticket rather than about the race.
 */
export function notarytoolArgs(archivePath: string, auth: NotarizeAuth): string[] {
    return ["notarytool", "submit", archivePath, "--wait", ...authArgs(auth)];
}

export function stapleArgs(path: string): string[] {
    return ["stapler", "staple", path];
}

/**
 * `ditto -c -k --keepParent`, the only archive format notarytool accepts for a
 * `.app`. `--sequesterRsrc` keeps extended attributes out of the archive, which
 * is what stops a resource fork from invalidating the signature in transit.
 */
export function appArchiveArgs(appPath: string, archivePath: string): string[] {
    return ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archivePath];
}

export function isNotarizationRequested(env: NodeJS.ProcessEnv): boolean {
    const value = env[NOTARIZE_FLAG_VAR];
    return value === "1" || value === "true";
}

export type NotarizeStatus = "notarized" | "skipped";

export interface NotarizeOutcome {
    status: NotarizeStatus;
    path: string;
    /** Why it was skipped. Always present when skipped, always null when not. */
    reason: string | null;
    /** Which credential form was used, for the log. Never the credential. */
    auth: NotarizeAuth["kind"] | null;
}

export type ExecFn = (file: string, args: readonly string[]) => Promise<unknown>;

export interface NotarizeAndStapleOptions {
    /** A `.app`, a `.dmg` or a `.zip`. A `.app` is archived first; the rest are submitted as they are. */
    path: string;
    env: NodeJS.ProcessEnv;
    exec: ExecFn;
    log?: (message: string) => void;
    /** Where the temporary archive for a `.app` goes. Injected so no test writes to a real temp dir. */
    archivePathFor?: (appPath: string) => string;
    /** Remove the temporary archive. Injected for the same reason. */
    cleanup?: (archivePath: string) => void;
}

/**
 * Submit, wait, staple.
 *
 * Throws on failure rather than returning one: this runs inside an
 * electron-builder hook and inside the release script, and both must abort. A
 * release that quietly went out unnotarized is the failure spec §4 describes,
 * and it is invisible until a stranger downloads it.
 */
export async function notarizeAndStaple(options: NotarizeAndStapleOptions): Promise<NotarizeOutcome> {
    const { path, env, exec } = options;
    const log = options.log ?? (() => {});

    if (!isNotarizationRequested(env)) {
        const reason = `${NOTARIZE_FLAG_VAR} is not set, so this is a local build and ${path} was not notarized.`;
        log(reason);
        return { status: "skipped", path, reason, auth: null };
    }

    const { auth, missing } = readNotarizeAuth(env);
    if (auth === null) {
        throw new Error(
            `${NOTARIZE_FLAG_VAR} is set but no Apple credentials are in the environment. Set ${KEYCHAIN_PROFILE_VAR} `
            + `(recommended — see \`xcrun notarytool store-credentials\`), or all of ${API_KEY_VARS.join(", ")}, `
            + `or all of ${APPLE_ID_VARS.join(", ")}. Looked for: ${missing.join(", ")}.`
        );
    }

    const isApp = path.endsWith(".app");
    const archivePath = isApp
        ? (options.archivePathFor ?? ((appPath: string) => `${appPath}.notarize.zip`))(path)
        : path;

    try {
        if (isApp) {
            log(`archiving ${path} for submission`);
            await exec("/usr/bin/ditto", appArchiveArgs(path, archivePath));
        }
        log(`submitting ${archivePath} to Apple (${auth.kind}); this waits for the result`);
        await exec("/usr/bin/xcrun", notarytoolArgs(archivePath, auth));
    } finally {
        // The archive is a submission vehicle, not an artefact. Removed even when
        // the submission failed, so a retry does not staple yesterday's zip.
        if (isApp) (options.cleanup ?? (() => {}))(archivePath);
    }

    // Stapled to the ORIGINAL, never to the archive: the ticket has to travel
    // with the thing the user opens.
    log(`stapling the ticket to ${path}`);
    await exec("/usr/bin/xcrun", stapleArgs(path));

    return { status: "notarized", path, reason: null, auth: auth.kind };
}
