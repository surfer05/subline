/**
 * The packaging configuration.
 *
 * ## Why it is a module and not `package.json`'s `build` field
 *
 * electron-builder validates its configuration against a strict schema and
 * **rejects unknown keys**, including the `"//comment"` convention the rest of
 * this project uses to keep reasoning next to the decision it explains. So a
 * configuration in `package.json` is a configuration with no explanation, and
 * every value below is one somebody will otherwise change without knowing what it
 * was for. `package.json` deliberately has no `build` field: it takes priority
 * over this file, so a leftover one would silently win.
 *
 * **The filename is not decorative.** electron-builder auto-discovers exactly
 * `electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}` — `electron-builder.config.js`,
 * which the documentation mentions, is NOT on that list and is silently ignored,
 * which is how a build ends up named `@sublineinstaller.app` in the wrong output
 * directory with none of this applied. With `"type": "module"` in `package.json`
 * the `.js` form is imported as ESM. `tests/packaging.test.ts`
 * imports THIS FILE, so what the tests assert about and what the build reads are
 * the same object.
 *
 * ## The shape of the thing being built
 *
 *   dist/            the compiled app (tsc + copyRenderer)
 *   build/mod/       the assembled mod bundle (buildMod.mjs) → Contents/Resources/mod
 *   packaging/       entitlements and hooks — inputs, not outputs
 *   release/         what comes out
 */

/**
 * SIGNING IS OPT-IN. THIS IS THE MOST IMPORTANT LINE IN THE FILE.
 *
 * electron-builder's default on macOS is to go looking in the login keychain for
 * any usable signing identity and sign with it. That default is wrong for this
 * project in a way that costs somebody something real: a routine "does it
 * package at all" build raises a **keychain authorisation prompt** on the
 * developer's machine and signs an artefact with a certificate nobody meant to
 * use — and on a shared or CI machine, with whoever's certificate happens to be
 * installed. It happened exactly once during this task, which is why the guard
 * exists rather than a note asking people to remember.
 *
 * So the default is `identity: null`, which is electron-builder's explicit "do
 * not sign at all". Signing happens only when `SUBLINE_SIGN` is deliberately set,
 * and `docs/RELEASING.md` documents it as a command the release engineer runs.
 * `pnpm release` sets it; nothing else does.
 */
const SIGNING_REQUESTED = process.env.SUBLINE_SIGN === "1" || process.env.SUBLINE_SIGN === "true";

/**
 * Belt and braces. `identity: null` already disables it, but auto-discovery is
 * what raises the keychain prompt, and it runs from more than one code path
 * inside electron-builder (`@electron/osx-sign`, the DMG signer, the
 * `signAndEditExecutable` path). Turning the discovery itself off means no code
 * path can reach the keychain, rather than every code path being individually
 * configured not to.
 */
if (!SIGNING_REQUESTED) process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

/**
 * @type {import("electron-builder").Configuration}
 */
const config = {
    appId: "com.subline.installer",
    /**
     * Also the name of the executable inside the bundle, which is what the
     * LaunchAgent's `ProgramArguments` points at — `<App>/Contents/MacOS/Subline`.
     * `tests/packaging.test.ts` holds the two together: a mismatch is a helper
     * launchd can never start, and it would be silent forever.
     */
    productName: "Subline",
    copyright: "Copyright © 2026 the Subline contributors. GPL-3.0-or-later.",

    directories: {
        output: "release",
        /**
         * NOT the default `build/`. That directory is gitignored and holds the
         * assembled mod bundle and a full Vencord checkout — outputs. `packaging/`
         * holds the entitlements and the hooks, which are inputs.
         */
        buildResources: "packaging"
    },

    /**
     * The compiled app and nothing else. `src/`, `tests/` and `packaging/` are
     * absent deliberately: the code that packages the artefact has no business
     * inside the artefact.
     */
    files: ["dist/**/*", "package.json"],

    /**
     * Ship one Chromium locale instead of fifty-five.
     *
     * Electron bundles a `.pak` per locale — 40 MB unpacked, against 480 KB for
     * the one we use. They translate CHROMIUM's own strings (text-field context
     * menus and the like), not ours: this window's interface is English, and the
     * reading language the user picks decides what Discord's messages are
     * translated INTO, nothing about this app.
     *
     * An explicit list rather than a post-build deletion hook, so the decision
     * is visible where the rest of the packaging lives. If the installer's own
     * interface is ever localised, this is the line that has to grow with it.
     *
     * Note what is deliberately NOT trimmed alongside it: the `.js.map` files
     * are 280 KB in total, and readable stack traces have paid for themselves
     * repeatedly here. Trading diagnosability for a tenth of a percent would be
     * exactly the wrong compromise.
     */
    electronLanguages: ["en-US"],

    /**
     * The mod bundle ships at `Contents/Resources/mod` and is COPIED OUT to
     * `~/Library/Application Support/Subline/mod` on install. It must never be
     * loaded from here — see `src/app/modInstall.ts`: App Translocation would make
     * the path vanish and stop Discord starting.
     */
    extraResources: [{ from: "build/mod", to: "mod" }],

    /**
     * `packaging/hooks.mjs` exports one function per hook name.
     *
     *   beforePack  the mod bundle we are about to ship is the build this
     *               checkout produces — `build/mod` is gitignored and outlives
     *               branch switches, so a stale one is not hypothetical
     *   afterPack   it actually arrived inside the app and still says the same
     *   afterSign   the signed app is notarized and carries a stapled ticket
     *
     * Each of them REFUSES rather than warns. A packaging configuration is a set
     * of promises and every one of them is silent when it does not happen; this
     * project's oldest failure is an install that was present, verified and
     * completely inert.
     */
    beforePack: "./packaging/hooks.mjs",
    afterPack: "./packaging/hooks.mjs",
    afterSign: "./packaging/hooks.mjs",

    artifactName: "${productName}-${version}-${arch}.${ext}",

    mac: {
        category: "public.app-category.utilities",
        target: [{ target: "dmg", arch: ["arm64", "x64"] }],

        /**
         * `null` means "do not sign", and it is the DEFAULT — see
         * `SIGNING_REQUESTED` at the top of this file. With `SUBLINE_SIGN` set,
         * the key is absent instead and electron-builder auto-discovers the
         * Developer ID Application certificate in the login keychain, or takes
         * `CSC_LINK` + `CSC_KEY_PASSWORD` from the environment.
         *
         * No identity is ever pinned by NAME here: that would put a Team ID in
         * the repository and break every other machine.
         */
        ...(SIGNING_REQUESTED ? {} : { identity: null }),

        hardenedRuntime: true,
        gatekeeperAssess: false,

        /**
         * READ `packaging/entitlements.mac.plist` BEFORE CHANGING THIS.
         *
         * The one thing worth repeating here: **no entitlement grants the right
         * to modify another application.** Writing inside `Discord.app` is
         * governed by TCC's App Management, a *user* grant made in System
         * Settings, and it attaches to the CODE-SIGNING IDENTITY. That is why
         * spec §4 requires Developer ID rather than ad-hoc signing (the grant has
         * to survive our own updates), and why the app is not sandboxed (a
         * sandboxed app cannot hold App Management over an arbitrary bundle, and
         * no entitlement would bring it back).
         */
        entitlements: "packaging/entitlements.mac.plist",
        entitlementsInherit: "packaging/entitlements.mac.inherit.plist",

        /**
         * `false` does not mean "do not notarize". `packaging/hooks.mjs`'s
         * afterSign runs `notarytool` itself, so the ticket is stapled to the
         * `.app` BEFORE the DMG wraps it — electron-builder's own step would
         * staple only the archive, leaving the app Gatekeeper-checkable online
         * but not offline.
         */
        notarize: false,

        extendInfo: {
            NSHumanReadableCopyright: "GPL-3.0-or-later",
            /**
             * What macOS shows in the Automation prompt when Subline asks Discord
             * to quit (spec §7: offer, never force-kill). Unlike App Management's
             * wording, this string is ours to write.
             */
            NSAppleEventsUsageDescription:
                "Subline asks Discord to quit before it changes it, so nothing you are part-way through typing is lost.",
            LSMinimumSystemVersion: "11.0"
        }
    },

    dmg: {
        /**
         * The DMG is not signed here: the app inside it is signed, notarized and
         * stapled, which is what Gatekeeper checks when the app is launched.
         * `scripts/release.mjs` notarizes and staples the DMG itself afterwards,
         * because the DMG is the file that carries the quarantine flag.
         */
        writeUpdateInfo: false
    },

    win: {
        /**
         * UNSIGNED, deliberately — spec §1 and §10: an EV certificate needs a
         * registered business and ~$500/yr, which is not justifiable pre-revenue.
         * `docs/RELEASING.md` has what users will see, and the ONE result that
         * changes this decision: Defender *quarantine*, not the SmartScreen
         * warning. "Click More info → Run anyway" is a fine thing to ask a
         * friend; "add a Defender exclusion" is not.
         *
         * ADDING A CERTIFICATE IS A CONFIG CHANGE, NOT A REWRITE. Setting
         * `CSC_LINK` (path or base64 of the .pfx) and `CSC_KEY_PASSWORD` in the
         * environment makes electron-builder sign with no edit to this file at
         * all. For a hardware token, add `certificateSubjectName` and
         * `signingHashAlgorithms` to this block.
         */
        target: [{ target: "nsis", arch: ["x64"] }]
    },

    nsis: {
        /**
         * Spec §5: Discord lives in `%LOCALAPPDATA%\Discord`, per-user, so there
         * is no UAC gate and no reason to ask for one. An unsigned installer that
         * ALSO demands elevation, patches another application and installs a
         * scheduled task is close to a textbook Defender heuristic (§10).
         */
        oneClick: false,
        perMachine: false,
        allowElevation: false,
        allowToChangeInstallationDirectory: true,
        deleteAppDataOnUninstall: false,
        artifactName: "${productName}-Setup-${version}.${ext}"
    }
};

export default config;
