# Reset subscriptions.last_payment_status on internal-sub recovery so portal change-date/frequency unlock

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `efe0d2ad-3752-495a-9b18-75ba13056678`

Annmarie Maruca (ticket efe0d2ad) tried to move her Amazing Coffee renewal date in the portal and was blocked by payment_failed_update_blocked, even though her dunning cycle had been marked `recovered` and two paid renewal orders had landed on the sub the day before. The portal guard is correct in principle — we don't want customers shuffling dates on a sub with a genuine failed payment (see the 52a0a618 comment in change-date.ts) — but internal subs never clear the flag, so the guard becomes a permanent lockout. Close the loop so the next Annmarie can self-serve.

## Problem (from escalated ticket `efe0d2ad-3752-495a-9b18-75ba13056678`)
subscriptions.last_payment_status is only flipped to 'succeeded' by the Appstle billing-success webhook (src/app/api/webhooks/appstle/[workspaceId]/route.ts:551). Internal subs do not fire that webhook. The internal renewal success path (src/lib/inngest/internal-subscription-renewals.ts, the `advance-next-billing-date` step around L694–L722) updates next_billing_date / applied_discounts / items but leaves last_payment_status untouched. closeInternalDunningOnSuccess (src/lib/inngest/internal-dunning.ts:197–215) only updates dunning_cycles. Consequence: any internal-sub customer who experiences a payment failure and then recovers is permanently blocked from change-date (src/lib/portal/handlers/change-date.ts:50), change-frequency (src/lib/portal/handlers/frequency.ts:39), and is permanently flagged as `needsAttention` in subscription-detail (src/lib/portal/handlers/subscription-detail.ts:55,354) and subscriptions list (src/lib/portal/handlers/subscriptions.ts:12,161). Annmarie's `496e3f53` row is the live example (last_payment_status='failed', dunning_cycle.status='recovered', sub.status='active', most recent two orders paid).

**Likely target:** `src/lib/inngest/internal-subscription-renewals.ts (add last_payment_status: 'succeeded' to the advance-next-billing-date update at ~L706); src/lib/inngest/internal-dunning.ts (extend closeInternalDunningOnSuccess at ~L197–L215 to also update the subscription row's last_payment_status to 'succeeded' alongside the dunning_cycle update); add scripts/backfill-internal-sub-last-payment-status.ts following the backfill skill conventions (chunked, --apply gated) to clear last_payment_status='failed' on rows where is_internal=true AND status='active' AND the most-recent dunning_cycles row for that subscription_id is status='recovered' AND there is at least one paid order on that subscription_id after dunning_cycles.recovered_at; cross-check that no other writer (re-import paths in src/lib/inngest/import-subscriptions.ts:299) is going to re-set 'failed' on the same rows.`

## Phases
- **P1 — implement the fix** — scope from the problem above; land code + a brain page; gate on `npx tsc --noEmit`.

## Verification
- Reproduce the escalation scenario → confirm the corrected behavior, and that the ticket that surfaced it would now be handled (or not mis-escalated).

> Authored by the box escalation-triage routine (solver+skeptic quorum) from escalated ticket `efe0d2ad-3752-495a-9b18-75ba13056678`. Commission the build from the Roadmap board (owner = cs).
