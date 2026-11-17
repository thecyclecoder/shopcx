# libraries/payment-recovery

Failed-payment recovery after a customer saves a new card. The ONE implementation for every
surface where a card can be fixed: the portal `recover=1` flow and the add_payment_method
journey.

**File:** `src/lib/payment-recovery.ts`

## Exports

### `runPaymentRecovery(input)` → `{ pinnedCount, reactivatedCount, chargedCount }`

```ts
async function runPaymentRecovery(input: PaymentRecoveryInput): Promise<PaymentRecoveryResult>
```

1. Reactivates subs DUNNING cancelled across the link group (`reactivateDunningCancelledSubs`,
   [[../inngest/internal-dunning]]; keyed on an exhausted cycle, never voluntary cancels).
2. Pins the new card to every active/paused internal sub in the group.
3. Fires `internal-subscription/renewal-attempt` with `recovery: true` for subs that were failing
   (open cycle) or just reactivated. Healthy subs are not charged.
4. Slacks the team (`notify: "always"` on the portal; `"if_recovered"` on the journey).

Every step is non-fatal; the card is already saved.

### `recovery: true` on the renewal attempt

[[../inngest/internal-subscription-renewals]] then (a) re-anchors `next_billing_date` to the
charge + one interval instead of advancing from the stored date (which had already been moved
forward by exhaustion / reactivation, so recovered customers skipped a cycle), and (b) closes the
newest dunning cycle as `recovered` even if it had already closed `exhausted`
(`closeInternalDunningOnSuccess(..., { includeExhausted: true })`, 120-day window,
`closed_reason IS NULL` only).

## Callers

- `src/lib/portal/handlers/payment-method-update.ts` (portal `recover=1`)
- `src/app/api/journey/[token]/submit-payment/route.ts` (add_payment_method journey, after the
  session compare-and-set so a second tab can't dispatch the charge twice)

## Gotchas

- 2026-11-17 ground truth: a dunning-cancelled customer fixed their card via the journey after
  the AI promised to restart them; the journey only vaulted + migrated, so nothing restarted and
  nothing was charged. Don't re-inline recovery in one surface.
