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
| `GET /v1/status` | `Bearer <code>` | `{ok,plan,used,cap,resetsInMs}` for the settings pane |
| `POST /admin/codes` | `Bearer <ADMIN_TOKEN>` | mint / revoke codes |
| `POST /webhook/mor` | Dodo Standard-Webhooks signature | issue/revoke on purchase/refund (inert until configured) |

Responses use the plugin's exact `NativeResponse` shape, so the client `relay`
engine needs no reshaping.

## Deploy runbook

```sh
cd relay
npm install
npx wrangler login                       # opens a browser; creates/links the free CF account

# 1. KV namespace (prod, and optionally staging)
npx wrangler kv namespace create CODES   # paste the returned id into wrangler.jsonc → kv_namespaces
# npx wrangler kv namespace create CODES --env staging

# 2. Secrets (never in git)
npx wrangler secret put GROQ_KEY         # your PAID Groq key
npx wrangler secret put ADMIN_TOKEN      # a long random string: openssl rand -hex 32
# npx wrangler secret put MOR_WEBHOOK_SECRET   # only when payments go live

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
