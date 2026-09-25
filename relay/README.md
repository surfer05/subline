# Subline relay

A Cloudflare Worker that holds the maker's paid Groq key and serves **keyless AI
translation** to Subline clients presenting an opaque per-user **code**.

- **Zero-retention** — message text is never logged or stored. `metrics.ts` is
  the only observability path; it emits counts and outcome labels, never bodies.
- **Zero-identity** — the code carries no name. The Merchant-of-Record holds the
  email; the relay holds only the code and counters.
- **The relay owns the model and prompt.** A client sends only the structured
  batch. It cannot pick the model, inject a prompt, or reach the key — so a
  valid code is not a general Groq proxy.
- **Budget-safe** — per-code daily caps, per-minute rate limits, and a
  cumulative global kill-switch (`GLOBAL_BUDGET_MESSAGES`, ~$45) that freezes the
  whole relay before spend can exceed the ~$50 beta budget.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/translate` | `Bearer <code>` | translate a batch → `{ok,results,used,cap}` |
| `GET /v1/status` | `Bearer <code>` | `{ok,plan,used,cap,resetsInMs}` for the settings pane (read-only; v0.1.6 clients also get `trialEndsAt`, `now`) |
| `POST /admin/codes` | `Bearer <ADMIN_TOKEN>` | mint / revoke codes |
| `GET /admin/stats?days=14` | `Bearer <ADMIN_TOKEN>` | approximate daily owner counts (see below) |
| `POST /webhook/mor` | Dodo Standard-Webhooks signature | issue/revoke on purchase/refund (inert until configured) |

Responses use the plugin's exact `NativeResponse` shape, so the client `relay`
engine needs no reshaping.

## The taste tier (keyless installs)

An install with no purchased code sends `Bearer free_<32 lowercase hex>`, a
random id it generates once and keeps. No mint, no KV row, nothing to revoke:
`authCode` resolves that bearer to a synthetic record
(`{ status:"active", plan:"taste", dailyCap:3 }`) without a lookup, so a `free_`
bearer can never be minted, revoked, or given a bigger cap. Any other `free_`
shape is rejected exactly like an unknown code.

- **3 quality translations a day**, counted as MESSAGES only (no prompt-size
  surcharge), so 3 presses means 3 translations however long they are. The
  global budget guard is still charged the real spend (messages +
  ceil(promptChars/1000)), as for a paid code.
- Same daily counter as every plan (`use:free_<id>:<day>`), same UTC midnight
  reset, same `{ok:false,error:"daily limit reached",retryAfterMs}` on the cap.
- **6 messages a day per IP** (`use:ip:<ip>:<day>`, from `cf-connecting-ip`), so
  rerolling the random id does not simply reset the cap. An IPv6 caller is
  keyed on its /64 (first 4 hextets, e.g. `2001:db8:1:2::/64`), since one
  subscriber can pick any address inside it. Skipped when the header is absent;
  the global budget guard applies as it does to everything.
- No per-minute `rl:` counter: with a daily cap of 3 it can never reach the
  rate limit of 20, so it is neither read nor written.
- `GET /v1/status` answers `{ok:true,plan:"taste",used,cap:3,resetsInMs}`, which
  is what the plugin reads at startup to show "2 of 3 left today".
- Metrics rows carry a plan label, so `ok`/`taste` (installs that tasted it) and
  `cap_exceeded`/`taste` (installs that hit the wall) are countable.

## The 7-day trial and preview mode (v0.1.6+ clients)

A v0.1.6+ plugin sends `x-subline-client: vcTranslate/<version>` (any value
matching `^[A-Za-z0-9._/+-]{1,40}$`; only its presence matters, versions are
never compared). Without it the relay behaves exactly as above, and never reads
or writes a `trial:` key, so v0.1.5 installs see no change.

- **Trial.** For a header'd `free_` bearer the relay stores `trial:<id>` = the
  first-seen epoch ms, written on that id's **first successful translate**
  (after `reserve()` passed the per-IP ceilings), never by `/v1/status` and
  never by a refused request. Until then the id is a *provisional* trial that
  starts now. The key has a **90-day TTL** from that first write, never
  refreshed: after 90 days it lapses. The relay alone would then offer that id
  a second trial, and it would also never end a trial whose first write failed
  (status keeps answering "now + 7 days"). The **client** is what closes both:
  it keeps its own trial start (set on its first v0.1.6 run, never reset) and
  takes the EARLIER of its own end and the relay's, and a status answer for an
  unwritten id carries `trialProvisional: true`, which the client never lets
  extend a trial.
- **Keyless requests fail CLOSED on KV.** For taste, trial and preview the KV
  counters are the only limit, so they are written *before* the global budget
  is committed; if any write fails the request gets 503 "temporarily
  unavailable" with nothing spent and no model call (partial writes are rolled
  back best-effort). Paid codes stay fail-open. A failed trial lookup refuses
  `mode:"auto"` with the same 503, never with "trial ended".
- For 7 days from first sight the bearer is plan `trial`: 300 messages/day
  (messages only, rpm 20). Per IP (IPv6 on its /64): 600 messages/day on
  `use:ipt:<ip>:<day>` **and** 1,200 cost units/day on `use:iptc:<ip>:<day>`
  (a cost unit is what the global budget is charged: messages +
  ceil(promptChars/1000)), so long messages hit a wall before 600 of them do.
  After day 7 it is plain taste (3/day, `use:ip:` 6/day).
- **`/v1/status`** is **read-only** for every caller. For a header'd `free_`
  bearer it adds `trialEndsAt` (epoch ms; `now + 7 days` for an id not yet
  written, marked `trialProvisional: true`) and reports `plan:"trial", cap:300` during the trial,
  `plan:"taste", cap:3` after.
- **`now`** (the relay's epoch ms) rides every header'd `/v1/status`, every
  header'd translate success, and the 402 below, so the client can count
  `trialEndsAt` down against the relay's clock. Header-less responses are
  byte-identical to v0.1.5.
- **`mode:"auto"`** (body field) after the trial ends, from a header'd `free_`
  bearer: `402 {ok:false,error:"trial ended",trialEndsAt,now}`, refused before
  any reservation so it never spends the hand-pressed taste messages. If the
  trial lookup itself fails (KV error), `mode:"auto"` gets the same 402 without
  `trialEndsAt`; a hand press in that outage gets taste. Ignored without the
  header.
- **`mode:"preview"`** from any `free_` bearer (ignored for real codes): each
  translated row is cut to its first 5 words, max 32 code points, and gets
  `truncated:true` when shortened. The cut happens on the relay, so a preview
  request never gets the full text back. Only the v0.1.6 client sends
  `mode:"preview"`: a header-less legacy (v0.1.5) request still gets full ✦
  text within its 3/day taste allowance. Charged exactly like a normal taste
  press.

## Owner stats

`GET /admin/stats?days=N` (1..30, default 14; `ADMIN_TOKEN`, same gate as
`/admin/codes`) returns `{ok,approximate:true,days:[…]}`, **newest day first**,
each `{day,activeFreeInstalls,trialsStarted,activeTrials,activePaidCodes,
previewsServed,conversions:{monthly,annual,lifetime,paid,free}}`.

Counters are KV keys `stat:<day>:<name>` (35-day TTL). Distinct actives use a
2-day marker `seen:<kind>:<day>:<first 16 hex of SHA-256(bearer)>`, so no key or
response ever holds a code, id, or IP. They are written only after a
successful `reserve()` (never by `/v1/status`), so "active" means "got a
translation that day". A conversion is counted when
`license_key.created` creates a key that did not exist (a replay does not
count). KV has no atomic increment, so concurrent requests can undercount
slightly: these are **approximate owner metrics, never billing**. Every stats
write runs in `ctx.waitUntil` and swallows errors, so stats can never slow or
fail a translation or a webhook. The spend counters (`use:`, `rl:`, per-IP)
are written after the budget guard has cleared the request; if KV refuses one
of those writes the relay logs the counter name and KV's error (never the code,
id, or IP) and still serves the request.

## Deploy runbook

```sh
cd relay
npm install
npx wrangler login                       # opens a browser; creates/links the free CF account

# 1. KV namespace (prod, and optionally staging)
npx wrangler kv namespace create CODES   # paste the returned id into wrangler.jsonc → kv_namespaces
# npx wrangler kv namespace create CODES --env staging

# 2. Secrets (never in git)
npx wrangler secret put GEMINI_KEY       # billing-enabled Google Gemini key — PRIMARY provider (MODEL=gemini-3.8-flash)
npx wrangler secret put GROQ_KEY         # a Groq key — the automatic FALLBACK when Gemini fails
npx wrangler secret put ADMIN_TOKEN      # a long random string: openssl rand -hex 32
# npx wrangler secret put MOR_WEBHOOK_SECRET   # only when payments go live
# Provider routing: MODEL=gemini* + GEMINI_KEY → Gemini primary, Groq fallback.
# Drop GEMINI_KEY (or set MODEL to a Groq id) to run Groq-only.

# 3. Ship
npm test                                 # cap/kill-switch/parse/drift guards must pass
npx wrangler deploy                      # prints the https://subline-relay.<you>.workers.dev URL
```

Put that URL into the plugin build as the `RELAY_URL` constant.

## Mint a code for a friend

```sh
curl -sX POST https://subline-relay.<you>.workers.dev/admin/codes \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"action":"mint","plan":"free","dailyCap":500,"note":"beta: alex"}'
# → { "ok": true, "code": "slp_xxxxxxxxxxxxxxxx", ... }   send that code to the friend
```

Revoke: `-d '{"action":"revoke","code":"slp_..."}'`.

## Smoke test

```sh
curl -sX POST https://subline-relay.<you>.workers.dev/v1/translate \
  -H "Authorization: Bearer slp_..." -H "content-type: application/json" \
  -d '{"messages":[{"id":"1","author":"a","text":"hola amigo"}],"context":[],"targetLang":"en"}'
# → { "ok": true, "results": [{"id":"1","lang":"es","text":"hi friend","skip":false}], "used":1, "cap":500 }
```

## Caps and cost

Groq ≈ $0.032 / 1,000 messages. Defaults: free code 500 msgs/day (≈ $0.016/day
ceiling), paid 1,500/day. Global freeze at 1.4M messages ≈ $45. Change
`GLOBAL_BUDGET_MESSAGES` in `wrangler.jsonc` and `dailyCap` per code.

## Security model

- **The money guard is atomic.** The global spend ceiling lives in a Durable
  Object (`budget.ts`), not KV — KV has no atomic read-modify-write, so a
  concurrent burst on one code would race the check and drain the key without
  bound (caught in review). The DO serialises reserves, so total spend is a hard
  stop at `GLOBAL_BUDGET_MESSAGES` no matter the concurrency. The migration in
  `wrangler.jsonc` creates it on first deploy; SQLite-backed DOs run on the
  Workers free plan.
- **Per-code daily caps stay in KV** — soft fairness limits, bounded by the
  atomic global guard, so a slight concurrent over-count costs pennies not
  dollars.
- **The relay owns the model and prompt, and every untrusted field is escaped**
  (message text, author, context, AND targetLang) — a crafted request cannot
  inject a prompt or turn the relay into a general Groq proxy. Payloads are
  capped: 40 messages, 12 context entries, 4k chars/field, 32KB body, 40-char
  target; `cost` folds prompt size in so a huge context cannot be billed as one.
- **A Groq timeout is truly cancelled** (AbortController) and stays charged, so a
  client cannot force slow batches to burn the key for free.
- `translate.ts` mirrors the plugin's `engines/llmShared.ts` + `engines/groq.ts`.
  The drift-guard test fails if the prompt's load-bearing rules change; keep them
  in sync.
