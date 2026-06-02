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

### `ConversationMessage` — interface

### `AssembledContext` — interface

## Callers

- `src/lib/inngest/unified-ticket-handler.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
