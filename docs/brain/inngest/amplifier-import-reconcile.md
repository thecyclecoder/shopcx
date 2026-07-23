# inngest/amplifier-import-reconcile

The **reconcile sweep** for paid orders the 3PL never received — Phase 2 of the [[../specs/amplifier-import-reliability-rail]] reliability rail. Reads the durable failure state Phase 1 persists on `public.orders` (`amplifier_import_attempts` / `amplifier_last_error` / `amplifier_last_attempt_at`) and re-submits any paid, un-imported, un-fraud-held order past a short grace window, under the retry cap. Turns "a transient Amplifier failure permanently drops a paid order" into "a self-healing sweep the next 15-minute tick catches."

**File:** `src/lib/inngest/amplifier-import-reconcile.ts` · See [[../tables/orders]], [[../libraries/integrations__amplifier]], [[../specs/amplifier-import-reliability-rail]].

## Functions

### `amplifier-import-reconcile`
- **Trigger:** cron `*/15 * * * *` — every 15 minutes.
- **Retries:** 1 · **Concurrency:** `[{ limit: 1 }]`
- **Batch cap:** 200 rows per tick. A runaway backlog surfaces on the heartbeat `scanned` count; the batch is small enough that a single Amplifier outage never fans out to hundreds of retries in one tick.
- **Candidate set:** `orders` where `financial_status='paid' AND amplifier_order_id IS NULL AND created_at < now() - interval '10 minutes' AND COALESCE(amplifier_import_attempts,0) < 5`, ordered by `created_at ASC` (oldest failure first). The 10-minute grace lets a live checkout retry finish before this sweep steps on it; the retry cap of 5 bounds the tail of un-fixable orders (unknown SKU, un-fulfillable address) for the Phase 3 CEO escalation.
- **Fraud-held skip:** an order with a non-dismissed [[../tables/fraud_cases]] row that names it (`contains order_ids [order.id]`) is the checkout fraud-held state — the fraud-dismiss handler is the retry surface for that class, not this sweep. Releasing a fraud-held order past this cron would bypass the hold.
- **Per-row:** rebuilds the `createAmplifierOrder` input exactly as the fraud-dismiss retry path does (`src/app/api/workspaces/[id]/fraud-cases/[caseId]/route.ts` ~245-309): every SKU-carrying line (gifts included at `unit_price_cents=0`), address / packing-slip / totals rebuilt from the row. SKU-safe via #2246's `applyVariantSkus` — the per-line SKU is always resolved from `product_variants` at import time, never trusted from the baked value.
- **Success write:** compare-and-set on `amplifier_order_id IS NULL` — `.eq('workspace_id', row.workspace_id).is('amplifier_order_id', null).select('id')` — so a live checkout retry that landed first never gets clobbered. Clears `amplifier_last_error = null` alongside the `amplifier_order_id` / `amplifier_received_at` stamp.
- **Failure write:** `stampAmplifierImportFailure(admin, row.id, res.error, res.details)` (Phase 1). A row that reaches the retry cap of 5 falls out of the candidate set and becomes the Phase 3 CEO escalation's input.
- **Phase 3 — retry-cap escalation:** after the candidate loop, `escalateExhaustedOrders` selects `orders` where `amplifier_order_id IS NULL AND amplifier_import_attempts >= 5`, skips fraud-held, and idempotently inserts ONE [[../tables/dashboard_notifications]] row of `type='fulfillment_alert'` per order — title `${order_number} — Amplifier import failed after N retries`, body naming the last error, `link=/dashboard/orders/{id}`, `metadata={kind:'amplifier_import_exhausted', order_id, order_number, attempts, last_error}`. Dedupe guard: an un-dismissed `fulfillment_alert` with `metadata @> {order_id: X}` short-circuits the second insert (same shape as `refund-settlement-reconcile.openDriftNotification`). Runs in a separate `step.run("escalate-exhausted-orders", …)` so an escalation error can't fail the sweep and an Inngest retry re-runs escalation independently (the guard keeps it idempotent).
- **Heartbeat:** `emitCronHeartbeat('amplifier-import-reconcile', {ok, produced, detail, durationMs})` at end of run with a `{scanned, imported, failed, skipped_fraud, skipped_no_skus, skipped_non_storefront, grace_cutoff, escalation:{scanned, opened, already_open, skipped_fraud}}` payload. Non-fatal — a heartbeat write cannot fail the sweep.

## Node completeness (CLAUDE.md hard rule)

1. **Owner** — `logistics`, declared on the `MONITORED_LOOPS` row and picked up by the canonical [[../libraries/control-tower-node-registry]] via block 5 (`for (const loop of MONITORED_LOOPS) addNode(...)`).
2. **Kill switch** — covered by the ancestry chain up to `dept:logistics`. A `kill_switches` row keyed by `logistics` (or the canonical `dept:logistics`) cascades down to this cron; no per-cron switch row required.
3. **Heartbeat** — `emitCronHeartbeat('amplifier-import-reconcile', …)` at end of run.
4. **MONITORED_LOOPS row** — `src/lib/control-tower/registry.ts`, `{ id:'amplifier-import-reconcile', kind:'cron', owner:'logistics', expectedCadence:'every 15 min (*/15 * * * *)', livenessWindowMs: 30 * MIN }`. 30-min window satisfies `assertRegistryInvariants` (`cadenceMs * 1.2 = 18 min ≤ 30 min`). `registeredAt` claims the new-cron grace.

## Monitoring

Registered in the [[../libraries/control-tower]] `MONITORED_LOOPS` cron registry with:
- **Owner:** [[../functions/logistics]]
- **Expected cadence:** every 15 min (`*/15 * * * *`)
- **Liveness window:** 30 minutes (one missed tick + jitter grace)
- **Registered:** 2026-07-23 — [[../specs/amplifier-import-reliability-rail]] Phase 2 launch.

## Gotchas

- **Compare-and-set on `amplifier_order_id IS NULL` is the double-import guard.** Without the `.is('amplifier_order_id', null)` predicate on the success write, a live checkout retry that landed first could be clobbered by this sweep — the 3PL side gets a duplicate order (or the second submission gets a different Amplifier id, which then races the first one's webhook). The predicate is the invariant from [[../../CLAUDE]] operational-rules: "any Supabase mutation after an async read re-asserts the read-time preconditions in the write itself."
- **10-minute grace, not zero grace.** A failed checkout call in-flight (Amplifier is slow, our function has retries) can look identical to a permanent drop for the first minute or two. The grace lets the primary path finish; if it does, the retry cap column stays at 0 and this sweep skips the row entirely.
- **Fraud-hold is a peer, not a parent.** A fraud_cases row that names the order is the checkout post-payment hold; the fraud-dismiss route is the release path. This sweep only reconciles the swallow-no-retry-drop class — it never releases a held order.
- **Owner is `logistics`, not `platform` or `retention`.** The 3PL rail is Marco's charge (fulfillment ops); the kill-switch cascade and the org-chart rollup both key off that.
- **`fulfillment_alert` had to be added to the `dashboard_notifications` type CHECK.** The CHECK is enforced (23514) and fire-and-forget inserts of an unlisted type silently drop — the exact class the 2026-07-09 hotfix (`20260709120000_dashboard_notifications_types_and_fraud_history_fk.sql`) fixed for `refund_drift` / `mario_accuracy_alarm` / `return_request`. Migration `20261206120000_dashboard_notifications_fulfillment_alert_type.sql` adds it (additive; the new list is a superset of the prior one).

---

[[../README]] · [[../tables/orders]] · [[../libraries/integrations__amplifier]] · [[../specs/amplifier-import-reliability-rail]] · [[../../CLAUDE]]
