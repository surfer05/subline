# ADR 0001 — Keep `inspectModBundle`

**Status:** accepted · 2026-08-24

## Context

An architecture review proposed deleting `inspectModBundle`
(`installer/src/bundle/bundle.ts`) as a pass-through. The argument: it converts
`inspectBundleDir`'s `{ manifest, problems, loaderPath }` into `Result<ModBundle>`
by re-flattening six manifest fields that it also carries whole as `.manifest`,
and the decision it appears to make ("usable, not merely present") is entirely
inside `spec.ts`. Under the deletion test, complexity would supposedly *move and
shrink* rather than concentrate.

## Decision

Keep it. The deletion test says the opposite once the call sites are counted.

Deleting it would push the usability gate — `manifest === null || problems.length
> 0`, plus the `MOD_BUNDLE_INVALID` error and its message — into all five
callers: `modInstall.ts` (three times), `patch.ts`, and `helper/ports.ts`. That
is the same decision written five times, and it is the decision that stops a
bundle whose identity is wrong from being patched into Discord.

The flattening is not redundancy, it is the leverage. Counted across `src` and
`tests`:

| field | read flattened | read via `.manifest` |
|---|---|---|
| `dir` | 66 | 0 |
| `buildId` | 32 | 12 |
| `loaderPath` | 25 | 0 |
| `pluginVersion` | 4 | 3 |
| `vencordCommit` | 3 | 0 |
| `vencordVersion` | 3 | 0 |
| `builtAt` | 0 | 1 |

Removing the flat fields would make 130+ sites reach through `.manifest` to say
what they say now in one property. That is a wider interface for every caller,
not a narrower one.

## Consequences

- `ModBundle.builtAt` is genuinely unread in its flattened form. Left in place:
  it costs one line, it describes what a bundle *is*, and churning it buys
  nothing measurable. Noted here so its absence from the table above is not
  mistaken for an oversight next time.
- A future review that proposes this again should count call sites before
  proposing it. "Interface nearly as wide as the implementation" was the right
  smell; the counts are what settle it.
