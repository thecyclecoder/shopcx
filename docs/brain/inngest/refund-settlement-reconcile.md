# inngest/refund-settlement-reconcile

The **T+3d settlement backstop** for [[../tables/order_refunds]] — the Phase-3 closing bookend on the refund-integrity build. Fires the mirror row from `succeeded` to `settled` once the vendor confirms settlement, and surfaces DRIFT (vendor doesn't recognize the refund id, reports a different amount, or reports it failed/voided) to a human via `dashboard_notifications` + a system-authored ticket sysNote.

**File:** `src/lib/inngest/refund-settlement-reconcile.ts` · See [[../tables/order_refunds]], [[../libraries/refund]], [[../specs/refund-integrity-order-refunds-mirror-verify-by-id-settlement-reconcile]].

## Functions

### `refund-settlement-reconcile`
- **Trigger:** cron `15 6 * * *` — 1:15 AM Central, immediately after the daily-order-snapshot pass.
- **Retries:** 1 · **Concurrency:** `[{ limit: 1 }]`
- **Batch cap:** 200 rows per tick — a runaway backlog is visible on the heartbeat's `scanned` count.
- **What it reads:** every [[../tables/order_refunds]] row where `status='succeeded' AND requested_at < now() - interval '3 days' AND vendor_refund_id IS NOT NULL AND vendor IN ('braintree','shopify')`. The `vendor='internal'` bookkeeping-only refunds are excluded — they have no external settlement to poll.
- **What it does per row:**
  1. Poll the vendor: **Braintree** → `gateway.transaction.find(vendor_refund_id)`; **Shopify** → REST `GET /admin/api/{ver}/orders/{shopify_order_id}/refunds/{refund_id}.json`.
  2. Reduce to a `VendorVerdict = { settled | drift | non-terminal }`:
     - `settled` — Braintree `status='settled'` OR Shopify `refund.transactions[0].status='success'`, AND amount matches the mirror row.
     - `drift` — vendor doesn't recognize the refund id; vendor amount differs from `amount_cents`; vendor reports a terminal-failed state (voided / gateway_rejected / processor_declined / failure / error) while the mirror says succeeded.
     - `non-terminal` — still in-flight (Braintree `submitted_for_settlement`/`settling`, Shopify `pending`) OR a soft lookup failure. Leave the row alone; the next tick re-checks.
  3. On `settled`: compare-and-set flip — `UPDATE order_refunds SET status='settled', settled_at=now() WHERE id=? AND workspace_id=? AND status='succeeded'` + `.select('id')` to assert exactly one row transitioned. A row that raced into `reversed` (chargeback / manual reversal) is protected by the `status='succeeded'` predicate.
  4. On `drift`: two writes — (i) a deduped `dashboard_notifications` row of `type='refund_drift'` carrying `metadata.order_refund_id` + `amount_cents_mirror` + `amount_cents_vendor` + `reason`; (ii) best-effort sysNote on the ticket that fired the refund, resolved from the [[../tables/customer_events]] `order.refunded` row's `properties.ticket_id`.

## Monitoring

Registered in the [[../libraries/control-tower]] `MONITORED_LOOPS` cron registry with:
- **Owner:** [[../functions/platform]]
- **Expected cadence:** daily (15 6 * * *)
- **Liveness window:** 26 hours (one missed tick + 2-hour buffer)
- **Registered:** 2026-07-08 — automatically proposed by [[../libraries/coverage-register-agent]] via the [[../specs/control-tower-complete-coverage]] Phase 1 self-audit, owner-confirmed at build time. The window ensures a 6:15 AM UTC miss on any given day still keeps the tile green until the next day's run. See [[../specs/register-loop-refund-settlement-reconcile]].

## Gotchas

- **The dedupe guard is metadata-based.** A re-tick after the ops card was opened but before it was dismissed must not spam a second one — `openDriftNotification` short-circuits when a matching `dashboard_notifications` with `dismissed=false AND metadata @> {order_refund_id: X}` already exists.
- **`agent_todos` is NOT the drift surface here.** The spec's original wording said "insert an agent_todos row of `kind='refund_drift'`", but `agent_todos.action_type` was pruned to the four customer-facing values in `20260620160100_agent_todos_prune_action_types.sql` — the CHECK constraint refuses a `refund_drift` insert. The current pattern for manual-attention alerts is `dashboard_notifications` with a free-form `type` (matching `fleet-spend-governor`, `escalation`, `daily-order-snapshot`). The spec intent (row_id + both amounts, ticket sysNote) is preserved verbatim; only the target table changed.
- **Compare-and-set is the double-flip guard.** `settled` is a terminal state; without the `status='succeeded'` predicate a concurrent chargeback-reversal → `status='reversed'` could be silently overwritten back to `settled`. Same shape as the [[../libraries/approval-inbox]] `.eq('status','needs_attention')` guard.
- **Non-terminal is not drift.** A Braintree `settling` row or a Shopify HTTP error is neither settled nor drift — it stays `succeeded` and re-checks next tick. Only a decisive vendor state (settled, or a terminal disagreement) mutates the row.
- **Best-effort sysNote.** Not every refund has a linked ticket (playbook + cron-fired refunds carry none). Skip silently; the `dashboard_notifications` row is the always-on backstop.

---

[[../README]] · [[../tables/order_refunds]] · [[../libraries/refund]] · [[../specs/refund-integrity-order-refunds-mirror-verify-by-id-settlement-reconcile]] · [[../lifecycles/subscription-billing]] · [[../../CLAUDE]]
