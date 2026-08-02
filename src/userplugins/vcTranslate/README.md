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

Opening (or reopening) an enabled channel also translates a backlog of its
most recent messages — how many is controlled by the **"How many recent
messages to translate when opening an enabled channel"** slider (default 20,
0 disables catch-up).

## Engines

| Engine | Cost | Quality |
|---|---|---|
| Google (default) | Free, no API key | Weaker on slang, mixed languages, and short fragments; each message is translated in isolation, with no conversation context |
| Claude Haiku (`claude-haiku-4-5`) | Roughly $2-3/month at typical chat volume | Noticeably better on slang and code-mixed text; batches multiple messages per request and includes a rolling window of recent channel context, so it can disambiguate short or ambiguous lines the way a person following the conversation would |

To use Claude: create a key at console.anthropic.com, paste it into the
**"Anthropic API key"** field in the plugin settings, and switch the
**"Translation engine"** dropdown to Claude Haiku. **Scope the key to a
dedicated project with a spend limit** — it is stored in plaintext in
Vencord's settings file, like every other Vencord plugin credential, not in
your OS keychain.

If the key field is left empty while Claude is selected, or if Claude ever
rejects the key, the plugin falls back to Google for the rest of the session
rather than failing outright — see Troubleshooting below.

## Troubleshooting

**Nothing translates at all.**
1. Confirm the plugin is enabled: Settings → Plugins → VcTranslate.
2. Confirm the *channel* is turned on: either the 🌐 popover button on a
   message in that channel shows the "on" state, or "Auto-translate every
   channel" (`globalAuto`) is checked in the plugin's own settings page. A
   channel is off by default and stays off until one of these two is true.
3. A non-English message in an active channel that still shows nothing is
   worth checking against the other items below (skip rules, cold-channel
   catch-up) before assuming the plugin is broken.

**A message you expected to translate is silently skipped.**
By design: your own messages, and messages that are only emotes, mentions,
links, digits/punctuation, or emoji once those are stripped out, are treated
as untranslatable and never sent to any engine (see `skip.ts`). This is
deliberate, not a bug — it also avoids burning API calls on content with
nothing to translate.

**Translations stopped after previously working, with no visible error.**
A bad or rejected Anthropic API key does not disable the plugin — it falls
back to Google silently for the rest of that Discord session (one toast is
shown the first time this happens; after that it's quiet, so it doesn't spam
you every batch). If translations still look "worse than they used to,"
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
The request for that message errored (network issue, rate limit, bad
response shape) after retrying once. It is not stuck permanently: the next
time you open (or reopen) that channel, catch-up retries any message still
marked failed automatically.

## Privacy

Message text is sent to whichever provider is selected — Google's free,
unofficial translation endpoint (no data-processing agreement exists for it)
or Anthropic's API. This includes the text of other people's messages in the
channel, not just your own, since the whole point of the plugin is
translating incoming messages. If you're running this in a channel with
people who haven't opted into that, that's worth knowing plainly, as a fact
about what the plugin does — not a recommendation either way.

## Known limitations

- Incoming messages only. No outgoing translation, no voice, no DMs — desktop
  app only (it uses `pnpm inject`'s desktop patch target and Node-side IPC for
  the network calls; there is no browser-userscript equivalent of the native
  bridge).
- `index.tsx` is currently 409 lines, against this project's own 200-line
  per-file convention. It grew past that budget across several correctness
  fixes (catch-up de-duplication, cold-channel handling, session fallback)
  where splitting mid-fix would have made the diffs harder to review than the
  size overrun was worth. Splitting it — likely into the Flux
  handlers/catch-up logic, the popover button, and the accessory component —
  is planned as a follow-up task, not done here.

## Tests

```bash
npx vitest run
```

92 tests across 7 suites (`batcher`, `channels` via `store`/`skip` coverage,
`claude`, `google`, `native`, `retry`, `skip`, `store` — see `tests/`), all
targeting pure-logic modules with no Discord/Vencord runtime dependency.
`index.tsx` itself (the Flux wiring, the popover button, the React
accessory) has no automated test coverage — exercising it would require
mocking `definePlugin`, `FluxDispatcher`, `ChannelStore`, `MessageStore`,
`UserStore`, `Toasts`, `React`, and the native IPC bridge, which is why the
manual checklist below exists.

## Manual verification checklist

The automated suite covers every pure-logic module. It cannot cover anything
that only exists once this plugin is running inside a real, injected Discord
client — Flux event wiring, the message-hover popover, actual network calls,
and Discord's own restart/reload behavior. The items below are exactly that
set, flagged during review as unverifiable from source alone. **Nothing in
this table has been executed.** It is a checklist for you (the person
running `pnpm inject` and Discord) to work through, not a report of results.

| # | What to do | Expected | Pass/Fail |
|---|---|---|---|
| 1 | Post a non-English message in an enabled channel | Dimmed italic subtitle appears within ~1s | ☐ |
| 2 | Post an English message | No subtitle | ☐ |
| 3 | Post an emote-only message, a link-only message, or your own message | No subtitle, no API call | ☐ |
| 4 | Have three people post at once in three different languages | All three translate, in one batch | ☐ |
| 5 | Edit a message that already has a translated subtitle | Subtitle re-translates to match the edit | ☐ |
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

If you'd rather work from the brief's original phrasing, items 1-3 and 5-6
above correspond to the brief's manual checklist 1-8 (minus a redundant
"delete a message" case not repeated here since it's a strict subset of
"edit"); items 7-19 are the additional cases raised in code review that the
brief's original list did not cover (cold-channel catch-up, duplicate-event
counting, mid-flight re-selection, retry-on-reopen, persistence-failure UX,
and the empty/invalid/fixed API-key sequence).
