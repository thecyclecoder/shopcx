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
import { getFunctions } from "@/lib/brain-roadmap";
import { BUILD_POOL_CAPACITY } from "@/lib/agents/platform-director";

type Admin = ReturnType<typeof createAdminClient>;

export type Cadence = "daily" | "weekly" | "monthly";
export type MetricUnit = "count" | "ratio" | "hours" | "pct";

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
}

// ── Daily pulse metric derivations (all from existing truth) ─────────────────────

/**
 * loop_health — share of monitored loops green. A loop is green when it has NO open loop_alert AND
 * (for a cron) a heartbeat within its livenessWindowMs. Worker / agent-kind / reactive / inline-agent
 * loops are idle-green (the Control Tower monitor opens an alert if one genuinely dies), so they're
 * judged on the open-alert signal alone. Current-state metric — prior comes from the prior snapshot.
 */
const loopHealth: MetricDef = {
  key: "loop_health",
  unit: "ratio",
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
 * needs_attention — open parked work the director triages (needs-attention-triage-and-verdict-robustness
 * Phase 3): agent_jobs in status='needs_attention' EXCLUDING the kinds another lane already owns (build →
 * the build loop-guard; repair → the repair-dismissal lane). The count is the headline value; detail carries
 * the OLDEST open item's age in hours + a by-kind breakdown, so a rotting parked item is a tracked, trending
 * KPI (not just a transient board line). A current-state metric — prior comes from the prior snapshot.
 */
const TRIAGED_NA_SKIP_KINDS = new Set(["build", "repair", "platform-director"]);
const needsAttention: MetricDef = {
  key: "needs_attention",
  unit: "count",
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
];

const REGISTRY: Record<Cadence, MetricDef[]> = {
  daily: DAILY_METRICS,
  weekly: [], // platform-scorecard-weekly
  monthly: [], // platform-scorecard-monthly
};

/** Default trailing-window length per cadence. */
const DEFAULT_WINDOW: Record<Cadence, number> = { daily: 1, weekly: 7, monthly: 30 };

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
    const value = round(result.value, metric.unit === "count" ? 0 : metric.unit === "hours" ? 2 : 4);
    const priorValue = result.priorValue == null ? null : round(result.priorValue, metric.unit === "count" ? 0 : metric.unit === "hours" ? 2 : 4);
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

  const { error } = await admin
    .from("platform_scorecard_snapshots")
    .upsert(rows, { onConflict: "workspace_id,metric_key,cadence,snapshot_date" });
  if (error) {
    await reportDbError(error, { op: "platform-scorecard-upsert", table: "platform_scorecard_snapshots", rows: rows.length });
    throw new Error(`platform_scorecard_snapshots upsert failed: ${(error as { code?: string }).code ?? "?"} ${error.message}`);
  }

  return rows;
}
