/**
 * Platform scorecard engine — the department-level KPI aggregation substrate
 * (platform-scorecard-engine spec, Phases 1–2; milestone (a) Daily pulse of the
 * platform-department-scorecard goal).
 *
 * The shared roll-up behind the whole Platform Department Scorecard. director-xp + director-recap
 * compute only PER-DIRECTOR gamification/EOD counts, and meta/scorecards is the AD domain; nothing
 * rolls the platform's own truth up to a department KPI that TRENDS over time. This engine computes
 * each KPI over a TRAILING window with a PRIOR equal-length window delta (mirroring the meta
 * scorecards window model), and UPSERTS every value into platform_scorecard_snapshots so a daily /
 * weekly / monthly tile can chart the curve — the CEO sees loop health, error backlog + MTTR, build
 * throughput, lane utilization + enqueue rate (the build-pool saturation KPIs,
 * director-initiation-throughput Phase 4), autonomy ratio, and escalations with zero hand-counting.
 *
 * Server-only (createAdminClient + brain-roadmap fs reads, like director-xp / director-recap).
 *
 * North-star invariant (operational-rules § North star): every KPI is DERIVED + READ-ONLY — computed
 * from existing tables, persisted for trend, NEVER written back as a target the directors/workers
 * optimize. This engine is the ONLY writer of platform_scorecard_snapshots; downstream readers read
 * the snapshot table, never the raw source tables ("read metrics from the scorecard").
 *
 * MTTR invariant: error_events.status is reserved/unmaintained and has no resolved_at — MTTR is
 * DERIVED by correlating each error signature to the repair job that resolved it, never read from a
 * status column.
 *
 * See docs/brain/libraries/platform-scorecard.md · docs/brain/tables/platform_scorecard_snapshots.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { reportDbError } from "@/lib/control-tower/error-feed";
import { MONITORED_LOOPS } from "@/lib/control-tower/registry";
import { getFunctions, getGoals, getRoadmap } from "@/lib/brain-roadmap";
import { BUILD_POOL_CAPACITY } from "@/lib/agents/platform-director";
import { computeAgentRollup, GRADEABLE_KINDS } from "@/lib/agents/agent-grader";

type Admin = ReturnType<typeof createAdminClient>;

export type Cadence = "daily" | "weekly" | "monthly";
/**
 * Render unit for `value` — drives the display-side formatter in [[platform-scorecard-display]].
 * `'grade'` is the 1–10 scale shared by worker + director rollups
 * ([[../specs/devops-kpi-review-sdk-and-data-fix]] Phase 2 — was previously stamped `'ratio'`, which
 * rendered an 8.5/10 grade as "850%").
 */
export type MetricUnit = "count" | "ratio" | "hours" | "pct" | "grade";

/** The org-chart function this scorecard belongs to — only platform-attributed rows are counted for
 *  the function-scoped metrics (escalations). Mirrors director-xp's "attribute to a real slug" guard. */
const PLATFORM_FUNCTION = "platform";

/** Repair-job statuses that mean the diagnose-and-surface work CONCLUDED — its terminal time is the
 *  resolution timestamp for MTTR. A repair opens no PR, so it concludes at completed/surfaced/failed. */
const CONCLUDED_REPAIR_STATUSES = new Set([
  "completed",
  "needs_approval",
  "needs_attention",
  "failed",
  "merged",
]);

/** One persisted snapshot row — the engine's return + upsert shape. */
export interface ScorecardSnapshotRow {
  workspace_id: string;
  metric_key: string;
  cadence: Cadence;
  snapshot_date: string;
  window_days: number;
  value: number;
  prior_value: number | null;
  delta_pct: number | null;
  unit: MetricUnit;
  detail: Record<string, unknown>;
  updated_at: string;
}

export interface ComputeOptions {
  cadence: Cadence;
  /** as-of day (UTC YYYY-MM-DD); defaults to today. The trailing window ends here. */
  snapshotDate?: string;
  /** trailing-window length in days; defaults to the cadence default (daily=1). */
  windowDays?: number;
}

// ── date helpers (mirror meta/scorecards window model) ───────────────────────────
const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const dayMinus = (base: string, n: number) =>
  dayStr(new Date(new Date(`${base}T00:00:00Z`).getTime() - n * 86_400_000));
const startIso = (day: string) => `${day}T00:00:00.000Z`;
const endIso = (day: string) => `${day}T23:59:59.999Z`;

const round = (n: number, p = 4): number => (Number.isFinite(n) ? Number(n.toFixed(p)) : 0);
/** (curr − prior) / prior — null when there's no positive prior to divide by (mirrors meta scorecards). */
const pctDelta = (curr: number, prior: number | null): number | null =>
  prior != null && prior > 0 ? round((curr - prior) / prior) : null;

/** Median of a numeric list (0 for an empty list). */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile (p ∈ [0,1]) of a numeric list (0 for an empty list). */
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}

/** Arithmetic mean of a numeric list (null for an empty list). */
function meanOf(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// ── per-metric context + registry ────────────────────────────────────────────────
interface MetricWindow {
  curr: { start: string; end: string; startIso: string; endIso: string };
  prev: { start: string; end: string; startIso: string; endIso: string };
}

interface MetricContext extends MetricWindow {
  admin: Admin;
  workspaceId: string;
  cadence: Cadence;
  snapshotDate: string;
  windowDays: number;
  /** real functions/*.md slugs — the "ignore a stray function" guard (director-xp pattern). */
  knownFunctions: Set<string>;
  /** the prior stored snapshot value for a current-state metric (snapshot_date − windowDays). */
  getPriorSnapshot: (metricKey: string) => Promise<number | null>;
}

interface MetricResult {
  value: number;
  priorValue: number | null;
  detail: Record<string, unknown>;
}

interface MetricDef {
  key: string;
  unit: MetricUnit;
  compute: (ctx: MetricContext) => Promise<MetricResult>;
  /**
   * Marks a CURRENT-STATE point-read metric: the value is "right now" (snapshot of a churning pool /
   * counter), not a windowed aggregate. [[kpi-review]] `auditAllKpis` / `auditKpi` skip these — the
   * snapshotted value freezes the moment-in-time read, and a later ground-truth re-run reads the pool
   * AGAIN at the moment-of-audit, so any movement in the seconds/minutes between the two reads
   * surfaces as "drift" that isn't drift (Repair Agent verdict on signature
   * `loop:kpi_drift:lane_utilization:daily`).
   */
  currentState?: true;
  /**
   * Marks a metric whose ground truth depends on the LIVE brain-roadmap spec set (via
   * `getRoadmap()` — `specs_per_week` uses it for the live spec→owner map; `regression_coverage_pct`
   * uses it for the live shipped-spec denominator). [[kpi-review]] `auditAllKpis` / `auditKpi` skip
   * these — the live set changes between snapshot write and audit re-read (specs fold/archive on
   * their own cadence), so the re-run sees a different population than the snapshot did and surfaces
   * the membership delta as "drift" that isn't engine drift. Same false-positive class as
   * `currentState` (comparing a frozen snapshot against a moving target) — different axis (the
   * population definition moved, not the underlying counter). Repair Agent verdict on signature
   * `loop:kpi_drift:specs_per_week:weekly`.
   */
  liveSpecSetDependent?: true;
}

// ── Daily pulse metric derivations (all from existing truth) ─────────────────────

/**
 * loop_health — share of monitored loops green. A loop is green when it has NO open loop_alert AND
 * (for a cron) a heartbeat within its livenessWindowMs. Worker / agent-kind / reactive / inline-agent
 * loops are idle-green (the Control Tower monitor opens an alert if one genuinely dies), so they're
 * judged on the open-alert signal alone. Current-state metric (`currentState: true` — point read of the
 * NOW state of `loop_alerts` + latest heartbeat per loop, not a windowed aggregate): prior comes from
 * the prior stored snapshot, and [[kpi-review]] `auditAllKpis` / `auditKpi` SKIP it — between the
 * snapshot write and the ground-truth re-read, a heartbeat lands or an alert opens/closes and the diff
 * surfaces as moving-target noise, not engine drift. Repair Agent verdict on signature
 * `loop:kpi_drift:loop_health:daily` (same false-positive class as `lane_utilization`).
 */
const loopHealth: MetricDef = {
  key: "loop_health",
  unit: "ratio",
  currentState: true,
  compute: async (ctx) => {
    const { admin } = ctx;
    const now = Date.now();

    // Latest beat per cron/agent loop_id via the bounded RPC (rides the (loop_id, ran_at desc) index).
    const { data: beats } = await admin.rpc("control_tower_loop_beats", { p_history_limit: 1 });
    const latestBeat = new Map<string, number>();
    for (const b of (beats ?? []) as Array<{ loop_id: string; ran_at: string; rn: number }>) {
      if (b.rn === 1 && !latestBeat.has(b.loop_id)) latestBeat.set(b.loop_id, new Date(b.ran_at).getTime());
    }

    const { data: alerts } = await admin.from("loop_alerts").select("loop_id").eq("status", "open");
    const openAlerts = new Set(((alerts ?? []) as Array<{ loop_id: string }>).map((a) => a.loop_id));

    const unhealthy: Array<{ id: string; label: string; kind: string; reason: string }> = [];
    let green = 0;
    for (const loop of MONITORED_LOOPS) {
      const hasOpenAlert = openAlerts.has(loop.id);
      let stale = false;
      if (loop.kind === "cron" && loop.livenessWindowMs) {
        const last = latestBeat.get(loop.id);
        stale = last == null || now - last > loop.livenessWindowMs;
      }
      if (!hasOpenAlert && !stale) {
        green++;
      } else {
        unhealthy.push({
          id: loop.id,
          label: loop.label,
          kind: loop.kind,
          reason: hasOpenAlert ? "open_alert" : "stale_heartbeat",
        });
      }
    }
    const total = MONITORED_LOOPS.length;
    const value = total > 0 ? round(green / total) : 1;
    const priorValue = await ctx.getPriorSnapshot("loop_health");
    return { value, priorValue, detail: { total, green, unhealthy } };
  },
};

/**
 * error_backlog — count of recent error_events incidents, excluding outage_correlated symptoms. Global
 * infra table (no workspace_id). Windowed by last_seen_at so a real prior-window delta exists; the
 * recency colouring (last 1h / 24h) buildErrorFeedSnapshot uses is surfaced in detail.
 */
const errorBacklog: MetricDef = {
  key: "error_backlog",
  unit: "count",
  compute: async (ctx) => {
    const { admin, curr, prev } = ctx;
    const now = Date.now();
    const { count: value } = await admin
      .from("error_events")
      .select("id", { count: "exact", head: true })
      .eq("outage_correlated", false)
      .gte("last_seen_at", curr.startIso)
      .lte("last_seen_at", curr.endIso);
    const { count: prior } = await admin
      .from("error_events")
      .select("id", { count: "exact", head: true })
      .eq("outage_correlated", false)
      .gte("last_seen_at", prev.startIso)
      .lte("last_seen_at", prev.endIso);

    // Recency colouring breakdown (display) — the active feed within the curr window by source + age.
    const { data: rows } = await admin
      .from("error_events")
      .select("source, last_seen_at")
      .eq("outage_correlated", false)
      .gte("last_seen_at", curr.startIso)
      .lte("last_seen_at", curr.endIso);
    const bySource: Record<string, number> = {};
    let last1h = 0;
    let last24h = 0;
    for (const r of (rows ?? []) as Array<{ source: string; last_seen_at: string }>) {
      bySource[r.source] = (bySource[r.source] ?? 0) + 1;
      const age = now - new Date(r.last_seen_at).getTime();
      if (age <= 3_600_000) last1h++;
      if (age <= 86_400_000) last24h++;
    }
    return {
      value: value ?? 0,
      priorValue: prior ?? null,
      detail: { window: value ?? 0, last_1h: last1h, last_24h: last24h, by_source: bySource },
    };
  },
};

/**
 * error_mttr_hours — median over the window of (resolution_ts − first_seen_at), DERIVED by correlating
 * each error signature → an agent_jobs repair (kind 'repair'/'regression', spec_slug = signature) and
 * taking its CONCLUDED terminal time as resolution_ts. error_events.status is reserved/unmaintained, so
 * MTTR is NEVER read from a status column. Errors with no concluded correlated repair are excluded and
 * surfaced in detail as still-open.
 */
const errorMttrHours: MetricDef = {
  key: "error_mttr_hours",
  unit: "hours",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;

    // Repair/regression jobs for the workspace, keyed by the signature they resolve (spec_slug). The
    // repair dedupe key is the error signature; regression spec_slug is regression:{slug}:{hash}, so it
    // only matches as the documented (rare) fallback.
    const { data: repairs } = await admin
      .from("agent_jobs")
      .select("kind, spec_slug, status, updated_at")
      .eq("workspace_id", workspaceId)
      .in("kind", ["repair", "regression"]);
    const concludedBySignature = new Map<string, number>();
    for (const j of (repairs ?? []) as Array<{ kind: string; spec_slug: string | null; status: string; updated_at: string }>) {
      if (!j.spec_slug || !CONCLUDED_REPAIR_STATUSES.has(j.status)) continue;
      const ts = new Date(j.updated_at).getTime();
      // earliest conclusion wins (the repair that first resolved this signature).
      const prevTs = concludedBySignature.get(j.spec_slug);
      if (prevTs == null || ts < prevTs) concludedBySignature.set(j.spec_slug, ts);
    }

    const mttrFor = async (w: MetricWindow["curr"]): Promise<{ hours: number; resolved: number; open: string[] }> => {
      const { data: errors } = await admin
        .from("error_events")
        .select("signature, first_seen_at")
        .eq("outage_correlated", false)
        .gte("first_seen_at", w.startIso)
        .lte("first_seen_at", w.endIso);
      const durationsHrs: number[] = [];
      const open: string[] = [];
      for (const e of (errors ?? []) as Array<{ signature: string; first_seen_at: string }>) {
        const resolvedAt = concludedBySignature.get(e.signature);
        const firstSeen = new Date(e.first_seen_at).getTime();
        if (resolvedAt != null && resolvedAt > firstSeen) {
          durationsHrs.push((resolvedAt - firstSeen) / 3_600_000);
        } else {
          open.push(e.signature);
        }
      }
      return { hours: round(median(durationsHrs), 2), resolved: durationsHrs.length, open };
    };

    const cur = await mttrFor(curr);
    const pri = await mttrFor(prev);
    return {
      value: cur.hours,
      priorValue: pri.resolved > 0 ? pri.hours : null,
      detail: { resolved_count: cur.resolved, open_count: cur.open.length, still_open: cur.open.slice(0, 20) },
    };
  },
};

/**
 * build_throughput — merged feature builds in the window: agent_jobs kind='build' status='merged' with
 * updated_at (the merge flip) in-window. The exact rule director-recap uses for specsShipped.
 */
const buildThroughput: MetricDef = {
  key: "build_throughput",
  unit: "count",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const countMerged = async (w: MetricWindow["curr"]): Promise<number> => {
      const { count } = await admin
        .from("agent_jobs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("kind", "build")
        .eq("status", "merged")
        .gte("updated_at", w.startIso)
        .lte("updated_at", w.endIso);
      return count ?? 0;
    };
    const value = await countMerged(curr);
    const prior = await countMerged(prev);
    return { value, priorValue: prior, detail: { merged_in_window: value } };
  },
};

/**
 * lane_utilization — how saturated the build pool is RIGHT NOW: build/plan jobs OCCUPYING a lane
 * (claimed / building / awaiting input/approval / queued_resume — a plain `queued` job is backlog
 * WAITING for a lane, not occupying one) ÷ {@link BUILD_POOL_CAPACITY} lanes. The visible KPI for the
 * saturation goal (director-initiation-throughput Phase 4): the curve should trend toward full. A
 * current-state metric — prior comes from the prior snapshot. Capped at 1 (a transient claimed+queued
 * overlap can't read as >100%).
 */
const OCCUPYING_LANE_STATUSES = ["claimed", "building", "needs_input", "needs_approval", "queued_resume"];
const laneUtilization: MetricDef = {
  key: "lane_utilization",
  unit: "ratio",
  currentState: true,
  compute: async (ctx) => {
    const { admin, workspaceId } = ctx;
    const { count } = await admin
      .from("agent_jobs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .in("kind", ["build", "plan"])
      .in("status", OCCUPYING_LANE_STATUSES);
    const busy = count ?? 0;
    const value = BUILD_POOL_CAPACITY > 0 ? round(Math.min(1, busy / BUILD_POOL_CAPACITY)) : 0;
    const priorValue = await ctx.getPriorSnapshot("lane_utilization");
    return { value, priorValue, detail: { busy, capacity: BUILD_POOL_CAPACITY } };
  },
};

/**
 * build_enqueue_rate — builds the director FED INTO the pool in the window: agent_jobs kind='build'
 * created_at in-window (the enqueue, vs build_throughput's merge). The saturation feed-rate KPI
 * (director-initiation-throughput Phase 4) — paired with lane_utilization it shows whether the pool is
 * being kept topped up. Windowed count metric with the prior equal-length window as the delta.
 */
const buildEnqueueRate: MetricDef = {
  key: "build_enqueue_rate",
  unit: "count",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const countEnqueued = async (w: MetricWindow["curr"]): Promise<number> => {
      const { count } = await admin
        .from("agent_jobs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("kind", "build")
        .gte("created_at", w.startIso)
        .lte("created_at", w.endIso);
      return count ?? 0;
    };
    const value = await countEnqueued(curr);
    const prior = await countEnqueued(prev);
    return { value, priorValue: prior, detail: { enqueued_in_window: value } };
  },
};

/**
 * autonomy_ratio — share of terminal approval decisions that were autonomous director auto-approvals:
 * approval_decisions autonomous=true ÷ all terminal decisions (decision ∈ approved|declined) in-window.
 * Escalated decisions (routed up, not decided here) are excluded from the denominator.
 */
const autonomyRatio: MetricDef = {
  key: "autonomy_ratio",
  unit: "ratio",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const ratioFor = async (w: MetricWindow["curr"]): Promise<{ ratio: number; autonomous: number; terminal: number; approved: number; declined: number }> => {
      const { data } = await admin
        .from("approval_decisions")
        .select("decision, autonomous")
        .eq("workspace_id", workspaceId)
        .in("decision", ["approved", "declined"])
        .gte("created_at", w.startIso)
        .lte("created_at", w.endIso);
      const rows = (data ?? []) as Array<{ decision: string; autonomous: boolean }>;
      const terminal = rows.length;
      const autonomous = rows.filter((r) => r.autonomous === true).length;
      const approved = rows.filter((r) => r.decision === "approved").length;
      const declined = rows.filter((r) => r.decision === "declined").length;
      return { ratio: terminal > 0 ? round(autonomous / terminal) : 0, autonomous, terminal, approved, declined };
    };
    const cur = await ratioFor(curr);
    const pri = await ratioFor(prev);
    return {
      value: cur.ratio,
      priorValue: pri.terminal > 0 ? pri.ratio : null,
      detail: { autonomous: cur.autonomous, terminal: cur.terminal, approved: cur.approved, declined: cur.declined },
    };
  },
};

/**
 * escalations — escalations the PLATFORM function raised to the CEO in-window: approval_decisions
 * decision='escalated' with raised_by_function='platform', PLUS director_activity action_kind='escalated'
 * with director_function='platform'. Only the real platform slug is counted (a stray/unknown function is
 * ignored — director-xp's guard).
 */
const escalations: MetricDef = {
  key: "escalations",
  unit: "count",
  compute: async (ctx) => {
    const { admin, workspaceId, knownFunctions, curr, prev } = ctx;
    // Guard: only attribute to a real function slug (here, the platform department).
    if (!knownFunctions.has(PLATFORM_FUNCTION)) {
      return { value: 0, priorValue: null, detail: { from_approvals: 0, from_activity: 0, note: "platform slug not found" } };
    }
    const countFor = async (w: MetricWindow["curr"]): Promise<{ total: number; fromApprovals: number; fromActivity: number }> => {
      const [{ count: fromApprovals }, { count: fromActivity }] = await Promise.all([
        admin
          .from("approval_decisions")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .eq("decision", "escalated")
          .eq("raised_by_function", PLATFORM_FUNCTION)
          .gte("created_at", w.startIso)
          .lte("created_at", w.endIso),
        admin
          .from("director_activity")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .eq("action_kind", "escalated")
          .eq("director_function", PLATFORM_FUNCTION)
          .gte("created_at", w.startIso)
          .lte("created_at", w.endIso),
      ]);
      return { total: (fromApprovals ?? 0) + (fromActivity ?? 0), fromApprovals: fromApprovals ?? 0, fromActivity: fromActivity ?? 0 };
    };
    const cur = await countFor(curr);
    const pri = await countFor(prev);
    return {
      value: cur.total,
      priorValue: pri.total,
      detail: { from_approvals: cur.fromApprovals, from_activity: cur.fromActivity },
    };
  },
};

/**
 * regressions — the day's regression flow split D detected · F fixed · R reconciled from backlog · E
 * escalated, all from existing director_activity rows (regression-backlog-reconciliation-scorecard Phase 1).
 * The headline `value` is the sum so the tile/sparkline track regression activity; `detail` carries each
 * leg so the board-watch line + tile sub-text can render the breakdown without a second read. Counts only
 * platform-attributed rows (the regression worker / Platform director own this surface), mirroring the
 * escalations metric's "real-slug guard". Escalated rows are filtered to regression context (signature
 * starts with `regression:`, or metadata.kind/escalation_kind names regression / loop_guard) so a
 * stranded loop-guard escalation reads as a regression escalation rather than a generic escalated row.
 */
const REGRESSION_ACTION_KINDS = ["detected_regression", "authored_fix", "reconciled_regression", "escalated"];
const regressions: MetricDef = {
  key: "regressions",
  unit: "count",
  compute: async (ctx) => {
    const { admin, workspaceId, knownFunctions, curr, prev } = ctx;
    if (!knownFunctions.has(PLATFORM_FUNCTION)) {
      return {
        value: 0,
        priorValue: null,
        detail: { detected: 0, fixed: 0, reconciled: 0, escalated: 0, note: "platform slug not found" },
      };
    }
    const countsFor = async (w: MetricWindow["curr"]): Promise<{
      total: number;
      detected: number;
      fixed: number;
      reconciled: number;
      escalated: number;
    }> => {
      const { data } = await admin
        .from("director_activity")
        .select("action_kind, metadata")
        .eq("workspace_id", workspaceId)
        .eq("director_function", PLATFORM_FUNCTION)
        .in("action_kind", REGRESSION_ACTION_KINDS)
        .gte("created_at", w.startIso)
        .lte("created_at", w.endIso);
      let detected = 0;
      let fixed = 0;
      let reconciled = 0;
      let escalated = 0;
      for (const r of (data ?? []) as Array<{ action_kind: string; metadata: Record<string, unknown> | null }>) {
        if (r.action_kind === "detected_regression") detected++;
        else if (r.action_kind === "authored_fix") fixed++;
        else if (r.action_kind === "reconciled_regression") reconciled++;
        else if (r.action_kind === "escalated") {
          // Filter the open `escalated` vocabulary to a regression context: the regression-agent loop-guard
          // (metadata.signature starts `regression:`) and the standing pass's stuck-fix escalation
          // (metadata.kind='regression' / escalation_kind='loop_guard'). Other escalations belong elsewhere.
          const m = r.metadata ?? {};
          const sig = typeof m["signature"] === "string" ? (m["signature"] as string) : "";
          const kind = typeof m["kind"] === "string" ? (m["kind"] as string) : "";
          const escalationKind = typeof m["escalation_kind"] === "string" ? (m["escalation_kind"] as string) : "";
          if (sig.startsWith("regression:") || kind === "regression" || escalationKind === "loop_guard") escalated++;
        }
      }
      return { total: detected + fixed + reconciled + escalated, detected, fixed, reconciled, escalated };
    };
    const cur = await countsFor(curr);
    const pri = await countsFor(prev);
    return {
      value: cur.total,
      priorValue: pri.total,
      detail: { detected: cur.detected, fixed: cur.fixed, reconciled: cur.reconciled, escalated: cur.escalated },
    };
  },
};

/**
 * needs_attention — open parked work the director triages (needs-attention-triage-and-verdict-robustness
 * Phase 3): agent_jobs in status='needs_attention' EXCLUDING the kinds another lane already owns (build →
 * the build loop-guard; repair → the repair-dismissal lane). The count is the headline value; detail carries
 * the OLDEST open item's age in hours + a by-kind breakdown, so a rotting parked item is a tracked, trending
 * KPI (not just a transient board line). Current-state metric (`currentState: true` — point read of the NOW
 * state of `agent_jobs` in `needs_attention`, not a windowed aggregate): prior comes from the prior stored
 * snapshot, and [[kpi-review]] `auditAllKpis` / `auditKpi` SKIP it — between the snapshot write and the
 * ground-truth re-read, a parked item routes/resolves or a new park lands, and the diff surfaces as
 * moving-target noise, not engine drift. Repair Agent verdict on signature
 * `loop:kpi_drift:needs_attention:daily` (same false-positive class as `lane_utilization` / `loop_health`).
 */
const TRIAGED_NA_SKIP_KINDS = new Set(["build", "repair", "platform-director"]);
const needsAttention: MetricDef = {
  key: "needs_attention",
  unit: "count",
  currentState: true,
  compute: async (ctx) => {
    const { admin, workspaceId } = ctx;
    const now = Date.now();
    const { data } = await admin
      .from("agent_jobs")
      .select("kind, created_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "needs_attention")
      .order("created_at", { ascending: true })
      .limit(500);
    const parked = ((data ?? []) as Array<{ kind: string; created_at: string }>).filter((j) => !TRIAGED_NA_SKIP_KINDS.has(String(j.kind)));
    const byKind: Record<string, number> = {};
    for (const j of parked) byKind[j.kind] = (byKind[j.kind] ?? 0) + 1;
    const oldestHours = parked.length ? round(Math.max(0, (now - new Date(parked[0].created_at).getTime()) / 3_600_000), 2) : 0;
    const priorValue = await ctx.getPriorSnapshot("needs_attention");
    return { value: parked.length, priorValue, detail: { open: parked.length, oldest_hours: oldestHours, by_kind: byKind } };
  },
};

// ── Weekly throughput + quality metric derivations (platform-scorecard-weekly spec) ──────────────
// The weekly lens: how much the build org shipped this week and how good it was. Each metric reuses
// the engine's trailing-7-day window + prior-week delta + idempotent upsert; only the derivation is
// new. All from existing truth — never written back as a target (North-star, display-only proxy).

/**
 * specs_per_week — merged feature builds OWNED BY PLATFORM in the window: agent_jobs kind='build'
 * status='merged' with updated_at (the merge flip) in-window, spec_slug mapped to its owner function
 * via the live spec→owner map (brain-roadmap getRoadmap().specs[].owner — the exact rule director-xp
 * uses for specsShipped). Only builds whose spec is platform-owned are counted.
 */
const specsPerWeek: MetricDef = {
  key: "specs_per_week",
  unit: "count",
  liveSpecSetDependent: true,
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    // Live spec slug → owner function (live specs only — a folded spec leaves specs/; display proxy).
    const { specs } = await getRoadmap();
    const ownerBySpec = new Map<string, string>();
    for (const s of specs) if (s.owner) ownerBySpec.set(s.slug, s.owner);

    const countPlatformMerged = async (w: MetricWindow["curr"]): Promise<{ n: number; slugs: string[] }> => {
      const { data } = await admin
        .from("agent_jobs")
        .select("spec_slug")
        .eq("workspace_id", workspaceId)
        .eq("kind", "build")
        .eq("status", "merged")
        .gte("updated_at", w.startIso)
        .lte("updated_at", w.endIso);
      const slugs: string[] = [];
      for (const r of (data ?? []) as Array<{ spec_slug: string | null }>) {
        const owner = r.spec_slug ? ownerBySpec.get(r.spec_slug) : undefined;
        if (owner === PLATFORM_FUNCTION && r.spec_slug) slugs.push(r.spec_slug);
      }
      return { n: slugs.length, slugs };
    };
    const cur = await countPlatformMerged(curr);
    const pri = await countPlatformMerged(prev);
    return { value: cur.n, priorValue: pri.n, detail: { merged_platform: cur.n, slugs: cur.slugs.slice(0, 50) } };
  },
};

/**
 * build_success_rate — merged ÷ (merged + failed) over the window: agent_jobs kind='build' with a
 * terminal flip (updated_at) in-window, where success = status='merged' and failure = status ∈
 * failed｜needs_attention (a pushed-but-broken PR). detail carries the raw counts. prior = the same
 * rate over the prior equal-length week (null when the prior week had no terminal builds).
 */
const FAILED_BUILD_STATUSES = ["failed", "needs_attention"];
const buildSuccessRate: MetricDef = {
  key: "build_success_rate",
  unit: "ratio",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const rateFor = async (w: MetricWindow["curr"]): Promise<{ rate: number; merged: number; failed: number; total: number }> => {
      const countStatuses = async (statuses: string[]): Promise<number> => {
        const { count } = await admin
          .from("agent_jobs")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .eq("kind", "build")
          .in("status", statuses)
          .gte("updated_at", w.startIso)
          .lte("updated_at", w.endIso);
        return count ?? 0;
      };
      const merged = await countStatuses(["merged"]);
      const failed = await countStatuses(FAILED_BUILD_STATUSES);
      const total = merged + failed;
      return { rate: total > 0 ? round(merged / total) : 0, merged, failed, total };
    };
    const cur = await rateFor(curr);
    const pri = await rateFor(prev);
    return {
      value: cur.rate,
      priorValue: pri.total > 0 ? pri.rate : null,
      detail: { merged: cur.merged, failed: cur.failed, total: cur.total },
    };
  },
};

/**
 * idea_to_merge_hours — median over merged builds in the window of (updated_at − created_at): the
 * queued→merged "idea→merged-PR" north-star cycle time from the platform function. value = p50;
 * detail carries p50/p90 + the sample count. prior = the prior week's median (null when none merged).
 */
const ideaToMergeHours: MetricDef = {
  key: "idea_to_merge_hours",
  unit: "hours",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const hoursFor = async (w: MetricWindow["curr"]): Promise<number[]> => {
      const { data } = await admin
        .from("agent_jobs")
        .select("created_at, updated_at")
        .eq("workspace_id", workspaceId)
        .eq("kind", "build")
        .eq("status", "merged")
        .gte("updated_at", w.startIso)
        .lte("updated_at", w.endIso);
      const hrs: number[] = [];
      for (const r of (data ?? []) as Array<{ created_at: string; updated_at: string }>) {
        const dt = (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 3_600_000;
        if (Number.isFinite(dt) && dt >= 0) hrs.push(dt);
      }
      return hrs;
    };
    const cur = await hoursFor(curr);
    const pri = await hoursFor(prev);
    const p50 = round(median(cur), 2);
    const p90 = round(percentile(cur, 0.9), 2);
    return {
      value: p50,
      priorValue: pri.length ? round(median(pri), 2) : null,
      detail: { p50, p90, merged_count: cur.length },
    };
  },
};

/**
 * approvals_untouched_pct — share of terminal platform approvals the CEO NEVER had to touch:
 * approval_decisions autonomous=true ÷ all terminal decisions (decision ∈ approved｜declined) in the
 * window, as a percentage. A `decided_by ∈ ceo｜human` decision is a TOUCHED approval (surfaced in
 * detail). Escalated decisions (routed up, not decided here) are excluded from the denominator.
 */
const approvalsUntouchedPct: MetricDef = {
  key: "approvals_untouched_pct",
  unit: "pct",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const pctFor = async (w: MetricWindow["curr"]): Promise<{ pct: number; untouched: number; touched: number; terminal: number }> => {
      const { data } = await admin
        .from("approval_decisions")
        .select("decided_by, autonomous")
        .eq("workspace_id", workspaceId)
        .in("decision", ["approved", "declined"])
        .gte("created_at", w.startIso)
        .lte("created_at", w.endIso);
      const rows = (data ?? []) as Array<{ decided_by: string; autonomous: boolean }>;
      const terminal = rows.length;
      const untouched = rows.filter((r) => r.autonomous === true).length;
      const touched = rows.filter((r) => r.decided_by === "ceo" || r.decided_by === "human").length;
      return { pct: terminal > 0 ? round((untouched / terminal) * 100, 2) : 0, untouched, touched, terminal };
    };
    const cur = await pctFor(curr);
    const pri = await pctFor(prev);
    return {
      value: cur.pct,
      priorValue: pri.terminal > 0 ? pri.pct : null,
      detail: { untouched: cur.untouched, touched: cur.touched, terminal: cur.terminal },
    };
  },
};

/**
 * worker_grade_rollup — the fleet's standing quality: per agent_kind average from agent_action_grades
 * via agent-grader computeAgentRollup (the same last-ROLLUP_WINDOW rollup the coaching loop reads — NOT
 * a second source of truth). value = the fleet mean (mean of the per-worker averages); detail carries
 * the per-worker breakdown (average + prior + drop + count) so a slipping worker is visible. prior =
 * the mean of the per-worker prior-window averages, so the fleet trend has a delta.
 */
const workerGradeRollup: MetricDef = {
  key: "worker_grade_rollup",
  unit: "grade",
  compute: async (ctx) => {
    const { admin, workspaceId } = ctx;
    const byWorker: Record<string, { average: number | null; prior: number | null; drop: number | null; count: number }> = {};
    const means: number[] = [];
    const priors: number[] = [];
    for (const kind of GRADEABLE_KINDS) {
      const roll = await computeAgentRollup(admin, workspaceId, kind);
      if (roll.count === 0 && roll.average == null) continue; // never graded — omit from the breakdown
      byWorker[kind] = { average: roll.average, prior: roll.priorAverage, drop: roll.drop, count: roll.count };
      if (roll.average != null) means.push(roll.average);
      if (roll.priorAverage != null) priors.push(roll.priorAverage);
    }
    const fleetMean = round(meanOf(means) ?? 0, 2);
    const fleetPrior = priors.length ? round(meanOf(priors) ?? 0, 2) : null;
    return {
      value: fleetMean,
      priorValue: fleetPrior,
      detail: { fleet_mean: fleetMean, graded_kinds: Object.keys(byWorker).length, by_worker: byWorker },
    };
  },
};

/**
 * regressions_caught — regression work concluded in the window: agent_jobs kind='regression' that
 * reached a concluded terminal status with updated_at in-window, PLUS director_activity rows the
 * Regression Agent emits (action_kind ∈ detected_regression｜authored_fix — the "caught" vocabulary).
 * detail splits detected vs dismissed vs fix-authored (dismissed_regression is tracked but not counted
 * toward the headline, since a dismissal is a non-regression).
 */
const regressionsCaught: MetricDef = {
  key: "regressions_caught",
  unit: "count",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const countFor = async (w: MetricWindow["curr"]): Promise<{ caught: number; jobsConcluded: number; detected: number; dismissed: number; fixAuthored: number }> => {
      const { data: jobs } = await admin
        .from("agent_jobs")
        .select("status")
        .eq("workspace_id", workspaceId)
        .eq("kind", "regression")
        .gte("updated_at", w.startIso)
        .lte("updated_at", w.endIso);
      const jobsConcluded = ((jobs ?? []) as Array<{ status: string }>).filter((j) => CONCLUDED_REPAIR_STATUSES.has(j.status)).length;

      const { data: acts } = await admin
        .from("director_activity")
        .select("action_kind")
        .eq("workspace_id", workspaceId)
        .in("action_kind", ["detected_regression", "dismissed_regression", "authored_fix"])
        .gte("created_at", w.startIso)
        .lte("created_at", w.endIso);
      let detected = 0;
      let dismissed = 0;
      let fixAuthored = 0;
      for (const a of (acts ?? []) as Array<{ action_kind: string }>) {
        if (a.action_kind === "detected_regression") detected++;
        else if (a.action_kind === "dismissed_regression") dismissed++;
        else if (a.action_kind === "authored_fix") fixAuthored++;
      }
      return { caught: jobsConcluded + detected + fixAuthored, jobsConcluded, detected, dismissed, fixAuthored };
    };
    const cur = await countFor(curr);
    const pri = await countFor(prev);
    return {
      value: cur.caught,
      priorValue: pri.caught,
      detail: { regression_jobs_concluded: cur.jobsConcluded, detected: cur.detected, dismissed: cur.dismissed, fix_authored: cur.fixAuthored },
    };
  },
};

/**
 * regression_coverage_pct — the coverage half of regression health
 * (regression-backlog-reconciliation-scorecard Phase 1): share of SHIPPED specs that received at least one
 * spec-test run in the week, as a percentage. Numerator = distinct shipped spec_slugs with a spec_test_runs
 * row in the trailing window; denominator = count of LIVE shipped specs (brain-roadmap getRoadmap() —
 * archived/folded specs have left the live set, so they're already covered by the brain). detail carries the
 * raw {verified, shipped} counts + the slugs still missing coverage this week (the names the standing
 * re-verification sweep should pick up next pass).
 */
const regressionCoveragePct: MetricDef = {
  key: "regression_coverage_pct",
  unit: "pct",
  liveSpecSetDependent: true,
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;

    // The live shipped set — archived/folded specs are no longer "live" and aren't expected to be re-tested
    // (the same definition `reconcileRegressionCoverage` uses for its sweep target).
    const { specs } = await getRoadmap();
    const shippedSlugs = new Set<string>();
    for (const s of specs) if (s.status === "shipped") shippedSlugs.add(s.slug);
    const shippedCount = shippedSlugs.size;

    const pctFor = async (
      w: MetricWindow["curr"],
    ): Promise<{ pct: number; verified: number; missing: string[] }> => {
      if (shippedCount === 0) return { pct: 0, verified: 0, missing: [] };
      const { data } = await admin
        .from("spec_test_runs")
        .select("spec_slug")
        .eq("workspace_id", workspaceId)
        .gte("run_at", w.startIso)
        .lte("run_at", w.endIso);
      const verifiedSlugs = new Set<string>();
      for (const r of (data ?? []) as Array<{ spec_slug: string | null }>) {
        if (r.spec_slug && shippedSlugs.has(r.spec_slug)) verifiedSlugs.add(r.spec_slug);
      }
      const missing: string[] = [];
      for (const s of shippedSlugs) if (!verifiedSlugs.has(s)) missing.push(s);
      missing.sort();
      return {
        pct: round((verifiedSlugs.size / shippedCount) * 100, 2),
        verified: verifiedSlugs.size,
        missing,
      };
    };

    const cur = await pctFor(curr);
    const pri = await pctFor(prev);
    return {
      value: cur.pct,
      // prior null when there are no live shipped specs (nothing to verify yet)
      priorValue: shippedCount > 0 ? pri.pct : null,
      detail: { verified: cur.verified, shipped: shippedCount, missing: cur.missing.slice(0, 50) },
    };
  },
};

// ── Monthly leading-curve metric derivations (platform-scorecard-monthly spec) ────────────────────
// The monthly lens: the slow-moving indicators that prove autonomy is compounding. The headline is
// `human_touch_per_build` (CEO/human approvals ÷ merged builds — the goal's success metric, declining
// MoM). Each metric reuses the engine's trailing-30-day window + prior-month delta + idempotent
// upsert; only the derivation is new. Display-only proxy, never a target (North-star).

/**
 * human_touch_per_build — the goal's headline. `(approval_decisions where decided_by ∈ ceo｜human in
 * the month) ÷ (agent_jobs kind='build' status='merged' in the month)`. Lower is better; the prior-
 * month `delta_pct` is the "declining MoM" signal. `value` = the ratio; `detail` carries the
 * numerator/denominator so the trend point is auditable. Workspace-scoped on both sides.
 */
const humanTouchPerBuild: MetricDef = {
  key: "human_touch_per_build",
  unit: "ratio",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const ratioFor = async (w: MetricWindow["curr"]): Promise<{ ratio: number; touched: number; builds: number }> => {
      const { count: touchedRaw } = await admin
        .from("approval_decisions")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .in("decided_by", ["ceo", "human"])
        .gte("created_at", w.startIso)
        .lte("created_at", w.endIso);
      const { count: buildsRaw } = await admin
        .from("agent_jobs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("kind", "build")
        .eq("status", "merged")
        .gte("updated_at", w.startIso)
        .lte("updated_at", w.endIso);
      const touched = touchedRaw ?? 0;
      const builds = buildsRaw ?? 0;
      return { ratio: builds > 0 ? round(touched / builds) : 0, touched, builds };
    };
    const cur = await ratioFor(curr);
    const pri = await ratioFor(prev);
    return {
      value: cur.ratio,
      priorValue: pri.builds > 0 ? pri.ratio : null,
      detail: { touched: cur.touched, builds: cur.builds },
    };
  },
};

/**
 * goals_escorted_unbabysat — goals whose milestones advanced WITHOUT CEO touch in the month. Resolve
 * candidates from director_activity action_kind='escorted_goal' (director_function='platform') rows
 * in-window → distinct goal_slug; intersect with brain-roadmap `getGoals()` to pick the goals with
 * at least one shipped milestone; count those whose milestone spec_slugs received NO non-autonomous
 * approval_decision (decided_by ∈ ceo｜human) in-window. The CEO-touch check joins approval_decisions
 * to agent_jobs.spec_slug (via agent_job_id) and matches against the goal's shipped-milestone slugs.
 */
const goalsEscortedUnbabysat: MetricDef = {
  key: "goals_escorted_unbabysat",
  unit: "count",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const countFor = async (w: MetricWindow["curr"]): Promise<{ count: number; goals: Array<{ goal: string; milestones: string[] }> }> => {
      const { data: escorts } = await admin
        .from("director_activity")
        .select("metadata")
        .eq("workspace_id", workspaceId)
        .eq("director_function", PLATFORM_FUNCTION)
        .eq("action_kind", "escorted_goal")
        .gte("created_at", w.startIso)
        .lte("created_at", w.endIso);
      const escortedSlugs = new Set<string>();
      for (const r of (escorts ?? []) as Array<{ metadata: Record<string, unknown> | null }>) {
        const slug = typeof r.metadata?.goal_slug === "string" ? (r.metadata.goal_slug as string) : null;
        if (slug) escortedSlugs.add(slug);
      }
      if (!escortedSlugs.size) return { count: 0, goals: [] };

      const allGoals = await getGoals();
      const candidates: Array<{ slug: string; milestones: string[]; specSlugs: Set<string> }> = [];
      for (const g of allGoals) {
        if (!escortedSlugs.has(g.slug)) continue;
        const shipped = g.milestones.filter((m) => m.status === "shipped");
        if (!shipped.length) continue;
        const specSlugs = new Set<string>();
        for (const m of shipped) for (const s of m.specSlugs) specSlugs.add(s);
        candidates.push({ slug: g.slug, milestones: shipped.map((m) => m.id || m.name), specSlugs });
      }
      if (!candidates.length) return { count: 0, goals: [] };

      const { data: touched } = await admin
        .from("approval_decisions")
        .select("agent_job_id")
        .eq("workspace_id", workspaceId)
        .in("decided_by", ["ceo", "human"])
        .gte("created_at", w.startIso)
        .lte("created_at", w.endIso);
      const jobIds = Array.from(
        new Set(
          ((touched ?? []) as Array<{ agent_job_id: string | null }>)
            .map((r) => r.agent_job_id)
            .filter((x): x is string => !!x),
        ),
      );
      const touchedSpecSlugs = new Set<string>();
      if (jobIds.length) {
        const { data: jobs } = await admin.from("agent_jobs").select("spec_slug").in("id", jobIds);
        for (const j of (jobs ?? []) as Array<{ spec_slug: string | null }>) {
          if (j.spec_slug) touchedSpecSlugs.add(j.spec_slug);
        }
      }

      const goals: Array<{ goal: string; milestones: string[] }> = [];
      for (const c of candidates) {
        let babysat = false;
        for (const s of c.specSlugs) {
          if (touchedSpecSlugs.has(s)) {
            babysat = true;
            break;
          }
        }
        if (!babysat) goals.push({ goal: c.slug, milestones: c.milestones });
      }
      return { count: goals.length, goals };
    };
    const cur = await countFor(curr);
    const pri = await countFor(prev);
    return { value: cur.count, priorValue: pri.count, detail: { goals: cur.goals } };
  },
};

/**
 * time_to_approve_hours — median over the month of `(approval_decisions.created_at − request_raised_at)`
 * for terminal decisions (decision ∈ approved｜declined). `request_raised_at` is approximated by the
 * raising agent_job's `created_at` (the floor — the job couldn't request approval before it existed),
 * since pending_actions carry no timestamp and the job's `updated_at` is post-approval by the time we
 * read it. `value` = p50; `detail` carries p50/p90 + the sample count.
 */
const timeToApproveHours: MetricDef = {
  key: "time_to_approve_hours",
  unit: "hours",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const hoursFor = async (w: MetricWindow["curr"]): Promise<number[]> => {
      const { data: decisions } = await admin
        .from("approval_decisions")
        .select("created_at, agent_job_id")
        .eq("workspace_id", workspaceId)
        .in("decision", ["approved", "declined"])
        .gte("created_at", w.startIso)
        .lte("created_at", w.endIso);
      const rows = (decisions ?? []) as Array<{ created_at: string; agent_job_id: string | null }>;
      if (!rows.length) return [];
      const jobIds = Array.from(new Set(rows.map((r) => r.agent_job_id).filter((x): x is string => !!x)));
      const raisedAtByJob = new Map<string, string>();
      if (jobIds.length) {
        const { data: jobs } = await admin.from("agent_jobs").select("id, created_at").in("id", jobIds);
        for (const j of (jobs ?? []) as Array<{ id: string; created_at: string }>) {
          raisedAtByJob.set(j.id, j.created_at);
        }
      }
      const hrs: number[] = [];
      for (const r of rows) {
        if (!r.agent_job_id) continue;
        const raisedAt = raisedAtByJob.get(r.agent_job_id);
        if (!raisedAt) continue;
        const dt = (new Date(r.created_at).getTime() - new Date(raisedAt).getTime()) / 3_600_000;
        if (Number.isFinite(dt) && dt >= 0) hrs.push(dt);
      }
      return hrs;
    };
    const cur = await hoursFor(curr);
    const pri = await hoursFor(prev);
    const p50 = round(median(cur), 2);
    const p90 = round(percentile(cur, 0.9), 2);
    return {
      value: p50,
      priorValue: pri.length ? round(median(pri), 2) : null,
      detail: { p50, p90, decided_count: cur.length },
    };
  },
};

/**
 * deploy_reliability — `deploy_healthy ÷ (deploy_healthy + deploy_rolled_back)` from director_activity
 * in the month — the deploy-health-rollback-guardian half of the reliability KPI (CI-green is the
 * weekly `build_success_rate`). When the guardian has written NO verdicts in the window we surface
 * `detail.no_data=true` so the UI shows "no data yet" rather than a fabricated 100% (or 0% — the spec
 * is explicit: never imply perfect reliability from absent data).
 */
const deployReliability: MetricDef = {
  key: "deploy_reliability",
  unit: "ratio",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const rateFor = async (w: MetricWindow["curr"]): Promise<{ rate: number; healthy: number; rolledBack: number; total: number }> => {
      const countKind = async (kind: string): Promise<number> => {
        const { count } = await admin
          .from("director_activity")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .eq("action_kind", kind)
          .gte("created_at", w.startIso)
          .lte("created_at", w.endIso);
        return count ?? 0;
      };
      const healthy = await countKind("deploy_healthy");
      const rolledBack = await countKind("deploy_rolled_back");
      const total = healthy + rolledBack;
      return { rate: total > 0 ? round(healthy / total) : 0, healthy, rolledBack, total };
    };
    const cur = await rateFor(curr);
    const pri = await rateFor(prev);
    return {
      value: cur.rate,
      priorValue: pri.total > 0 ? pri.rate : null,
      detail:
        cur.total === 0
          ? { no_data: true, healthy: 0, rolled_back: 0 }
          : { healthy: cur.healthy, rolled_back: cur.rolledBack, total: cur.total },
    };
  },
};

/**
 * director_call_grade — the CEO's grade of the Platform director's calls in the month: average
 * director_decision_grades.grade (1–10) split by `dimension ∈ auto-approval｜goal-escort` — the same
 * shape `computeDirectorGradeReport` reads. `value` = the blended mean across both dimensions;
 * `detail.by_dimension` carries each dimension's mean + count. When no grades land in-window we
 * surface `detail.no_data=true` (value=0) so the UI shows "no data yet".
 */
const DIRECTOR_GRADE_DIMENSIONS = ["auto-approval", "goal-escort"] as const;
const directorCallGrade: MetricDef = {
  key: "director_call_grade",
  unit: "grade",
  compute: async (ctx) => {
    const { admin, workspaceId, curr, prev } = ctx;
    const meanFor = async (w: MetricWindow["curr"]): Promise<{ blended: number | null; byDim: Record<string, { mean: number | null; count: number }>; total: number }> => {
      // Platform scorecard — only grade the Platform Director's calls.
      // growth-adopt-meta-iteration-engine Phase 2 added a Growth slice to director_decision_grades;
      // without this filter the Platform metric would blend in Growth's grades and conflate the two.
      const { data } = await admin
        .from("director_decision_grades")
        .select("dimension, grade")
        .eq("workspace_id", workspaceId)
        .eq("director_function", "platform")
        .gte("created_at", w.startIso)
        .lte("created_at", w.endIso);
      const rows = (data ?? []) as Array<{ dimension: string; grade: number | null }>;
      const byDim: Record<string, { mean: number | null; count: number }> = {};
      const allGrades: number[] = [];
      for (const dim of DIRECTOR_GRADE_DIMENSIONS) {
        const grades = rows.filter((r) => r.dimension === dim && typeof r.grade === "number").map((r) => r.grade as number);
        const m = meanOf(grades);
        byDim[dim] = { mean: m == null ? null : round(m, 2), count: grades.length };
        for (const g of grades) allGrades.push(g);
      }
      const blended = meanOf(allGrades);
      return { blended: blended == null ? null : round(blended, 2), byDim, total: allGrades.length };
    };
    const cur = await meanFor(curr);
    const pri = await meanFor(prev);
    return {
      value: cur.blended ?? 0,
      priorValue: pri.blended,
      detail:
        cur.total === 0
          ? { no_data: true, by_dimension: cur.byDim, total: 0 }
          : { blended_mean: cur.blended, by_dimension: cur.byDim, total: cur.total },
    };
  },
};

/**
 * The per-cadence KPI registry — declarative so a new KPI needs no migration. This spec seeds the
 * DAILY set; platform-scorecard-weekly + platform-scorecard-monthly add their own cadence registries.
 */
const DAILY_METRICS: MetricDef[] = [
  loopHealth,
  errorBacklog,
  errorMttrHours,
  buildThroughput,
  laneUtilization,
  buildEnqueueRate,
  autonomyRatio,
  escalations,
  needsAttention,
  regressions,
];

/**
 * Weekly throughput + quality set (platform-scorecard-weekly spec): how much the build org shipped
 * this week and how good it was — all derived from existing truth, never written back as a target.
 */
const WEEKLY_METRICS: MetricDef[] = [
  specsPerWeek,
  buildSuccessRate,
  ideaToMergeHours,
  approvalsUntouchedPct,
  workerGradeRollup,
  regressionsCaught,
  regressionCoveragePct,
];

/**
 * Monthly leading-curve set (platform-scorecard-monthly spec): the slow-moving indicators that prove
 * autonomy is compounding. `human_touch_per_build` is the goal's headline (declining MoM signal);
 * `deploy_reliability` reads the deploy-health-rollback-guardian verdicts; `director_call_grade`
 * reads director_decision_grades. Display-only proxy, never a target (North-star).
 */
const MONTHLY_METRICS: MetricDef[] = [
  humanTouchPerBuild,
  goalsEscortedUnbabysat,
  timeToApproveHours,
  deployReliability,
  directorCallGrade,
];

const REGISTRY: Record<Cadence, MetricDef[]> = {
  daily: DAILY_METRICS,
  weekly: WEEKLY_METRICS,
  monthly: MONTHLY_METRICS,
};

/** Default trailing-window length per cadence. */
const DEFAULT_WINDOW: Record<Cadence, number> = { daily: 1, weekly: 7, monthly: 30 };

/**
 * Compute every KPI in the cadence's registry for one workspace as-of `snapshotDate` and return the
 * rows WITHOUT persisting them — the shared compute pass behind both `computePlatformScorecard` (the
 * writer) and [[kpi-review]] `auditAllKpis` (the read-only diff layer). Same window math, same
 * `MetricDef.compute`, same rounding — so "ground truth" the audit produces is byte-equivalent to
 * what the engine would persist. A single metric's read failing writes a zero row + logs, never
 * drops the rest.
 */
export async function computeScorecardValuesOnly(
  workspaceId: string,
  opts: ComputeOptions,
): Promise<ScorecardSnapshotRow[]> {
  const admin = createAdminClient();
  const cadence = opts.cadence;
  const metrics = REGISTRY[cadence];
  if (!metrics.length) return [];

  const snapshotDate = opts.snapshotDate ?? dayStr(new Date());
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW[cadence];
  const nowIso = new Date().toISOString();

  const currStart = dayMinus(snapshotDate, windowDays - 1);
  const prevStart = dayMinus(snapshotDate, 2 * windowDays - 1);
  const prevEnd = dayMinus(snapshotDate, windowDays);
  const window: MetricWindow = {
    curr: { start: currStart, end: snapshotDate, startIso: startIso(currStart), endIso: endIso(snapshotDate) },
    prev: { start: prevStart, end: prevEnd, startIso: startIso(prevStart), endIso: endIso(prevEnd) },
  };

  // The "attribute to a real function slug" guard (director-xp pattern).
  const functions = await getFunctions();
  const knownFunctions = new Set(functions.map((f) => f.slug));

  // Prior stored snapshot lookup for current-state metrics (snapshot_date − windowDays).
  const priorSnapshotDate = dayMinus(snapshotDate, windowDays);
  const getPriorSnapshot = async (metricKey: string): Promise<number | null> => {
    const { data } = await admin
      .from("platform_scorecard_snapshots")
      .select("value")
      .eq("workspace_id", workspaceId)
      .eq("metric_key", metricKey)
      .eq("cadence", cadence)
      .eq("snapshot_date", priorSnapshotDate)
      .maybeSingle();
    const v = (data as { value: number | null } | null)?.value;
    return v == null ? null : Number(v);
  };

  const ctx: MetricContext = {
    admin,
    workspaceId,
    cadence,
    snapshotDate,
    windowDays,
    knownFunctions,
    getPriorSnapshot,
    ...window,
  };

  const rows: ScorecardSnapshotRow[] = [];
  for (const metric of metrics) {
    let result: MetricResult;
    try {
      result = await metric.compute(ctx);
    } catch (e) {
      // A single metric's read failing must not drop the rest — write a zero row + log.
      console.error(`[platform-scorecard] metric ${metric.key} compute failed:`, e instanceof Error ? e.message : e);
      result = { value: 0, priorValue: null, detail: { error: e instanceof Error ? e.message : String(e) } };
    }
    const precision = metric.unit === "count" ? 0 : metric.unit === "hours" || metric.unit === "grade" ? 2 : 4;
    const value = round(result.value, precision);
    const priorValue = result.priorValue == null ? null : round(result.priorValue, precision);
    rows.push({
      workspace_id: workspaceId,
      metric_key: metric.key,
      cadence,
      snapshot_date: snapshotDate,
      window_days: windowDays,
      value,
      prior_value: priorValue,
      delta_pct: pctDelta(value, priorValue),
      unit: metric.unit,
      detail: result.detail,
      updated_at: nowIso,
    });
  }

  return rows;
}

/**
 * Compute + persist every KPI in the cadence's registry for one workspace as-of `snapshotDate`. For
 * each metric: compute the trailing-window value, the prior equal-length window value, and delta_pct,
 * then UPSERT on (workspace_id, metric_key, cadence, snapshot_date) — idempotent, a same-day re-run
 * upserts in place. Returns the rows written. A quiet workspace writes zeros, never errors.
 */
export async function computePlatformScorecard(
  workspaceId: string,
  opts: ComputeOptions,
): Promise<ScorecardSnapshotRow[]> {
  const rows = await computeScorecardValuesOnly(workspaceId, opts);
  if (!rows.length) return rows;
  const admin = createAdminClient();
  const { error } = await admin
    .from("platform_scorecard_snapshots")
    .upsert(rows, { onConflict: "workspace_id,metric_key,cadence,snapshot_date" });
  if (error) {
    await reportDbError(error, { op: "platform-scorecard-upsert", table: "platform_scorecard_snapshots", rows: rows.length });
    throw new Error(`platform_scorecard_snapshots upsert failed: ${(error as { code?: string }).code ?? "?"} ${error.message}`);
  }
  return rows;
}

/**
 * The (metric_key, unit, currentState, liveSpecSetDependent) tuples for every metric in the cadence's
 * registry — the surface [[kpi-review]] needs to enumerate the advertised KPI set (and skip
 * current-state point-read metrics + live-spec-set-dependent metrics) without re-importing the
 * private `MetricDef` shape. The optional flags are omitted (not `false`) for the common
 * windowed-aggregate case so the tuple shape matches `MetricDef`.
 */
export function getRegisteredMetrics(
  cadence: Cadence,
): ReadonlyArray<{ key: string; unit: MetricUnit; currentState?: true; liveSpecSetDependent?: true }> {
  return REGISTRY[cadence].map((m) => ({
    key: m.key,
    unit: m.unit,
    ...(m.currentState ? { currentState: true as const } : {}),
    ...(m.liveSpecSetDependent ? { liveSpecSetDependent: true as const } : {}),
  }));
}

/** Every advertised cadence — the single source of truth for callers that enumerate the registry. */
export const CADENCES: readonly Cadence[] = ["daily", "weekly", "monthly"] as const;

/**
 * Is this `loop_alerts.loop_id` a `kpi_drift:<metric>:<cadence>` alert for a metric whose audit is SKIPPED
 * as a false-positive class — i.e. a `currentState` point-read OR a `liveSpecSetDependent` meta-metric
 * (kpi-audit-skip-live-spec-set-dependent-metrics, #848)? These loops reflect the snapshot-vs-moving-target
 * MEMBERSHIP delta (specs fold/archive, pools drain), NOT engine drift — and crucially NOT the deployed
 * code. They are the SAME class [[kpi-review]] `auditAllKpis` skips; this is the single predicate behind
 * both the audit skip and the deploy-guardian non-attribution gate ([[deploy-guardian]] `verdictFor`).
 *
 * A non-`kpi_drift` loop_id, an unparseable one, or a `kpi_drift` loop for a genuine windowed-aggregate
 * metric returns `false` — those still page / still attribute to a deploy.
 */
export function isAuditSkippedKpiDriftLoop(loopId: string): boolean {
  const m = /^kpi_drift:(.+):(daily|weekly|monthly)$/.exec(loopId || "");
  if (!m) return false;
  const [, metricKey, cadence] = m;
  const reg = getRegisteredMetrics(cadence as Cadence).find((r) => r.key === metricKey);
  return !!(reg?.currentState || reg?.liveSpecSetDependent);
}

/**
 * The default trailing-window length the engine uses for a cadence — exposed so [[kpi-review]] can
 * read it without duplicating the table.
 */
export function getDefaultWindowDays(cadence: Cadence): number {
  return DEFAULT_WINDOW[cadence];
}
