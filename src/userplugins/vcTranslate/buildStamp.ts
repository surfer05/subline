/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by `scripts/stampBuild.mjs` (run `pnpm stamp`). `BUILD_ID` is a
 * digest of the plugin's shipped sources, which is what makes it an IDENTITY:
 * a different build of this plugin — Vencord's own copy, an older Subline
 * install, a hand-built userplugin — cannot produce this value.
 *
 * The installer records the id it expects in `subline-patch.json` at patch
 * time and refuses to confirm a beacon that reports any other one, so "a
 * vcTranslate is running" can no longer be mistaken for "the vcTranslate we
 * just installed is running".
 *
 * `tests/buildStamp.test.ts` re-runs the generator and fails if this file is
 * stale, so the two can never drift silently.
 */

export const PLUGIN_VERSION = "0.1.0";

export const BUILD_ID = "0cb922be4e32b487";
