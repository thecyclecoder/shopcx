# libraries/ai-usage

Token accounting writes to [[../tables/ai_token_usage]]. `withTokenAccounting()` wraps SDK calls.

**File:** `src/lib/ai-usage.ts`

## File header

```
Token-usage logging for Claude API calls. Anthropic returns precise
input/output token counts on every response — we capture them in
ai_token_usage so analytics can compute per-ticket cost and per-
purpose token burn.
Usage shape (Anthropic responses include this):
data.usage = { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
Pricing reference (Apr 2026, may drift):
sonnet-4: $3/M input, $15/M output
haiku-4.5: $1/M input, $5/M output
opus-4.7: $15/M input, $75/M output
```

## Exports

### `logAiUsage` — function

```ts
async function logAiUsage({ workspaceId, model, usage, purpose, ticketId }: LogParams) : Promise<void>
```

### `usageCostCents` — function

```ts
function usageCostCents(model: string, row: { input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number }) : number
```

### `ClaudeUsage` — interface

## Callers

- `src/app/api/workspaces/[id]/analytics/ai/route.ts`
- `src/lib/daily-analysis-report.ts`
- `src/lib/inngest/unified-ticket-handler.ts`
- `src/lib/social-comment-orchestrator.ts`
- `src/lib/sonnet-orchestrator-v2.ts`
- `src/lib/ticket-analyzer.ts`
- `src/lib/translate.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
