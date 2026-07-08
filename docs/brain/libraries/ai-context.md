# libraries/ai-context

Pre-loaded context builder for the orchestrator. Customer + ticket history + handler catalog + personality + rule pack.

**File:** `src/lib/ai-context.ts`

## File header

```
Multi-turn AI context assembler
Builds full conversation context with customer history for Claude
```

## Exports

### `assembleTicketContext` — function

```ts
async function assembleTicketContext(workspaceId: string, ticketId: string,) : Promise<AssembledContext>
```

### `assembleDirectionContext` — function (Direction-scoped, cost-inverted path)

```ts
async function assembleDirectionContext(
  workspaceId: string,
  ticketId: string,
  input: { live_direction: TicketDirection; newest_inbound: { body_clean: string | null } },
): Promise<AssembledDirectionContext | null>
```

Phase 1 of [[../specs/sol-cheap-execution-over-ticket-direction]] — the actual cost inverter. Once Sol's first-touch box session has written a live [[../tables/ticket_directions]] row, calm turns stop paying for full-history Sonnet: per-turn context becomes the Direction (intent + context_summary + guardrails) + the newest inbound message + (only when `chosen_path='playbook'` AND `tickets.active_playbook_id` is set) the current playbook step. Customer / order / subscription re-fetches are deliberately omitted — Sol summarized them into `context_summary` at first-touch, so re-fetching wastes tokens on data the model would just re-summarize identically. Returns `null` when the caller passed a Direction whose `superseded_at` is non-null (caller falls through to `assembleTicketContext`).

Consumed by [[../libraries/sonnet-orchestrator-v2]] `buildPreContext` via the `directionOverride` parameter — when a live Direction is passed, the orchestrator's user block is built from `renderDirectionSystemPrompt` INSTEAD of the customer-name / RECENT ORDERS / full-history block. Wire-in: [[../inngest/unified-ticket-handler]] § Step 2e — Sonnet orchestrator (Direction-scoped user block). See also [[../libraries/model-picker]] § Direction-driven Haiku route (a fresh + high-confidence + stateless Direction relaxes the picker toward Haiku).

### `renderDirectionSystemPrompt` — function (pure, testable)

```ts
function renderDirectionSystemPrompt(
  direction: TicketDirection,
  playbook?: DirectionPlaybookSnapshot | null,
): string
```

Pure system-prompt renderer for the Direction-scoped path — extracted so unit tests can pin the exact shape ("suffix contains intent, context_summary, stringified guardrails; does NOT contain the customer name or Recent Orders block `assembleTicketContext` would have injected"). No DB, no network. Emits the `DIRECTION` section always; the `PLAYBOOK STEP` sub-section is emitted only when `direction.chosen_path === 'playbook'` AND a `playbook` snapshot is passed in.

### `AssembledDirectionContext` — interface

### `DirectionPlaybookSnapshot` — interface

### `ConversationMessage` — interface

### `AssembledContext` — interface

## Callers

- `src/lib/inngest/unified-ticket-handler.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
