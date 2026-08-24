# Domain glossary

Terms that mean something specific here. Written as they get settled, not in
one sitting — a glossary composed up front is a file nobody opens.

This is a glossary and nothing else: no implementation detail, no decisions.
Decisions live in `docs/adr/`.

## Session

One activation of the translation plugin — from `start()` to `stop()`, which is
to say from Discord launching (or the plugin being toggled on) until it is
toggled off or Discord quits.

A session owns only **in-memory** state: what is in flight, which engine has
failed this time round, which messages have already had a quality attempt spent
on them. Resetting a session drops all of it.

A session explicitly does **not** own the things that deliberately outlive it:

- **cooldowns** — a fact about an API key, not about this run. Clearing one on
  every toggle would buy a fresh probe request against a limit already hit.
- **cached translations** — a fact about the conversation. Clearing them would
  re-translate, and re-pay for, messages already fetched.
- **learned quota** — what a provider reported its limit to be.
- **enabled channels** — the user's own per-channel choices.

Each of those is persisted and read back by the next `start()`. "Reset the
session" must therefore never mean "forget the user's data".

## Tier

Which translator produced a line. Two exist, and every message can pass through
both.

- **Fast tier** — Google. Arrives within a second, free, no account. Marked `≈`.
- **Quality tier** — an LLM that sees the surrounding conversation, so slang,
  replies and mixed-language messages come out right. Needs a key. Marked `✦`.

The fast tier always answers first; the quality tier *upgrades* that line in
place when it lands. An upgrade never runs backwards — a fast result cannot
replace a quality one.

## Fallback pin

A session-scoped decision to stop using the quality tier after it refused.

Two kinds, and they expire differently because their remedies are opposite:

- **rejected key** — a fact about the credential. It will still be wrong in an
  hour, so the pin lasts until the key or engine changes.
- **blocked network** — a VPN, an ISP, a region. Those come back, so the pin
  expires on its own and the tier is retried.

## Marker

The sidecar Subline writes beside Discord's `app.asar` recording which build
patched it. It answers "is this patch ours, and is it the one we think it is?" —
distinct from the beacon, which answers "is it running?".

## Beacon

The status file the plugin writes from inside Discord. It is *evidence* that
translation is alive, and it is the only thing allowed to confirm an install.
It carries counts, timestamps and error codes — never message text, never an
API key.

## Bundle

The built Vencord-plus-plugin directory that Discord loads. It has an identity
(a build id) that travels with it, so an install can say which build is
actually running rather than merely that *some* Subline is.

## Managed install

A Discord that Subline patched and still recognises as its own — as opposed to
one patched by another mod, one half-patched, or one that has since been updated
out from under us. Only a managed install is repaired automatically.
