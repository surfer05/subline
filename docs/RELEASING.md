# Releasing Subline

Everything needed to turn a clean checkout into signed, notarized, stapled
artefacts plus a release manifest — and what to tell users about the Windows
build, which is deliberately unsigned.

**Spec:** `docs/superpowers/specs/2026-08-06-one-click-installer.md` §1, §4, §5, §10
**Report:** `.superpowers/sdd/packaging.md`

---

## The short version

```sh
cd installer
export APPLE_KEYCHAIN_PROFILE=subline-notary   # one-off setup below
export SUBLINE_NOTARIZE=1
pnpm release --win
```

One command. It refuses to start on a dirty tree, refuses to build an
un-notarized release, and **does not publish** — it prints the `gh release create`
line for you to run.

### Nothing signs unless you ask it to

**Every build in this repository is unsigned by default.** electron-builder's own
default is the opposite: on macOS it searches the login keychain for any usable
identity and signs with it, which raises a keychain authorisation prompt for a
build nobody asked to be signed — and signs the artefact with whatever certificate
happens to be installed.

`electron-builder.js` therefore sets `mac.identity: null` (electron-builder's
explicit "do not sign") and `CSC_IDENTITY_AUTO_DISCOVERY=false` unless
`SUBLINE_SIGN` is set. **`pnpm release` is the only thing that sets it**, and only
after you have opted into notarization as well. `pnpm run pack:dir`,
`pnpm dist:mac`, `pnpm dist:win`, `pnpm dist` and `pnpm release --dry-run` never
reach the keychain.

To sign without the release script:

```sh
SUBLINE_SIGN=1 SUBLINE_NOTARIZE=1 pnpm dist:mac
```

---

## 1. One-off setup

### The signing certificate

You need a **Developer ID Application** certificate in the login keychain. Check
that it is there:

```sh
security find-identity -v -p codesigning
```

You are looking for a line reading `Developer ID Application: <your name> (TEAMID)`.
If it is there, electron-builder finds it on its own and **no environment
variable is needed** — `electron-builder.js` deliberately pins no `identity`, so
nothing about your Team ID is in this repository.

On a machine without the keychain entry (CI, a second Mac), export the `.p12`
instead:

| Variable | What it is |
|---|---|
| `CSC_LINK` | Path to the `.p12`, or its base64 |
| `CSC_KEY_PASSWORD` | The password for it |

### The notarization credential

The **recommended** form stores the credential in the keychain once, so no
password is ever passed on a command line where `ps` can read it:

```sh
xcrun notarytool store-credentials subline-notary \
  --apple-id "you@example.com" \
  --team-id "YOURTEAMID" \
  --password "abcd-efgh-ijkl-mnop"      # app-specific password from appleid.apple.com
```

Then only the profile name is ever used:

```sh
export APPLE_KEYCHAIN_PROFILE=subline-notary
```

Two alternatives are supported, in this order of preference:

| Form | Variables |
|---|---|
| Keychain profile (recommended) | `APPLE_KEYCHAIN_PROFILE` |
| App Store Connect API key | `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY` (path to the `.p8`) |
| Apple ID + app-specific password | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

The last one puts the password into the process table for the duration of the
submission. It works; prefer the first.

### The switch

Notarization is **opt-in**, so a local `pnpm run pack:dir` never needs a
credential:

```sh
export SUBLINE_NOTARIZE=1
```

`pnpm release` refuses to run without it (or `--dry-run`), because a
signed-but-not-notarized build makes users hit Gatekeeper *before* App
Management — two walls instead of one (§4).

**No credential is ever written into the repository.** Every variable above is
read from the environment at the moment it is used.

---

## 2. What `pnpm release` does

| # | Step | Needs credentials |
|---|---|---|
| 1 | Preflight: clean tree, current build stamp, both test suites, typecheck | |
| 2 | `build:mod` — Vencord at the pinned commit + the plugin | |
| 3 | Check the bundle's build id is the one this checkout produces | |
| 4 | `build:app` — compile the Electron app | |
| 5 | `electron-builder --mac` → signs, then `afterSign` notarizes and staples the `.app` | **yes** |
| 6 | `electron-builder --win` (with `--win`) — unsigned, deliberately | |
| 7 | `ditto` the mod bundle into `subline-mod-<buildId>.zip` | |
| 8 | Notarize and staple each `.dmg` | **yes** |
| 9 | Write `subline-release.json` and `SHA256SUMS`, print the publish command | |

Flags: `--win`, `--dry-run` (everything but the two signing steps), `--skip-tests`,
`--allow-dirty` (never for a real release — the build id is a digest of the
plugin's sources, so a dirty tree produces an id that names a tree existing on
one laptop).

### Doing it by hand

If you need to run the steps individually:

```sh
pnpm build:mod && pnpm build:app
pnpm dist:mac                                  # signs; notarizes if SUBLINE_NOTARIZE=1
xcrun notarytool submit release/Subline-0.1.0-arm64.dmg --wait \
      --keychain-profile subline-notary
xcrun stapler staple release/Subline-0.1.0-arm64.dmg
xcrun stapler validate release/Subline-0.1.0-arm64.dmg
spctl --assess --type open --context context:primary-signature -vv \
      release/Subline-0.1.0-arm64.dmg
```

`stapler validate` and `spctl --assess` are how you confirm it worked. Do not
trust "notarytool said Accepted" alone: a ticket that was issued and not stapled
still fails on a machine with no network.

---

## 3. Publishing

The release script prints the command; it never runs it.

```sh
gh release create v0.1.0 --repo surfer05/vctranslate \
  --title "Subline 0.1.0" --notes-file notes.md \
  release/subline-release.json \
  release/SHA256SUMS \
  release/Subline-0.1.0-arm64.dmg \
  release/Subline-0.1.0-x64.dmg \
  release/subline-mod-<buildId>.zip \
  release/Subline-Setup-0.1.0.exe
```

**`subline-release.json` must be attached to every release**, under exactly that
name. It is what installed copies of Subline poll, at

```
https://github.com/surfer05/vctranslate/releases/latest/download/subline-release.json
```

which GitHub redirects to the newest published release's asset of that name. That
is why the URL compiled into a shipped app never changes.

### After the first release

`src/helper/feed.ts` has `RELEASE_FEED_ENABLED = false`. Flip it to `true` and
ship the **next** build with it on. Not before: the URL 404s until a release
exists, and a 404 on every hourly run raises "Subline cannot check for updates"
for a feature that has not shipped — the false warning §6 says makes true ones
get ignored.

---

## 4. The release manifest

`subline-release.json`, read by `src/helper/release.ts` and written by
`packaging/manifest.ts`:

```json
{
    "format": 1,
    "product": "subline",
    "buildId": "e3f2e5ef4a6e7ba6",
    "pluginVersion": "0.1.0",
    "publishedAt": "2026-08-07T09:00:00.000Z",
    "artifact": {
        "name": "subline-mod-e3f2e5ef4a6e7ba6.zip",
        "url": "https://github.com/surfer05/vctranslate/releases/download/v0.1.0/subline-mod-e3f2e5ef4a6e7ba6.zip",
        "bytes": 812345,
        "sha256": "…64 hex…"
    },
    "signature": null
}
```

**The artefact is the mod bundle, not the app.** The helper's second trigger
ships new plugin and Vencord code to an already-installed Subline (§6); the app
itself updates by the user downloading a new DMG.

**What the checksum proves and what it does not.** It proves the download matches
what the feed said — a truncated download, a CDN serving the wrong bytes, a
half-uploaded asset. It does **not** prove we published it: anyone who can serve
the manifest can serve a matching digest for anything. Transport authenticity
rests entirely on TLS to GitHub, which is why `assertTrustedUrl` refuses anything
that is not HTTPS on an allow-listed GitHub host. `signature` is the field a
detached signature lands in, and `REQUIRE_SIGNATURE` in `release.ts` is the
one-line switch that makes an unsigned release refuse to install once there is a
key to check against.

---

## 5. macOS: the two permission walls

Users meet **Gatekeeper** first and **App Management** second, and notarization is
what removes the first one.

**There is no entitlement that lets an application modify another application.**
Writing inside `Discord.app` is governed by TCC's App Management service, which
is a *user grant* made in System Settings › Privacy & Security › App Management.
It cannot be requested, declared or entitled. Three consequences:

1. **The app must not be sandboxed.** A sandboxed app cannot hold App Management
   over an arbitrary bundle, and no entitlement brings that back. So
   `com.apple.security.app-sandbox` is deliberately absent.
2. **The grant attaches to the code-signing identity**, which is why Developer ID
   is required rather than ad-hoc signing: a stable Team ID is what makes the
   permission survive Subline's own updates, and what lets the LaunchAgent helper
   — the same bundle, run with `--helper` — write to Discord under the permission
   the user already gave.
3. **Its wording is not ours.** macOS supplies the App Management text and names
   the app; there is no usage-description key for it, unlike Automation. The only
   levers are the product name and the signed identity, so the *installer's own*
   explanation screen (`permission-explain`) is where the reasoning has to live.

The entitlements that are present, each because something breaks without it:

| Entitlement | Why |
|---|---|
| `com.apple.security.cs.allow-jit` | V8 compiles JS at runtime; without it the renderer aborts |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Chromium's W→X pages; a startup crash, not a prompt |
| `com.apple.security.automation.apple-events` | `osascript … tell application "Discord" to quit` (§7: offer, never force-kill) and the helper's notifications |

Deliberately absent: the sandbox, `disable-library-validation` (we load no
third-party native code) and `allow-dyld-environment-variables` (letting a library
be injected into a process that edits another app is worth more to an attacker
here than almost anywhere).

`NSAppleEventsUsageDescription` in `extendInfo` is the string the user reads in
the Automation prompt. That one *is* ours to write.

---

## 6. Windows: unsigned, and what that means

Per spec §1 and §10: **unsigned for now.** An EV certificate needs a registered
business entity and ~$500/yr, which is not justifiable pre-revenue.

### What a user will see

Downloading and running `Subline-Setup-0.1.0.exe` shows:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognised app from starting.
> Running this app might put your PC at risk.

with a single **Don't run** button. The way through is **More info → Run anyway**,
and it is not discoverable — the link looks like body text.

**The download page must show this screenshot and those exact clicks.** A user who
expects the warning experiences a step; a user surprised by it assumes malware.
This is a documentation requirement, not a nicety.

### The result that changes the plan

SmartScreen is survivable. **Defender *quarantine* is not.** An unsigned binary
that patches another application and installs a scheduled task is close to a
textbook Defender heuristic, and a quarantined binary leaves a non-technical
friend with nothing to click.

> *"Click More info → Run anyway"* is a fine thing to ask a friend.
> *"Add a Defender exclusion"* is not.

**Run the installer on the old Windows PC before shipping to anyone.** If Defender
quarantines it, either buy an OV certificate or ship macOS first and tell the
Windows users theirs is coming. Do not ship something that requires a security
exclusion.

The NSIS installer is configured `perMachine: false` and `allowElevation: false`
on purpose: Discord lives in `%LOCALAPPDATA%\Discord`, so there is no UAC gate to
pass, and an unsigned installer that *also* demands admin is strictly more
suspicious to a heuristic scanner.

### Adding a certificate later

A config change, not a rewrite. Set two environment variables and rebuild:

```sh
export CSC_LINK=/path/to/cert.pfx      # or its base64
export CSC_KEY_PASSWORD=…
pnpm dist:win
```

electron-builder signs with no edit to `electron-builder.js` at all. For a
hardware token (EV certificates are token-bound), add `certificateSubjectName`
and `signingHashAlgorithms` to the `win` block.

---

## 7. What packaging refuses to do

Three hooks in `packaging/hooks.mjs`, each of which **fails the build** rather
than warning:

- **`beforePack`** — the mod bundle in `build/mod` must be the build this checkout
  produces. `build/mod` is gitignored and survives branch switches, so a stale one
  is not hypothetical: it would ship a bundle whose recorded build id no committed
  source produces, and every check downstream would pass.
- **`afterPack`** — the same check against the copy *inside* the packed app, which
  is the only place the `extraResources` promise can be observed rather than
  assumed.
- **`afterSign`** — notarize and staple the `.app` before the DMG wraps it, so the
  ticket travels with the thing the user opens.

---

## 8. Verifying a build you have in your hand

```sh
codesign -dv --verbose=4 /Applications/Subline.app          # identity, Team ID, runtime flags
codesign -d --entitlements - /Applications/Subline.app      # the effective entitlements
xcrun stapler validate /Applications/Subline.app            # the ticket is attached
spctl --assess --type execute -vv /Applications/Subline.app # what Gatekeeper will decide
shasum -a 256 -c SHA256SUMS                                 # run inside the download directory
```

`codesign -dv` should report `flags=0x10000(runtime)` and your Team ID.
`spctl --assess` should say `accepted` and `source=Notarized Developer ID`.
