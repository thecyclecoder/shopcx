# libraries/model-picker

Per-call orchestrator model selection. **Founder directive (2026-07-10): the orchestrator NEVER runs on Opus.** Two tiers only: SONNET (the workhorse) and HAIKU (the cheap fast-path for a fresh, high-confidence, stateless Sol Direction).

**File:** `src/lib/model-picker.ts`

## Never Opus (2026-07-10)

Opus was removed entirely from the orchestrator routing path (`OrchestratorModel = "sonnet" | "haiku"`; `OPUS_MODEL` dropped from `sonnet-orchestrator-v2.ts` MODEL_IDS). The rationale: Sonnet 5 is more than capable, and a ticket that genuinely needs deeper handling is **re-sessioned to Sol** (the box first-touch / re-session router) rather than escalated to an Opus middle tier — *"either Sonnet handles it, or Sonnet decides this is better handled by Sol."*

The "hard" signals below are still **computed and surfaced** in `reason` as `hard:<signals>` — but they no longer change the MODEL, only the reason string (for audit + to feed the Sonnet→Sol escalation decision):

- `ai_turn_count >= 1` — turn 1 didn't close the ticket
- Complex tags: `crisis*`, `pb:*`, `j:cancel*`, `wb`, `dunning:active`, `fraud`
- Active crisis enrollment for this customer
- Linked accounts (`customer_links` row exists for this customer)
- Customer has 2+ active subscriptions
- Recently merged into this ticket (sibling row with `merged_into=tid` in last 24h)

## Precedence (in `pickModelFromSignals`)

0. `isCheckoutStuck === true` → **Sonnet** with reason `checkout-stuck`. Earliest gate (part of [[../recipes/checkout-stuck-concierge-flow]]). Set by `pickOrchestratorModel` from the newest inbound message via [[checkout-stuck-intent]] `classifyCheckoutStuck`. Overrides EVERY subsequent rule — a checkout question is a re-session-Sol problem, not a Sonnet→Opus problem, and this gate is the belt while [[inflection-detector]] fires the actual re-session on the same turn.
1. Any hard signal → **Sonnet** with reason `hard:<signals>`. (The Haiku fast-path is deliberately NOT taken on a hard ticket.)
2. No hard signals BUT a fresh + high-confidence + stateless Direction → **Haiku** (reason `sol-direction-fresh(...)`).
3. Otherwise → **Sonnet** (reason `default`).

Returns `{ model, reason }` so we can stamp `purpose` on `ai_token_usage` with the routing rationale.

## Exports

### `pickOrchestratorModel` — function

```ts
async function pickOrchestratorModel(params: {
  workspaceId: string;
  ticketId: string;
  customerId: string | null;
  direction?: TicketDirection | null;
  newestMessage?: string | null;   // Phase 2 — for checkout-stuck classification
}) : Promise<ModelPick>
```

### `ModelPick` — interface

### `OrchestratorModel` — type (`"sonnet" | "haiku"` — no `"opus"`)

## Callers

- `src/lib/inngest/unified-ticket-handler.ts` — calls `pickOrchestratorModel`, stamps `[System] Orchestrator model: …` sysNote, and passes the pick to `callSonnetOrchestratorV2`. The result label is `Haiku` when `pick.model === "haiku"`, else `Sonnet` (never Opus).

## Gotchas

- **Never Opus.** The `OrchestratorModel` type has no `"opus"` member — any `pick.model === "opus"` comparison is a tsc error. If you're reviving a deeper tier, the intended path is a Sol re-session, not adding Opus back.

---

[[../README]] · [[../../CLAUDE]]
