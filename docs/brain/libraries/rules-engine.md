# libraries/rules-engine

Synchronous compound AND/OR rules engine. 8 action types: tags, status, assign, auto-reply, internal note, customer update, Appstle pause/cancel.

**File:** `src/lib/rules-engine.ts`

## Exports

### `evaluateRules` — function

```ts
async function evaluateRules(workspaceId: string, eventType: string, context: RuleContext,) : Promise<void>
```

### `RuleCondition` — interface

### `ConditionGroup` — interface

### `RuleConditions` — interface

### `RuleAction` — interface

### `Rule` — interface

### `RuleContext` — interface

## Callers

- `src/app/api/tickets/[id]/messages/route.ts`
- `src/app/api/tickets/[id]/route.ts`
- `src/app/api/webhooks/appstle/[workspaceId]/route.ts`
- `src/app/api/webhooks/email/route.ts`
- `src/app/api/webhooks/sms/route.ts`
- `src/lib/rules-actions.ts`
- `src/lib/shopify-webhooks.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
