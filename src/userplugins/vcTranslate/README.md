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

Every message is translated **twice, by design.** A subtitle marked `≈`
appears within about a second — Google, translating that one message in
isolation, no conversation context. If an LLM engine (Claude or Gemini) is
configured, that same message is *also* sent to it with a rolling window of
recent channel context, and when that answer comes back — typically some
seconds later, up to about 20 — it silently replaces the `≈` line in place
with a `✦` one. You never do anything to trigger this; it just gets better
under you.

| Prefix | Meaning |
|---|---|
| `✦ es · …` | Translated by a context-aware LLM engine (Claude or Gemini) — batched, with a rolling window of recent channel messages. This is the final answer for this message |
| `≈ es · …` | Translated by Google alone, each message in isolation, no conversation context. If an LLM is configured, this is a **placeholder that has not been upgraded yet** — wait a few seconds. If Google is the only engine configured, this is the final answer |
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
which resolves `ne` far better than any language code could. This is one of
the concrete reasons the quality tier's upgrade is worth waiting the extra
~20 seconds for, and one of the things you lose for as long as only the fast
(Google) tier is answering.

With Claude or Gemini configured, the marker doubles as a live readout of
whether the second, better translation has landed yet: `✦` means the LLM
engine answered for that specific message, `≈` means it has not — either
because it simply has not had its turn yet (the normal case for the first
~20 seconds of any message's life), or because it could not: the key field
is empty, the key was rejected, or the engine is rate limited right now.
**A `≈` line that never turns into `✦`, minutes later, in an otherwise
active channel is the sign something is actually wrong** (usually a quota
issue) — a `≈` line that is merely a few seconds old is not.

The **"Target language code"** setting defaults to your Discord client's own
language (`en-US` becomes `en`, `pt-BR` becomes `pt`, and so on) rather than
always English. Set it explicitly if you want subtitles in something other
than the language your client is in.

## Engines

**Two tiers, not one selected engine.** *Every* incoming message is sent to
Google, always, regardless of what you have configured — this is the **fast
tier**: a 700ms debounce, up to 10 messages per request, no conversation
context, and it is what puts a `≈` subtitle on screen in about a second.
If you have configured an LLM engine (Claude or Gemini), that *same* message
is independently sent to it too — the **quality tier**: a 20-second debounce,
up to 25 messages per request, with a rolling window of recent channel
context. When the LLM answers, its result silently replaces the Google line
in place and the marker flips from `≈` to `✦`. Neither tier waits on the
other, and writes are upgrade-only: an LLM result may replace a Google line,
but a slow Google reply can never overwrite an LLM line that already landed,
and a failure marker can never overwrite a real translation from either
tier. So a slow or failed tier never degrades what the other already
produced — the worst it can do is leave the message where it already was.

**Setting the engine to Google disables the quality tier entirely.** There is
then only the fast tier, and `≈` is simply the final answer, exactly as if
the second tier did not exist.

| Engine | Cost | Quality |
|---|---|---|
| Google (fast tier, always on) | Free, no API key | Weaker on slang, mixed languages, and short fragments; each message is translated in isolation, with no conversation context |
| Claude Haiku (`claude-haiku-4-5`) or Gemini (quality tier, when configured) | Roughly $2-3/month at typical chat volume for Claude; Gemini has a usable free tier | Noticeably better on slang and code-mixed text; batches multiple messages per request and includes a rolling window of recent channel context, so it can disambiguate short or ambiguous lines the way a person following the conversation would |

To use Claude: create a key at console.anthropic.com, switch the
**"Translation engine"** dropdown to Claude Haiku — the **"Anthropic API
key"** field is hidden until you do, since it is meaningless for Google — then
paste the key into it. **Scope the key to a dedicated project with a spend
limit** — it is stored in plaintext in Vencord's settings file, like every
other Vencord plugin credential, not in your OS keychain.

Because the fast tier already gave the reader a Google line before the
quality tier is ever asked, the LLM engine being unavailable costs nothing
but the upgrade — there is no "falling back" to arrange, because Google was
never bypassed in the first place. There are three ways the quality tier can
be unavailable, and they recover differently:

| Why | Recovers when |
|---|---|
| Key field is empty | Immediately, as soon as you paste a key |
| Engine rejected the key (401/403) | Only after restarting Discord — the quality tier is disabled for the rest of the session |
| Engine is rate limited (429) | Automatically, when the cooldown lapses (see below) |

Each shows one toast, and only one per session — never one per batch.

### Free-tier rate limiting

Claude and Gemini are both key-gated and both rate-limited on typical
free/low tiers. Measured directly against the live Gemini API: the free-tier
limit is **20 requests per rolling minute** (not a daily cap — three separate
probes each returned a sub-minute retry hint). Google is per-message with its
own concurrency cap on the fast tier and is not affected by any of this.

The quality tier's 20-second debounce and 25-message batch cap (see "Engines"
above) are sized directly against that number: a single busy channel (60
messages/minute of chat) flushes the quality tier at roughly **2-3 requests a
minute — an order of magnitude under the 20/minute ceiling.** (An earlier
version of this plugin used a fixed 3-second window, which meant a
continuously active channel flushed every 3 seconds — 20 requests/minute,
exactly on the ceiling, which is where most of the 429s came from.)

The one thing the debounce window does *not* smooth out is opening many
channels in a row: catch-up gives each channel its own queue and its own
20-second timer, so hopping through 10 channels can still produce up to 10
quality-tier requests clumped within the same few seconds. That is what the
client-side token-bucket gate below still exists for.

A small client-side token-bucket gate (`rateGate.ts`) sits in front of every
Claude/Gemini request: a burst of 5 requests is always available immediately,
refilling at roughly 1 every 4 seconds (~15/minute — deliberately under the
measured 20/minute ceiling). A single live conversation's quality tier never
needs more than one token at a time, so **normal chat is never
throttled** by this gate at all — it is the channel-hopping burst above that
it smooths out, spacing 10 clumped requests into the steady rate instead of
firing them all at once and getting several back as 429s.

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

### When the LLM engine is rate limited, nothing happens — and that is the point

A 429 no longer costs the reader anything, because the fast tier already put
a Google line on screen for every one of these messages roughly 20 seconds
before the quality tier was even asked. There is nothing to fall back to and
nothing to retry: the fallback already ran, before the LLM engine was ever
touched.

Concretely, on a 429 from Claude or Gemini:

1. That engine is put in a **cooldown** for exactly as long as the API asked
   for. The real captured Gemini 429 says "Please retry in 551.874307ms." in
   the prose of its error message — there is no `Retry-After` header and no
   structured `RetryInfo` field on a real response, so `rateHint.ts` parses
   the sentence (a 30-second default only applies when nothing at all is
   stated). Retrying straight back into a wall that just rejected us is how
   roughly half of the observed API traffic became 429s.
2. The rate gate re-tunes from any quota the same message reports (above).
3. Every quality-tier batch that becomes due during the cooldown is **not
   sent at all** — not to the LLM, and not to Google either, since the fast
   tier already handled Google independently, ~20 seconds earlier, for these
   exact messages. The `≈` line the reader already has simply stays.
4. When the cooldown lapses, the quality tier resumes **automatically** on
   the next batch. Nothing to restart, no setting to touch.

You get one toast the first time this happens in a session, saying
translations are running on Google only for now and roughly how long until
the better engine is back — and only one, however many batches are affected.

`{ deferred: true }` (the "⏳ translation delayed — retrying" line) is a
holdover from a design where the LLM engine was the reader's *only*
translator and a 429 genuinely left them with nothing. **Nothing writes it
any more.** With the fast tier always running independently, a rate-limited
quality tier has a Google line to leave in place instead — see "The four-way
resolved-state model" below for where you can still encounter one (a cache
entry from before this change, read back off disk).

### Two debounce windows, sized for two different jobs

The fast tier exists purely to get *something* on screen quickly: **Google,
700ms debounce, up to 10 messages per request.** Google is free and
unmetered, so the only cost is a slightly larger number of small HTTP calls,
which is a good trade for a subtitle appearing in about a second.

The quality tier exists to make that something *right*, without spending the
free-tier budget doing it: **the configured LLM, 20-second debounce, up to 25
messages per request.** Sized directly against the measured 20 requests/minute
ceiling above — a busy channel flushes the quality tier at roughly 2-3
requests a minute, an order of magnitude under it. (An earlier, single-tier
version of this plugin used a 3-second debounce for the LLM engine directly,
which sat exactly on the ceiling and produced the 429 storm this two-tier
design exists to fix.)

The reader never waits on the quality tier's window — the fast tier already
gave them a line. The 20 seconds only decide how long that line stays
Google's before the better one silently replaces it.

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

**Translations stopped looking as good as they used to, with no visible error.**
A bad or rejected Anthropic API key does not disable the plugin — the fast
(Google) tier keeps running exactly as before, and only the quality tier is
disabled for the rest of that Discord session (one toast is shown the first
time this happens; after that it's quiet, so it doesn't spam you every
batch). Selecting Claude with the key field still empty shows its own,
separate one-per-session toast and leaves the quality tier off until you
paste one. If translations look "worse than they used to" — i.e. every
subtitle is stuck at `≈` — that's expected: the quality tier stays off until
you fix the key and **restart Discord** (a rejected key is per-session and
does not clear itself while Discord stays open, even if you re-paste a
working key — see the item below).

**Pasted a new/fixed API key but Claude still isn't being used.**
Once a session has disabled the quality tier for a rejected key (see above),
it stays disabled until Discord restarts, even after you fix the key in
settings. This is intentional — it avoids retrying a broken key on every
single batch — but it means "fix the key" alone does not bring Claude back
mid-session; restart Discord afterward.

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
Only the fast (Google) tier ever writes this marker — a quality-tier failure
is invisible by design (see below), so this always means Google itself came
back broken for that message (network issue, an unparseable response, an id
the model never returned a usable row for) after retrying once. It is not
stuck permanently: the next time you open (or reopen) that channel, catch-up
retries any message still marked failed automatically.

**Subtitles briefly say `≈` before switching to `✦`.**
Expected, and not an error at all — this is every message's normal life
cycle when an LLM engine is configured. `≈` is the fast tier's Google line,
which appears in about a second; `✦` is the quality tier's upgrade, which can
take up to ~20 seconds to arrive. A subtitle marked `≈` for a few seconds
is working exactly as designed.

**Subtitles stay `≈` for minutes, well past the ~20 second upgrade window, even though Claude/Gemini is selected.**
This is the state worth investigating. The quality tier is unavailable right
now — most often rate limited, sometimes an empty or rejected key (see the
recovery table under "Engines" above) — so only the fast tier's Google line
is showing. A toast said so once when it started. The `✦` marker
comes back on its own as soon as the engine recovers; you do not have to
restart anything. If it never comes back, the cause is a *rejected* key
rather than a rate limit — that one does pin the session to Google-only, see
the two items above.

**A message shows a dim "⏳ translation delayed — retrying" instead of ≈ or ⚠.**
This should now be rare to the point of not happening at all in a fresh
session: nothing in the current code writes this marker any more (see "When
the LLM engine is rate limited" above — a rate-limited quality tier now
leaves the existing Google line alone instead). The one way to still see it
is a translation cache entry written by an *earlier* version of this plugin,
persisted to disk, and read back on a later launch before it has been
re-requested. It resolves itself exactly like a failure does — reopening the
channel retries it.

**Which engine produced this line? / Some subtitles show `≈`, others `✦`.**
Translations are cached by (message, target language) only — deliberately
*not* by engine. That is what lets a Google line and an LLM line for
different messages sit side by side legibly in the same channel, and it is
the precondition for the two-tier design itself: a message's key does not
change between the fast tier's write and the quality tier's later upgrade of
the very same entry. The consequence you will actually notice: **switching
the configured engine does not re-translate anything you have already
read.** A message already upgraded to `✦` by Gemini keeps that `✦` line
after you switch to Claude; only messages the quality tier has not gotten to
yet use the newly-selected engine. That is intentional — re-spending an LLM
budget upgrading messages you have already read is the least valuable thing
it could be spent on. If you genuinely want a specific message redone by the
new engine, edit anything in your own copy of it, or reopen the channel
after the message has scrolled out of the cached 500.

### The four-way resolved-state model

Internally, every message id a translation was ever requested for resolves to
exactly one of four states (`store.ts`'s `StoredTranslation`), so that "no
entry yet" always means "never requested" and nothing silently falls through
the cracks. All four are engine-independent: the entry records which engine
produced it (`via`) rather than being filed under that engine. A stricter
rule then governs which tier may overwrite which state (see "Engines"
above): an LLM result outranks a Google one, and a marker
(failed/deferred/skipped) never overwrites a real translation from either
tier.

| State | Meaning | Rendered as | Retried on next catch-up? |
|---|---|---|---|
| `{ lang, text, via }` | A real translation, plus the engine that produced it. Two tiers can both write this key over a message's life — first the fast tier, then the quality tier upgrading it in place | The dimmed subtitle, prefixed `✦` (Claude/Gemini) or `≈` (Google) | No — already done, whichever engine did it (though a Google-authored entry still leaves the *quality* tier free to upgrade it — see `needsQuality` below) |
| `{ skipped: true, via? }` | The engine reported the message is already in your target language. `via` matters: a Google skip is not authoritative — Google echoes short or romanized text back unchanged when it has simply given up, which looks identical to "already translated" — so only an *LLM* skip (`via` set to `claude`/`gemini`) actually closes the message. A Google skip stays open to the quality tier | Nothing (no subtitle) | Only if an LLM hasn't confirmed it yet |
| `{ failed: true }` | A genuine attempt came back broken. Only ever written by the fast tier — see "⚠ translation failed" above | "⚠ translation failed" | Yes |
| `{ deferred: true }` | Historical only — **nothing writes this state any more.** It dates from a design where the LLM engine was the reader's only translator and a 429 left them with genuinely nothing. Kept in the type and in the renderer purely so a cache entry persisted by an earlier version of the plugin still renders sensibly instead of falling through to "⚠ translation failed" | "⏳ translation delayed — retrying" | Yes |

`failed` and `deferred` look and read differently on purpose: a plain English
message caught in a 429 storm was never actually wrong about anything, and
telling the user "failed" for it is what used to make a rate-limited batch
look like the plugin being broken. That distinction is now moot for anything
translated going forward — the fast tier means a rate-limited quality tier
simply leaves the existing `≈` Google line in place rather than writing any
marker at all — but the rendering stays in case an old `deferred` entry is
still sitting in your persisted cache.

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
- `index.tsx` is currently ~1,160 lines, against this project's own 200-line
  per-file convention. It grew past that budget across several correctness
  fixes (catch-up de-duplication, cold-channel handling, session fallback,
  edit re-translation), again with the budget work (focused-channel gating,
  batch sizing, cache loading), and again with the two-tier rework (a second
  batcher, per-tier in-flight tracking, the upgrade-only write path), where
  splitting mid-change would have made the diffs harder to review than the
  size overrun was worth. Splitting it — likely into the Flux handlers/catch-up
  logic, the popover button, and the accessory component — is planned as a
  follow-up task, not done here.

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

322 tests across 14 suites (`batcher`, `claude`, `detectLang`, `gemini`,
`google`, `index`, `native`, `rateGate`, `rateHint`, `retry`, `romanized`,
`skip`, `store`, `upgrade` — see `tests/`). `tests/fixtures/` holds shared
non-test data, notably the verbatim bytes of a real Gemini 429 captured
against the live API, which `rateHint.test.ts` and `gemini.test.ts` both
assert against so they cannot drift apart from each other or from reality.

Thirteen of the fourteen target pure-logic modules with no Discord/Vencord
runtime dependency (`store.test.ts` is pure logic plus the `DataStore` stub,
which its persistence cases drive directly; `upgrade.test.ts` and
`romanized.test.ts` are the two-tier and script-mismatch modules, also pure
logic). `index.test.ts` covers `index.tsx` — the Flux wiring, the
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
| 1 | Post a non-English message in an enabled channel | A dimmed italic subtitle appears within ~1s, marked `≈` (the fast tier, Google) — this is always the first line you see, regardless of which engine is configured. Hovering it names Google and the detected language. If Claude/Gemini is configured, it silently upgrades in place to `✦` afterwards, usually within ~20s (see row 32) | ☐ |
| 1b | With some messages translated by Google only (no LLM configured yet), switch the engine to Claude or Gemini and reopen the channel | The existing `≈` subtitles stay visible while the channel loads. Because a Google line is never a finished answer once an LLM is configured, catch-up also re-offers those exact messages to the new quality tier — expect new Claude/Gemini requests, and some of those lines flipping to `✦` shortly after. Only messages an LLM had *already* translated before the switch are left untouched | ☐ |
| 2 | Post a message already in your target language, then reopen the channel | No subtitle either time. If only the fast tier has judged it a skip so far (engine set to Google, or the quality tier hasn't gotten to it yet), reopening the channel may send ONE more quality-tier request to confirm the skip — a Google skip is not authoritative (see "The four-way resolved-state model"). Once an LLM has confirmed the skip, reopening again sends nothing further for that message | ☐ |
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
| 13 | Switch engine Google → Claude mid-session | New messages get a `≈` line from the fast tier and, up to ~20s later, a `✦` line from Claude. Messages already cached under Google keep their `≈` result until you next reopen that channel — reopening lets catch-up offer them to Claude too, same as row 1b | ☐ |
| 14 | Paste a valid API key mid-session while engine is set to Claude | Translations start working without a restart (this was a Critical bug in an earlier round — confirm it stays fixed) | ☐ |
| 15 | Set engine to Claude with an invalid API key | Exactly one toast, then Google is used for the rest of the session | ☐ |
| 16 | Disconnect your network, then post a message | ⚠ marker appears, no popup dialog, no console spam | ☐ |
| 17 | Reconnect the network, post again | Translation resumes normally | ☐ |
| 18 | Disable the plugin mid-flight (a translation in progress), then re-enable it | The next channel-open catch-up still enqueues correctly | ☐ |
| 19 | Restart Discord entirely | Previously enabled channels are remembered | ☐ |
| 20 | Post a message containing a link, and let Discord's preview embed load | The embed's own `MESSAGE_UPDATE` must not trigger an extra translation request for that message — you should see the normal fast-tier request (plus one quality-tier request if an LLM is configured), not a duplicate of either from the embed loading | ☐ |
| 21 | Open the plugin settings with engine = Google, then switch to Claude | The "Anthropic API key" field is absent for Google and appears for Claude | ☐ |
| 22 | Select Claude while the key field is empty, then post a message | Exactly one "no Anthropic API key" toast; pasting a valid key afterwards starts using Claude with no restart | ☐ |
| 23 | Check the "Target language code" setting on a fresh install with a non-English Discord client | It defaults to your client's language as a bare code (`pt`, not `pt-BR`) | ☐ |
| 24 | **Focus:** with `globalAuto` on, sit in channel A while someone posts a non-English message in channel B | Nothing is requested for B while you are in A (check the provider dashboard). Opening B translates its recent backlog then | ☐ |
| 25 | **Focus, popout:** pop a channel out into its own window and post there while the main window is on another channel | Expected to *not* translate live — a known, documented simplification. It should still translate once that channel is opened in the main window | ☐ |
| 26 | **Local English skip:** post a plain English sentence in an English-target channel | No subtitle **and no API request at all** (the dashboard count must not move) | ☐ |
| 27 | **Local English skip, the timid half:** post `yess`, `THIS`, or a Spanish sentence | These are still sent (`yess`/`THIS` may return nothing to show; the Spanish one must get a subtitle). A missing Spanish subtitle here is a real bug — report it | ☐ |
| 28 | **Persistence:** translate a channel, fully restart Discord, reopen the same channel | Subtitles are already there immediately on reopen. If any of them were still Google-only (`≈`) when Discord closed and an LLM is configured, catch-up sends fresh quality-tier requests to upgrade those specific ones to `✦` — that is expected, not a bug. Messages already upgraded to `✦` before the restart generate no new requests | ☐ |
| 29 | **Persistence, edited message:** edit a translated message, restart Discord, reopen the channel | The subtitle matches the *edited* text — the pre-edit translation must not come back from disk | ☐ |
| 30 | **Batch size:** post 3-4 messages quickly in a channel with Claude/Gemini selected | Each message still gets its own `≈` line within about a second (the fast tier is per-message, not delayed by batching). Then, up to ~20 seconds later, all of them upgrade to `✦` together, from a single quality-tier request carrying up to 25 messages (`QUALITY_MAX_BATCH`/`QUALITY_DEBOUNCE_MS`) | ☐ |
| 31 | **Two-tier, happy path:** post a foreign message in a busy channel | A `≈` subtitle appears within ~1s | ☐ |
| 32 | **Two-tier, upgrade:** keep watching that same message for ~30s | It changes to `✦` with a better translation | ☐ |
| 33 | **Two-tier, backlog:** open a channel with a long untranslated backlog | `≈` lines appear immediately, `✦` follows in batches | ☐ |
| 34 | **Two-tier, quota exhausted:** exhaust the Gemini quota, then post a message | `≈` still appears; no `⚠`, no `⏳`, no toast storm | ☐ |
| 35 | **Two-tier, quota headroom:** watch the AI Studio rate-limit dashboard for 10 min of normal use | Well under 20 requests/min | ☐ |
| 36 | **Romanized text:** post romanized Darija: `ana bghit nmchi l dar` | Either no ≈ line, or one marked `ar?`; the ✦ line that follows says "I want to go home" (NOT "don't want") | ☐ |
| 37 | **Romanized text, pass-through:** post `baraka 3lik mn dak monster` | Google returns it unchanged so there may be no ≈ line at all — but a ✦ line still arrives and mentions the drink | ☐ |
| 38 | **Romanized text, DM prerequisite:** before rows 36-37, confirm the DM is enabled with the 🌐 button first | Rows 36-37 do nothing in a DM that was never enabled; `globalAuto` never covers DMs | ☐ |

If you'd rather work from the brief's original phrasing, items 1-3 and 5-6
above correspond to the brief's manual checklist 1-8 (minus a redundant
"delete a message" case not repeated here since it's a strict subset of
"edit"); items 7-23 are the additional cases raised in code review that the
brief's original list did not cover (cold-channel catch-up, duplicate-event
counting, mid-flight re-selection, retry-on-reopen, persistence-failure UX,
and the empty/invalid/fixed API-key sequence); items 31-38 are the two-tier
pipeline and romanized-text cases added for this task, taken verbatim from
the two-tier plan's own manual checklist (`docs/superpowers/plans/2026-08-05-two-tier-translation.md`),
renumbered to continue this table's existing sequence rather than colliding
with rows 10-14 already in use here.
