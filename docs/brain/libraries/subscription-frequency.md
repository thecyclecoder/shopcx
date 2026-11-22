# libraries/subscription-frequency

The ONE sequence both the Portal and the next-order journey run when a customer changes
delivery cadence. Extracted so the two surfaces stay in sync (CEO parity rule, 2026-11-22).

**File:** `src/lib/subscription-frequency.ts`

## Why it exists

The journey edit route used to call `subscriptionUpdateBillingInterval` alone and skip the
next-bill-date roll-forward that fixed the stranded-sub bug (Ashley Denson, 2026-10-08).
A journey frequency change therefore let Shopify re-shape the cycle window and strand the
sub. This helper is the Portal's full sequence, called by BOTH surfaces.

## Exports

### `changeSubscriptionFrequency(workspaceId, contractId, interval, intervalCount, admin?)`

Returns `ChangeFrequencyResult` `{ success, error?, interval, intervalCount, nextBillingDate? }`.
The shared mutation sequence:

1. **Engine write** through the commerce SDK `subscriptionUpdateBillingInterval`
   (resolves `billing_source` across internal / shopcx / appstle).
2. **Roll `next_billing_date` forward** by the NEW cadence on our planner row
   (`rollForwardToFutureBillingDate` from [[dunning]]) — our DB row is the PLANNER; the
   charge resolves the first unbilled cycle by index at charge time, so this never
   re-pins the cycle calendar.
3. **Display-only Shopify sync** via `subscriptionUpdateNextBillingDate` (non-fatal;
   cosmetic drift the daily reconciler catches).

Normalizes interval casing (UPPER for the vendor, lower on our row) the way the Portal
does. Returns `{ success: false, error }` on bad input (`missing_contractId` /
`missing_intervalCount` / `invalid_interval`) or an engine-write failure.

### `isValidBillingInterval(v)` — type guard for `"DAY" | "WEEK" | "MONTH" | "YEAR"`

### `BillingInterval` — the interval union type

## Callers own their surface gates

The helper is just the shared mutation. Each caller keeps its own gates:

- [[portal__handlers__frequency]] — ban check, failed-payment guard, `resolveSub`, portal action log.
- `src/app/api/journey/[token]/edit/route.ts` (`change_frequency` case) — `runPortalParityGuards`
  (first-delivery lock + failed-payment block) before dispatch.

## See also

- [[../journeys/next-order]] · [[portal__handlers__frequency]] · [[portal__editable-catalog]] · [[dunning]]
