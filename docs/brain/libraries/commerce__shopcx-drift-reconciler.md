# `src/lib/commerce/shopcx-drift-reconciler.ts`

Compares every ShopCX-billed subscription against its live Shopify contract and reports where they
disagree. Read-only by default.

## ⭐ Why

ShopCX bills `subscriptions`, but the thing holding the money is the **Shopify contract**. When the
two disagree the failure is silent in both directions — nothing on the charge path errors:

| Drift | What it costs |
|---|---|
| `status` — our row `active`, contract `CANCELLED`/`PAUSED` | the renewal cron selects it forever and every attempt no-ops; the customer believes they are subscribed and is not |
| **`stranded`** — our date lands in a cycle Shopify already marked `BILLED`/skipped | ⚠️ **the renewal worker skips that subscriber FOREVER.** The worker resolves the cycle by date and skips spent ones. Measured on the 2026-09-16 cohort: two of three subs that had just charged were already dead, one by eight minutes |
| `date` — Shopify's `nextBillingDate` differs from ours | display only (we bill by our own date), but it is what the customer and every Shopify surface see |
| `unreadable` | the contract is gone, or app ownership was lost |

At eight rows a person can eyeball this. At three hundred nobody can — which is exactly when a
migration wave makes it matter.

## `apply` fixes ONE thing on purpose

`reconcileShopcxDrift(ws, { apply: true })` repairs **only the `status` disagreement**, where the
contract is authoritative by definition, and applies cancel-truth in the same write (`cancelled` ⇒
`next_billing_date` null, first `cancelled_at` preserved).

**Dates are never auto-written.** A strand needs a re-pin decision (`shopifyRetimeContract` — see
[[commerce__shopify-subscription-client]] § "Keeping a customer's own dates"), not a blind
overwrite: overwriting our date to match Shopify's would silently reschedule a customer, and
overwriting Shopify's to match ours is what the pin already does properly.

## First live run (2026-09-18)

8 rows checked, **4 drifted, 0 false positives**:

- `35945087149` — `active` against a `CANCELLED` contract. Repaired.
- `36018618541` (28d), `36018585773` (21d) — date drift on subs charged 09-16, before the rolling
  pin shipped. Re-pinned with `shopifyRetimeContract`; both returned clean and the next run showed
  them matched.
- `36018651309` — 30d, and left alone: it is PAUSED, and [[../inngest/portal-auto-resume]]'s
  `retimeAfterResume` sets a billable date when it wakes.

Drift went 4 → 1 in one pass, and the remaining one is correct to leave.

## Gotchas

- **Keyset-paginated.** A bare select caps at the PostgREST 1000-row max and silently drops the
  overflow — which here would mean the newest migrated subs, the ones most likely to have drifted,
  are exactly the ones never checked.
- **`DATE_TOLERANCE_MS` is 36h**, because a date-only field's clock time varies and a few hours of
  difference is the same date, not drift.
- The strand check costs one `getBillingCycleForDate` per row — the expensive part, and the only
  one that finds a subscriber who will never be charged again.

## Related

[[../inngest/shopcx-drift-reconcile]] · [[commerce__shopify-subscription-client]] ·
[[commerce__shopcx-contract-ingest]] · [[../inngest/shopify-subscription-renewals]] ·
[[../lifecycles/shopcx-subscriptions]]
