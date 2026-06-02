# libraries/shipping-address-journey-builder

Builds the address-change journey: select target (sub / order / default) → enter → validate via EasyPost.

**File:** `src/lib/shipping-address-journey-builder.ts`

## File header

```
Shipping Address Journey Builder
Builds steps for confirming/updating a customer's shipping address.
Used during replacement order flow to validate address via EasyPost.
Steps:
1. confirm_address — show current address, ask if correct
2. update_address — address form (if customer says no)
3. address_confirmed — terminal confirmation
```

## Exports

### `buildShippingAddressSteps` — function

```ts
async function buildShippingAddressSteps(admin: Admin, workspaceId: string, customerId: string, ticketId: string,) : Promise<BuiltJourneyConfig>
```

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
