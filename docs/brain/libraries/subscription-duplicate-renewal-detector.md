# libraries/subscription-duplicate-renewal-detector

**File:** `src/lib/subscription-duplicate-renewal-detector.ts`

**Phase 2 of** [[../specs/immediate-charge-renewal-paths-need-per-subscription-idempotency]] — the read-only safety net over Phase 1's [[subscription-cycle-charge-claim]] guard. Phase 1's unique index on `(subscription_id, cycle_key)` is the BELT that refuses the second Braintree sale. This detector is the SUSPENDERS: if a future path bypasses the guard (a new immediate-charge caller that skips the chokepoint, a schema drift that dodges the unique index), the pattern surfaces immediately as a `dashboard_notifications` card instead of when a customer writes in a month later.

**Ground truth:** on 2026-08-28 internal sub fd857ad9 produced SHOPCX273 (17:18:44) and SHOPCX274 (17:22:56) — same subscription_id, same $102.33, minutes apart, both `financial_status='paid'`, both `source_name='internal_subscription_renewal'`. Only surfaced because the customer wrote in.

## The move

- **Pure detector:** `detectDuplicateRenewalGroups(orders)` — buckets a batch of orders by `(subscription_id, YYYY-MM-DD from created_at)`. Ignores non-`internal_subscription_renewal` rows and rows missing subscription_id / workspace_id. Returns groups with `>= 2` orders (sorted by `created_at ASC` — earliest first).
- **Live scan:** `scanDuplicateRenewals(admin, workspace_id, sinceIso?)` — reads every `internal_subscription_renewal` order in the window (default: last 26h — a hair over the daily cron cadence) and runs the pure detector. Cap 5000 rows/pass; a workspace with more renewals a day should page.
- **Surface:** `surfaceDuplicateRenewalAlert(admin, group)` — writes ONE `dashboard_notifications` card per fresh group. `type='billing_alert'`; dedupe on `metadata->>dedupe_key = 'duplicate-renewal:<subscription_id>:<cycle_day>'` — the same convention `ad-spend-governor` + `fleet-spend-governor` + `cs-director-escalate-founder-card` use. A repeated scan on the same spike does NOT write a second card.
- **Scan + surface in one:** `scanAndSurfaceDuplicateRenewals(admin, workspace_id, sinceIso?)` — the shape [[../inngest/internal-subscription-renewals]]'s daily cron uses at end-of-run.

## Wiring

Piggy-backed on [[../inngest/internal-subscription-renewals]]'s `internal-subscription-renewal-cron` — no new Inngest function, no new [[../libraries/control-tower]] MONITORED_LOOPS registration, no new kill-switch ancestry. The daily fan-out step (which already knows the set of workspaces with due subs) hands each workspace's id to `runDuplicateRenewalSweep` in a `scan-duplicate-renewals` step. A workspace with no due subs this run is NOT scanned (nothing new to detect); a workspace with due subs gets its last-26h renewals bucketed and any group of >=2 surfaced.

Best-effort — a detector throw is logged + swallowed so a bug in this observer NEVER breaks the actual renewal fan-out.

## Exports

- `interface RenewalOrderLike` — the order shape the pure detector needs (`id`, `workspace_id`, `customer_id`, `subscription_id`, `order_number`, `total_cents`, `source_name`, `financial_status`, `created_at`).
- `interface DuplicateRenewalGroup` — one detected group: `workspace_id`, `subscription_id`, `customer_id`, `cycle_day` (YYYY-MM-DD), `orders` (array, sorted earliest → latest).
- `detectDuplicateRenewalGroups(orders): DuplicateRenewalGroup[]` — pure.
- `scanDuplicateRenewals(admin, workspace_id, sinceIso?): Promise<DuplicateRenewalGroup[]>` — live read.
- `surfaceDuplicateRenewalAlert(admin, group): Promise<{ inserted: boolean }>` — deduped write.
- `scanAndSurfaceDuplicateRenewals(admin, workspace_id, sinceIso?): Promise<{ groups_found; alerts_inserted }>` — the composite.
- **Semantic aliases** (grep-friendly names for the concept, not just the mechanics):
  - `duplicateRenewalGroups` = `detectDuplicateRenewalGroups`
  - `scanForDuplicateRenewals` = `scanDuplicateRenewals`
  - `surfaceDuplicateRenewalGroup` = `surfaceDuplicateRenewalAlert`
  - `runDuplicateRenewalSweep` = `scanAndSurfaceDuplicateRenewals`

## Tables read

- [[../tables/orders]] — the window scan (filtered `source_name='internal_subscription_renewal'`).

## Tables written

- [[../tables/dashboard_notifications]] — one `type='billing_alert'` card per fresh duplicate group.

## Regression tests

Pinned by `src/lib/subscription-duplicate-renewal-detector.test.ts` (registered as `npm run test:subscription-duplicate-renewal-detector` in package.json, executed by `npm run test:all` and the `check:tests-registered` gate):

1. The SHOPCX273/274 shape — two same-day same-sub renewal orders form ONE group with earliest first.
2. A lone renewal on the day does NOT surface (happy path stays silent).
3. A manual admin order + a real renewal on the same day is NOT a duplicate renewal (detector filters non-`internal_subscription_renewal` rows).
4. Two renewals on different subs on the same day are two 1-item buckets — neither surfaces.
5. Rows missing `subscription_id` / `workspace_id` are dropped without crash / group corruption.
6. Unparseable `created_at` is dropped without NaN bucket.
7. Split-by-UTC-midnight goes into separate day buckets (pins the "same-day is a deliberate simplification" behavior; future widen to same-cycle flips this test).
8. THREE same-day renewals on one sub form ONE group with all three orders sorted ASC by `created_at` (a triple charge is worse than a double and must be surfaced with every offending id).

## Invariants

- **Read-only against everything except `dashboard_notifications`.** A detector that mutates the state it observes is not a detector — it's an actor that would need its own supervisor. See [[../operational-rules]] § North star.
- **Idempotent surface** — the `metadata->>dedupe_key` dedupe check + the partial UNIQUE index means the same spike CAN be re-scanned safely; it never emits a second card.
- **Best-effort in the cron** — a detector throw NEVER breaks the fan-out.

---

[[../README]] · [[../inngest/internal-subscription-renewals]] · [[subscription-cycle-charge-claim]] · [[../tables/subscription_cycle_charges]] · [[../specs/immediate-charge-renewal-paths-need-per-subscription-idempotency]] · [[../../CLAUDE]]
