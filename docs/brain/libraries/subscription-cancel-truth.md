# libraries/subscription-cancel-truth

The invariant enforcer for the two cancel writers: a subscription row with `status='cancelled'` must have `next_billing_date IS NULL` AND a non-null `cancelled_at`. A cancelled row cannot advertise a future charge date.

**File:** `src/lib/subscription-cancel-truth.ts` · **Test:** `src/lib/subscription-cancel-truth.test.ts` (npm script `test:subscription-cancel-truth`)

## Why

Ticket f773b8ec (bonnie marlette, 2026-08-21) — the CS Director read a cancelled subscription whose `next_billing_date` still pointed at 2026-09-11, concluded the contract was still live in Appstle, and escalated a $209.13 "post-cancellation renewals" refund to the founder. The billing_forecast_events ledger showed the opposite: the cancel landed at 2026-07-17T08:39:51, 36 minutes AFTER the last renewal billed at 08:03:45. Every one of the three "post-cancellation" charges was an ordinary pre-cancel renewal. The founder ruled no refund. The field lied and an agent believed it.

Two write paths were leaving the contradiction behind:
1. `src/app/api/webhooks/appstle/[workspaceId]/route.ts` `handleSubscriptionEvent` — the upsert set `next_billing_date` from `data.nextBillingDate` on **every** subscription event including `subscription.cancelled`, so Appstle's last-known date survived the cancel.
2. `src/lib/appstle.ts` `appstleSubscriptionAction` — the update on cancel wrote only `{ status: 'cancelled', updated_at }`, leaving `next_billing_date` untouched.

Both writers now call `applyCancelTruth` — one helper, one invariant.

## Exports

### `applyCancelTruth<T>(update: T, action, opts?): T` — function

Merges the cancel-truth patch into an in-flight update blob and returns it. On a cancel action: sets `next_billing_date = null` and `cancelled_at = existingCancelledAt ?? nowIso ?? new Date().toISOString()`. On pause/resume/active/paused: no-op (leaves the update alone).

`existingCancelledAt` is how the webhook path preserves the historical cancel moment across Appstle re-sends — pass the row's current `cancelled_at` (via a targeted `.select('cancelled_at')` before the upsert) and the helper keeps it rather than overwriting.

### `buildCancelTruthPatch(action, opts?): CancelTruthPatch` — function

Pure builder returning `{ next_billing_date: null, cancelled_at }` on cancel, `{}` otherwise. Used by the test pins; production callers reach for `applyCancelTruth` because it mutates the caller's blob in place.

### `isCancelAction(action): boolean` — function

Truth for both the SDK verb (`'cancel'`) and the row-status noun (`'cancelled'`) — the webhook hands us `mapStatus(status)` (a status noun), the SDK hands us the action verb; one predicate covers both.

### `CancelTruthAction` — type

`"active" | "paused" | "cancelled" | "expired" | "failed" | "cancel" | "pause" | "resume"` — the union both the webhook `mapStatus` output and the SDK action verb belong to.

## Callers

- [[appstle]] `appstleSubscriptionAction` — direct SDK cancel path (portal / agent / playbook)
- `src/app/api/webhooks/appstle/[workspaceId]/route.ts` — Appstle-originated cancel via webhook upsert
- Phase 2 backfill `scripts/_backfill-cancelled-sub-truth.ts` (upcoming) will apply the same patch to historically-cancelled rows

## Gotchas

- **Never clear `cancelled_at` on resume.** The helper only writes on cancel; a reactivate path must not null the historical record. See [[../integrations/appstle]] § Cancel is reversible — the row transitioning back to `active` naturally satisfies the "cancelled ⇒ next_billing_date IS NULL" invariant because the reactivate path re-reads Appstle's `nextBillingDate`.
- **Webhook path preserves existing `cancelled_at`.** Appstle re-sends the same `subscription.cancelled` event; without the pre-read + `existingCancelledAt` guard the timestamp would drift forward on each re-send.
- **Cancel must win over the active-dunning guard.** The webhook's dunning guard skips `next_billing_date` writes while a `dunning_cycles` row is `active`/`skipped`. `applyCancelTruth` runs *after* that branch so the null wins — a cancelled contract is never in dunning.

## Related

[[../tables/subscriptions]] · [[../integrations/appstle]] · [[appstle]] · [[../specs/cancelled-subs-stop-reporting-a-future-billing-date]]
