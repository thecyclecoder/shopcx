# libraries/research/probes/subscription

Subscription state probe.

**File:** `src/lib/research/probes/subscription.ts`

## File header

```
Subscription state probe — used by verify_subscription_changes and
any future recipe that needs the live, OG-source-of-truth view of a
customer's subscriptions.
Returns our DB shape (kept fresh by Appstle webhooks) PLUS, for any
contract_id explicitly requested, a forced refresh from Appstle to
catch webhook lag.
```

## Exports

### `getSubsForCustomer` — function

```ts
async function getSubsForCustomer(workspaceId: string, customerId: string) : Promise<SubState[]>
```

### `getLiveSubFromAppstle` — function

```ts
async function getLiveSubFromAppstle(workspaceId: string, contractId: string) : Promise<SubState | null>
```

### `SubState` — interface

## Callers

- `src/lib/research/recipes/verify-grandfathered-pricing.ts`
- `src/lib/research/recipes/verify-subscription-changes.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
