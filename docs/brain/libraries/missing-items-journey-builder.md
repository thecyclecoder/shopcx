# libraries/missing-items-journey-builder

Builds the missing-items checklist step from an order's line items.

**File:** `src/lib/missing-items-journey-builder.ts`

## File header

```
Missing Items Journey Builder
Two-step flow:
Step 1 (item_accounting): For EACH item, what happened? Per-item radio
- Received and OK (default — no action)
- Item is missing
- Damaged or unusable (melted, discolored, broken seal, stuck together)
- Wrong item — got something different than ordered
Step 2 (item_accounting): For items marked missing/damaged/wrong, how many?
If every item is "received and OK", we close out as no replacement needed.
Otherwise we produce a replacement plan keyed by reason — the orchestrator's
reply can mention common causes (heat for "damaged", carrier for "missing",
etc.) based on which reasons appear in the result.
Old shape was a single "select all that had issues" checkbox — Angelyna
Reggiani (ticket 0428c8a9) revealed the gap: she received the box but
the tablets were unusable, so she correctly didn't tick "missing"
boxes, and the journey concluded "all items received OK". The per-item
radio with explicit reason eliminates that mismatch.
```

## Exports

### `buildMissingItemsSteps` — function

```ts
async function buildMissingItemsSteps(admin: Admin, workspaceId: string, customerId: string, ticketId: string,) : Promise<BuiltJourneyConfig>
```

### `parseItemAccounting` — function

```ts
function parseItemAccounting(selectResponse: string, accountingResponse: string, lineItems: OrderLineItem[],) :
```

### `OrderLineItem` — interface

### `ParsedReplacementItem` — interface

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
