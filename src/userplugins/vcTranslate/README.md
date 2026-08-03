# vcTranslate

A [Vencord](https://vencord.dev) userplugin that automatically translates
incoming Discord messages and renders the translation as a dimmed, italic
subtitle beneath the original — like a live caption track for a channel in a
language you don't speak.

## Install

Requires a from-source Vencord checkout — userplugins do not work with the
stock installer.

### Option A: symlink (recommended for development)

This is how this repo itself is set up. Keeping the plugin in its own git
repo and symlinking it into Vencord means edits are made in one place and
picked up by Vencord's build immediately, with no copy step to forget.

```bash
# from the Vencord repo root
mkdir -p src/userplugins
ln -s /path/to/discord-translate/src/userplugins/vcTranslate src/userplugins/vcTranslate
pnpm build
```

If you symlink, also copy (or write your own version of) this repo's root
`tsconfig.json` `paths` block into the plugin's source tree, or keep it in the
plugin repo as we do here. It exists **only** for the symlinked case: esbuild
discovers a file's tsconfig by walking up from that file's *real*,
symlink-resolved path, not the path it was reached through. Since the plugin's
real location is a sibling directory (`discord-translate/`), not inside
`Vencord/`, esbuild would otherwise never find Vencord's own tsconfig and
would fail to resolve bare specifiers like `@api/*`, `@utils/*`,
`@webpack/common`, etc. The `paths` block in [`../../../tsconfig.json`](../../../tsconfig.json)
mirrors Vencord's own path map, relative to the sibling checkout, so esbuild's
default per-file discovery resolves them anyway. Vencord's own internal files
are unaffected — they still resolve through normal walk-up discovery via
Vencord's own tsconfig.

### Option B: copy (for a one-off install, no ongoing plugin development)

```bash
# from the Vencord repo root
mkdir -p src/userplugins
cp -r /path/to/discord-translate/src/userplugins/vcTranslate src/userplugins/
pnpm build
```

Copy-install users are unaffected by the `paths` caveat above — a copied
plugin's real path is already inside the Vencord tree, so Vencord's own
tsconfig resolves it through ordinary walk-up discovery.

### Injecting

```bash
pnpm inject
```

**Warning:** `pnpm inject` patches your actual Discord installation (desktop
app or browser userscript, depending on what you select) to load your local
Vencord build. This is a real modification to software you use every day —
run it only once you've decided you want that, and know that `pnpm uninject`
reverses it.

After injecting, restart Discord and enable **VcTranslate** in
Settings → Plugins.

## Use

By default, no channel is translated. Hover any message in a channel → click
the 🌐 button in the message's hover toolbar to turn on auto-translate for
that channel. The choice persists across restarts (stored via Vencord's
`DataStore`, keyed per channel id). Click it again (now showing 🌫) to turn a
channel back off.

If you'd rather not manage this per channel, Settings → VcTranslate has a
**"Auto-translate every channel"** (`globalAuto`) toggle that turns
translation on everywhere at once, overriding the per-channel list.

**Only the channel you are looking at is translated as messages arrive.**
`globalAuto` decides which channels are *eligible*; the channel currently on
screen is the one that actually gets spent on. A message that arrives in
another channel is not translated then and there — it is translated when you
open that channel, by the same catch-up pass described below. This is
deliberate: free-tier API budgets are on the order of tens of requests a day,
and translating channels nobody has read is the fastest way to spend all of
them before lunch. (Popped-out channels and second Discord windows are not
detected — a message read in a popout is translated when its channel is next
opened in the main window, not never.)

Opening (or reopening) an enabled channel also translates a backlog of its
most recent messages — how many is controlled by the **"How many recent
messages to translate when opening an enabled channel"** slider (default 20,
0 disables catch-up). Messages the engine reports as *already* in your target
language get no subtitle, and are remembered as resolved: reopening the
channel does not re-send them. Editing a message clears its subtitle and
re-translates the new text.

Two other things happen before a request is ever sent, both to protect that
daily budget:

- **Obviously-English messages are never sent** when your target language is
  English. This is a local check (`detectLang.ts`) and it is deliberately
  timid: anything short or ambiguous (`yess`, `THIS`, `ok`) is sent anyway,
  because guessing wrong would silently lose a translation with no error and
  no way for you to know. It is implemented **only** for English targets; every
  other target language skips the check entirely.
- **Translations are remembered across restarts.** Restarting Discord used to
  re-translate the whole visible backlog from scratch; now it costs nothing.
  See Privacy below for what that means for other people's messages.

Every subtitle starts with a small marker saying which engine produced it,
because that is no longer always the engine you have selected (see
"Which engine produced this line?" below):

| Prefix | Meaning |
|---|---|
| `✦ es · …` | Translated by a context-aware LLM engine (Claude or Gemini) — batched, with a rolling window of recent channel messages |
| `≈ es · …` | Translated by Google — each message in isolation, no conversation context, so it is an approximation |
| `≈ ha? · …` | The `?` means Google was **not confident** which language this was. Treat the line as unreliable — see below |

Hovering the marker shows the engine's full name and the language spelled out
("Translated by Google Translate · Hausa"), because a bare `ha` tells you
nothing about whether the detection was plausible.

### The `?` marker, and why short replies are the dangerous ones

Google reports how confident it is in the language it detected, and on very
short messages it is often barely confident at all. Measured against the live
endpoint:

| Message | Detected | Confidence | Rendered | Actually means |
|---|---|---|---|---|
| `ne` | `ha` (Hausa) | 0.22 | "it is" | German **"no"** — the opposite |
| `ja` | `et` | 0.45 | "and" | German **"yes"** |
| `nö` | `et` | 0.61 | "so-called" | German **"nope"** |
| `ok dann brauch ich net neidisch sein` | `de` | 0.99 | correct | — |
| `hola que tal` | `es` | 1.00 | correct | — |

Two things make this worse than an ordinary bad translation: the wrong answer
reads just as fluently as a right one, and the failures cluster on yes/no
replies, where being wrong **inverts** the meaning of the message.

So two defences, both Google-only:

- **Short replies borrow their parent's language.** If a message is a reply, is
  short, and the message it replies to was detected confidently, that language
  is pinned instead of auto-detected. Live, `ne` pinned to German returns "no"
  rather than "it is". Long messages are excluded on purpose — they detect
  reliably on their own, and forcing a long Spanish reply into its German
  parent's language would create the very bug this prevents.
- **Anything still under 0.85 confidence is marked `?`.** It is shown rather
  than hidden — a rough translation you know to distrust beats a blank — with
  the confidence spelled out on hover.

Neither applies to Claude or Gemini: they receive the surrounding conversation,
which resolves `ne` far better than any language code could. This is one of the
concrete things you lose while falling back to Google.

With Claude or Gemini selected, the marker doubles as a live quota readout:
`✦` means the LLM engine served that line, `≈` means it could not and Google
stepped in — because the key field is empty, because the key was rejected, or
because the engine is rate limited right now. **A run of `≈` lines while an LLM
engine is selected means you are out of quota for the moment, not that the
plugin is broken.** They go back to `✦` on their own once the engine recovers.

The **"Target language code"** setting defaults to your Discord client's own
language (`en-US` becomes `en`, `pt-BR` becomes `pt`, and so on) rather than
always English. Set it explicitly if you want subtitles in something other
than the language your client is in.

## Engines

| Engine | Cost | Quality |
|---|---|---|
| Google (default) | Free, no API key | Weaker on slang, mixed languages, and short fragments; each message is translated in isolation, with no conversation context |
| Claude Haiku (`claude-haiku-4-5`) | Roughly $2-3/month at typical chat volume | Noticeably better on slang and code-mixed text; batches multiple messages per request and includes a rolling window of recent channel context, so it can disambiguate short or ambiguous lines the way a person following the conversation would |

To use Claude: create a key at console.anthropic.com, switch the
**"Translation engine"** dropdown to Claude Haiku — the **"Anthropic API
key"** field is hidden until you do, since it is meaningless for Google — then
paste the key into it. **Scope the key to a dedicated project with a spend
limit** — it is stored in plaintext in Vencord's settings file, like every
other Vencord plugin credential, not in your OS keychain.

Whenever the selected LLM engine cannot serve a batch, the plugin falls back
to Google rather than failing outright, so you always see *a* translation.
There are three such cases and they recover differently:

| Why | Recovers when |
|---|---|
| Key field is empty | Immediately, as soon as you paste a key |
| Engine rejected the key (401/403) | Only after restarting Discord — the session is pinned to Google |
| Engine is rate limited (429) | Automatically, when the cooldown lapses (see below) |

Each shows one toast, and only one per session — never one per batch.

### Free-tier rate limiting

Claude and Gemini are both key-gated and both rate-limited on typical
free/low tiers — Gemini's free tier allows on the order of 15 requests per
minute, and Anthropic's lowest tiers are comparably tight. Google is
per-message with its own concurrency cap and is not affected by any of this.

Nothing previously limited how fast *this plugin* sent requests to Claude or
Gemini. With "Auto-translate every channel" on, restarting Discord fires
catch-up for every open server channel within seconds of each other, each
flushing its own batch independently — easily enough requests in that first
second to blow straight through a free-tier per-minute ceiling and get every
one of those batches back as a 429.

A small client-side token-bucket gate (`rateGate.ts`) now sits in front of
every Claude/Gemini request: a burst of 5 requests is always available
immediately, refilling at roughly 1 every 4 seconds (~15/minute — matched to
the tighter free-tier ceiling above). A single live conversation flushes at
most one batch per debounce window, so **normal chat is never
throttled** — it never needs more than one token at a time. A catch-up storm
across many channels, by contrast, gets smoothed out to that steady rate
instead of front-loading a burst that gets rejected wholesale.

**The gate re-tunes itself from the API's own reported limit.** Those 5-and-4
seconds numbers are only a starting guess. A Gemini 429 body states the quota
it just enforced — literally `limit: 20` in the middle of the error message —
and when it does, the gate throws away the guess and aims at 75% of the real
number instead (20/minute becomes 15/minute; a project limited to 4/minute
becomes 3/minute, one request every 20 seconds). This is deliberately adaptive
rather than a compiled-in constant: free-tier quotas differ per project, per
model, and get changed by the provider without notice, so any number hardcoded
here is guaranteed to be wrong for someone — and being wrong in the generous
direction is exactly what produced the 429 storm. The learned value lasts for
the session and is re-learned after a restart, at the cost of one 429 whose
batch Google serves anyway.

### When the LLM engine is rate limited, Google takes over

Previously, a batch that ran into a 429 was marked "rate limited — retrying"
and the reader saw no translation at all until catch-up got round to it.
**Now that batch is immediately re-run through Google instead.** A mediocre
translation is strictly better than none.

Concretely, on a 429 from Claude or Gemini:

1. That engine is put in a **cooldown** for exactly as long as the API asked
   for. The real captured Gemini 429 says "Please retry in 551.874307ms." in
   the prose of its error message — there is no `Retry-After` header and no
   structured `RetryInfo` field on a real response, so `rateHint.ts` parses
   the sentence (a 30-second default only applies when nothing at all is
   stated). Retrying straight back into a wall that just rejected us is how
   roughly half of the observed API traffic became 429s.
2. The rate gate re-tunes from any quota the same message reports (above).
3. Every batch that becomes due during the cooldown goes to Google, marked
   `≈`, without touching the LLM engine.
4. When the cooldown lapses, the LLM engine resumes **automatically** on the
   next batch. Nothing to restart, no setting to touch.

You get one toast the first time this happens in a session, saying
translations have dropped to Google and roughly how long until the better
engine is back — and only one, however many batches are affected.

`{ deferred: true }` (the "⏳ translation delayed — retrying" line) still
exists, but it is now the narrow case it was always meant to be: the LLM
engine was rate limited *and* the Google fallback did not come through either.
It should be rare rather than routine.

### Batch sizes are set by the daily budget, not by latency

The real constraint on a free tier is **requests per day**, not requests per
minute: one day's dashboard showed roughly 40 successful requests against ~50
`429`s. So Claude and Gemini batch **up to 25 messages per request, with a 3
second debounce** (Google keeps its old 700ms / 10 messages — it is
per-message, free, and was never the source of the 429s). At ~25 messages a
request, ~40 requests covers roughly 1,000 messages a day.

The visible cost is latency: a subtitle can take up to ~3 seconds to appear
instead of ~1. That is the trade — a subtitle two seconds later beats one that
never arrives because the day's budget ran out at lunchtime.

If a 429 does still get through, the API's own retry hint is read from
whichever of three places actually carries it: the prose of Gemini's error
message ("Please retry in 551.874307ms." — the only one a real Gemini 429 has
been observed to use), a structured `RetryInfo`/`retryDelay` entry (kept as a
fallback because other Google APIs do send it), or a `Retry-After` header. The
guessed 30-second pause applies only when none of the three is available.

## Troubleshooting

**Nothing translates at all.**
1. Confirm the plugin is enabled: Settings → Plugins → VcTranslate.
2. Confirm the *channel* is turned on: either the 🌐 popover button on a
   message in that channel shows the "on" state, or "Auto-translate every
   channel" (`globalAuto`) is checked in the plugin's own settings page. A
   channel is off by default and stays off until one of these two is true.
3. Confirm you were *looking at* that channel when the message arrived. Live
   translation only happens for the channel on screen; anything else is
   translated when you open it. If a channel's backlog does not translate on
   open either, that is a real bug — see the cold-channel item below.
4. A non-English message in an active channel that still shows nothing is
   worth checking against the other items below (skip rules, the local
   English check, cold-channel catch-up) before assuming the plugin is broken.

**A message you expected to translate is silently skipped.**
By design, in one of three ways. Locally, structurally: your own messages, and
messages that are only emotes, mentions, links, digits/punctuation, or emoji
once those are stripped out, are treated as untranslatable and never sent to
any engine (see `skip.ts`). Locally, linguistically: with an English target,
a message the plugin can confidently place as English is skipped without a
request (`detectLang.ts`) — this errs heavily toward sending, so if a
*non*-English message is ever skipped this way, that is a bug worth reporting.
Remotely: the engine itself reports a message that is already in
your target language, and there is nothing to subtitle. All three are deliberate —
they avoid burning API calls on content with nothing to translate. The second
kind is recorded as resolved rather than left blank, so reopening the channel
does not re-request the whole already-translated backlog.

**A message edit doesn't update the subtitle.**
It should: an edit clears the old subtitle and re-queues the new text, so the
subtitle reappears within about a second. Updates that carry no message text
(a link preview loading, an attachment finishing processing — Discord fires
the same event for those) are deliberately not re-translated, since the text
has not changed.

**Translations stopped after previously working, with no visible error.**
A bad or rejected Anthropic API key does not disable the plugin — it falls
back to Google for the rest of that Discord session (one toast is shown the
first time this happens; after that it's quiet, so it doesn't spam you every
batch). Selecting Claude with the key field still empty shows its own,
separate one-per-session toast and uses Google until you paste one. If translations still look "worse than they used to,"
that's expected: you're on Google until you fix the key and **restart
Discord** (the fallback is per-session and does not clear itself while
Discord stays open, even if you re-paste a working key — see the item below).

**Pasted a new/fixed API key but Claude still isn't being used.**
Once a session has fallen back to Google (see above), it stays on Google
until Discord restarts, even after you fix the key in settings. This is
intentional — it avoids retrying a broken key on every single batch — but it
means "fix the key" alone does not bring Claude back mid-session; restart
Discord afterward.

**Opening a channel you haven't visited this session doesn't translate its
backlog ("cold channel").**
Catch-up on channel open relies on two Discord Flux events: `CHANNEL_SELECT`
(payload field confirmed against real Vencord plugin usage) and
`LOAD_MESSAGES_SUCCESS`, which fires once Discord has actually fetched a
channel's message history — necessary because `CHANNEL_SELECT` can arrive
before that history exists locally. `LOAD_MESSAGES_SUCCESS` is a real,
type-confirmed Discord event, but **no plugin in the Vencord tree subscribes
to it**, so its payload's channel-id field name (`channelId` vs.
`channel_id`) could not be verified against a real dispatch — it's inferred
from `MessageStore`'s naming convention, not confirmed. If cold-channel
catch-up never fires for you, open the Discord developer console (Ctrl+Shift+I
/ Cmd+Option+I) and look for a warning tagged `VcTranslate` that says
`LOAD_MESSAGES_SUCCESS payload had no channelId/channel_id; ... Payload keys:`
followed by the event's actual keys. That tells you the real field name so
the fix is a one-line change in `index.tsx`'s `onMessagesLoaded`. Please
report it if you hit this — it's the one behavior in this plugin that
automated tests could not pin down.

**A message shows "⚠ translation failed."**
The request for that message was actually attempted and came back broken
(network issue, an unparseable response, an id the model never returned a
usable row for) after retrying once. It is not stuck permanently: the next
time you open (or reopen) that channel, catch-up retries any message still
marked failed automatically.

**Subtitles suddenly all say `≈` even though Claude/Gemini is selected.**
Expected, and self-healing. The LLM engine is unavailable right now — most
often rate limited — so Google is translating instead so that you still get
*something* (see "When the LLM engine is rate limited, Google takes over"
above). A toast said so once when it started. The `✦` marker comes back on its
own as soon as the engine recovers; you do not have to restart anything. If it
never comes back, the cause is a *rejected* key rather than a rate limit —
that one does pin the session to Google, see the two items above.

**A message shows a dim "⏳ translation delayed — retrying" instead of ⚠.**
This is a *different*, non-broken state, and it should now be rare: the
message's batch was rejected by the API before any model ever saw it (a 429),
**and** the Google fallback did not come through either. Nothing about the
translation itself failed, so this is deliberately not styled or worded like
the ⚠ marker. It resolves itself the same way a failure does — reopening the
channel retries it — and usually clears within seconds once the cooldown lapses
or Google recovers.

**Which engine produced this line? / Some subtitles show `≈`, others `✦`.**
Translations are cached by (message, target language) only — deliberately
*not* by engine. That is what lets a translation produced by one engine stay
readable when another is selected, and it is the precondition for falling back
to Google when an LLM engine is unavailable rather than showing nothing at
all. The consequence you will actually notice: **switching engines does not
re-translate anything you have already read.** A message Google translated
stays on screen, still marked `≈`, after you switch to Gemini; only messages
that have not been translated yet (or that are marked failed/rate-limited)
use the new engine. That is intentional — re-spending an LLM budget upgrading
messages you have already read is the least valuable thing it could be spent
on. If you genuinely want a specific message redone by the new engine, edit
anything in your own copy of it, or reopen the channel after the message has
scrolled out of the cached 500.

### The four-way resolved-state model

Internally, every message id a translation was ever requested for resolves to
exactly one of four states (`store.ts`'s `StoredTranslation`), so that "no
entry yet" always means "never requested" and nothing silently falls through
the cracks. All four are engine-independent: the entry records which engine
produced it (`via`) rather than being filed under that engine.

| State | Meaning | Rendered as | Retried on next catch-up? |
|---|---|---|---|
| `{ lang, text, via }` | A real translation, plus the engine that produced it | The dimmed subtitle, prefixed `✦` (Claude/Gemini) or `≈` (Google) | No — already done, whichever engine did it |
| `{ skipped: true }` | The engine reported the message is already in your target language | Nothing (no subtitle) | No — re-asking would produce the same answer at the same cost |
| `{ failed: true }` | A genuine attempt came back broken | "⚠ translation failed" | Yes |
| `{ deferred: true }` | Rate limited before the model saw it, *and* the Google fallback failed too | "⏳ translation delayed — retrying" | Yes |

`failed` and `deferred` look and read differently on purpose: a plain English
message caught in a 429 storm was never actually wrong about anything, and
telling the user "failed" for it is what previously made a rate-limited
catch-up look like the plugin being broken. Since the Google fallback landed,
`deferred` is the rare bottom of the ladder rather than the routine outcome of
every 429 — a rate-limited batch now becomes a `≈` Google translation, not a
pending marker.

## Privacy

Message text is sent to whichever provider is selected — Google's free,
unofficial translation endpoint (no data-processing agreement exists for it)
or Anthropic's API. This includes the text of other people's messages in the
channel, not just your own, since the whole point of the plugin is
translating incoming messages. If you're running this in a channel with
people who haven't opted into that, that's worth knowing plainly, as a fact
about what the plugin does — not a recommendation either way.

**Translations are now stored on disk, not just in memory.** Up to 2,000
entries (message id, target language, translated text, and which engine
produced it) are written to Vencord's `DataStore` — the same IndexedDB storage
the per-channel toggle list uses — so a Discord restart doesn't re-translate,
and re-spend on, the same backlog. Two consequences worth stating plainly:

- Translations of **other people's** messages now persist across restarts
  rather than dying with the process. They are bounded only by that 2,000-entry
  cap (oldest evicted first), not by time, so a translation can outlive the
  original message being deleted in Discord.
- The text is stored unencrypted, alongside the rest of Vencord's plugin data.
  Anything with access to that directory can read it.

To wipe it, clear Vencord's `DataStore` (the same action that would forget your
per-channel toggles).

## Known limitations

- Incoming messages only. No outgoing translation, no voice, no DMs — desktop
  app only (it uses `pnpm inject`'s desktop patch target and Node-side IPC for
  the network calls; there is no browser-userscript equivalent of the native
  bridge).
- `index.tsx` is currently ~810 lines, against this project's own 200-line
  per-file convention. It grew past that budget across several correctness
  fixes (catch-up de-duplication, cold-channel handling, session fallback,
  edit re-translation) and then again with the budget work (focused-channel
  gating, batch sizing, cache loading), where splitting mid-fix would have made
  the diffs harder to review than the size overrun was worth. Splitting it —
  likely into
  the Flux handlers/catch-up logic, the popover button, and the accessory
  component — is planned as a follow-up task, not done here.

## Tests

```bash
cd src/userplugins/vcTranslate && npx vitest run
```

**Run it from this directory.** `vitest.config.ts` lives here and supplies the
aliases that stub out Vencord's modules. Run from the repo root, vitest never
finds the config and `tests/index.test.ts` fails to import — and because the
summary line counts only tests in files that actually loaded, it silently
reports a *smaller* pass count that still looks like success.

`vitest` is not saved as a dependency; in a fresh clone run `npm i -D vitest`
first.

272 tests across 12 suites (`batcher`, `claude`, `detectLang`, `gemini`,
`google`, `index`, `native`, `rateGate`, `rateHint`, `retry`, `skip`, `store`
— see `tests/`). `tests/fixtures/` holds shared non-test data, notably the
verbatim bytes of a real Gemini 429 captured against the live API, which
`rateHint.test.ts` and `gemini.test.ts` both assert against so they cannot
drift apart from each other or from reality.

Ten of the twelve target pure-logic modules with no Discord/Vencord runtime
dependency (`store.test.ts` is pure logic plus the `DataStore` stub, which its
persistence cases drive directly). `index.test.ts` covers `index.tsx` — the Flux wiring, the
catch-up logic and the subtitle accessory — against the small set of Vencord
stand-ins in `tests/stubs/` (`FluxDispatcher`, `MessageStore`, `UserStore`,
`ChannelStore`, `Toasts`, `LocaleStore`, `DataStore`, the settings API, and
just enough of `React` to call a function component and inspect what it
returned). `vitest.config.ts` aliases the `@api/*`, `@utils/*` and
`@webpack/common` specifiers onto those stubs. What remains uncovered is the
part that only exists inside a running Discord — whether Discord actually
dispatches the events with the payload shapes assumed here, and the real
network calls — which is what the manual checklist below is for.

## Manual verification checklist

The automated suite covers every module, `index.tsx` included, but it does so
against stand-ins for Discord. It cannot cover what only exists once this
plugin is running inside a real, injected Discord client — whether Discord's
own events carry the payload shapes assumed here, the message-hover popover,
actual network calls, and Discord's restart/reload behavior. The items below
are exactly that set, flagged during review as unverifiable from source
alone. **Nothing in this table has been executed.** It is a checklist for you
(the person running `pnpm inject` and Discord) to work through, not a report
of results.

| # | What to do | Expected | Pass/Fail |
|---|---|---|---|
| 1 | Post a non-English message in an enabled channel | Dimmed italic subtitle appears within ~1s, prefixed with the engine marker (`≈` on Google, `✦` on Claude/Gemini); hovering the marker names the engine | ☐ |
| 1b | With some messages already translated on Google, switch the engine to Claude or Gemini and reopen the channel | The existing subtitles stay visible and stay marked `≈`; no new API calls for them. Only untranslated messages use the new engine, and those show `✦` | ☐ |
| 2 | Post a message already in your target language, then reopen the channel | No subtitle, and no second API call on reopen (the skip is cached as resolved) | ☐ |
| 3 | Post an emote-only message, a link-only message, or your own message | No subtitle, no API call | ☐ |
| 4 | Have three people post at once in three different languages | All three translate, in one batch | ☐ |
| 5 | Edit a message that already has a translated subtitle | Subtitle re-translates to match the edit (the old one clears, the new one appears within ~1s) | ☐ |
| 6 | Scroll far up in a channel, then back down | Subtitles persist; nothing is re-requested | ☐ |
| 7 | **Cold channel:** open a channel not visited yet this session | Its backlog translates without needing a second channel selection. If it does not, check the console for the `VcTranslate` warning listing `Payload keys:` — see Troubleshooting | ☐ |
| 8 | Count how many times `LOAD_MESSAGES_SUCCESS` fires for one channel open (scrolling up to load more history also dispatches it) | Confirm no duplicate API spend from repeated catch-up triggers for the same channel open | ☐ |
| 9 | Re-select a channel roughly 3s into a pending translation | No second request is sent (check Anthropic usage dashboard or the native-side log) | ☐ |
| 10 | Let a message fail (e.g. during a network blip), then reopen its channel | It retries on the next channel open and stops showing ⚠ once it succeeds | ☐ |
| 11 | Open the 🌐 popover item on a message; toggle a channel off | Popover renders correctly; toggling off hides subtitles for that channel | ☐ |
| 12 | Simulate a persistence failure if you can (e.g. revoke write access to Vencord's settings/data directory) | A failure toast appears and the toggle does not stick | ☐ |
| 13 | Switch engine Google → Claude mid-session | New messages use Claude; messages already cached under Google keep their Google result | ☐ |
| 14 | Paste a valid API key mid-session while engine is set to Claude | Translations start working without a restart (this was a Critical bug in an earlier round — confirm it stays fixed) | ☐ |
| 15 | Set engine to Claude with an invalid API key | Exactly one toast, then Google is used for the rest of the session | ☐ |
| 16 | Disconnect your network, then post a message | ⚠ marker appears, no popup dialog, no console spam | ☐ |
| 17 | Reconnect the network, post again | Translation resumes normally | ☐ |
| 18 | Disable the plugin mid-flight (a translation in progress), then re-enable it | The next channel-open catch-up still enqueues correctly | ☐ |
| 19 | Restart Discord entirely | Previously enabled channels are remembered | ☐ |
| 20 | Post a message containing a link, and let Discord's preview embed load | Exactly one translation request for that message — the embed's own `MESSAGE_UPDATE` must not trigger a second | ☐ |
| 21 | Open the plugin settings with engine = Google, then switch to Claude | The "Anthropic API key" field is absent for Google and appears for Claude | ☐ |
| 22 | Select Claude while the key field is empty, then post a message | Exactly one "no Anthropic API key" toast; pasting a valid key afterwards starts using Claude with no restart | ☐ |
| 23 | Check the "Target language code" setting on a fresh install with a non-English Discord client | It defaults to your client's language as a bare code (`pt`, not `pt-BR`) | ☐ |
| 24 | **Focus:** with `globalAuto` on, sit in channel A while someone posts a non-English message in channel B | Nothing is requested for B while you are in A (check the provider dashboard). Opening B translates its recent backlog then | ☐ |
| 25 | **Focus, popout:** pop a channel out into its own window and post there while the main window is on another channel | Expected to *not* translate live — a known, documented simplification. It should still translate once that channel is opened in the main window | ☐ |
| 26 | **Local English skip:** post a plain English sentence in an English-target channel | No subtitle **and no API request at all** (the dashboard count must not move) | ☐ |
| 27 | **Local English skip, the timid half:** post `yess`, `THIS`, or a Spanish sentence | These are still sent (`yess`/`THIS` may return nothing to show; the Spanish one must get a subtitle). A missing Spanish subtitle here is a real bug — report it | ☐ |
| 28 | **Persistence:** translate a channel, fully restart Discord, reopen the same channel | Subtitles are already there, and no new API requests are made for those messages | ☐ |
| 29 | **Persistence, edited message:** edit a translated message, restart Discord, reopen the channel | The subtitle matches the *edited* text — the pre-edit translation must not come back from disk | ☐ |
| 30 | **Batch size:** post 3-4 messages quickly in a channel with Claude/Gemini selected | Subtitles appear together after ~3s (not ~1s), in a single request | ☐ |

If you'd rather work from the brief's original phrasing, items 1-3 and 5-6
above correspond to the brief's manual checklist 1-8 (minus a redundant
"delete a message" case not repeated here since it's a strict subset of
"edit"); items 7-23 are the additional cases raised in code review that the
brief's original list did not cover (cold-channel catch-up, duplicate-event
counting, mid-flight re-selection, retry-on-reopen, persistence-failure UX,
and the empty/invalid/fixed API-key sequence).
