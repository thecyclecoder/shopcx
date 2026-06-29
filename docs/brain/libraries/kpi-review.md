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

(Current-state point-read metrics — `lane_utilization` · `loop_health` — are SKIPPED entirely below, so they don't need a tolerance entry.)

A metric is `withinTolerance` when `driftPct ≤` its tolerance. When `driftPct` is null (`snapshotValue === 0`): **count-unit** metrics tolerate `|drift| ≤ 2` (the count-metric zero-snapshot boundary-race floor — see below); every other unit requires `drift === 0` strictly.

### Count-metric zero-snapshot boundary-race floor

When a `unit: 'count'` metric snapshots to 0, the percentage tolerance is undefined and strict `drift === 0` alarms on a single row that moved across the window boundary between snapshot write and audit re-read — the canonical case is [[../tables/error_events]] (`error_backlog:daily`) where `last_seen_at` is bumped to "now" each time the same error re-occurs, so a row whose `last_seen_at` lived in yesterday's window at snapshot time can have `last_seen_at = today` by the next audit pass (or vice versa), surfacing as drift of ±1 that isn't engine drift. The floor (`|drift| ≤ 2`) absorbs that boundary noise without masking real engine drift. Repair Agent verdict on signature `kpi_drift:error_backlog:daily` (verdict: monitor-false-positive). Non-count units (`ratio`, `hours`, `grade`) keep the strict `drift === 0` rule — a ratio drifting from 0 to even 0.0001 is meaningful in a way ±1 row in a count is not.

## Current-state point-read skip

`auditKpi` / `auditAllKpis` SKIP every metric flagged `MetricDef.currentState` (today: [[platform-scorecard]] `lane_utilization` · `loop_health`). A point read of a CURRENTLY-OCCUPIED pool / NOW-state counter is "right now": the snapshotted value freezes the moment-in-time read, and a ground-truth re-run reads the same pool/counter AGAIN at the moment-of-audit — any movement in the seconds between the two reads surfaces as "drift" that isn't drift. `lane_utilization` reads the build pool's currently-occupied lanes; `loop_health` reads `loop_alerts` open-state + the latest heartbeat per loop. Repair Agent verdicts on signatures `loop:kpi_drift:lane_utilization:daily` and `loop:kpi_drift:loop_health:daily` (same false-positive class). Same shape as the in-flight daily window guard below — comparing a frozen snapshot against a moving target — applied to a different axis (point-read vs in-flight window).

## Live-spec-set-dependent skip

`auditKpi` / `auditAllKpis` also SKIP every metric flagged `MetricDef.liveSpecSetDependent` (today: [[platform-scorecard]] `specs_per_week`, `regression_coverage_pct`). These metrics derive ground truth from the LIVE brain-roadmap spec set (`getRoadmap()` — `specs_per_week` uses it for the live spec→owner map; `regression_coverage_pct` uses it for the live shipped-spec denominator). The live set churns between snapshot write and audit re-read — a spec that was live when the engine wrote the snapshot can fold/archive on its own cadence before the audit re-runs, so the re-run sees a different population than the snapshot did and the membership delta surfaces as "drift" that isn't engine drift. Same false-positive class as the current-state skip (frozen snapshot vs moving target) — different axis (the population definition moved, not the underlying counter). Repair Agent verdict on signature `loop:kpi_drift:specs_per_week:weekly`.

## Skipped-metric stale-alert sweep

The [[../inngest/platform-director-cron]] `audit-platform-scorecard` step runs a sister sweep that auto-resolves any open `kpi_drift:<skipped-metric>:<cadence>` `loop_alerts` row for BOTH skip classes (`currentState` and `liveSpecSetDependent`) — an alert opened BEFORE a metric was flagged clears on the next standing beat (the within-tolerance auto-resolve branch can't fire for a metric that no longer appears in `reports`).

## In-flight daily window

`auditKpi` / `auditAllKpis` audit **closed** daily snapshots only — when called without an explicit `snapshotDate`, the daily-cadence read filters `snapshot_date < today UTC`. The daily cron writes its snapshot mid-day; a later same-UTC-day audit re-runs the SAME `[today T00:00, today T23:59]` window math against a row count that has **grown** since the snapshot froze (legitimate intra-day enqueues, completions, escalations), surfacing as "drift" that isn't drift. Skipping today eliminates the false positive — Repair Agent verdict on signature `kpi_drift:build_enqueue_rate:daily` (the canonical case: every new `agent_jobs kind='build'` enqueue inflates the ground-truth count against the frozen snapshot). Weekly/monthly cadences have the same SHAPE in-flight (one in-flight day inside a 7- or 30-day window) but a far smaller relative-drift amplitude; they're left as-is until a signature surfaces. Callers that explicitly pass `snapshotDate` bypass the guard (the caller knows which window they want).

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
