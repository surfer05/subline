# One-Click Installer — Design Spec

**Status:** draft for review · **Date:** 2026-08-06

**Goal:** a person who has never heard of a client mod downloads one file, opens
it, answers at most one system prompt, and has working inline translation in
Discord — the app they already use, not a replacement for it.

**The Spotify test** (the user's own framing): asking someone to build Vencord
from source is asking them to make music instead of pressing play. Every
decision below is measured against that.

---

## 1. Decisions already made

| Question | Decision | Why |
|---|---|---|
| Patch Discord, or replace it? | **Patch the official app** | A replacement client costs automatic game detection and Rich Presence. The audience is gamers in voice channels; taking that away to gain a translator is a bad trade. |
| What mod do we bundle? | **Vencord + our plugin only** | A focused product. Every bug report is about translation. We do not inherit support for 340 plugins we did not write. |
| The ✦ quality tier | **Explained on the site and in the installer; the user chooses** | Google (`≈`) needs no key and works instantly. Gemini (`✦`) needs a per-user key and cannot be pooled (5 req/min). So it is presented as an informed choice, not forced and not hidden. |
| Updates (both kinds) | **Silent** | Re-patch after a Discord update and self-update to new builds, both without prompting. Disclosed clearly at install. |
| Diagnostics | **Local file, never message text, user-shareable** | This tool reads private messages including DMs. A plaintext log of other people's conversations on disk is a liability the moment a stranger installs this. |
| Existing Vencord/BetterDiscord users | **Detect, explain, let them choose** | Silently patching over someone's setup can wipe their plugins. That ends a product's reputation early. |
| Uninstall | **One click, inside the app** | Being easy to remove is what makes people willing to try software that modifies Discord. |
| Platforms | **Both — macOS and Windows** | All three interested users are probably on Windows. Shipping only macOS would be shipping to nobody who asked. |

### Windows code signing — recommendation, not yet decided

- **macOS:** sign + notarize from day one. The Developer account already exists; there is no reason to ship unsigned.
- **Windows:** ship **unsigned or OV to the first handful of users**, and hand-hold them through SmartScreen. EV certificates give immediate trust but require a **registered business entity** — a real commitment for something with no revenue.
- **The trigger to buy OV is not the warning, it is Defender quarantine.** A SmartScreen warning can be explained in a DM; a quarantined binary leaves a non-technical friend stuck with nothing to click. Watch for this during testing on the old Windows PC — if Defender quarantines, buy OV before shipping to anyone.
- Revisit EV only when hand-holding stops scaling (~dozens of users).

---

## 2. What ships

One application per platform, containing:

1. **The installer/manager UI** — the thing the user opens. Also the uninstaller, the settings surface, and the diagnostics view. It is not a run-once wizard; it stays installed.
2. **The patcher** — locates Discord, backs up the original, writes the loader.
3. **The bundled mod** — Vencord + vcTranslate, pre-built. The user never sees Node, pnpm, or a terminal.
4. **The helper** — a background agent that re-patches after Discord updates and pulls new builds.

**The helper must live inside the same signed bundle as the app**, not as a separate binary. On macOS, TCC grants attach to a code-signing identity; a standalone helper would need its own App Management grant, appearing weeks later out of nowhere, which is far more confusing than the first prompt.

---

## 3. Install flow (the spine)

Every step below is a screen with a state, because every one of them can fail
and each failure needs its own explanation.

1. **Welcome** — what this does, in one sentence, with a real screenshot of a translated message.
2. **Explain the two tiers** — `≈` free and instant, no account; `✦` better, needs a free Google key. Say plainly that `✦` can be set up now or any time later from settings. This is the "informed choice" decision.
3. **Detect Discord** — which branches are installed (Stable/PTB/Canary), and which are running.
4. **Detect existing mods** — Vencord, BetterDiscord, Equicord. If found: show what was found, what would happen to it, and offer Proceed / Cancel.
5. **Quit Discord** — required for patching. Offer to quit it for them; never kill it without asking.
6. **Permission** (macOS only) — see §4.
7. **Patch** — backup, write, verify.
8. **Install the helper** — LaunchAgent / Scheduled Task.
9. **Launch Discord and verify** — see §7. Do not declare success until translation is confirmed working.
10. **Optional ✦ setup** — guided Google AI Studio key flow, skippable.

---

## 4. macOS specifics

### App Management is unavoidable and must be designed for

Modifying Discord.app triggers macOS App Management. **Our Team ID does not
exempt us** — the exemption applies only when the modifier is signed by the
*same team* as the app being modified, or when the target ships an
`NSUpdateSecurityPolicy` authorising us. Discord does neither.

Worse, it is not a tidy Allow/Deny dialog: the write is **blocked**, a
notification appears, and the user must go to **System Settings** to flip a
toggle. This is exactly the round trip that happened three times during
development (ClaudeCode, then Terminal, then Zed) and each time it read as a
failure rather than a step.

**Required UX:**
- Anticipate the block. Do not attempt the write and report a generic error.
- Explain before attempting: "macOS will ask permission for us to update Discord. Here's why."
- Provide a button that deep-links to the exact pane:
  `x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles`
- **Poll for the grant and continue automatically.** Never require the user to quit and re-run — that is what turns one step into a dead end.
- If the user denies: explain what will not work and offer to retry, rather than dying.

### Signing

Developer ID Application, hardened runtime, notarized via `notarytool`, stapled.
Without notarization users hit Gatekeeper *before* App Management — two walls
instead of one.

The stable Team ID is what makes the App Management grant **persist across our
own updates**. An ad-hoc-signed binary changes identity when it changes and can
be re-prompted every time.

### Paths

- App: `/Applications/Discord.app` (also PTB/Canary variants)
- Patch target: `Contents/Resources/app.asar`, original preserved as `_app.asar`
- Helper: LaunchAgent in `~/Library/LaunchAgents/`
- Logs: `~/Library/Logs/<Product>/`

---

## 5. Windows specifics

### Structurally different from macOS — do not port assumptions

**Easier:** Discord installs to `%LOCALAPPDATA%\Discord\` — per-user, so **no
UAC and no permission gate at all**. There is no App Management equivalent. The
install itself is smoother than macOS.

**Harder in three ways:**

1. **Versioned folders.** Discord lives in `app-1.0.xxxx\` and every update
   creates a *new* directory. The patch is not overwritten — it is orphaned in
   an old folder. The repatcher must resolve the newest versioned directory on
   every check, not watch a fixed path.
2. **Update timing.** Prior art ([VencordAutoRepair], [BetterVencordPatch],
   [VencordAutoUpdater]) all wait for Discord's updater to *settle* before
   repatching. Racing the updater produces a half-patched install. Steal this
   rather than rediscovering it.
3. **AV false positives.** An app that patches another application and installs
   a scheduled task is textbook antivirus-flag material. **This is the real
   Windows risk, more than SmartScreen.**

### SmartScreen

OV certificates show the publisher name but still warn until reputation accrues
from install volume. EV gives immediate trust but requires a registered
business. See §1 — deferred deliberately.

**Required UX:** if shipping unsigned or OV, the download page must show what
the warning looks like, with a screenshot, and the exact clicks. A user who
expects the warning experiences a step; a user surprised by it assumes malware.

### Paths

- Discord: `%LOCALAPPDATA%\Discord\app-<version>\`
- Patch target: `resources\app.asar`, original preserved
- Helper: Scheduled Task (at logon + periodic)
- Logs: `%LOCALAPPDATA%\<Product>\logs\`

---

## 6. The helper (both platforms)

Two independent triggers, both silent:

| Trigger | Action |
|---|---|
| Discord version changed | Wait for the updater to settle, then re-patch |
| New build published | Download, verify signature, install, re-patch |

**Why both:** re-patching alone is not enough. Two different things break on a
Discord update, and only one is repairable automatically:

- **The injection is wiped** — mechanical, always fixable by re-patching.
- **The patches stop matching** — Discord ships a new frontend bundle and
  Vencord's webpack finders no longer locate `MessageStore` / `FluxDispatcher`,
  or the message-renderer patch fails. The mod loads and silently renders
  nothing. **No amount of re-patching fixes this** — it requires merging
  Vencord's upstream fixes and shipping a new build.

The helper must therefore also be an updater, or the product dies quietly the
first time Discord rewrites its frontend.

**Health check, not just patch check.** The helper should verify the mod is
actually *working*, not merely present — see §7. A patch that applied cleanly
but no longer functions is the failure mode the user cannot diagnose and we
cannot see.

---

## 7. Verification and diagnostics

This is the section the development history most demands. Four separate problems
this week each took multiple rounds because the plugin only logged warnings and
there was no way to see what it had decided.

### Post-install verification

Do not declare success on "the file was written". Confirm the whole chain:

1. Patch file present and pointing at our bundle
2. Discord launched
3. The mod loaded (renderer reports in)
4. **A translation actually rendered** — the strongest available signal

If step 4 cannot be confirmed, say so honestly rather than showing a green tick.
A false success is worse than a clear "installed, but we could not confirm it is
working — here's how to check."

### The log

- Rotating local file, human-readable, with timestamps and a version header
  (product version, Discord version, mod version, OS).
- **Never message text.** Decisions, counts, ids, errors, timings — not content.
  The plugin's own `debugLogging` setting stays separate and stays off by
  default; that one *does* include text and says so.
- Records: patch attempts and results, permission grants/denials, Discord
  version changes, helper runs, update checks, mod-load results, health checks.
- **"Copy diagnostics" button** in the app that puts a redacted bundle on the
  clipboard for a bug report.

### The known failure catalogue

Every one of these was hit during development. Each needs a specific, named
error state — not a generic failure:

| Failure | Handling |
|---|---|
| Discord running during patch | Offer to quit it; never force-kill silently |
| macOS App Management denied | §4 — explain, deep-link, poll, retry |
| Discord updated, patch orphaned | Helper re-patches (Windows: new versioned folder) |
| Discord frontend changed, patches stale | Health check detects; helper pulls a new build; if none exists, tell the user plainly |
| Existing Vencord/BetterDiscord | Detect, explain, let them choose |
| Antivirus quarantine (Windows) | Detect missing files post-install; link to instructions |
| Disk permission / read-only volume | Named error, not a stack trace |
| Discord installed somewhere unusual | Manual path picker as a fallback |
| Partially applied patch | Verify after write; roll back to the backup on mismatch |

---

## 8. Uninstall

One click, from inside the app:

1. Restore the original `app.asar` from backup
2. Remove the helper (LaunchAgent / Scheduled Task)
3. Remove the bundled mod
4. Offer to keep or delete settings and the translation cache
5. Confirm Discord launches clean

If the backup is missing, say so and point at Discord's own repair/reinstall
rather than leaving a broken client behind.

---

## 9. Testing plan

Because "restart Discord and see" is what cost this project days.

- **macOS:** clean VM, no Developer tools, no prior Vencord. Full install, verify translation, force a Discord update, confirm silent re-patch, uninstall, confirm Discord is clean.
- **Windows:** same on the old PC. Additionally: confirm the versioned-folder repatch works across a real Discord update, and **watch for Defender quarantine** — that result decides the OV certificate question.
- **Existing-mod case:** install Vencord manually first, then run our installer, confirm the detection screen is accurate.
- **Denial case:** deny App Management, confirm the retry path works without re-running.
- **Offline case:** install with no network; it should degrade clearly, not hang.

---

## 10. Open questions

1. **Product name** — blocks bundle identifier, certificate CN, site domain, and the uninstall entry. Nothing else can be finalised without it.
2. **Source visibility** — Vencord is GPL-3.0. A distribution built on it inherits that: the source must be published, and anyone may fork it. Charging is still permitted; keeping it proprietary is not. This needs a deliberate decision before the first public release, not after.
3. **Update channel** — GitHub Releases is the obvious default and is free. Confirm.
4. **Discord branches** — support Stable only at first, or PTB/Canary too?

---

[VencordAutoRepair]: https://github.com/Extrautior/VencordAutoRepair
[BetterVencordPatch]: https://github.com/AaronWijesinghe/BetterVencordPatch
[VencordAutoUpdater]: https://github.com/Febsho/VencordAutoUpdater
