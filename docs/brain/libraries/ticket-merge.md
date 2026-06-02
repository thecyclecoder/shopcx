# libraries/ticket-merge

Merge duplicate tickets via `merged_into` self-FK. Combines messages, retains the canonical id.

**File:** `src/lib/ticket-merge.ts`

## File header

```
Ticket merge — single function used by bulk action (agent UI) and Sonnet (auto-merge).
Always merges old tickets INTO the newest ticket.
Old tickets are archived with `merged_into` reference.
```

## Exports

### `mergeTickets` — function

```ts
async function mergeTickets(workspaceId: string, ticketIds: string[], mergedBy: string = "System",) : Promise<MergeResult>
```

### `MergeResult` — interface

## Callers

- `src/app/api/tickets/merge/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
