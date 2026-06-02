# libraries/improve-actions

Improve-tab actions for agent overrides on playbook tickets.

**File:** `src/lib/improve-actions.ts`

## File header

```
Improve-tab action dispatcher. Used by both:
- The Opus loop in /api/tickets/[id]/improve (when admin hasn't yet
approved a proposal)
- The fast-path "execute_actions" body field (when admin clicks
Approve & Execute — bypasses Opus to avoid the "Opus forgot the
JSON it emitted last turn" failure mode)
Returns the result strings + the action context (label_url, etc.)
accumulated across the batch so chained send_message can substitute
placeholders.
```

## Exports

### `runImproveActions` — function

```ts
async function runImproveActions(workspaceId: string, ticketId: string, actions: ImproveAction[],) : Promise<ImproveActionResult>
```

### `ImproveAction` — interface

### `ImproveActionResult` — interface

## Callers

- `src/app/api/tickets/[id]/improve/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
