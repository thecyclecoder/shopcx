# libraries/remedy-actions

The single executor for cancel-flow save offers ([[../tables/remedies]]). Used by BOTH the portal
cancel flow and the journey / mini-site cancel flow, so an accepted save behaves identically on
either surface. See [[../journeys/cancel]] § Remedy execution for why it exists (the two surfaces
had drifted and the journey copy silently dropped free-product and change-items saves).

**File:** `src/lib/remedy-actions.ts`

## Exports

### `executeRemedyAction(workspaceId, contractId, remedyType, config)`

```ts
async function executeRemedyAction(workspaceId: string, contractId: string, remedyType: string, config: RemedyConfig): Promise<{ success: boolean; error?: string; patch?: Record<string, unknown>; savedAction?: string }>
```

Applies one remedy type (`coupon` · `pause` · `skip` · `frequency_change` · `free_product` ·
`line_item_modifier`) through the engine-aware commerce SDK (`@/lib/commerce/subscription`).
`savedAction` is the customer-facing past-tense phrase ("changed your delivery to monthly").
`line_item_modifier` is a no-op here; the item edit itself goes through `executeLineItemAction`.

### `executeLineItemAction(workspaceId, contractId, input)`

```ts
async function executeLineItemAction(workspaceId: string, contractId: string, input: LineItemActionInput): Promise<{ success: boolean; error?: string; validationError?: string; savedAction: string }>
```

One "change items" edit: `swap_variant` · `change_quantity` · `remove` · `swap_product`, via
[[subscription-items]]. `validationError` is set (nothing written) on bad input.

### `RemedyConfig`, `LineItemActionInput` — types

## Callers

- `src/lib/portal/handlers/cancel-journey.ts` — portal `remedy` + `line_item_action` steps
- `src/app/api/journey/[token]/complete/route.ts` — journey `saved_*` outcomes

## Gotchas

- Add a new remedy type HERE only. A surface-specific copy is how the 2026-11 drift happened.
- `pause` writes `subscriptions.pause_resume_at` directly (pre-existing portal behaviour, moved verbatim).
