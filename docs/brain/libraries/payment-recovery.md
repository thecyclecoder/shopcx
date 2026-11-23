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
- 2026-11-23 ground truth: when the card save also MIGRATES the sub, `vaultAndMigratePaymentMethod`
  fires its own order-now retry ([[order-now-verify]] `dispatchOrderNowRetryOnMigrate`) ~200ms before
  this file's recovery event. Both target the same cycle, the per-cycle claim lets one through, and
  the order-now retry always won — without `recovery: true` it advanced from the already-pushed
  stored date, so 5 recovered customers each skipped a shipment (one charge each, no double-charge).
  The migrate retry now forwards `recovery: !!isRecovery` through `subscriptionOrderNowVerified` →
  `subscriptionOrderNow(…, { recovery })` → the internal renewal-attempt, so whichever event wins,
  the date re-anchors and the exhausted cycle closes.
- 2026-11-23 (second round), three more recovery/migration bugs found on one win-back customer:
  1. **Double Subscribe & Save.** A contract's structural "Subscribe & Save" discount was mirrored
     into `applied_discounts` and survived migration; [[coupons]] `resolveRenewalDiscount` resolved
     it via a live Shopify lookup as a 25% coupon ON TOP of the engine's own S&S (15 renewals
     undercharged $382 since 10/29). `isStructuralSubscribeAndSave` now skips + drops it at renewal;
     the 26 subs carrying it were cleaned on Dylan's OK.
  2. **Stale-cycle revival.** `reactivateDunningCancelledSubs` revived any cancelled internal sub
     with ANY exhausted/cancelled cycle — a sub voluntarily cancelled 8/11 came back (and was
     charged) off an unclosed April cycle. Now gated by `isRecentDunningCancel` (cycle opened ≤ 90d
     ago; `cancelled_at` ≤ 60d after the cycle opened, an earlier historical stamp ignored).
  3. **Lost one-time gifts.** ShopCX one-time lines (win-back gifts) live in billing-cycle edits,
     not the base contract, so migration never saw them. [[migrate-to-internal]]
     `carryPendingShopcxOneTimeLines` reads unbilled cycle edits before the old contract is
     cancelled and carries them as `one_time_next_renewal` items ($0 → `is_gift`).
