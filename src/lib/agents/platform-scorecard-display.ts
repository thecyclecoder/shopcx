/**
 * Display config for the Platform Department Scorecard surface
 * ([[../specs/platform-scorecard-surface]] Phase 2 / Phase 3).
 *
 * The metrics engine ([[platform-scorecard]]) writes raw `(value, prior_value, delta_pct, unit)` into
 * [[../tables/platform_scorecard_snapshots]] without saying whether ↑ is good or what the human label is —
 * that's a SURFACE concern. This module is that surface config: per-metric label + polarity (which
 * direction is "good") for the scorecard page tiles, the board-watch one-liner, and any other display.
 *
 * Display-only proxy ([[../operational-rules]] § North star) — never written back as a target.
 */

export type Cadence = "daily" | "weekly" | "monthly";

/** Polarity for the trend arrow. */
export type MetricPolarity = "up_is_good" | "down_is_good";

export interface MetricDisplayDef {
  /** the metric_key in `platform_scorecard_snapshots`. */
  key: string;
  /** short human label rendered on the tile + the watch line. */
  label: string;
  /** which way is "healthy" — drives the arrow colour. */
  polarity: MetricPolarity;
  /** the cadence the metric is sourced from (one cadence per metric in the registry). */
  cadence: Cadence;
}

/**
 * The DAILY pulse — current-state KPIs + today's flow ([[platform-scorecard-engine]] registry).
 * Order = display order on the daily section of the scorecard page.
 */
export const DAILY_DISPLAY: MetricDisplayDef[] = [
  { key: "loop_health", label: "Loop health", polarity: "up_is_good", cadence: "daily" },
  { key: "error_backlog", label: "Error backlog", polarity: "down_is_good", cadence: "daily" },
  { key: "error_mttr_hours", label: "Error MTTR", polarity: "down_is_good", cadence: "daily" },
  { key: "build_throughput", label: "Builds shipped", polarity: "up_is_good", cadence: "daily" },
  { key: "lane_utilization", label: "Lane utilization", polarity: "up_is_good", cadence: "daily" },
  { key: "build_enqueue_rate", label: "Build enqueue rate", polarity: "up_is_good", cadence: "daily" },
  { key: "autonomy_ratio", label: "Autonomy", polarity: "up_is_good", cadence: "daily" },
  { key: "escalations", label: "Escalations to CEO", polarity: "down_is_good", cadence: "daily" },
  { key: "needs_attention", label: "Needs attention", polarity: "down_is_good", cadence: "daily" },
];

/** The WEEKLY throughput + quality set ([[platform-scorecard-weekly]] registry). */
export const WEEKLY_DISPLAY: MetricDisplayDef[] = [
  { key: "specs_per_week", label: "Specs shipped this week", polarity: "up_is_good", cadence: "weekly" },
  { key: "build_success_rate", label: "Builds green", polarity: "up_is_good", cadence: "weekly" },
  { key: "idea_to_merge_hours", label: "Idea → merge", polarity: "down_is_good", cadence: "weekly" },
  { key: "approvals_untouched_pct", label: "Approvals untouched", polarity: "up_is_good", cadence: "weekly" },
  { key: "worker_grade_rollup", label: "Worker grade", polarity: "up_is_good", cadence: "weekly" },
  { key: "regressions_caught", label: "Regressions caught", polarity: "up_is_good", cadence: "weekly" },
];

/** The MONTHLY leading curve ([[platform-scorecard-monthly]] registry). */
export const MONTHLY_DISPLAY: MetricDisplayDef[] = [
  { key: "human_touch_per_build", label: "Human touch / build", polarity: "down_is_good", cadence: "monthly" },
  { key: "goals_escorted_unbabysat", label: "Goals escorted unbabysat", polarity: "up_is_good", cadence: "monthly" },
  { key: "time_to_approve_hours", label: "Time to approve", polarity: "down_is_good", cadence: "monthly" },
  { key: "deploy_reliability", label: "Deploy reliability", polarity: "up_is_good", cadence: "monthly" },
  { key: "director_call_grade", label: "Director call grade", polarity: "up_is_good", cadence: "monthly" },
];

/**
 * The reserved Fleet-spend (Cost / budget) tile — cross-goal slot the [[../goals/grow-surface-platform-agent-team]]
 * cost governor's spend metric lands into. Documented here so the cost-governor build knows the slot exists; the
 * tile renders muted "no data yet" until that engine starts writing `fleet_spend_*` into the snapshot store.
 */
export const FLEET_SPEND_RESERVED: MetricDisplayDef = {
  key: "fleet_spend_daily",
  label: "Fleet spend",
  polarity: "down_is_good",
  cadence: "daily",
};

export const DISPLAY_BY_CADENCE: Record<Cadence, MetricDisplayDef[]> = {
  daily: DAILY_DISPLAY,
  weekly: WEEKLY_DISPLAY,
  monthly: MONTHLY_DISPLAY,
};

/**
 * Format a numeric snapshot value for display, per the engine's `unit`. Mirrors the engine's
 * rounding conventions — count → integer, hours → 1dp, ratio/pct → percent with 1dp.
 */
export function formatMetricValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "—";
  if (unit === "pct") return `${value.toFixed(1)}%`;
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  if (unit === "hours") return `${value.toFixed(1)}h`;
  // count + anything else
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1);
}

/**
 * Whether a delta_pct is "good" for the arrow tint — depends on polarity. Treat 0 / null as neutral.
 */
export function isHealthyDelta(deltaPct: number | null | undefined, polarity: MetricPolarity): "good" | "bad" | "neutral" {
  if (deltaPct == null || !Number.isFinite(deltaPct) || deltaPct === 0) return "neutral";
  const up = deltaPct > 0;
  if (polarity === "up_is_good") return up ? "good" : "bad";
  return up ? "bad" : "good";
}

/**
 * Compose the one-line scorecard summary for the [[../libraries/platform-director]] daily watch
 * post + the EOD recap row ([[../specs/platform-scorecard-surface]] Phase 3). Plain text, no markdown
 * — the [[../libraries/director-board]] board voice. Reads pre-fetched snapshot rows; renders only
 * the headline KPIs from each cadence so the line stays scannable.
 *
 * Example: "Scorecard: 6 specs this week · 92% builds green · autonomy 0.78 ↑ · human-touch/build 0.4 ↓"
 *
 * Returns null when not a single headline KPI has a value — keeps the watch line tidy on a
 * pre-snapshot day (no fabricated numbers; the same "no data yet" invariant the page enforces).
 */
export interface ScorecardSnapshotLite {
  metric_key: string;
  value: number;
  delta_pct: number | null;
  unit: string;
}

const HEADLINE_KEYS: Array<{ key: string; cadence: Cadence; label: string }> = [
  { key: "specs_per_week", cadence: "weekly", label: "specs this week" },
  { key: "build_success_rate", cadence: "weekly", label: "builds green" },
  { key: "autonomy_ratio", cadence: "daily", label: "autonomy" },
  { key: "human_touch_per_build", cadence: "monthly", label: "human-touch/build" },
];

function trendArrow(deltaPct: number | null | undefined): string {
  if (deltaPct == null || !Number.isFinite(deltaPct) || deltaPct === 0) return "";
  return deltaPct > 0 ? "↑" : "↓";
}

function formatHeadlineValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "—";
  if (unit === "pct") return `${value.toFixed(0)}%`;
  if (unit === "ratio") return `${(value * 100).toFixed(0)}%`;
  if (unit === "hours") return `${value.toFixed(1)}h`;
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(2);
}

export function composeScorecardWatchLine(byCadence: Record<Cadence, ScorecardSnapshotLite[]>): string | null {
  const byKey = new Map<string, ScorecardSnapshotLite>();
  for (const cadence of ["daily", "weekly", "monthly"] as Cadence[]) {
    for (const row of byCadence[cadence] ?? []) {
      byKey.set(`${cadence}::${row.metric_key}`, row);
    }
  }
  const parts: string[] = [];
  for (const h of HEADLINE_KEYS) {
    const row = byKey.get(`${h.cadence}::${h.key}`);
    if (!row) continue;
    const arrow = trendArrow(row.delta_pct);
    const value = formatHeadlineValue(row.value, row.unit);
    parts.push(`${h.label === "specs this week" ? `${value} ${h.label}` : `${h.label} ${value}`}${arrow ? ` ${arrow}` : ""}`);
  }
  if (!parts.length) return null;
  return `Scorecard: ${parts.join(" · ")}`;
}
