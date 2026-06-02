# libraries/replacement-order

`createReplacementOrder()` — builds + completes a Shopify draft order at no charge to the customer. Stamps with `replacement: true` so downstream events skip marketing attribution + LTV bump. Tracks against `workspaces.replacement_threshold_cents`.

**File:** `src/lib/replacement-order.ts`

## File header

```
Canonical helper for creating a Shopify replacement order AND persisting
it to the `replacements` table.
Use this EVERYWHERE we create a replacement — direct actions, playbook
steps, ad-hoc agent scripts, the agent-facing dashboard. The contract:
1. Insert a `replacements` row FIRST (status='pending') — guarantees
a DB record exists even if the Shopify call fails or the process
dies mid-flight.
2. Create + complete the Shopify draft order.
3. Update the row with the Shopify order name (status='created') OR
mark it 'failed' with the error.
4. Optionally write a [Manual action] system note on the ticket.
This is the single source of truth: if a Shopify replacement order
exists, a `replacements` row exists for it. No silent gaps where the
order shipped but our system doesn't know.
Why a record-first approach: previously the direct action inserted
AFTER the Shopify call inside a try/catch labeled "non-fatal". On any
insert failure (RLS, schema drift, network), the order shipped but
the row was lost. Record-first means the row exists for sure and the
Shopify call updates it with the outcome.
```

## Exports

### `createReplacementOrder` — function

```ts
async function createReplacementOrder(input: CreateReplacementInput) : Promise<CreateReplacementResult>
```

### `CreateReplacementInput` — interface

### `CreateReplacementResult` — interface

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
