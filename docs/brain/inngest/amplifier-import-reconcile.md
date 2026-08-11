# inngest/amplifier-import-reconcile

The **reconcile sweep** for paid orders the 3PL never received — Phase 2 of the amplifier-import-reliability-rail reliability rail. Reads the durable failure state Phase 1 persists on `public.orders` (`amplifier_import_attempts` / `amplifier_last_error` / `amplifier_last_attempt_at`) and re-submits any paid, un-imported, un-fraud-held order past a short grace window, under the retry cap. Turns "a transient Amplifier failure permanently drops a paid order" into "a self-healing sweep the next 15-minute tick catches."

**File:** `src/lib/inngest/amplifier-import-reconcile.ts` · See [[../tables/orders]], [[../libraries/integrations__amplifier]].

## Functions

### `amplifier-import-reconcile`
- **Trigger:** cron `*/15 * * * *` — every 15 minutes.
- **Retries:** 1 · **Concurrency:** `[{ limit: 1 }]`
- **Batch cap:** 200 rows per tick. A runaway backlog surfaces on the heartbeat `scanned` count; the batch is small enough that a single Amplifier outage never fans out to hundreds of retries in one tick.
- **Candidate set:** `orders` where `financial_status='paid' AND amplifier_order_id IS NULL AND shopify_order_id IS NULL AND created_at < now() - interval '10 minutes' AND COALESCE(amplifier_import_attempts,0) < 5`, ordered by `created_at ASC` (oldest failure first). The `shopify_order_id IS NULL` predicate scopes the rail to internal `SHOPCX*` orders — see § Internal orders only below; it is applied at ALL THREE selection sites (sweep, exhaustion escalation, stale escalation). The 10-minute grace lets a live checkout retry finish before this sweep steps on it; the retry cap of 5 bounds the tail of un-fixable orders (unknown SKU, un-fulfillable address) for the Phase 3 CEO escalation.
- **Eligible source_name (widened 2026-08-10):** `reconcileOne` delegates to the pure `isReconcileEligibleSourceName` helper, which allows `storefront` (the original scope) AND `internal_subscription_renewal`. Historically the gate was `source_name !== 'storefront' → skipped-non-storefront`, which meant an internal renewal that Amplifier 400d for a nameless address was skipped every single tick — SHOPCX170 (Shannon Russell) + SHOPCX181 sat paid + unshipped for four days at `amplifier_import_attempts=1` before hand-repair on 2026-08-10. Comp $0 marker orders (`internal_subscription_comp_renewal`) stay out — they do not represent a warehouse-bound hand-off; any other source (Shopify backfill imports, external CSV loads) also stays out (safety default). Pinned by `amplifier-import-reconcile.eligibility.test.ts`.
- **Fraud-held skip:** an order with a non-dismissed [[../tables/fraud_cases]] row that names it (`contains order_ids [order.id]`) is the checkout fraud-held state — the fraud-dismiss handler is the retry surface for that class, not this sweep. Releasing a fraud-held order past this cron would bypass the hold.
- **Per-row:** rebuilds the `createAmplifierOrder` input exactly as the fraud-dismiss retry path does (`src/app/api/workspaces/[id]/fraud-cases/[caseId]/route.ts` ~245-309): every SKU-carrying line (gifts included at `unit_price_cents=0`), address / packing-slip / totals rebuilt from the row. SKU-safe via #2246's `applyVariantSkus` — the per-line SKU is always resolved from `product_variants` at import time, never trusted from the baked value.
- **Packing-slip greeting reads both casings:** the packing-slip note builder is fed via the pure `packingSlipFirstName(ship)` helper, which returns `ship.first_name` (snake — the storefront legacy shape) OR `ship.firstName` (camel — the internal renewal shape written by the portal + checkout). Historically only `ship?.first_name` was read, so a widened-eligibility internal renewal would silently lose its first name on the printed slip. Snake wins on tie for compatibility with storefront rows.
- **Success write:** compare-and-set on `amplifier_order_id IS NULL` — `.eq('workspace_id', row.workspace_id).is('amplifier_order_id', null).select('id')` — so a live checkout retry that landed first never gets clobbered. Clears `amplifier_last_error = null` alongside the `amplifier_order_id` / `amplifier_received_at` stamp.
- **Failure write:** `stampAmplifierImportFailure(admin, row.id, res.error, res.details)` (Phase 1). A row that reaches the retry cap of 5 falls out of the candidate set and becomes the Phase 3 CEO escalation's input.
- **Phase 3 — retry-cap escalation:** after the candidate loop, `escalateExhaustedOrders` selects `orders` where `amplifier_order_id IS NULL AND amplifier_import_attempts >= 5`, skips fraud-held, and idempotently inserts ONE [[../tables/dashboard_notifications]] row of `type='fulfillment_alert'` per order — title `${order_number} — Amplifier import failed after N retries`, body naming the last error, `link=/dashboard/orders/{id}`, `metadata={kind:'amplifier_import_exhausted', order_id, order_number, attempts, last_error}`. Dedupe guard: an un-dismissed `fulfillment_alert` with `metadata @> {order_id: X}` short-circuits the second insert (same shape as `refund-settlement-reconcile.openDriftNotification`). Runs in a separate `step.run("escalate-exhausted-orders", …)` so an escalation error can't fail the sweep and an Inngest retry re-runs escalation independently (the guard keeps it idempotent).
- **Residue escalation (2026-08-10):** `escalateStaleErroredOrders` runs after the retry-cap escalation and selects the safety-net superset — `orders` where `financial_status='paid' AND amplifier_order_id IS NULL AND amplifier_last_error IS NOT NULL AND created_at < now() - interval '24 hours'` — catching any paid + errored order that never reached the 5-attempt exhaustion threshold. The retry-cap path takes ~75 min to trip (5 × 15 min); an order whose attempts stalled below the cap (the pre-widen source_name gate did exactly this — SHOPCX170/SHOPCX181 sat at `amplifier_import_attempts=1` for four days) would otherwise never fire an alert. Same `metadata @> {order_id: X}` un-dismissed dedupe guard, so an order the exhaustion path already escalated gets no second card. Inserts `type='fulfillment_alert'`, `metadata={kind:'amplifier_import_stale_errored', order_id, order_number, source_name, attempts, age_hours, last_error}`. On 2026-08-10 the two stuck renewals were only discovered because one customer wrote in — this closes that observability gap.
- **Heartbeat:** `emitCronHeartbeat('amplifier-import-reconcile', {ok, produced, detail, durationMs})` at end of run with a `{scanned, imported, failed, skipped_fraud, skipped_no_skus, skipped_non_storefront, skipped_shopify_origin, grace_cutoff, escalation:{scanned, opened, already_open, skipped_fraud}, stale_escalation:{scanned, opened, already_open, skipped_fraud}}` payload. Non-fatal — a heartbeat write cannot fail the sweep.

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
- **Registered:** 2026-07-23 — amplifier-import-reliability-rail Phase 2 launch.

## Internal orders only — the head-of-line guard

The rail's candidate shape is "paid but `amplifier_order_id IS NULL`." Every one of the ~125k legacy Shopify `SC*` orders matches that shape permanently — they were fulfilled through Shopify's own pipeline and will never carry an Amplifier id. They are not un-imported; they were never meant to be imported.

Before 2026-08-11 the exclusion was a post-fetch skip (`source_name` check inside `reconcileOne`). That skip returns **without stamping an attempt**, so those rows never drain out of the candidate set. With `ORDER BY created_at ASC` and `BATCH_LIMIT=200`, the sweep re-fetched the same oldest 200 rows from 2024 every 15 minutes, skipped all 200, and emitted a green heartbeat — `200 scanned · 0 imported · 200 skipped`, every tick, indefinitely.

**Nothing downstream of the batch window was reachable.** SHOPCX171 (2026-08-07, an empty-cart renewal that failed import) sat at queue position **3,084** of 3,093 candidates. It was never retried, so `amplifier_import_attempts` stayed at 1, so the `>= RETRY_CAP` exhaustion escalation never fired either. Both the automatic fix and the human alarm were silent while the cron reported healthy.

The fix is `isShopifyOriginOrder` applied as a **query predicate** (`.is("shopify_order_id", null)`) at every selection site, not as a post-fetch filter. That collapses the candidate set from 3,093 rows to the handful of genuinely stuck internal orders. `shopify_order_id IS NULL` splits the table exactly — every `SHOPCX*` row has it null, every `SC*` row has it set — and is the same discriminator [[../libraries/refund]] uses to route internal orders to Braintree.

`reconcileOne` keeps a defensive `isShopifyOriginOrder` check that reports as `skipped_shopify_origin` on the beat. **That counter must stay 0**; a non-zero value means a selection site lost its predicate and the rail is re-stalling.

## Gotchas

- **Compare-and-set on `amplifier_order_id IS NULL` is the double-import guard.** Without the `.is('amplifier_order_id', null)` predicate on the success write, a live checkout retry that landed first could be clobbered by this sweep — the 3PL side gets a duplicate order (or the second submission gets a different Amplifier id, which then races the first one's webhook). The predicate is the invariant from [[../../CLAUDE]] operational-rules: "any Supabase mutation after an async read re-asserts the read-time preconditions in the write itself."
- **10-minute grace, not zero grace.** A failed checkout call in-flight (Amplifier is slow, our function has retries) can look identical to a permanent drop for the first minute or two. The grace lets the primary path finish; if it does, the retry cap column stays at 0 and this sweep skips the row entirely.
- **Fraud-hold is a peer, not a parent.** A fraud_cases row that names the order is the checkout post-payment hold; the fraud-dismiss route is the release path. This sweep only reconciles the swallow-no-retry-drop class — it never releases a held order.
- **Owner is `logistics`, not `platform` or `retention`.** The 3PL rail is Marco's charge (fulfillment ops); the kill-switch cascade and the org-chart rollup both key off that.
- **`fulfillment_alert` had to be added to the `dashboard_notifications` type CHECK.** The CHECK is enforced (23514) and fire-and-forget inserts of an unlisted type silently drop — the exact class the 2026-07-09 hotfix (`20260709120000_dashboard_notifications_types_and_fraud_history_fk.sql`) fixed for `refund_drift` / `mario_accuracy_alarm` / `return_request`. Migration `20261206120000_dashboard_notifications_fulfillment_alert_type.sql` adds it (additive; the new list is a superset of the prior one).

---

[[../README]] · [[../tables/orders]] · [[../libraries/integrations__amplifier]] · [[../../CLAUDE]]
