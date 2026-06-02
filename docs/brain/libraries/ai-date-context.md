# libraries/ai-date-context

Relative-date helpers (e.g. 'last Tuesday') for AI prompts.

**File:** `src/lib/ai-date-context.ts`

## File header

```
Standardized "current date" context block to inject into AI prompts.
Claude models have training cutoffs in the past. Without explicitly
being told what today's date is, they sometimes reason from a stale
baseline — e.g. miscalculating "expires in June 2026" as 13 months
out when it's actually 1 month from today's actual May 2026.
Drop this block into any AI prompt that involves date math, timeline
analysis, or temporal reasoning (orders, expirations, subscriptions,
messages, returns, etc).
```

## Exports

### `currentDateContext` — function

```ts
function currentDateContext() : string
```

## Callers

- `src/lib/sonnet-orchestrator-v2.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
