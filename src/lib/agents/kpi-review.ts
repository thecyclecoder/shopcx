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
  /**
   * true when `driftPct ≤` the metric's tolerance. When `driftPct` is null (`snapshotValue === 0`):
   * count-unit metrics tolerate `|drift| ≤ COUNT_ZERO_SNAPSHOT_ABS_FLOOR` (the boundary-race floor —
   * see the constant for why); every other unit requires `drift === 0` strictly.
   */
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

/**
 * Count-metric zero-snapshot boundary-race floor. When a count-unit metric's snapshot value is 0
 * the percentage tolerance is undefined (divide-by-zero) and strict `drift === 0` alarms on a
 * single row that moved across the window boundary between snapshot write and audit re-read —
 * e.g. `error_backlog:daily` where `error_events.last_seen_at` updates to "now" each time the
 * same error re-occurs, so a row whose last_seen_at lived in yesterday's window at snapshot time
 * can have last_seen_at = today by the next audit pass (or vice versa), surfacing as drift of ±1
 * that isn't engine drift. Tolerate small absolute drifts (≤ `COUNT_ZERO_SNAPSHOT_ABS_FLOOR`) in
 * this case — Repair Agent verdict on signature `kpi_drift:error_backlog:daily`.
 */
const COUNT_ZERO_SNAPSHOT_ABS_FLOOR = 2;

function toleranceFor(metricKey: string): number {
  return TOLERANCE_OVERRIDES[metricKey] ?? DEFAULT_TOLERANCE;
}

/** Today UTC as YYYY-MM-DD — the day the in-flight daily window is still accumulating into. */
const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/**
 * True when `snapshot_date` (YYYY-MM-DD) is a Sunday in UTC. Under the post-fix weekly writer
 * ([[../specs/devops-kpi-weekly-snapshot-date-lag-fix]]) every valid weekly snapshot_date is the
 * previous ISO Sunday — any other day-of-week is a pre-fix stale in-flight row that must be
 * discarded before picking "latest". Clears loop signature
 * `loop:kpi_drift:approvals_untouched_pct:weekly` (a stale 2026-06-29 Monday row was outsorting
 * the valid 2026-06-28 Sunday row).
 */
const isSundayUtc = (snapshotDate: string): boolean =>
  new Date(snapshotDate + "T00:00:00Z").getUTCDay() === 0;

/**
 * Read the persisted snapshot row for `(workspace_id, metric_key, cadence)` — either at the exact
 * `snapshotDate` (when given) or the latest **closed** snapshot.
 *
 * **In-flight window guard (all cadences):** with no explicit `snapshotDate`, we exclude today UTC
 * regardless of cadence. Every cadence writes its snapshot mid-day and reads a window whose end is
 * TODAY UTC — a later same-UTC-day audit re-runs the SAME window math against a row-count that has
 * GROWN since the snapshot froze, surfacing legitimate intra-window writes as "drift" that isn't
 * drift. Canonical cases: `kpi_drift:build_enqueue_rate:daily` (every new `agent_jobs` enqueue
 * inflates the ground-truth count against the frozen snapshot) AND `loop:kpi_drift:deploy_reliability:monthly`
 * (the monthly snapshot writes on the 1st using a trailing 30-day window ending TODAY; more
 * `director_activity` deploy rows land later that same day, so the ground-truth ratio drifts by
 * >0.5% against the frozen ratio and trips the ≥2-consecutive-snapshot loop gate against a KPI that
 * is actually healthy). Weekly has the same shape when a snapshot is read on its write-day. Auditing
 * only **closed** windows (skipping today's still-in-flight snapshot) eliminates the entire
 * false-positive class in one stroke — the monthly audit falls back to the previous month's
 * closed-window snapshot, the weekly audit falls back to the prior Sunday's closed snapshot.
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
  else q = q.lt("snapshot_date", todayUtc());
  // Weekly-Sunday reader guard: fetch a small window (not just top-1) so that if the latest row is
  // a pre-lag-fix stale non-Sunday snapshot_date we can skip over it and land on the newest valid
  // Sunday. See `isSundayUtc` above — clears `loop:kpi_drift:approvals_untouched_pct:weekly`.
  const isWeeklyLatest = cadence === "weekly" && !snapshotDate;
  const { data } = await q
    .order("snapshot_date", { ascending: false })
    .limit(isWeeklyLatest ? 20 : 1);
  const rows = (data ?? []) as ScorecardSnapshotRow[];
  if (isWeeklyLatest) return rows.find((r) => isSundayUtc(r.snapshot_date)) ?? null;
  return rows[0] ?? null;
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
  const withinTolerance =
    driftPct == null
      ? snapshot.unit === "count"
        ? Math.abs(drift) <= COUNT_ZERO_SNAPSHOT_ABS_FLOOR
        : drift === 0
      : driftPct <= tolerance;
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
 * (nothing to compare to), or when the metric is a current-state point read or live-spec-set
 * dependent (see guards below). NO writes.
 *
 * **Current-state guard:** metrics flagged `MetricDef.currentState` (e.g. `lane_utilization`,
 * `loop_health`, `needs_attention`) are point reads of a CURRENTLY-OCCUPIED pool/counter — the
 * snapshotted value freezes the moment-in-time read, and a ground-truth re-run reads the pool AGAIN
 * at the moment-of-audit, so any movement in the seconds between the two reads surfaces as "drift"
 * that isn't drift. Paired with the in-flight daily window guard (`readPersistedSnapshot` above):
 * same false-positive class — comparing a frozen snapshot against a moving target — applied to a
 * different axis (point-read vs in-flight window). Repair Agent verdicts on signatures
 * `loop:kpi_drift:lane_utilization:daily`, `loop:kpi_drift:loop_health:daily`, and
 * `loop:kpi_drift:needs_attention:daily`.
 *
 * **Live-spec-set guard:** metrics flagged `MetricDef.liveSpecSetDependent` (today: only
 * `regression_coverage_pct`) derive ground truth from the LIVE brain-roadmap spec set
 * (`getRoadmap()`). The live set churns between snapshot write and audit re-read — specs fold or
 * archive on their own cadence — so the re-run sees a different population than the snapshot did and
 * the membership delta surfaces as "drift" that isn't engine drift. Same false-positive class as
 * `currentState` (frozen snapshot vs moving target) — different axis (the population definition
 * moved, not the underlying counter). `specs_per_week` USED to be flagged too; director-kpi-sdk
 * Phase 1 repointed it at the FULL spec set (via [[director-kpis]] `shippedSpecsByOwner`) so its
 * slug→owner map is folded-inclusive + stable across snapshot/audit — it's no longer flagged.
 */
export async function auditKpi(
  workspaceId: string,
  metric: string,
  cadence: Cadence,
  snapshotDate?: string,
): Promise<KpiAuditReport | null> {
  const registryEntry = getRegisteredMetrics(cadence).find((m) => m.key === metric);
  if (registryEntry?.currentState) return null;
  if (registryEntry?.liveSpecSetDependent) return null;

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
 * Test-injection seams for `auditAllKpis`. Both default to the real prod dependencies; supplying
 * either lets a unit test swap in a fake admin client / compute stub. Not part of the SDK contract
 * — callers should keep using the 3-arg form.
 */
export interface AuditAllKpisDeps {
  admin?: ReturnType<typeof createAdminClient>;
  compute?: typeof computeScorecardValuesOnly;
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
  deps: AuditAllKpisDeps = {},
): Promise<KpiAuditReport[]> {
  const admin = deps.admin ?? createAdminClient();
  const compute = deps.compute ?? computeScorecardValuesOnly;
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
  // In-flight window guard (all cadences) — see `readPersistedSnapshot` for the rationale. Every
  // cadence writes mid-day into a window ending TODAY UTC; a same-UTC-day audit re-runs the SAME
  // window math against a growing row-count and reads it as drift. Covers daily
  // (`build_enqueue_rate`), monthly (`loop:kpi_drift:deploy_reliability:monthly` — trailing 30-day
  // ratio inflated by later-in-the-day `director_activity` writes on the 1st), and weekly (same
  // shape on the Sunday write). Audit only closed windows when the caller didn't pin a date.
  else q = q.lt("snapshot_date", todayUtc());
  const { data } = await q;
  let rows = (data ?? []) as ScorecardSnapshotRow[];

  // Weekly-Sunday reader guard: discard pre-lag-fix stale non-Sunday snapshot_dates BEFORE the
  // latest-per-metric pass, so a stale Monday row can't outsort the valid Sunday row. See
  // `isSundayUtc` above — clears `loop:kpi_drift:approvals_untouched_pct:weekly`. Skipped when the
  // caller pinned an explicit `snapshotDate` (they know which window they want).
  if (cadence === "weekly" && !snapshotDate) {
    rows = rows.filter((r) => isSundayUtc(r.snapshot_date));
  }

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
    const gt = await compute(workspaceId, { cadence, snapshotDate: d });
    groundTruthByDate.set(d, gt);
  }

  const reports: KpiAuditReport[] = [];
  for (const m of registry) {
    // Current-state guard — skip point-read metrics. See `auditKpi` above for the full rationale; the
    // short version: a CURRENTLY-OCCUPIED pool/counter (lane_utilization) churns in the seconds
    // between the snapshot write and the ground-truth re-read, so the diff is moving-target noise,
    // not drift. Same false-positive class as the in-flight daily window guard (different axis).
    if (m.currentState) continue;
    // Live-spec-set guard — skip metrics whose ground truth depends on the live brain-roadmap spec
    // set (today: only regression_coverage_pct — specs_per_week moved to the folded-inclusive
    // director-kpis SDK in director-kpi-sdk Phase 1). The live set churns between snapshot write
    // and audit re-read (specs fold/archive), so the re-run sees a different population than the
    // snapshot did and the membership delta surfaces as "drift" that isn't engine drift. See
    // `auditKpi` above for the full rationale.
    if (m.liveSpecSetDependent) continue;
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
