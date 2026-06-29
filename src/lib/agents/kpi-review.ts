/**
 * KPI review SDK — the read-only diff layer for the Platform Department Scorecard
 * ([[../specs/devops-kpi-review-sdk-and-data-fix]] Phase 1).
 *
 * Typed access to every KPI the scorecard advertises ([[platform-scorecard]] DAILY/WEEKLY/MONTHLY
 * registries + [[platform-scorecard-display]] config) AND an independent re-derivation of each one
 * from the raw tables, so a stale / drifted snapshot is detectable. The SDK loads the latest
 * persisted [[../tables/platform_scorecard_snapshots]] row, re-runs the SAME `MetricDef.compute`
 * from [[platform-scorecard]] (via [[platform-scorecard]] `computeScorecardValuesOnly` — same
 * window math, same rounding, byte-equivalent ground truth), and reports drift in the metric's
 * native unit.
 *
 * Server-only (createAdminClient). **NO writes** — the SDK is the read/diff layer; the engine
 * remains the only writer of `platform_scorecard_snapshots`. Mirrors the "one writer" invariant
 * from [[platform-scorecard]].
 *
 * See docs/brain/libraries/kpi-review.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeScorecardValuesOnly,
  getRegisteredMetrics,
  type Cadence,
  type MetricUnit,
  type ScorecardSnapshotRow,
} from "@/lib/agents/platform-scorecard";
import {
  DISPLAY_BY_CADENCE,
  type MetricPolarity,
} from "@/lib/agents/platform-scorecard-display";

/**
 * One advertised KPI — the (cadence, metric_key, label, polarity, unit) tuple the scorecard surface
 * exposes. Combines the engine's registry (key/unit) with the display config (label/polarity).
 */
export interface AdvertisedKpi {
  cadence: Cadence;
  metric_key: string;
  label: string;
  polarity: MetricPolarity;
  unit: MetricUnit;
}

/** Per-metric drift verdict for one `(metric_key, cadence, snapshot_date)`. */
export interface KpiAuditReport {
  metric: string;
  cadence: Cadence;
  /** the date the snapshot row is dated (and the as-of day the ground-truth re-run uses). */
  snapshotDate: string;
  /** the value the engine persisted into [[../tables/platform_scorecard_snapshots]]. */
  snapshotValue: number;
  /** the value the same `MetricDef.compute` produces RIGHT NOW from the raw tables. */
  groundTruthValue: number;
  /** absolute drift in the metric's native unit: `groundTruthValue − snapshotValue`. */
  drift: number;
  /** `|drift / snapshotValue|`; null when `snapshotValue` is 0 (division by zero — drift is reported but the percentage is undefined). */
  driftPct: number | null;
  /** true when `driftPct ≤` the metric's tolerance (or — when `driftPct` is null — when `drift` itself is 0). */
  withinTolerance: boolean;
  /** the persisted `detail` blob (the engine's per-metric breakdown). */
  snapshotDetail: Record<string, unknown>;
  /** the re-derived `detail` blob — same shape as `snapshotDetail`, so side-by-side compare works. */
  groundTruthDetail: Record<string, unknown>;
  /** the metric's unit — drives the display-side formatting. */
  unit: MetricUnit;
  /** the display label (from [[platform-scorecard-display]]). */
  label: string;
  /** which direction is "good" (from [[platform-scorecard-display]]). */
  polarity: MetricPolarity;
}

/**
 * Per-metric tolerance overrides — keyed by `metric_key`. A derived median (`error_mttr_hours`)
 * tolerates a wider band than a strict count (`build_throughput`). Anything not listed falls back to
 * `DEFAULT_TOLERANCE`. Current-state point-read metrics (`MetricDef.currentState`) are SKIPPED by the
 * audit entirely (see `auditKpi` / `auditAllKpis` below) and don't need a tolerance entry here.
 */
const DEFAULT_TOLERANCE = 0.005; // 0.5%
const TOLERANCE_OVERRIDES: Record<string, number> = {
  // Median-of-distribution metrics — the prior snapshot was computed off a slightly different sample
  // window than the re-run sees right now (concluded repairs land between writes), so a strict 0.5%
  // band reads as "drift" on noise.
  error_mttr_hours: 0.05,
  idea_to_merge_hours: 0.05,
  time_to_approve_hours: 0.05,
  // Per-worker grade aggregates pick up grading writes between snapshots.
  worker_grade_rollup: 0.05,
  director_call_grade: 0.05,
  // Loop health is a CURRENT-STATE point read — open loop_alerts and the latest-beat-per-loop set
  // churn in the seconds between the snapshot write and the audit re-run.
  loop_health: 0.05,
};

function toleranceFor(metricKey: string): number {
  return TOLERANCE_OVERRIDES[metricKey] ?? DEFAULT_TOLERANCE;
}

/** Today UTC as YYYY-MM-DD — the day the in-flight daily window is still accumulating into. */
const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/**
 * Read the persisted snapshot row for `(workspace_id, metric_key, cadence)` — either at the exact
 * `snapshotDate` (when given) or the latest **closed** snapshot.
 *
 * **In-flight daily window guard:** for `cadence='daily'` with no explicit `snapshotDate`, we
 * exclude today UTC. The daily cron writes the snapshot mid-day; a later same-day audit re-runs the
 * SAME `[today T00:00, today T23:59]` window math against a row-count that has GROWN since the
 * snapshot froze, surfacing legitimate intra-day enqueues as "drift" (signature
 * `kpi_drift:build_enqueue_rate:daily`). Auditing only closed days eliminates the false positive.
 */
async function readPersistedSnapshot(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  metric: string,
  cadence: Cadence,
  snapshotDate?: string,
): Promise<ScorecardSnapshotRow | null> {
  let q = admin
    .from("platform_scorecard_snapshots")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("metric_key", metric)
    .eq("cadence", cadence);
  if (snapshotDate) q = q.eq("snapshot_date", snapshotDate);
  else if (cadence === "daily") q = q.lt("snapshot_date", todayUtc());
  const { data } = await q.order("snapshot_date", { ascending: false }).limit(1).maybeSingle();
  return (data as ScorecardSnapshotRow | null) ?? null;
}

function buildReport(
  snapshot: ScorecardSnapshotRow,
  groundTruth: ScorecardSnapshotRow,
  display: { label: string; polarity: MetricPolarity },
): KpiAuditReport {
  const snapshotValue = Number(snapshot.value);
  const groundTruthValue = Number(groundTruth.value);
  const drift = groundTruthValue - snapshotValue;
  const driftPct = snapshotValue !== 0 ? Math.abs(drift / snapshotValue) : null;
  const tolerance = toleranceFor(snapshot.metric_key);
  const withinTolerance = driftPct == null ? drift === 0 : driftPct <= tolerance;
  return {
    metric: snapshot.metric_key,
    cadence: snapshot.cadence,
    snapshotDate: snapshot.snapshot_date,
    snapshotValue,
    groundTruthValue,
    drift,
    driftPct,
    withinTolerance,
    snapshotDetail: snapshot.detail ?? {},
    groundTruthDetail: groundTruth.detail ?? {},
    unit: snapshot.unit,
    label: display.label,
    polarity: display.polarity,
  };
}

function displayFor(cadence: Cadence, metricKey: string): { label: string; polarity: MetricPolarity } {
  const row = DISPLAY_BY_CADENCE[cadence].find((d) => d.key === metricKey);
  if (row) return { label: row.label, polarity: row.polarity };
  // Fall back to the metric_key when a registry entry has no display config yet — keeps the SDK
  // working for a freshly added metric before the display row lands in the same PR.
  return { label: metricKey, polarity: "up_is_good" };
}

/**
 * Audit one `(metric_key, cadence)` — loads the latest persisted snapshot row (or the row at
 * `snapshotDate` when given), re-runs the SAME `MetricDef.compute` from [[platform-scorecard]]
 * against the raw tables, and reports drift. Returns null when nothing has been persisted yet
 * (nothing to compare to), or when the metric is a current-state point read (see guard below).
 * NO writes.
 *
 * **Current-state guard:** metrics flagged `MetricDef.currentState` (e.g. `lane_utilization`) are
 * point reads of a CURRENTLY-OCCUPIED pool/counter — the snapshotted value freezes the moment-in-time
 * read, and a ground-truth re-run reads the pool AGAIN at the moment-of-audit, so any movement in
 * the seconds between the two reads surfaces as "drift" that isn't drift. Paired with the in-flight
 * daily window guard (`readPersistedSnapshot` above): same false-positive class — comparing a frozen
 * snapshot against a moving target — applied to a different axis (point-read vs in-flight window).
 * Repair Agent verdict on signature `loop:kpi_drift:lane_utilization:daily`.
 */
export async function auditKpi(
  workspaceId: string,
  metric: string,
  cadence: Cadence,
  snapshotDate?: string,
): Promise<KpiAuditReport | null> {
  const registryEntry = getRegisteredMetrics(cadence).find((m) => m.key === metric);
  if (registryEntry?.currentState) return null;

  const admin = createAdminClient();
  const snapshot = await readPersistedSnapshot(admin, workspaceId, metric, cadence, snapshotDate);
  if (!snapshot) return null;

  const groundTruthRows = await computeScorecardValuesOnly(workspaceId, {
    cadence,
    snapshotDate: snapshot.snapshot_date,
    windowDays: snapshot.window_days,
  });
  const groundTruth = groundTruthRows.find((r) => r.metric_key === metric);
  if (!groundTruth) return null;

  return buildReport(snapshot, groundTruth, displayFor(cadence, metric));
}

/**
 * Audit every metric in the cadence's registry — runs `auditKpi` for each and returns a sorted
 * report. `driftPct` descending so the worst offenders surface first (null `driftPct` rows — the
 * `snapshotValue === 0` case — sort below any positive-drift row).
 *
 * The ground-truth re-run is a single compute pass, NOT one per metric, so the wall-clock cost is
 * "one snapshot pass" regardless of how many metrics are in the registry. Metrics with no persisted
 * snapshot row yet are omitted (the scorecard page renders them as "no data yet"; nothing to diff).
 */
export async function auditAllKpis(
  workspaceId: string,
  cadence: Cadence,
  snapshotDate?: string,
): Promise<KpiAuditReport[]> {
  const admin = createAdminClient();
  const registry = getRegisteredMetrics(cadence);

  // Pull the latest persisted rows in ONE read. When `snapshotDate` is omitted we want each metric's
  // latest row; capping at 1000 covers ~100 days × 10 metrics — comfortable for any cadence. The
  // (workspace_id, cadence, snapshot_date desc) index makes this cheap.
  let q = admin
    .from("platform_scorecard_snapshots")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("cadence", cadence)
    .order("snapshot_date", { ascending: false })
    .limit(1000);
  if (snapshotDate) q = q.eq("snapshot_date", snapshotDate);
  // In-flight daily window guard — see `readPersistedSnapshot` for the rationale. The daily
  // snapshot is taken mid-day; a same-UTC-day audit re-runs the SAME window math against a growing
  // row-count and reads it as drift. Audit only closed days when caller didn't pin a date.
  else if (cadence === "daily") q = q.lt("snapshot_date", todayUtc());
  const { data } = await q;
  const rows = (data ?? []) as ScorecardSnapshotRow[];

  // Latest snapshot per metric_key (rows are already snapshot_date desc).
  const latestByMetric = new Map<string, ScorecardSnapshotRow>();
  for (const r of rows) if (!latestByMetric.has(r.metric_key)) latestByMetric.set(r.metric_key, r);

  // Build one ground-truth re-run per distinct snapshot_date present in the latest set. In the
  // common case every metric was snapshotted on the same day, so this is a single pass.
  const distinctDates = Array.from(
    new Set(Array.from(latestByMetric.values()).map((r) => r.snapshot_date)),
  );
  const groundTruthByDate = new Map<string, ScorecardSnapshotRow[]>();
  for (const d of distinctDates) {
    const gt = await computeScorecardValuesOnly(workspaceId, { cadence, snapshotDate: d });
    groundTruthByDate.set(d, gt);
  }

  const reports: KpiAuditReport[] = [];
  for (const m of registry) {
    // Current-state guard — skip point-read metrics. See `auditKpi` above for the full rationale; the
    // short version: a CURRENTLY-OCCUPIED pool/counter (lane_utilization) churns in the seconds
    // between the snapshot write and the ground-truth re-read, so the diff is moving-target noise,
    // not drift. Same false-positive class as the in-flight daily window guard (different axis).
    if (m.currentState) continue;
    const snap = latestByMetric.get(m.key);
    if (!snap) continue; // no data yet — nothing to compare to
    const gt = (groundTruthByDate.get(snap.snapshot_date) ?? []).find((r) => r.metric_key === m.key);
    if (!gt) continue;
    reports.push(buildReport(snap, gt, displayFor(cadence, m.key)));
  }

  // Worst offenders first; `null` driftPct sorts below any numeric driftPct.
  reports.sort((a, b) => {
    const ax = a.driftPct ?? -Infinity;
    const bx = b.driftPct ?? -Infinity;
    return bx - ax;
  });
  return reports;
}

/**
 * Every advertised KPI across all three cadences — the union of the engine's registry (key/unit)
 * and the display config (label/polarity). External callers can iterate without re-importing the
 * display config.
 */
export function listAdvertisedKpis(): AdvertisedKpi[] {
  const out: AdvertisedKpi[] = [];
  for (const cadence of ["daily", "weekly", "monthly"] as Cadence[]) {
    const reg = getRegisteredMetrics(cadence);
    for (const m of reg) {
      const d = displayFor(cadence, m.key);
      out.push({ cadence, metric_key: m.key, label: d.label, polarity: d.polarity, unit: m.unit });
    }
  }
  return out;
}
