# Subline — design handoff

**Repo:** https://github.com/surfer05/subline
**Surfaces to design:** the installer app, the website, and the in-Discord subtitle.
**Status:** all three are functionally complete and engineer-designed. None has had design work.

---

## 1. What Subline is

Subline puts a translation underneath Discord messages written in a language you don't
read. It runs inside the Discord you already have — same app, same account, same servers.

Two translations arrive per message. A fast one within a second (Google Translate, free,
no setup), then a better one replaces it a few seconds later if the user has added an AI
key. The markers are currently `≈` for fast and `✦` for better.

## 2. Who is using it

Someone in a Discord server where people type in a language they don't read — a gaming
community, a study group, a friend group split across countries. They are **not
technical**. They did not come looking for a "client mod". They came because they can't
read what their friends are saying.

The engineering framing has been: a patcher that injects a Vencord bundle into Discord's
`app.asar`. **That framing has leaked into every surface**, and it is wrong for the person
using it. Nobody using Google Maps wants to know about relativistic clock correction in
GPS satellites — it's real, it's necessary, and it belongs nowhere near the interface.

## 3. The central design problem

This product has to ask for an unusual amount of trust, very early, before delivering any
value at all:

- The app is **not code-signed**. macOS says *"Apple could not verify this app is free of
  malware"*; Windows shows a full-screen SmartScreen warning. Signing costs several
  hundred dollars a year and is not happening yet.
- On macOS it then asks for **App Management** permission — the OS-level right to modify
  other applications. The system's own wording for this is alarming.
- It then **modifies Discord**, quits it, and restarts it.

Every one of those is legitimate and necessary. But stacked together, and rendered in an
interface that looks unfinished, they read as something you should not run. The current
interface makes each ask *harder* than it needs to be.

**So the installer is not a wizard. It is a trust ladder.** Each screen either builds
credit or spends it. The permission request is the single most expensive moment, and
everything before it exists to earn the right to make that ask.

A second, non-obvious point: the happy path is only ~6 of 25 screens. **The other 19 are
failure and edge states** — and those are exactly where a user decides whether this thing
is trustworthy or broken. They deserve at least as much design attention as the happy
path, arguably more.

---

## 4. Surface A — the installer

An Electron desktop app. Runs once, at install time. Also re-openable later to check
status or uninstall.

**Constraints:**
- Window is currently **720 × 620**, not resizable by the user. Changeable if the design
  calls for it; it is not load-bearing.
- macOS uses `titleBarStyle: "hiddenInset"`; Windows uses a standard title bar.
- **Strict CSP — no external requests of any kind.** No web fonts, no CDN, no remote
  images. Everything must be inlined or bundled. System font stacks or embedded font
  files only.
- Must work in **light and dark**, following the OS.
- Renderer is plain TypeScript + DOM, no framework. A design that needs one is fine to
  propose; say so explicitly.

### 4.1 Every state

The renderer draws exactly what the state machine hands it: a title, one sentence, an
optional payload, and a list of permitted actions. It never invents a button.

**Happy path (what most people see):**

| State | Current title | Current sentence | Register |
|---|---|---|---|
| `welcome` | Welcome | Subline adds a translation underneath messages written in another language, inside the Discord you already use. | First impression. Carries the whole trust burden. |
| `tiers` | Two levels of translation | ≈ is free, instant, and needs no account. ✦ is better and needs a free key — you can set it up now or any time later. | An informed choice, not a upsell. |
| `detecting` | Looking for Discord | Looking for Discord… | Momentary. |
| `choose-language` | Your reading language | Subline will translate messages into *{language}*. Change it if that is not the language you read. | Pre-filled from the OS locale. |
| `permission-explain` | macOS needs your permission | *(explains App Management before triggering it)* | **The most expensive screen in the product.** |
| `permission-waiting` | Waiting for permission | Waiting for permission. Turn Subline on under Privacy & Security › App Management — this screen will move on by itself. | Polls; advances by itself. |
| `patching` | Installing | Adding Subline to Discord… | Momentary. |
| `installing-helper` | Setting up background updates | Setting Subline up to repair itself after Discord updates… | Momentary. |
| `launching` | Starting Discord | Starting Discord… | Momentary. |
| `verifying` | Checking it works | Checking that translation is actually working. This waits for a message in another language to appear. | Can take a while, or honestly fail. |
| `done` | Finished | *(see §4.2 — the outcome is conditional)* | The payoff. Currently underwhelming. |

**Blocked / conflict states:**

| State | Current title | Situation |
|---|---|---|
| `discord-not-found` | Discord not found | Can't locate Discord. Offers manual folder picking. |
| `choose-install` | Which Discord? | More than one Discord found. Rare. |
| `betterdiscord-blocked` | BetterDiscord is installed | **Hard refusal — no way to proceed.** Design must not invent one. |
| `mod-conflict` | Another mod is installed | Vencord/Equicord present. Offers "Replace it and continue". Destructive; must feel it. |
| `already-installed` | Subline is already set up | Reopened after a successful install. Should feel reassuring, not like a dead end. |
| `broken-install` | Discord needs repairing | Half-patched Discord. Offers repair. |
| *(same state)* | Subline couldn't read Discord | Same state, permission problem, **different heading** — because pointing someone at destructive "repair" for a healthy install is wrong. |
| `mod-bundle-invalid` | Subline is damaged | Our own bundle failed its integrity check. Re-download. |

**Discord-is-running states:**

| State | Current title | Situation |
|---|---|---|
| `discord-running` | Discord is running | Offers "Quit Discord for me". |
| `quit-blocked` | Discord is still running | Polite quit failed. On Windows this usually means Discord went to the system tray. Offers "Close Discord anyway" — a user-consented force quit, offered **once**. |

**Failure states:**

| State | Current title | Note |
|---|---|---|
| `permission-blocked` | Permission not granted | Deep-links to the exact Settings pane. |
| `patch-failed` | Could not install | Shows a named error code, path, and underlying cause. |
| `helper-failed` | Background updates are not set up | **Partial success.** Translation works; self-repair doesn't. Must not read as total failure. |
| `launch-failed` | Could not start Discord | Installed fine, couldn't launch. |
| `cancelled` | Cancelled | "Nothing was changed. Discord is exactly as it was." Reassurance, not an error. |

**Actions** (the full vocabulary; the renderer only ever draws from this list):
Continue · Cancel · Choose Discord… · Choose · Replace it and continue · Quit Discord for
me · Close Discord anyway · Check again · Open System Settings · Try again · Continue
without background updates · I'll open Discord myself · Done

Also persistently available: **Copy diagnostics** and **Uninstall**.

### 4.2 Invariants design must not break

These are correctness properties, not preferences. They came from real failures.

1. **The success tick is conditional.** The final screen shows a green tick *only* when a
   translation was observed actually rendering in Discord. Otherwise it says "Installed —
   but we could not confirm it is working." **Design must keep two visually distinct
   outcomes on the last screen.** A single triumphant end state would be a lie in the case
   we cannot verify.
2. **A refusal offers no way past.** `betterdiscord-blocked` has no proceed button by
   construction. Design must not add one, or style Cancel as if it were one.
3. **Progress must not be faked.** No indeterminate bar pretending to be determinate. Some
   steps genuinely take unknown time (`verifying` waits for a real foreign-language
   message to appear).
4. **Errors keep their detail.** Every failure shows a code, path and underlying cause.
   It can be visually de-emphasised or behind a disclosure — it must remain copyable.
   Hiding it cost days of debugging.
5. **"Uninstall" must not read as "delete Discord".** Early wording genuinely scared the
   product owner. It restores Discord to byte-identical original state.
6. **Destructive actions must be named for what they cost.** "Continue without background
   updates", not "Skip". The user is giving up self-repair and should know it.

### 4.3 What is weakest right now

- `welcome` does nothing to earn trust — it's a sentence and a Continue button.
- `permission-explain` is the highest-stakes screen and looks like every other one.
- `done` has no sense of payoff. It should feel like something was achieved.
- Failure states are indistinguishable from each other in tone; a recoverable hiccup looks
  the same as a hard refusal.
- Nothing communicates "this is safe and reversible", which is the single most important
  message in the entire flow.

---

## 5. Surface B — the website

Currently `site/index.html`: one self-contained page, no external assets, deploys to
Vercel. Content is right; presentation is engineer-grade.

**Sections:** hero + live example of what a translated message looks like · downloads
(macOS Apple Silicon / Intel, Windows) · how it works · the two translation tiers · what
gets sent where (privacy) · installing, **including a walkthrough of the security
warnings** · keeping it working · uninstalling · source/GPL-3.0 · disclaimers.

**Notes:**
- The **security-warning walkthrough is a conversion-critical section**, not fine print.
  Someone who hits "Apple could not verify this app" with no guidance simply stops.
- Download links resolve at runtime from the GitHub API; buttons must work before that
  resolves.
- Mac architecture is **asked, not detected** — no browser API can tell Apple Silicon from
  Intel, and guessing hands half of visitors a file that won't open.
- The honest privacy section stays. Message text does go to third-party APIs, DMs are off
  by default, and saying so plainly is a trust asset, not a liability.
- Must state it is unaffiliated with Discord.

---

## 6. Surface C — the in-Discord subtitle

The actual product, seen far more than the other two combined. Currently a line under each
foreign-language message:

```
≈ pt · hey beautiful
✦ ar · when we start writing, we make a mix of arabic and french
```

- `≈` = fast/Google, `≈` upgrades to `✦` = AI, in place, a few seconds later.
- A `?` after the language code means low detection confidence.
- There is also a chat-bar indicator showing quota state, and per-message actions
  (force-translate now, enable/disable this channel).

**Known problem, in the product owner's words:** an earlier indicator reading `✦ 3` was
meaningless to a normal user — "my understanding itself was 3 calls remaining and I was
wrong, think about normies then". The glyph vocabulary needs a designer's pass: it has to
be compact enough to sit under every message without shouting, while still distinguishing
fast from good, and confident from uncertain.

**Constraint:** this renders inside Discord and must sit naturally with Discord's own
typography and spacing without imitating Discord's brand or looking like a Discord
feature.

---

## 7. Open questions for design

1. Does the installer stay a single 720×620 window, or become something more paced?
2. How should the trust story be told visually — and how much can be carried before the
   permission ask versus at it?
3. Is there an identity here at all yet? There is no logo, no palette, no type choice.
   `✦` is a placeholder someone typed, not a mark.
4. How should the two translation tiers be expressed to someone who does not care how
   machine translation works?
5. How do partial successes look — installed but unverified, installed but no self-repair?
6. Windows and macOS: one design, or platform-native divergence?

## 8. What we are not asking for

Any change to what the states *are*, or to what the software claims. The state machine is
correct and heavily tested (666 tests). Design is free to re-title, re-word, re-group,
re-sequence and re-render anything — but a screen cannot claim more certainty than the
state carries.
