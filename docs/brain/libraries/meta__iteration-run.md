# libraries/meta/iteration-run

Daily-run orchestration helpers — Storefront Iteration Engine **Phase 5**. Owns
the [[../tables/iteration_runs]] run-record (open/close), the **reconcile stage**
(measure prior-action outcomes + link reversals on [[../tables/iteration_actions]]),
and the run-wide noise-floor constants. The durable orchestration itself lives in
the `meta-iteration-run` Inngest function ([[../inngest/meta-performance]]), which
sequences: ingest (P1) → attribution (P2/2b) → rollups (P3) → **reconcile** →
4a actions + 4b recs ([[meta__decision-engine]]) → persist actions + link reversals
→ **execute** (6a — [[meta__execution]] `executeAutonomousActions` applies the decided
pause/unpause/scale to Meta). Every stage is idempotent.

**File:** `src/lib/meta/iteration-run.ts`

## Constants

- `MIN_ACTION_SPEND_CENTS = 500` — $5 trailing-window spend floor for ad/adset/campaign.
- `MIN_VARIANT_SESSIONS = 30` — trailing-window sessions floor for a variant.
- `OUTCOME_MATURATION_DAYS = 3` — wait this long after a decision before its outcome is measurable.

The two noise floors are passed to `runDecisionEngine` so thin objects are skipped
for both autonomous actions and recommendations. v1 they're module constants —
candidate to migrate into [[../tables/iteration_policies]] later (no schema churn needed).

## Exports

### `startRun` / `finishRun` — run records

```ts
async function startRun(p: DecisionEngineParams, trigger: "cron" | "manual"): Promise<string>
async function finishRun(runId: string, fields: { status: "complete" | "failed"; snapshotDate?; policy_active?; policy_version_id?; stages?; counts?; error? }): Promise<void>
```
`startRun` inserts an [[../tables/iteration_runs]] row (`status='running'`) and returns
its id. `finishRun` stamps the terminal status, `duration_ms` (recovered from the row's
`started_at`), `stages`, `counts`, and `error`.

### `reconcilePriorActions` — reconcile stage

```ts
async function reconcilePriorActions(p: DecisionEngineParams, snapshotDate: string): Promise<{ outcomes_reconciled: number; openReversibles: OpenReversibles }>
```
(1) Backfills `outcome_roas`/`outcome_revenue_cents`/`outcome_window_days`/
`outcome_evaluated_at` on [[../tables/iteration_actions]] rows whose maturation window
(`OUTCOME_MATURATION_DAYS`) has elapsed, reading the object's current trailing-window
metrics from [[../tables/iteration_scorecards_daily]]. (2) Returns `openReversibles`
(`object_id → { scale_up?, pause? }`) — the most recent still-open (un-reversed)
scale_up / pause actions, the targets a new scale_down / unpause this run reverses.
Idempotent: only touches rows with `outcome_evaluated_at` null.

### `buildReversalLinks` / `linkReversals` — reversal linking

```ts
function buildReversalLinks(actions: ComputedAction[], open: OpenReversibles): ReversalLink[]   // pure
async function linkReversals(p: DecisionEngineParams, snapshotDate: string, links: ReversalLink[]): Promise<number>
```
`buildReversalLinks` is pure: a `scale_down` reverts the object's open `scale_up`, an
`unpause` reverts its open `pause`. `linkReversals` (run AFTER `persistActions` has
written this run's actions) stamps the reversing row's `reverses_action_id` and flips
the reverted row to `status='reversed'` with `reversed_by_action_id`. Idempotent — sets
the same values on a re-run.

### Types

`StageRecord` (`{ name, status, ms, ...counts }`), `OpenReversibles`, `ReconcileResult`,
`ReversalLink`.

## Callers

- `src/lib/inngest/meta-performance.ts` (`meta-iteration-run`) — the only caller; driven
  by the `meta-performance-daily` cron.

## Gotchas

- The reconcile **outcome** measures the object's post-decision trailing-window metrics;
  it is most meaningful for actions Phase 6a actually executed ([[meta__execution]]) — a
  `decided` row whose adapter is not yet enabled (e.g. `replenish_creative`) stays
  `decided` and its outcome reflects an unapplied decision.
- `linkReversals` must run **after** `persistActions` (it looks up the reversing row by
  its natural key for this snapshot).
- [[../tables/iteration_runs]] is append-only run history — a re-run is a new row.
- **Depends on scorecards actually persisting.** `reconcilePriorActions` and the decision
  engine read [[../tables/iteration_scorecards_daily]] only — if the Phase-3 rollup writes 0
  rows they reconcile/decide on nothing (fly blind). A prior bug had
  [[meta__scorecards]] swallow the upsert `{ error }` and report `rows: records.length`
  while a dangling FK dropped the whole batch (reported 7, persisted 0). Fixed
  (iteration-scorecard-upsert-resilience): the rollup now nulls unresolved refs, isolates
  bad rows per-row, and **throws** on a real error, so the run fails loudly instead of
  feeding this stage an empty table.

See [[../specs/storefront-iteration-engine]] (Phase 5) · [[meta__decision-engine]].
