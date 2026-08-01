# vcTranslate — Design

**Date:** 2026-08-01
**Status:** Approved, ready for implementation planning

## Problem

Reading a Discord voice-channel text chat where several people write in their own
languages currently means copy-pasting (or screenshotting) the conversation into
Google Translate to follow along. This is slow, breaks focus mid-game, and loses
the flow of the conversation.

The goal is a passive, always-on translated view of a fast-moving VC chat.

## Constraints

These are fixed by the user's situation and drive most of the design:

- **Not a server admin.** A Discord bot cannot be installed, so everything must
  run client-side.
- **Desktop app only.** The user does not use Discord in a browser.
- **Read-only.** Only incoming messages need translating; outgoing messages are
  out of scope.
- **Several languages at once**, so per-message detection is required.

The user reviewed the Discord ToS risk of client modification and chose to
proceed with a Vencord userplugin.

## Prior art

Vencord ships a [Translate plugin](https://vencord.dev/plugins/Translate), but it
is **manual — one click per message**. The open request for automatic translation
of incoming messages
([Vendicated/Vencord#2164](https://github.com/Vendicated/Vencord/issues/2164))
is unimplemented. The passive, always-on behavior this spec describes does not
exist off the shelf.

## Architecture

A Vencord userplugin at `src/userplugins/vcTranslate/`. Installation requires
building Vencord from source (`pnpm build` + `pnpm inject`); userplugins are not
available in the stock installer.

Discord's Content Security Policy blocks the renderer process from reaching
`api.anthropic.com`. Vencord's `native.ts` mechanism runs code in Electron's main
process, outside the CSP. This forces a clean three-way split:

| File | Process | Responsibility | Coupled to |
|---|---|---|---|
| `index.tsx` | Renderer | Flux hooks, subtitle rendering, settings, header button | Discord internals |
| `translator.ts` | Renderer | Batching, skip rules, cache, prompt building | Nothing |
| `native.ts` | Main (Node) | HTTP calls, API key custody | Nothing |
| `engines/*.ts` | Main (Node) | Per-provider request/response mapping | Provider APIs |

`translator.ts` holds all real logic as pure functions and is unit-testable
without launching Discord. The Discord-coupled shell is deliberately thin.

## Data flow

```
MESSAGE_CREATE (Flux)
  → skip rules       (own message, empty, emote/link/mention-only, numeric)
  → enqueue          (debounce ~700ms — VC chat arrives in bursts)
  → batch            (≤10 messages + last 8 messages as context)
  → native.translate()  → engine → [{id, lang, text} | {id, skip}]
  → LRU cache        (key: messageId + targetLang + engineId)
  → render subtitle beneath the original message
```

### Why batching

Three people typing simultaneously in three languages becomes one API call rather
than three. It is roughly 3× cheaper and lower-latency, but the real reason is
**context**: the model sees the surrounding conversation, so "yeah I agree"
resolves to what it is agreeing with, and pronoun-heavy replies land correctly.
Per-message, context-free translation is precisely why pasting chat into Google
Translate produces unusable output.

### Language detection

No separate detection step. The Claude engine is asked to return `skip` for
messages already in the target language; the Google engine derives the same
signal from its detected-language field. One round trip either way, and the LLM
path judges a whole message in context rather than guessing from three words.

## Engine abstraction

```ts
interface TranslationEngine {
  id: "google" | "claude";
  supportsContext: boolean;
  translate(req: BatchRequest): Promise<Result[]>;
}

type BatchRequest = {
  messages: { id: string; author: string; text: string }[];
  context:  { author: string; text: string }[];   // omitted when !supportsContext
  targetLang: string;
};

type Result =
  | { id: string; lang: string; text: string }
  | { id: string; skip: true };
```

**Google (default, free).** Unofficial `translate.googleapis.com` endpoint. No
key, no signup, no cost. Ignores `context`; fires per-message with a concurrency
cap of 4. Quality on slang, abbreviations, and short fragments is poor — this is
the engine the existing Vencord plugin uses.

**Claude (optional, ~$2–3/month).** `claude-haiku-4-5` via `@anthropic-ai/sdk`
at $1/$5 per MTok. Sends the whole batch plus context in one call. Handles slang,
typos, and mixed-language messages substantially better. Estimated cost: ~500
messages per session ≈ 60 batched calls ≈ under $0.10 per night.

Both return the same shape, so `index.tsx` is engine-agnostic. The batcher skips
assembling context when `supportsContext` is false.

**Rationale for shipping both:** the free path removes any commitment to try the
tool, and the paid path is one setting away if the free output proves unusable
for this group's languages. The interface boundary already existed for CSP
reasons, so supporting two engines costs little extra.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Engine | Google | Claude selectable |
| Anthropic API key | — | Only rendered when Claude is selected |
| Target language | Discord locale (English) | |
| Catch-up on open | 20 messages | Translates visible backlog when opening a channel |
| Global auto-translate | off | Per-channel toggle is the primary control |

**Scope of activation.** A globe button in the channel header toggles
auto-translate for that channel; the choice persists by channel ID. The target VC
chat is on, other channels in the server stay quiet.

## Display

Original message unchanged; translation rendered directly beneath in dimmed
italic with a language tag:

```
grimzz  今日はやめとく、明日やろう
        ⤷ ja · let's skip today, we'll do it tomorrow
```

Rendered via Vencord's **message-accessory API**, not by patching message
components. Accessories are a supported extension point and survive Discord's
frequent internal refactors far better than component patching.

## Failure handling

| Failure | Behavior |
|---|---|
| Network / 5xx | Retry once after 1s; then a dimmed `⚠ translation failed` under the message. Never a popup. |
| Rate limited (429) | Exponential backoff, pause queue, drop oldest pending batch rather than accumulate a backlog. |
| Missing/invalid Claude key | One toast on first failure, then fall back to Google for the session. |
| Google response shape change | Endpoint is unofficial and unversioned; parse defensively and treat unexpected shapes as ordinary failures. |
| Edited message | `MESSAGE_UPDATE` invalidates the cache entry and re-queues. |
| Deleted message | Accessory is removed with the message; no action needed. |

**Cache:** LRU capped at 500 entries, keyed by `messageId + targetLang +
engineId`. Scrolling does not re-spend; switching engines does not serve stale
output from the previous one.

## Security and privacy decisions

**API key storage.** The Anthropic key is stored in plaintext in Vencord's
`settings.json`, readable by anything running as the user. This is normal for
local developer tooling. Mitigation: scope the key to a dedicated Anthropic
project with a spend limit so exposure is bounded.

**Third-party transmission.** The plugin sends other participants' messages to a
translation provider. Google's free endpoint is unofficial, with no
data-processing agreement or stated retention; Anthropic's API has published
terms and does not train on API traffic by default.

*Decision (user, 2026-08-01):* accepted. The channel is a public group chat
readable by anyone in it, and the user already pastes its contents into Google
Translate manually. Automation changes the volume of what is sent, not its kind.

## Testing

`translator.ts` is pure and covered by vitest with no Discord running:

- **Skip rules** — emote-only, link-only, mention-only, numeric-only, empty, own message
- **Batching** — debounce window, batch-size cap, context assembly, `supportsContext: false` path
- **Cache** — LRU eviction, key includes engine and language, edit invalidation
- **Engines** — recorded fixtures of real API responses, including malformed and error payloads

Discord-coupled parts (Flux subscription, accessory rendering, header button)
are verified by a short manual checklist. Mocking Discord internals costs more
than it catches, and those parts are thin by design.

## Out of scope

- Translating outgoing messages
- Voice / speech translation
- DMs and group DMs
- Any Discord client other than the desktop app
- Server-side bot deployment
