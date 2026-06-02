# libraries/model-picker

Per-call model selection: turn 1-2 Haiku, turn 3+ Sonnet, deep analysis Opus.

**File:** `src/lib/model-picker.ts`

## File header

```
Picks the orchestrator model (Sonnet vs Opus) per ticket. Broad Opus
triggers — at our ticket volume even all-Opus is ~$420/mo, well below
the cost of a part-time CSR. The aim is reliability, not penny-pinching:
Sonnet is reserved for the obviously-trivial first touch.
Signals (any one trips Opus):
• ai_turn_count >= 1 — turn 1 didn't close the ticket
• Complex tags: crisis*, pb:*, j:cancel*, wb, dunning:active, fraud
• Active crisis enrollment for this customer
• Linked accounts (customer_links row exists for this customer)
• Customer has 2+ active subscriptions
• Recently merged into this ticket (sibling row with merged_into=tid in last 24h)
• Customer LTV >= $200
Returns { model, reason } so we can stamp `purpose` on ai_token_usage
with WHY Opus was chosen — that's how we audit "did Opus actually help?"
```

## Exports

### `pickOrchestratorModel` — function

```ts
async function pickOrchestratorModel(params: { workspaceId: string; ticketId: string; customerId: string | null; }) : Promise<ModelPick>
```

### `ModelPick` — interface

### `OrchestratorModel` — type

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
