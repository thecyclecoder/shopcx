# inngest/returns-reconcile-sweep

Daily reconcile sweep that makes the return-refund rail self-healing — rescues returns Phases 1+2 wouldn't catch (webhook that never arrived, gateway blip, a human that flipped a delivery through a path that fires no event).

**File:** `src/lib/inngest/returns-reconcile-sweep.ts`

## Functions

### `returns-reconcile-sweep`
- **Trigger:** cron `0 6 * * *` (daily at 06:00 UTC ≈ 11pm PT / 2am ET)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`
- **Heartbeat:** end-of-run `emitCronHeartbeat("returns-reconcile-sweep", { ok, produced: { delivered, upstream } })` in a try/finally (`ok:false` on throw). Registered in MONITORED_LOOPS (`src/lib/control-tower/registry.ts`) with `livenessWindowMs = 30 * HOUR` (daily × 1.2 grace, per CLAUDE.md monitor-cadence invariant), `owner = retention`, `errorRateThreshold = 0.5`, `minRunsForErrorRate = 3`. Node-completeness trio (owner + kill-switch ancestry inherited from the `retention` seat + heartbeat) is satisfied.

## Two scopes

**Scope 1 — DELIVERED but not refunded.** Query: `status='delivered' AND refunded_at IS NULL AND easypost_shipment_id IS NOT NULL` (the `easypost_shipment_id` filter excludes imported/Shopify-native returns per [[../lifecycles/return-pipeline]] § "Imported vs created-by-us"). Per hit, read the live gateway ledger via `getOrderRefundLedger` and route via `decideDeliveredSweep`:

| Action | When | What the cron does |
|---|---|---|
| `stamp_oob` | ledger says refundable=0 AND refunded≥contract | Stamp `refund_id='out_of_band_shopify'`, `refunded_at=now()` with a compare-and-set on `.is('refunded_at', null)` — money already moved out of band (SC130193). **Healed.** |
| `redrive_refund` | ledger says cap-to-ledger, refund-full-contract, or is unreadable | Fire `returns/issue-refund` — Phase 1 reconciles inside the handler, `refundOrder`'s pre-dispatch `order_refunds.request_key` guard keeps it money-moves-once idempotent. **Redriven.** |
| `escalate_no_order` | `order_id IS NULL` AND `shopify_order_gid` repair failed | Insert `RETURN_SWEEP_NO_ORDER_TITLE` dashboard notification with the concrete diagnosis + `net_refund_cents` (never a bare "needs review"). **Escalated.** |

**Scope 2 — UPSTREAM stranded.** Query: `status IN ('label_created','in_transit') AND easypost_shipment_id IS NOT NULL AND created_at ≤ now() - 14 days`. Per hit, look up EasyPost via `lookupTracking` and route via `decideUpstreamSweep`:

| Action | When | What the cron does |
|---|---|---|
| `promote_delivered` | tracker says `delivered` or `available_for_pickup` | Compare-and-set the row to `status='delivered'` + `delivered_at`, then fire `returns/process-delivery` — the webhook-missed case (see [[../integrations/easypost]] § Webhooks). **Redriven.** |
| `escalate_failure` | tracker says `failure` / `error` / `return_to_sender` | Insert `RETURN_SWEEP_UPSTREAM_FAILURE_TITLE` dashboard notification with the tracker detail. **Escalated.** |
| `escalate_stale` | age ≥ 30d and still in transit | Insert `RETURN_SWEEP_UPSTREAM_STALE_TITLE` — likely carrier-lost. **Escalated.** |
| `no_action` | still in transit, age < 30d | Skip until the next sweep. |

This generalises `scripts/returns-spot-check.ts` (single-workspace hardcoded) to every workspace via `lookupTracking(workspaceId, ...)`.

## Pure deciders (unit-tested)

- `decideDeliveredSweep({ hasOrderId, netRefundCents, ledger })` → `stamp_oob | redrive_refund | escalate_no_order`. Delegates the ledger→action mapping to `decideRefundReconcile` in [[../libraries/refund-ledger]].
- `decideUpstreamSweep({ trackerStatus, ageDays })` → `promote_delivered | escalate_failure | escalate_stale | no_action`.

Both are covered in `src/lib/inngest/returns-reconcile-sweep.decider.test.ts`.

## Produced counts

Every heartbeat carries `{ delivered: { swept, healed, redriven, escalated }, upstream: { swept, healed, redriven, escalated } }` so a silent zero-work run is distinguishable from a broken one (a zero-swept sweep with `ok:true` is idle; ok:false is a real fault).

## Tables written

- [[../tables/returns]] — `status='refunded'` + `refund_id='out_of_band_shopify'` (stamp_oob), `status='delivered'` + `delivered_at` (promote_delivered), `order_id` (repair).
- [[../tables/dashboard_notifications]] — one row per `escalate_*` action.

## Tables read (not written)

- [[../tables/returns]] — the two scope queries.
- [[../tables/orders]] — via the shopify_order_gid → shopify_order_id repair, and via `getOrderRefundLedger`.
- [[../tables/order_refunds]] — via `getOrderRefundLedger`'s local-mirror reconciliation.
- [[../tables/workspaces]] — via `lookupTracking`'s credential lookup.

## Events sent

- `returns/issue-refund` — redrive on the delivered scope.
- `returns/process-delivery` — redrive on the upstream scope's `promote_delivered` branch.

---

[[../README]] · [[../lifecycles/return-pipeline]] · [[../inngest/returns]] · [[../integrations/easypost]] · [[../libraries/refund-ledger]] · [[../../CLAUDE]]
