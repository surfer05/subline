/**
 * Where the release feed is (spec §10: GitHub Releases), and the one switch that
 * turns trigger B on.
 *
 * ## Why the URL is a constant and not a setting
 *
 * The manifest decides which code gets installed into another application. A
 * feed URL that could be pointed somewhere else by an environment variable, a
 * config file or a command-line flag would be a way to make Subline install
 * arbitrary code under the App Management grant the user gave it — and it would
 * be the easiest such way, because it requires no exploit at all. `release.ts`
 * already refuses any host that is not on the allow-list; this module makes sure
 * there is nothing to point in the first place.
 *
 * ## Why `/releases/latest/download/`
 *
 * That path is a GitHub redirect which always resolves to the newest PUBLISHED
 * release's asset of that name. So the URL compiled into a shipped copy of
 * Subline never has to change, and a release is published rather than deployed —
 * there is no server, and nothing to keep running. It redirects to
 * `objects.githubusercontent.com` / `release-assets.githubusercontent.com`, which
 * is why both are on `ALLOWED_RELEASE_HOSTS` and why `redirect: "follow"` in
 * `helper/ports.ts` is safe rather than merely convenient.
 *
 * ## Why it is OFF
 *
 * `helper.md` states the reason and it has not changed: a 404 on every hourly run
 * would raise "Subline cannot check for updates" for a feature that has not
 * shipped, and spec §6 says a false warning is how true ones stop being read.
 * There is no release yet, so there is nothing at that URL yet.
 *
 * **Flipping `RELEASE_FEED_ENABLED` to `true` is the whole of turning self-update
 * on, and it is done in the same commit that publishes the first release** — not
 * before, because the URL 404s until then, and not later, because a shipped build
 * with it `false` can never be updated by anything except the user downloading a
 * new DMG.
 */

/** `owner/name` on GitHub. The release script derives every URL from this. */
export const RELEASE_REPOSITORY = "surfer05/subline";

/** The asset name the feed URL resolves to. `packaging/manifest.ts` writes it. */
export const RELEASE_MANIFEST_ASSET_NAME = "subline-release.json";

export const RELEASE_FEED_URL =
    `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/${RELEASE_MANIFEST_ASSET_NAME}`;

/**
 * `false` until the first release exists. See the header — this is the switch,
 * and it is the only one.
 */
export const RELEASE_FEED_ENABLED = true;

/**
 * The URL the helper polls, or `null` for "do not check at all".
 *
 * `null` is a real answer rather than a placeholder: `helper.ts` treats it as
 * "trigger B is not configured" and never counts it as a failed check, so an
 * inert feed raises nothing.
 */
export function releaseManifestUrl(options: { enabled?: boolean } = {}): string | null {
    return (options.enabled ?? RELEASE_FEED_ENABLED) ? RELEASE_FEED_URL : null;
}
