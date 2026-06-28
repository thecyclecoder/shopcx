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
- `lane_utilization` — a current-state point read that churns in the seconds between writes

A metric is `withinTolerance` when `driftPct ≤` its tolerance, or — when `driftPct` is null (`snapshotValue === 0`) — when the absolute `drift` itself is 0.

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
