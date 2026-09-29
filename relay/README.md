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
| `POST /v1/checkout` | `Bearer free_<id>` + `x-subline-client` | `{plan:"monthly"\|"annual"}` → `{ok,url}`: a Dodo checkout session tied to this install (503 without `DODO_API_KEY`) |
| `POST /admin/coupon` | `Bearer <ADMIN_TOKEN>` | `{name}` → a single-use 100%-off code for 3 monthly cycles |
| `POST /v1/redeem` (v2) | code or install + `x-subline-install` | `{code}` → `{ok,code}`: a promo code grants Automatic |
| `POST /admin/promo` | `Bearer <ADMIN_TOKEN>` | `{code, cap}` → a server promo code, Automatic for the first `cap` installs |

Responses use the plugin's exact `NativeResponse` shape, so the client `relay`
engine needs no reshaping.

## v2: paid only (Automatic, AI, promo codes)

A v2 client sends `x-subline-api: 2` and its install id in
`x-subline-install: free_<32 hex>` on every request; the bearer is its saved
code, or the install id when it has none. Requests WITHOUT `x-subline-api: 2`
are answered exactly as before (taste, trial, previews, purchase links), so
v0.1.5 to v0.1.9 clients keep working until they update. Code: `src/entitle.ts`,
`src/v2.ts`, `src/promo.ts`.

- **Plans.** Automatic ($4.99 once, VARIANTS plan `automatic`, a license key
  that never expires) and AI (monthly/annual), sold only on top of Automatic.
  The Automatic product id in `wrangler.jsonc` is a PLACEHOLDER
  (`pdt_AUTOMATIC_PENDING`) until the owner creates the Dodo product.
- **Accounts.** `acct:<id>` joins a buyer's codes and installs; `ia:<hash>` and
  `ca:<code>` point at it. What an install may use is the union over the
  account's live codes. At most **3 installs** per account; a 4th gets 403
  `device_limit`. A purchase made from an install (`paid:<hash>`, the same
  checkout link as v1) joins that install's account on its next status.
- **Grants.** An AI code made before launch (no `createdAt`, or older than
  `LAUNCH_AT`) gives its account Automatic, kept after the subscription lapses
  and lost if that code is refunded. An install whose `trial:<id>` record is
  older than `LAUNCH_AT` gets Automatic free as an early user (an `slp_` code,
  note `early`).
- **Refunds** revoke the code they paid for; the union simply stops counting it.
  Refunding Automatic leaves AI, refunding AI leaves Automatic.
- **`GET /v1/status` (v2)** →
  `{ok, automatic, ai, aiUntil?, code?, previews:{used,cap}, token, tokenExpiresAt, now}`.
  `code` is a code the install should save (only when it presented its
  install id). `token` is base64url(JSON `{v,i,a,ai,exp}`) + "." +
  base64url(HMAC-SHA256 with `ENTITLEMENT_SECRET`), valid 7 days; empty
  signature when the secret is unset. AI is enforced here either way.
- **`POST /v1/translate` (v2).** AI: full ✦, charged to the account's AI code.
  Automatic only: `mode:"preview"` gets 5 cut previews a day per account
  (`use:pv:<account>:<day>`), anything else 402 `ai_required`. No
  entitlement: 402 `not_activated`.
- **`POST /v1/checkout` (v2)** takes `plan: "automatic"|"monthly"|"annual"`:
  AI without Automatic is 403 `automatic_required`, Automatic twice is 409
  `already_owned`.
- **Promo codes.** `node scripts/promo.mjs LEAKCLUB 100` (ADMIN_TOKEN from the
  environment) creates `promo:<CODE>`: 4 to 16 uppercase letters or digits,
  refused if it is already a working code. `POST /v1/redeem {code}` answers
  200 `{ok, code:"slp_..."}` (a new Subline code, plan automatic, note
  `promo:<CODE>`), 404 `not_found`, 410 `claimed`, 409 `already`, 429
  `rate_limited` (3 per address a day), 503 `unavailable`. The cap is counted
  by one `Promo` Durable Object per code, so 100 is exactly 100, one per
  install. `/admin/stats` adds `promos: [{code, cap, redemptions, aiPurchases}]`.
- **KV writes.** A status call from an install already in its account writes
  nothing. Writes happen only when something is learnt: an install or code
  joining an account (`acct:`, `ia:`, `ca:`), a grandfather or early grant,
  a redemption (`code:`, account rows, the per-address counter). A preview
  writes its day counter; AI writes the code's counters as v1 does.
- **Deploy.** Migration `v2` creates the `Promo` class. Optional secret:
  `npx wrangler secret put ENTITLEMENT_SECRET` (`openssl rand -hex 32`). Var
  `LAUNCH_AT` (epoch ms or ISO date): move it to the real launch moment.

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
npx wrangler secret put DODO_API_KEY     # Dodo API key (same mode as DODO_API_BASE): enables /v1/checkout and /admin/coupon
# Provider routing: MODEL=gemini* + GEMINI_KEY → Gemini primary, Groq fallback.
# Drop GEMINI_KEY (or set MODEL to a Groq id) to run Groq-only.

# 3. Ship
npm test                                 # cap/kill-switch/parse/drift guards must pass
npx wrangler deploy                      # prints the https://subline-relay.<you>.workers.dev URL
```

Put that URL into the plugin build as the `RELAY_URL` constant.

## Buying without a key (`/v1/checkout`)

Needs the `DODO_API_KEY` secret (`npm run secret:dodo`) and the `DODO_API_BASE`
var (live or test, matching the key). Without the key `/v1/checkout` and
`/admin/coupon` answer 503 and nothing else changes.

1. The plugin calls `POST /v1/checkout {plan}` with its `free_` id and the
   `x-subline-client` header, both required: no bearer is 401, a malformed
   bearer or a missing/invalid header is 400, all answered before any KV
   access or Dodo call. There is no anonymous checkout. The relay
   creates a Dodo checkout session (`POST /checkouts`) for the VARIANTS product
   of that plan, with `metadata.install` = first 16 hex of SHA-256 of the
   bearer (never the raw id), `return_url` = `CHECKOUT_RETURN_URL` plus `?from=discord` (so the site says "go back to Discord"), and
   `redirect_immediately`. It stores `checkout:<session_id>` → hash (2 days).
   Rate limits: 6 an hour per install, 20 an hour per IP.
2. Webhooks, any order. `payment.*` / `subscription.*` carry the session
   metadata (a payment also carries `checkout_session_id`, the fallback join):
   the relay writes `inst:<payment_id|subscription_id>` → hash (3 days).
   `license_key.created` carries the key and the same ids. Whichever lands
   second writes `paid:<hash>` → key (30 days). Each side re-reads the other's
   row once after writing, so two events processed at the same moment still
   complete the link.
3. `GET /v1/status` from a header'd client holding that `free_` id adds
   `purchase:{code,plan}` while the code is active. Nobody else can get it.

The site does not use this endpoint: it sells through Dodo's static links, and
the buyer sees the key on the thanks page (Dodo appends `license_key` to the
return URL) and in the receipt email.

## Personal coupons

```sh
ADMIN_TOKEN=... node scripts/coupon.mjs alex     # prints e.g. ALEXK7Q2M
```

Creates a Dodo discount: code = the name uppercased with everything but A-Z
and 0-9 removed (at least 3 left, else 400), cut to 11, plus 5 random
characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (crypto RNG, unbiased), so
at most 16 (Dodo's documented maximum) and not guessable from the name alone.
100% off, restricted
to the monthly product, `subscription_cycles: 3`, `usage_limit: 1`.

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
