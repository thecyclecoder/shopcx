# libraries/dunning-strand-detector

**File:** `src/lib/dunning-strand-detector.ts`

**Phase 5 of** [[../specs/a-dunning-cycle-must-never-silently-strand-a-subscription]] — the read-only safety net that surfaces the class of failure verified 2026-09-21: an open `dunning_cycles` row silently pointing at a dead pre-migration contract, holding an active subscription out of renewal selection for 50-72 days while nothing paged. Six of thirty-three open cycles were on wrong contracts, five customers were stranded, $480.22 was recovered after manual repair — and every one of them was invisible because a wrong-contract retry finds nothing to bill and writes no attempt.

## The move

Two invariants, both MUST be 0:

- **(a) contract drift** — an open `dunning_cycles` row whose `shopify_contract_id` differs from its `subscription_id`'s current value. Every dunning step follows the cycle's contract, so a cycle pointing at the dead pre-migration contract silently retries forever. Phase 1's migration re-point ([[migrate-to-internal]] `repointOpenDunningCyclesForMigration`) closes this going forward; this detector is how a regression is caught the next day instead of month-later.
- **(b) overdue-but-active** — `subscriptions.status='active'`, `is_internal=true`, `next_billing_date` more than 1.5 billing intervals in the past. Comp subs (`comp=true`) are excluded — sub `5ec77e57` is a legitimate 92-day-overdue comp.

## Exports

- `interface StrandedContractDriftFinding` — `{ workspace_id, cycle_id, subscription_id, cycle_contract_id, subscription_contract_id, cycle_status, cycle_number }`.
- `interface StrandedOverdueFinding` — `{ workspace_id, subscription_id, customer_id, contract_id, next_billing_date, billing_interval, billing_interval_count, days_overdue }`.
- `interface StrandedDunningReport` — `{ workspace_id, contract_drift[], overdue_but_active[] }`.
- `detectStrandedDunningCycles(admin, workspace_id, nowMs?): Promise<StrandedDunningReport>` — pure detector (no writes; nowMs injected for tests).
- `surfaceStrandedDunningAlerts(admin, report): Promise<{ alerts_inserted }>` — deduped writer.
- `runStrandedDunningCyclesSweep(admin, workspace_id): Promise<{ contract_drift, overdue_but_active, alerts_inserted }>` — the composite the cron uses.

## Wiring

Piggy-backed on [[../inngest/internal-subscription-renewals]]'s `internal-subscription-renewal-cron` end-of-run (new step: `scan-stranded-dunning-cycles`), alongside `scan-duplicate-renewals` — **no new Inngest function, no new MONITORED_LOOPS cadence row, no new kill-switch ancestry**. The cron already knows the set of workspaces with due subs; the sweep runs once per workspace with due subs (a workspace with none needs no new signal).

Per CLAUDE.md node completeness: if this ever moves off the parent cron into its own cron/agent/reactive fn, it MUST ship in the same PR with (1) an OWNER in [[control-tower-node-registry]], (2) a [[../tables/kill_switches]] ancestry, and (3) an end-of-run heartbeat via `emitCronHeartbeat` / `emitReactiveHeartbeat`. Today it is a child step of the parent cron's heartbeat, which is why it doesn't register its own.

Best-effort: a detector throw is logged + swallowed so a bug in this observer NEVER breaks the actual renewal fan-out. Owner: [[../functions/retention]] (via the parent cron's owner).

## Tables read

- [[../tables/dunning_cycles]] — the open-cycle contract-drift join (via PostgREST nested select on `subscriptions!inner(shopify_contract_id)`).
- [[../tables/subscriptions]] — the overdue-but-active scan (filters `status='active'`, `is_internal=true`, `comp!=true`).

## Tables written

- [[../tables/dashboard_notifications]] — one `type='billing_alert'` card per fresh finding. Dedupe key inside `metadata`:
  - contract drift: `stranded-dunning-contract-drift:<cycle_id>`
  - overdue-but-active: `stranded-dunning-overdue-active:<subscription_id>`

  The partial UNIQUE index `dashboard_notifications_dedupe_key_open_uniq` enforces one-open-card-per-key at the DB level, so a rescanned finding does not stack cards ([[subscription-duplicate-renewal-detector]] uses the same convention).

## Related

- [[../lifecycles/dunning]] § Migration path
- [[../lifecycles/subscription-billing]] § Migration path (Appstle → internal)
- [[migrate-to-internal]] — Phase 1's `repointOpenDunningCyclesForMigration`
- [[dunning]] — `updateDunningCycle`, `RECOVERABLE_DUNNING_STATUSES`, `triggerNewCardRecovery`
- [[subscription-duplicate-renewal-detector]] — same wiring shape (piggy-back on the daily renewal cron)
