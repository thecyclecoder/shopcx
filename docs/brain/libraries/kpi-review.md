# libraries/kpi-review

The **read-only diff layer** for the [[platform-scorecard]] engine ([[../specs/devops-kpi-review-sdk-and-data-fix]] Phase 1). Typed access to every KPI the scorecard advertises ([[platform-scorecard]] DAILY/WEEKLY/MONTHLY registries + [[platform-scorecard-display]] config) AND an independent re-derivation of each one from the raw tables, so a stale / drifted snapshot is detectable.

**File:** `src/lib/agents/kpi-review.ts` (server-only — `createAdminClient`).

**Invariant:** **NO writes.** The SDK is the read/diff layer; [[platform-scorecard]] `computePlatformScorecard` remains the **only** writer of [[../tables/platform_scorecard_snapshots]] (the "one writer" rule from [[platform-scorecard]] is preserved).

## How it works

The SDK loads the persisted [[../tables/platform_scorecard_snapshots]] row, then re-runs the **same** `MetricDef.compute` from [[platform-scorecard]] via `computeScorecardValuesOnly` — same window math, same rounding, byte-equivalent ground truth — and reports drift in the metric's **native unit**.

- The same window math means an audit's ground-truth re-run is what the engine *would* persist if `computePlatformScorecard` ran right now for that `(workspace_id, cadence, snapshot_date)`. Any drift is real (raw tables shifted between writes, or the engine itself disagrees with its persisted row).
- `auditAllKpis` does **one** compute pass per distinct `snapshot_date` across the cadence's registry, not one per metric — wall-clock cost is "one snapshot pass" regardless of registry size.

## Exports

- **`interface AdvertisedKpi { cadence; metric_key; label; polarity; unit }`** — one row of `listAdvertisedKpis()`.
- **`interface KpiAuditReport`** — `{ metric, cadence, snapshotDate, snapshotValue, groundTruthValue, drift, driftPct, withinTolerance, snapshotDetail, groundTruthDetail, unit, label, polarity }`. `driftPct = |drift / snapshotValue|`, null when `snapshotValue === 0` (division undefined).
- **`auditKpi(workspaceId, metric, cadence, snapshotDate?): Promise<KpiAuditReport | null>`** — audits one metric. Loads the latest persisted snapshot row (or the row at `snapshotDate` when given), re-runs the same `MetricDef.compute`, returns the report. Null when there's no persisted snapshot to compare to.
- **`auditAllKpis(workspaceId, cadence, snapshotDate?): Promise<KpiAuditReport[]>`** — audits every metric in the cadence's registry. Sorted by `driftPct` descending so the worst offenders surface first (null `driftPct` rows sort below any numeric drift). Metrics with no persisted snapshot yet are omitted.
- **`listAdvertisedKpis(): AdvertisedKpi[]`** — the full `(cadence, metric_key, label, polarity, unit)` set the scorecard surfaces. Combines the engine's registry (key/unit via [[platform-scorecard]] `getRegisteredMetrics`) with the display config (label/polarity via [[platform-scorecard-display]] `DISPLAY_BY_CADENCE`).

## Tolerance model

A single default tolerance (`0.5%`) with per-metric overrides keyed by `metric_key`. A derived median (`error_mttr_hours`) tolerates a wider band than a strict count (`build_throughput`) — the prior snapshot was computed off a slightly different sample window than the re-run sees right now, so a strict 0.5% band reads as "drift" on noise. The current overrides (all `5%`):

- `error_mttr_hours` · `idea_to_merge_hours` · `time_to_approve_hours` — medians of distributions
- `worker_grade_rollup` · `director_call_grade` — per-worker / per-dimension grade aggregates picking up writes between snapshots
- `loop_health` — current-state point read: open `loop_alerts` and the latest-beat-per-loop set churn in the seconds between the snapshot write and the audit re-run

(Current-state point-read metrics — `lane_utilization` · `loop_health` · `needs_attention` — are SKIPPED entirely below, so they don't need a tolerance entry.)

A metric is `withinTolerance` when `driftPct ≤` its tolerance. When `driftPct` is null (`snapshotValue === 0`): **count-unit** metrics tolerate `|drift| ≤ 2` (the count-metric zero-snapshot boundary-race floor — see below); every other unit requires `drift === 0` strictly.

### Count-metric zero-snapshot boundary-race floor

When a `unit: 'count'` metric snapshots to 0, the percentage tolerance is undefined and strict `drift === 0` alarms on a single row that moved across the window boundary between snapshot write and audit re-read — the canonical case is [[../tables/error_events]] (`error_backlog:daily`) where `last_seen_at` is bumped to "now" each time the same error re-occurs, so a row whose `last_seen_at` lived in yesterday's window at snapshot time can have `last_seen_at = today` by the next audit pass (or vice versa), surfacing as drift of ±1 that isn't engine drift. The floor (`|drift| ≤ 2`) absorbs that boundary noise without masking real engine drift. Repair Agent verdict on signature `kpi_drift:error_backlog:daily` (verdict: monitor-false-positive). Non-count units (`ratio`, `hours`, `grade`) keep the strict `drift === 0` rule — a ratio drifting from 0 to even 0.0001 is meaningful in a way ±1 row in a count is not.

## Current-state point-read skip

`auditKpi` / `auditAllKpis` SKIP every metric flagged `MetricDef.currentState` (today: [[platform-scorecard]] `lane_utilization` · `loop_health` · `needs_attention`). A point read of a CURRENTLY-OCCUPIED pool / NOW-state counter is "right now": the snapshotted value freezes the moment-in-time read, and a ground-truth re-run reads the same pool/counter AGAIN at the moment-of-audit — any movement in the seconds between the two reads surfaces as "drift" that isn't drift. `lane_utilization` reads the build pool's currently-occupied lanes; `loop_health` reads `loop_alerts` open-state + the latest heartbeat per loop; `needs_attention` reads `agent_jobs` currently in `status='needs_attention'` (a parked item routes/resolves or a new park lands between snapshot write and audit re-read). Repair Agent verdicts on signatures `loop:kpi_drift:lane_utilization:daily`, `loop:kpi_drift:loop_health:daily`, and `loop:kpi_drift:needs_attention:daily` (same false-positive class). Same shape as the in-flight daily window guard below — comparing a frozen snapshot against a moving target — applied to a different axis (point-read vs in-flight window).

## Live-spec-set-dependent skip

`auditKpi` / `auditAllKpis` also SKIP every metric flagged `MetricDef.liveSpecSetDependent` (today: [[platform-scorecard]] `specs_per_week`, `regression_coverage_pct`). These metrics derive ground truth from the LIVE brain-roadmap spec set (`getRoadmap()` — `specs_per_week` uses it for the live spec→owner map; `regression_coverage_pct` uses it for the live shipped-spec denominator). The live set churns between snapshot write and audit re-read — a spec that was live when the engine wrote the snapshot can fold/archive on its own cadence before the audit re-runs, so the re-run sees a different population than the snapshot did and the membership delta surfaces as "drift" that isn't engine drift. Same false-positive class as the current-state skip (frozen snapshot vs moving target) — different axis (the population definition moved, not the underlying counter). Repair Agent verdict on signature `loop:kpi_drift:specs_per_week:weekly`.

## Skipped-metric stale-alert sweep

The [[../inngest/platform-director-cron]] `audit-platform-scorecard` step runs a sister sweep that auto-resolves any open `kpi_drift:<skipped-metric>:<cadence>` `loop_alerts` row for BOTH skip classes (`currentState` and `liveSpecSetDependent`) — an alert opened BEFORE a metric was flagged clears on the next standing beat (the within-tolerance auto-resolve branch can't fire for a metric that no longer appears in `reports`).

## Weekly-Sunday reader guard

`auditKpi` / `auditAllKpis` — and the mirroring [[../dashboard/agents]] scorecard route (`src/app/api/developer/agents/scorecard/route.ts`, both default and history modes) — discard any `cadence='weekly'` row whose `snapshot_date` is not a Sunday in UTC (`new Date(snapshot_date + 'T00:00:00Z').getUTCDay() !== 0`). Under the post-fix weekly writer ([[../specs/devops-kpi-weekly-snapshot-date-lag-fix]]) every valid weekly `snapshot_date` is the previous ISO Sunday — any other day-of-week is a pre-fix stale in-flight row that must be discarded before picking "latest". The canonical case: a stale Monday 2026-06-29 snapshot (written mid-day when that week's window was still open) kept outsorting the valid Sunday 2026-06-28 row, so the audit re-derived the closed window's true value (48) against the frozen mid-day snapshot (53.66) and reported 10.55% drift; the CEO's Approvals-untouched tile served the stale value; the loop alert stayed red until the next Sunday write superseded it. The reader-side filter clears it on the next audit beat. Repair Agent verdict on signature `loop:kpi_drift:approvals_untouched_pct:weekly` (verdict: real-bug — genuine reader-side gap in the writer fix). Callers that explicitly pass `snapshotDate` bypass the guard (the caller knows which window they want). Defensive against any future writer bug producing invalid weekly `snapshot_date`s — mirrors the "one writer, defensive readers" pattern the [[#in-flight-window-all-cadences]] guard already uses.

## In-flight window (all cadences)

`auditKpi` / `auditAllKpis` audit **closed** snapshots only, on every cadence — when called without an explicit `snapshotDate`, the persisted-snapshot read filters `snapshot_date < today UTC` regardless of cadence. Every cadence writes its snapshot mid-day into a window ending TODAY UTC; a later same-UTC-day audit re-runs the SAME window math against a row count that has **grown** since the snapshot froze (legitimate intra-window writes — enqueues, completions, deploys, escalations), surfacing as "drift" that isn't drift. Auditing only closed windows eliminates the entire false-positive class in one stroke — on the 1st of a month the monthly audit falls back to the previous month's snapshot (whose window ended in the prior month → fully closed), on Sunday the weekly audit falls back to the prior Sunday's closed snapshot. Repair Agent verdicts:

- **daily** — `kpi_drift:build_enqueue_rate:daily` — every new `agent_jobs kind='build'` enqueue inflates the ground-truth count against the frozen snapshot.
- **monthly** — `loop:kpi_drift:deploy_reliability:monthly` — the monthly snapshot writes on the 1st using a trailing 30-day window ending TODAY UTC. Every additional `director_activity` `deploy_healthy` / `deploy_rolled_back` row that lands later that same day inflates the ground-truth ratio against the frozen ratio (canonical incident: snapshot=0.9583 vs raw=0.9529 = 0.56% drift, over the 0.5% ratio tolerance; both the June and July monthly snapshots hit the same in-flight window on their 1sts and tripped the ≥2-consecutive-snapshot loop gate against a KPI that was actually healthy).
- **weekly** — same in-flight shape when a snapshot is read on the Sunday write-day (no signature has surfaced yet — the fix is preemptive, unifies the guard).

Callers that explicitly pass `snapshotDate` bypass the guard (the caller knows which window they want). Regression coverage: `src/lib/agents/kpi-review.test.ts` seeds a monthly `deploy_reliability` snapshot dated today plus a within-tolerance one dated last month and asserts `auditAllKpis('monthly')` lands on the closed prior-month row.

## CLI

```
npx tsx scripts/_audit-kpis.ts                 # all workspaces, all three cadences
npx tsx scripts/_audit-kpis.ts <workspace-id>  # narrow to one workspace
```

Prints `metric · cadence · snapshot · ground-truth · drift · driftPct · status` to stdout, plus a final count of metrics drifting beyond tolerance. Read-only — wraps `auditAllKpis`.

## Callers

- `scripts/_audit-kpis.ts` — the Phase 1 CLI surface.
- (Phase 4 — planned) `GET /api/developer/agents/scorecard/audit?metric=&cadence=` — owner-gated, calls `auditKpi` for a single metric or `auditAllKpis` for a cadence's full registry. The scorecard page's `KpiTile` component will call this after the snapshot loads, rendering a subscript: `audit: snapshot ✓` (drift <0.5%), `drift: +Y% vs raw` (0.5–5%), or `DRIFT: snapshot=X · raw=Y` (>5%). Click to expand per-metric drift detail side-by-side (`snapshotDetail` vs `groundTruthDetail`).
- `audit-platform-scorecard` step on [[../inngest/platform-director-cron]] ([[../specs/devops-kpi-review-sdk-and-data-fix]] Phase 5) — runs `auditAllKpis(workspaceId, cadence)` on the standing pass for all three cadences, upserts one [[../tables/kpi_audit_log]] row per metric (idempotent on `snapshot_date`), and opens a [[../tables/loop_alerts]] row (`loop_id`/`signature` = `kpi_drift:<metric>:<cadence>`, `owner='platform'`, `kind='kpi-drift'`, `reason='kpi_drift'`) when a metric has been over-tolerance for ≥2 consecutive snapshots. A single-snapshot drift is logged but NOT alerted (self-healing on transient timing noise); a metric recovering to within-tolerance auto-resolves its open alert.

## Related

[[platform-scorecard]] · [[platform-scorecard-display]] · [[../tables/platform_scorecard_snapshots]] · [[../inngest/platform-director-cron]] · [[../specs/devops-kpi-review-sdk-and-data-fix]] · [[../operational-rules]]
