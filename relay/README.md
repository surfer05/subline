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
| `POST /webhook/mor` | HMAC signature | issue/revoke on purchase/refund (inert until configured) |

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

## Notes / upgrade path

- KV metering is eventually consistent: concurrent requests on one code can
  slightly undercount. Bounded and safe here because (a) a client sends ~2-3
  req/min and (b) the global kill-switch is the real budget guard. For precise
  per-code accounting on the paid tier, swap `codes.ts` for one Durable Object
  per code — the router only calls `authCode`/`reserve`/`refund`.
- `translate.ts` mirrors the plugin's `engines/llmShared.ts` + `engines/groq.ts`.
  The drift-guard test fails if the prompt's load-bearing rules change; keep them
  in sync.
