# libraries/portal/failed-payment-guard

Portal guard that blocks subscription mutations on failed-payment Appstle contracts.

**File:** `src/lib/portal/failed-payment-guard.ts`

## Context

A customer on a dormant failed-payment Appstle contract can no longer silently push the next billing date around without fixing the payment method first (ticket 52a0a618). However, the block is **Appstle-only** and does NOT apply to internal subs — `last_payment_status='failed'` on an `is_internal=true` sub is often stale (a prior Appstle-era decline that never cleared, or a transient failure whose next renewal already paid). Internal subs route through the internal-aware mutation wrapper, which handles dunning correctly and succeeds regardless of the flag.

Verified live (ticket 115350d5, sub `e1d4f32b`): `is_internal=true`, `last_payment_status='failed'`, portal date change Oct 1 → Oct 6 → `{success:true}`, flag untouched.

## Exports

### `shouldBlockForFailedPayment(sub): boolean` — function

```ts
export function shouldBlockForFailedPayment(sub: {
  is_internal: boolean | null;
  last_payment_status: string | null;
}): boolean
```

**Returns** `true` only when `is_internal=false` AND `last_payment_status='failed'`. Internal subs always pass through (returns `false`); Appstle subs with a healthy last payment also pass through.

**Unit test:** `src/lib/portal/failed-payment-guard.test.ts`.

## Callers

- `src/lib/portal/handlers/change-date.ts` — blocks on failed payment.
- `src/lib/portal/handlers/frequency.ts` — blocks on failed payment.

## Recovery path

When the block fires, the real-portal subscription-detail screen renders an inline **"Update payment method"** CTA on the error overlay (no dead-end text). Vaulting the card triggers `migrateCustomerAppstleSubsToInternal`, converting the blocked Appstle sub to internal billing — mutations become available immediately (no Appstle block, and no portal guard fires). See [[subscription-billing]] § Failed-payment mutation block is Appstle-only and [[customer-portal]] § Payment methods · Failed-payment block → inline card-update recovery.

---

[[../README]] · [[../../CLAUDE]]
