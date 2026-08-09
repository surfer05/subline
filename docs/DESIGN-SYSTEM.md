# Design system — contract and Claude Design prompt

Two documents in one:

- **§1** is the prompt to paste into Claude Design.
- **§2–§5** are the output contract it refers to. Both sides honour this, which is what
  makes a design change propagate by replacing files rather than by re-implementing.

---

## 0. Why the contract exists

The site and the installer have already drifted into two accidental design systems:

| | installer | site |
|---|---|---|
| accent | `#5865f2` | `#8b7bf7` |
| error token | `--danger` | `--warn` |
| default scheme | light-first | dark-first |
| extra tokens | — | `--panel`, `--radius` |

Neither was designed; both were typed. If Claude Design produces work against one
vocabulary and the surfaces consume another, every sync becomes a manual reconciliation.
So: **one token file, imported by both surfaces, is the entire integration.**

---

## 1. The prompt

> Design the product surfaces for **Subline**, a Discord translation tool.
>
> **Read first:** `github.com/surfer05/subline` — specifically `docs/DESIGN-BRIEF.md`
> (what the product is, who uses it, all 25 installer states, and the invariants a design
> must not break) and `docs/DESIGN-SYSTEM.md` (the output contract below, §2–§5).
>
> **The core problem.** An unsigned app asks for permission to modify another app. macOS
> says "Apple could not verify this app is free of malware", then asks for App Management.
> Every one of those asks is legitimate and necessary, and the current interface — which
> was written by an engineer, not designed — makes each one harder than it needs to be.
> The installer is not a wizard, it is a trust ladder. Design has to earn the right to
> make that permission ask.
>
> Only about 6 of 25 installer screens are the happy path. The other 19 are failures,
> conflicts and refusals, and those are precisely where someone decides whether this is
> trustworthy or broken. Please treat them as first-class.
>
> **There is no identity yet.** No logo, no palette, no type choice. `✦` is a character
> someone typed, not a mark. That is open.
>
> **Deliver, in this order:**
> 1. `tokens.css` — the full token set in §2, both colour schemes.
> 2. Primitives — button variants, the error/warning block, the list, the select, the
>    spinner/progress treatment, the status/verdict block.
> 3. Installer screens — at minimum `welcome`, `tiers`, `permission-explain`, `done` in
>    both its confirmed and unconfirmed forms, `betterdiscord-blocked`, `patch-failed`,
>    and `already-installed`.
> 4. Site sections — hero with the translated-message sample, downloads, the security
>    warning walkthrough, privacy.
> 5. The in-Discord subtitle — the line under a translated message, plus the two-tier
>    markers. It renders inside Discord and must sit naturally with Discord's typography
>    without imitating Discord's brand.
>
> **Hard constraints, non-negotiable — see §3.** Strict CSP: no web fonts, no CDN, no
> remote images, no external requests of any kind. Plain CSS and semantic HTML, no
> framework, no build step. Light and dark both required. The installer renders in a
> 720×620 window.

---

## 2. Token contract

`tokens.css` defines exactly these, and both surfaces consume only these. Adding a token
is fine; renaming or dropping one breaks a surface, so treat the list as additive.

```css
:root {
  color-scheme: light dark;

  /* surfaces */
  --bg:            /* page/window background */
  --panel:         /* raised block: sample, callout, list rows */
  --line:          /* borders and rules */

  /* text */
  --fg:            /* primary text */
  --muted:         /* secondary text, captions, help */

  /* meaning — these carry semantics, not decoration */
  --accent:        /* primary action, brand */
  --accent-fg:     /* text on --accent */
  --ok:            /* verified success. See §4.1 */
  --warn:          /* recoverable problem, caution */
  --danger:        /* destructive or hard failure */

  /* form */
  --radius:        /* corner radius */
  --radius-sm:
  --font-sans:     /* system stack, or a self-hosted face — see §3 */
  --font-mono:     /* error codes and paths */
}
```

Dark mode via `@media (prefers-color-scheme: dark)` **and** a `:root[data-theme="dark"]`
override, so a future in-app theme toggle does not need a redesign.

`--ok` and `--danger` must be distinguishable to someone with red-green colour blindness
without relying on hue alone — the confirmed and unconfirmed end states differ by more
than colour.

## 3. Technical constraints

- **No external requests.** The installer runs under a strict CSP that blocks every remote
  host. A web font, a CDN stylesheet or a remote image does not degrade — it fails
  silently and the design does not appear. Fonts must be a system stack, or a `woff2`
  embedded as a `data:` URI in `tokens.css`.
- **No framework, no build step.** The installer renderer is plain TypeScript writing DOM;
  the site is one static HTML file. Deliverables are CSS and semantic HTML. If a component
  genuinely needs JS, it must be a few lines of vanilla, self-contained.
- **Both schemes.** Follows the OS.
- **Installer window is 720 × 620**, not user-resizable. Changeable if the design calls for
  it — say so, it is not load-bearing.
- **The site is responsive**; the installer is not, but must tolerate OS text-size changes.
- Assume no images unless supplied as SVG or a `data:` URI.

## 4. Behavioural invariants

Correctness properties, from real failures. Full list in `docs/DESIGN-BRIEF.md` §4.2.

### 4.1 The success state is conditional

The final screen has **two visually distinct outcomes**:

- verified — a translation was observed rendering in Discord
- installed but unverified — everything was written, we could not confirm it works

A single triumphant ending would be a lie in the second case. Both need designing; the
second is not an error state and must not look like one.

### 4.2 A refusal offers no way out

`betterdiscord-blocked` has no proceed action by construction. Do not add one, and do not
style Cancel as though it were one.

### 4.3 Errors keep their detail

Every failure carries a code, a path and an underlying cause. It may be de-emphasised or
behind a disclosure. It must stay copyable — hiding it cost days of debugging.

### 4.4 Progress is never faked

Some steps take genuinely unknown time. No determinate bar for an indeterminate wait.

## 5. File layout and sync

Claude Design project structure:

```
tokens.css                     the contract in §2
components/<name>/index.html   self-contained preview, first line:
                               <!-- @dsCard group="Components" -->
screens/<state>/index.html     one per installer state designed
site/<section>/index.html      one per site section
```

Each preview is standalone: it links `tokens.css` and contains its own markup and styles.
The `@dsCard` first-line comment is what the Design System pane indexes on.

**Sync back into this repo** lands under `design/`, and the two surfaces consume it:

```
design/tokens.css              ← single source of truth
design/components/…
site/index.html                imports design/tokens.css
installer/src/renderer/…       imports design/tokens.css
```

Neither surface may define a colour inline again. A design change is then: sync
`design/`, rebuild, done.

Sync is **incremental, one component at a time** — never a wholesale replace. The repo is
the integration point, not the design tool.
