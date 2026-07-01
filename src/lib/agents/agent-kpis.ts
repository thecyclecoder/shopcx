/**
 * Agent KPI SDK — computes a per-agent-kind KPI structure the KPI page renders generically.
 *
 * A second supervision layer above [[agent-grader]] (per-action grades) + [[agent-coaching]]
 * (learning loop): every agent gets a KPI page that answers two distinct questions —
 * "is this agent ON IT?" (liveness/posture) and "is it WINNING?" (outcomes). Motivated by
 * Cleo (Storefront Optimizer, [[../libraries/storefront-optimizer-agent]]): while
 * experiments run she correctly does NOT propose, so the box board reads as idle when she
 * is actually monitoring N experiments + blocked because every surface has a live test.
 * The KPI page makes that legible.
 *
 * Built as a REGISTRY of per-agent-kind definitions with a GENERIC FALLBACK — any agent
 * kind without a bespoke definition still gets a sane KPI page from day one.
 *
 * Pure reads, no writes. Server-only (createAdminClient).
 *
 * Leading-vs-lagging note: until calibrated + sufficient traffic, Tier 2 (cadence) + Tier 4
 * (quality/learning) LEAD, Tier 3 (outcome) LAGS — a fresh agent shows movement on Tier
 * 2/4 long before Tier 3 has enough signal to trust.
 *
 * See spec `docs/brain/specs/agent-kpi-pages-cleo-first.md`.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  loadOptimizerPolicy,
  isOptimizerActive,
  type OptimizerPolicy,
} from "@/lib/storefront/optimizer-policy";
import {
  LANDER_TYPES,
  OPTIMIZER_AUDIENCES,
} from "@/lib/storefront/optimizer-agent";

type Admin = ReturnType<typeof createAdminClient>;

/** One KPI card rendered on the page. Structural — the page decides layout. */
export interface KpiCard {
  /** Stable card key — the page uses this for keys / deep-linking. */
  key: string;
  /** Display label ("Predicted LTV / visitor"). */
  label: string;
  /** The headline value; `null` when the underlying source has no data yet. */
  value: string | number | null;
  /** Optional unit ("$", "%", "days") — appended after the value. */
  unit?: string;
  /**
   * Visual polarity: `good` = emerald, `bad` = rose, `neutral` = grey. The SDK sets tone
   * from the underlying signal (e.g. a lever-coverage of 0% is `bad`, not `neutral`);
   * the page renders it — it does not re-interpret.
   */
  tone: "good" | "neutral" | "bad";
  /** Optional trend arrow — WoW / prior-window direction. */
  trend?: { dir: "up" | "down" | "flat"; pct?: number };
  /** Optional secondary line under the value. */
  subtitle?: string;
  /** Human-legible source hint (rendered as a tooltip). */
  source: string;
}

export interface KpiTier {
  /** Stable tier key — `"on-it" | "cadence" | "outcome" | "quality"` for Cleo's four; free-form for other kinds. */
  key: string;
  /** Display label ("On it", "Cadence", …). */
  label: string;
  cards: KpiCard[];
}

export interface AgentKpis {
  agentKind: string;
  /** ISO stamp when this snapshot was computed (best-effort observability). */
  generatedAt: string;
  /**
   * The featured cards — the "at a glance" row above the tier grid. Cleo: the On-it
   * posture card + predicted-LTV-per-visitor. Generic: activity + avg grade.
   */
  headline: KpiCard[];
  /** Full tier structure — the page renders one section per tier. */
  tiers: KpiTier[];
}

/** Contract every agent-kind definition implements. */
type KpiDefinition = (opts: {
  workspaceId: string;
  admin: Admin;
}) => Promise<{ headline: KpiCard[]; tiers: KpiTier[] }>;

// ── Small helpers ────────────────────────────────────────────────────────────

/** Format a cents amount as "$X.YZ" (or "$X" when >= 100). Handles null → "—". */
function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 100) return `$${Math.round(dollars).toLocaleString()}`;
  return `$${dollars.toFixed(2)}`;
}

/** Format an ISO stamp as a "N hours ago" / "N days ago" hint. */
function relativeAge(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const ms = Date.now() - t;
  const h = ms / (60 * 60 * 1000);
  if (h < 1) return `${Math.max(1, Math.round(ms / (60 * 1000)))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Days since an ISO stamp, or null if the stamp is missing / invalid. */
function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

// ── Storefront-optimizer (Cleo) definition ───────────────────────────────────

/**
 * Cleo's four-tier KPI definition. Every card sources from a real table (probed against
 * the current brain pages — [[../tables/storefront_experiments]],
 * [[../tables/storefront_ltv_metrics]], [[../tables/storefront_lever_importance]],
 * [[../tables/storefront_campaign_grades]], [[../tables/agent_jobs]]).
 */
const storefrontOptimizerDefinition: KpiDefinition = async ({ workspaceId, admin }) => {
  // Tier 1 sources ──────────────────────────────────────────────────────────
  const policy = await loadOptimizerPolicy(admin, workspaceId);
  const active = isOptimizerActive(policy);

  const { data: lastPassRow } = await admin
    .from("agent_jobs")
    .select("updated_at, status")
    .eq("workspace_id", workspaceId)
    .eq("kind", "storefront-optimizer")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastPassAt = (lastPassRow as { updated_at?: string } | null)?.updated_at ?? null;
  const daysSincePass = daysSince(lastPassAt);

  const { data: runningRows } = await admin
    .from("storefront_experiments")
    .select("id, product_id, lander_type, audience, started_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "running");
  const running = (runningRows as Array<{
    id: string;
    product_id: string;
    lander_type: string;
    audience: string;
    started_at: string | null;
  }> | null) ?? [];

  const { count: awaitingOwnerCount } = await admin
    .from("agent_jobs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("kind", "storefront-optimizer")
    .eq("status", "needs_approval");

  const { count: needsAttentionCount } = await admin
    .from("agent_jobs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("kind", "storefront-optimizer")
    .eq("status", "needs_attention");

  const totalSurfaces = policy?.product_scope
    ? policy.product_scope.length * LANDER_TYPES.length * OPTIMIZER_AUDIENCES.length
    : 0;
  const surfacesWithRunning = new Set(
    running.map((r) => `${r.product_id}:${r.lander_type}:${r.audience}`),
  ).size;
  const surfaceBlockedFraction =
    totalSurfaces > 0 ? surfacesWithRunning / totalSurfaces : 0;

  const posture: string = !active
    ? "Optimizer OFF — not proposing (no active policy)."
    : totalSurfaces === 0
    ? "Policy active but product_scope is empty — nothing in scope to propose on."
    : surfacesWithRunning >= totalSurfaces
    ? `Monitoring ${surfacesWithRunning} experiments — no free surface to propose on.`
    : `Monitoring ${surfacesWithRunning} experiments; ${totalSurfaces - surfacesWithRunning}/${totalSurfaces} free surface(s) available.`;

  // Age of oldest running experiment — supervision cue if a bandit is stuck.
  const oldestRunningDays = running.reduce<number | null>((acc, r) => {
    const d = daysSince(r.started_at);
    if (d === null) return acc;
    return acc === null ? d : Math.max(acc, d);
  }, null);

  // Tier 2 sources ──────────────────────────────────────────────────────────
  const windowDays = 30;
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const prevStart = new Date(Date.now() - 2 * windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: campaignsInWindow } = await admin
    .from("storefront_experiments")
    .select("id, status, started_at, stopped_at, created_at, promoted_variant_id")
    .eq("workspace_id", workspaceId)
    .gte("created_at", windowStart);
  const proposedInWindow = (campaignsInWindow as Array<Record<string, unknown>> | null) ?? [];

  const launched = proposedInWindow.filter((r) => r.started_at !== null).length;
  const concludedRows = proposedInWindow.filter((r) =>
    ["promoted", "killed", "rolled_back"].includes(String(r.status)),
  );
  const concluded = concludedRows.length;

  const decisionDurations: number[] = concludedRows
    .map((r) => {
      const started = r.started_at ? Date.parse(String(r.started_at)) : null;
      const stopped = r.stopped_at ? Date.parse(String(r.stopped_at)) : null;
      if (!started || !stopped || !Number.isFinite(started) || !Number.isFinite(stopped)) return null;
      return (stopped - started) / (24 * 60 * 60 * 1000);
    })
    .filter((n): n is number => n !== null && n >= 0);
  const avgDaysToDecision =
    decisionDurations.length > 0
      ? decisionDurations.reduce((a, b) => a + b, 0) / decisionDurations.length
      : null;

  // Traffic sufficiency — % of running experiments whose latest snapshot visitors >= min_sample.
  const minSample = policy?.min_sample ?? 0;
  let sufficientCount = 0;
  if (running.length > 0) {
    for (const r of running) {
      const { data: metric } = await admin
        .from("storefront_ltv_metrics")
        .select("visitors")
        .eq("workspace_id", workspaceId)
        .eq("product_id", r.product_id)
        .eq("lander_type", r.lander_type)
        .eq("audience", r.audience)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      const visitors = (metric as { visitors?: number } | null)?.visitors ?? 0;
      if (minSample > 0 && visitors >= minSample) sufficientCount++;
    }
  }
  const trafficSufficiencyPct =
    running.length > 0 ? (sufficientCount / running.length) * 100 : null;

  // Tier 3 sources ──────────────────────────────────────────────────────────
  const { data: recentMetrics } = await admin
    .from("storefront_ltv_metrics")
    .select("visitors, predicted_ltv_per_visitor_cents, sub_attach_rate, snapshot_date")
    .eq("workspace_id", workspaceId)
    .gte("snapshot_date", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
    .order("snapshot_date", { ascending: false });
  const recent = (recentMetrics as Array<{
    visitors: number | null;
    predicted_ltv_per_visitor_cents: number | null;
    sub_attach_rate: number | null;
    snapshot_date: string;
  }> | null) ?? [];
  const { data: priorMetrics } = await admin
    .from("storefront_ltv_metrics")
    .select("visitors, predicted_ltv_per_visitor_cents")
    .eq("workspace_id", workspaceId)
    .gte(
      "snapshot_date",
      new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    )
    .lt(
      "snapshot_date",
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    );
  const prior = (priorMetrics as Array<{
    visitors: number | null;
    predicted_ltv_per_visitor_cents: number | null;
  }> | null) ?? [];

  const blendedLtv = (rows: Array<{ visitors: number | null; predicted_ltv_per_visitor_cents: number | null }>) => {
    let num = 0;
    let den = 0;
    for (const r of rows) {
      const v = r.visitors ?? 0;
      const p = r.predicted_ltv_per_visitor_cents ?? 0;
      if (v > 0) {
        num += v * p;
        den += v;
      }
    }
    return den > 0 ? num / den : null;
  };
  const ltvNow = blendedLtv(recent);
  const ltvPrior = blendedLtv(prior);
  const ltvTrend =
    ltvNow !== null && ltvPrior !== null && ltvPrior > 0
      ? { pct: ((ltvNow - ltvPrior) / ltvPrior) * 100 }
      : null;

  const subAttachAvg = (() => {
    const vals = recent.map((r) => r.sub_attach_rate ?? 0).filter((v) => Number.isFinite(v));
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  })();

  const { count: promotedCount } = await admin
    .from("storefront_experiments")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "promoted");
  const { count: killedCount } = await admin
    .from("storefront_experiments")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "killed");
  const totalConcluded = (promotedCount ?? 0) + (killedCount ?? 0);
  const winRatePct =
    totalConcluded > 0 ? ((promotedCount ?? 0) / totalConcluded) * 100 : null;

  // Tier 4 sources ──────────────────────────────────────────────────────────
  const { data: gradeRows } = await admin
    .from("storefront_campaign_grades")
    .select("grade_initial, hypothesis_quality, grade_revised")
    .eq("workspace_id", workspaceId)
    .not("grade_initial", "is", null);
  const grades = (gradeRows as Array<{
    grade_initial: number | null;
    hypothesis_quality: number | null;
    grade_revised: number | null;
  }> | null) ?? [];
  const avg = (vals: Array<number | null>) => {
    const nums = vals.filter((v): v is number => v !== null && Number.isFinite(v));
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  };
  const avgGrade = avg(grades.map((g) => g.grade_initial));
  const avgHypothesis = avg(grades.map((g) => g.hypothesis_quality));

  // Proxy honesty — |grade_revised - grade_initial| avg over revised rows; low = trustworthy.
  const revisedPairs = grades
    .map((g) =>
      g.grade_initial !== null && g.grade_revised !== null
        ? Math.abs(g.grade_revised - g.grade_initial)
        : null,
    )
    .filter((v): v is number => v !== null);
  const proxyGap =
    revisedPairs.length > 0
      ? revisedPairs.reduce((a, b) => a + b, 0) / revisedPairs.length
      : null;

  const { count: rolledBackCount } = await admin
    .from("storefront_experiments")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "rolled_back");
  const totalConcludedForRollback = totalConcluded + (rolledBackCount ?? 0);
  const rollbackRatePct =
    totalConcludedForRollback > 0
      ? ((rolledBackCount ?? 0) / totalConcludedForRollback) * 100
      : null;

  // Lever-map coverage — % of lever_importance rows with n_tests > 0 (i.e. LEARNED, not still-prior).
  const { count: leverCellsTotal } = await admin
    .from("storefront_lever_importance")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  const { count: leverCellsLearned } = await admin
    .from("storefront_lever_importance")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .gt("n_tests", 0);
  const leverCoveragePct =
    (leverCellsTotal ?? 0) > 0
      ? ((leverCellsLearned ?? 0) / (leverCellsTotal ?? 1)) * 100
      : 0;

  // ── Build the KpiCards ─────────────────────────────────────────────────
  const onItTone: KpiCard["tone"] =
    daysSincePass !== null && daysSincePass < 1
      ? "good"
      : daysSincePass !== null && daysSincePass < 2
      ? "neutral"
      : "bad";
  const onItCard: KpiCard = {
    key: "on-it",
    label: "On it",
    value: lastPassAt ? relativeAge(lastPassAt) : "no pass on file",
    tone: onItTone,
    subtitle: posture,
    source: "agent_jobs kind='storefront-optimizer' (last pass) + storefront_experiments (posture)",
  };
  const ltvHeadlineCard: KpiCard = {
    key: "ltv-per-visitor",
    label: "Predicted LTV / visitor",
    value: formatCents(ltvNow ?? null),
    tone:
      ltvTrend === null
        ? "neutral"
        : ltvTrend.pct >= 0
        ? "good"
        : "bad",
    trend:
      ltvTrend === null
        ? undefined
        : {
            dir: ltvTrend.pct > 0.5 ? "up" : ltvTrend.pct < -0.5 ? "down" : "flat",
            pct: ltvTrend.pct,
          },
    subtitle: recent.length > 0 ? `blended across ${recent.length} cohort-day(s)` : "no data yet",
    source: "storefront_ltv_metrics (last 7d vs prior 7d)",
  };

  const tiers: KpiTier[] = [
    {
      key: "on-it",
      label: "On it",
      cards: [
        onItCard,
        {
          key: "why-not-proposing",
          label: "Why not proposing",
          value: totalSurfaces === 0 ? "no scope" : `${surfacesWithRunning}/${totalSurfaces} surfaces busy`,
          tone: surfaceBlockedFraction >= 1 ? "neutral" : "good",
          subtitle: posture,
          source: "storefront_optimizer_policy.product_scope × LANDER_TYPES × OPTIMIZER_AUDIENCES + running experiments",
        },
        {
          key: "experiments-in-flight",
          label: "Experiments in flight",
          value: running.length,
          tone: running.length > 0 ? "good" : "neutral",
          subtitle:
            oldestRunningDays !== null
              ? `oldest ${Math.round(oldestRunningDays)}d`
              : "none running",
          source: "storefront_experiments status='running'",
        },
        {
          key: "awaiting-owner",
          label: "Awaiting owner",
          value: (awaitingOwnerCount ?? 0) + (needsAttentionCount ?? 0),
          tone:
            (awaitingOwnerCount ?? 0) + (needsAttentionCount ?? 0) === 0
              ? "good"
              : "neutral",
          subtitle:
            (awaitingOwnerCount ?? 0) > 0
              ? `${awaitingOwnerCount} Build/Approve card(s)`
              : "no cards waiting",
          source: "agent_jobs status='needs_approval'|'needs_attention'",
        },
      ],
    },
    {
      key: "cadence",
      label: "Cadence",
      cards: [
        {
          key: "campaigns-proposed",
          label: `Campaigns proposed (${windowDays}d)`,
          value: proposedInWindow.length,
          tone: proposedInWindow.length > 0 ? "good" : "neutral",
          subtitle: `${launched} launched · ${concluded} concluded`,
          source: `storefront_experiments created_at ≥ ${windowDays}d ago`,
        },
        {
          key: "avg-days-to-decision",
          label: "Avg time to decision",
          value: avgDaysToDecision !== null ? Number(avgDaysToDecision.toFixed(1)) : "—",
          unit: avgDaysToDecision !== null ? "d" : undefined,
          tone: avgDaysToDecision !== null && avgDaysToDecision < 14 ? "good" : "neutral",
          subtitle:
            decisionDurations.length > 0
              ? `across ${decisionDurations.length} concluded run(s)`
              : "no concluded runs yet",
          source: "storefront_experiments started_at → stopped_at",
        },
        {
          key: "traffic-sufficiency",
          label: "Traffic sufficiency",
          value:
            trafficSufficiencyPct !== null
              ? Number(trafficSufficiencyPct.toFixed(0))
              : "—",
          unit: trafficSufficiencyPct !== null ? "%" : undefined,
          tone:
            trafficSufficiencyPct === null
              ? "neutral"
              : trafficSufficiencyPct >= 80
              ? "good"
              : trafficSufficiencyPct >= 50
              ? "neutral"
              : "bad",
          subtitle:
            running.length > 0
              ? `${sufficientCount}/${running.length} clear policy.min_sample=${minSample}`
              : "no running experiments",
          source:
            "storefront_ltv_metrics.visitors ≥ storefront_optimizer_policy.min_sample (per running experiment)",
        },
      ],
    },
    {
      key: "outcome",
      label: "Outcome",
      cards: [
        ltvHeadlineCard,
        {
          key: "cumulative-lift",
          label: "Cumulative lift (visitors)",
          value: recent.reduce((a, r) => a + (r.visitors ?? 0), 0),
          tone: "neutral",
          subtitle: `${promotedCount ?? 0} promoted variant(s) live`,
          source: "storefront_experiment_variants + promoted experiments",
        },
        {
          key: "win-rate",
          label: "Win rate",
          value: winRatePct !== null ? Number(winRatePct.toFixed(0)) : "—",
          unit: winRatePct !== null ? "%" : undefined,
          tone:
            winRatePct === null
              ? "neutral"
              : winRatePct >= 30
              ? "good"
              : winRatePct >= 15
              ? "neutral"
              : "bad",
          subtitle: `${promotedCount ?? 0} promoted / ${totalConcluded} concluded`,
          source: "storefront_experiments status in ('promoted','killed')",
        },
        {
          key: "sub-attach",
          label: "Sub-attach rate",
          value:
            subAttachAvg !== null ? Number((subAttachAvg * 100).toFixed(1)) : "—",
          unit: subAttachAvg !== null ? "%" : undefined,
          tone: "neutral",
          subtitle: "avg across last 7d cohort-days",
          source: "storefront_ltv_metrics.sub_attach_rate",
        },
      ],
    },
    {
      key: "quality",
      label: "Quality & learning",
      cards: [
        {
          key: "avg-campaign-grade",
          label: "Avg campaign grade",
          value: avgGrade !== null ? Number(avgGrade.toFixed(1)) : "—",
          unit: avgGrade !== null ? "/10" : undefined,
          tone:
            avgGrade === null ? "neutral" : avgGrade >= 7 ? "good" : avgGrade >= 5 ? "neutral" : "bad",
          subtitle:
            avgHypothesis !== null
              ? `hypothesis ${avgHypothesis.toFixed(1)}/10 (independent of result)`
              : `${grades.length} graded campaign(s)`,
          source: "storefront_campaign_grades.grade_initial + hypothesis_quality",
        },
        {
          key: "proxy-honesty",
          label: "Proxy honesty",
          value: proxyGap !== null ? Number(proxyGap.toFixed(1)) : "not yet",
          unit: proxyGap !== null ? "Δ" : undefined,
          tone:
            proxyGap === null ? "neutral" : proxyGap <= 1 ? "good" : proxyGap <= 2 ? "neutral" : "bad",
          subtitle:
            revisedPairs.length > 0
              ? `|revised − initial| avg across ${revisedPairs.length} reconciled campaign(s)`
              : "no 4-month reconciliations landed yet",
          source: "storefront_campaign_grades revised vs initial gap",
        },
        {
          key: "auto-rollback-rate",
          label: "Auto-rollback rate",
          value:
            rollbackRatePct !== null ? Number(rollbackRatePct.toFixed(0)) : "—",
          unit: rollbackRatePct !== null ? "%" : undefined,
          tone:
            rollbackRatePct === null
              ? "neutral"
              : rollbackRatePct <= 10
              ? "good"
              : rollbackRatePct <= 25
              ? "neutral"
              : "bad",
          subtitle: `${rolledBackCount ?? 0} rolled back of ${totalConcludedForRollback} concluded`,
          source: "storefront_experiments status='rolled_back'",
        },
        {
          key: "lever-coverage",
          label: "Lever-map coverage",
          value: Number(leverCoveragePct.toFixed(0)),
          unit: "%",
          tone:
            leverCoveragePct >= 50 ? "good" : leverCoveragePct >= 10 ? "neutral" : "bad",
          subtitle: `${leverCellsLearned ?? 0}/${leverCellsTotal ?? 0} cells with a learned posterior`,
          source: "storefront_lever_importance n_tests > 0",
        },
      ],
    },
  ];

  return {
    headline: [onItCard, ltvHeadlineCard],
    tiers,
  };
};

// ── Generic fallback definition (every other agent kind) ─────────────────────

const genericDefinition: KpiDefinition = async ({ workspaceId, admin }) => {
  // Since this is called per agentKind, load state for the caller's kind. We pull the kind
  // through a closure below in the exported computeAgentKpis.
  // Placeholder — replaced in computeAgentKpis with the kind-aware version.
  void workspaceId;
  void admin;
  return { headline: [], tiers: [] };
};

/**
 * Build the generic tiers for an arbitrary agent kind. Sourced from the SAME tables the
 * bespoke definitions use (agent_jobs / agent_action_grades / agent_coaching_log), so
 * every agent gets a truthful KPI page from day one.
 */
async function computeGenericTiers(opts: {
  agentKind: string;
  workspaceId: string;
  admin: Admin;
}): Promise<{ headline: KpiCard[]; tiers: KpiTier[] }> {
  const { agentKind, workspaceId, admin } = opts;

  const { data: lastJob } = await admin
    .from("agent_jobs")
    .select("updated_at, status")
    .eq("workspace_id", workspaceId)
    .eq("kind", agentKind)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastAt = (lastJob as { updated_at?: string } | null)?.updated_at ?? null;
  const daysSinceLast = daysSince(lastAt);

  const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count: throughput } = await admin
    .from("agent_jobs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("kind", agentKind)
    .gte("updated_at", windowStart)
    .in("status", ["merged", "done", "resolved"]);

  const { count: awaitingCount } = await admin
    .from("agent_jobs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("kind", agentKind)
    .in("status", ["needs_approval", "needs_attention"]);

  const { data: gradeRows } = await admin
    .from("agent_action_grades")
    .select("grade, created_at")
    .eq("workspace_id", workspaceId)
    .eq("agent_kind", agentKind)
    .order("created_at", { ascending: false })
    .limit(10);
  const grades = (gradeRows as Array<{ grade: number | null; created_at: string }> | null) ?? [];
  const avgGrade = (() => {
    const nums = grades.map((g) => g.grade).filter((g): g is number => g !== null);
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  })();

  const { count: coachingCount } = await admin
    .from("agent_coaching_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("agent_kind", agentKind);

  const onItCard: KpiCard = {
    key: "on-it",
    label: "On it",
    value: lastAt ? relativeAge(lastAt) : "no runs on file",
    tone:
      daysSinceLast === null
        ? "neutral"
        : daysSinceLast < 1
        ? "good"
        : daysSinceLast < 3
        ? "neutral"
        : "bad",
    subtitle: (awaitingCount ?? 0) > 0 ? `${awaitingCount} card(s) waiting` : "no cards waiting",
    source: `agent_jobs kind='${agentKind}' (last run + awaiting)`,
  };
  const gradeCard: KpiCard = {
    key: "avg-grade",
    label: "Avg grade (last 10)",
    value: avgGrade !== null ? Number(avgGrade.toFixed(1)) : "—",
    unit: avgGrade !== null ? "/10" : undefined,
    tone:
      avgGrade === null ? "neutral" : avgGrade >= 7 ? "good" : avgGrade >= 5 ? "neutral" : "bad",
    subtitle: `${grades.length} graded action(s)`,
    source: `agent_action_grades agent_kind='${agentKind}'`,
  };

  const tiers: KpiTier[] = [
    {
      key: "activity",
      label: "Activity",
      cards: [
        onItCard,
        {
          key: "throughput",
          label: "Throughput (7d)",
          value: throughput ?? 0,
          tone: (throughput ?? 0) > 0 ? "good" : "neutral",
          subtitle: "merged / done / resolved jobs",
          source: `agent_jobs kind='${agentKind}' updated_at ≥ 7d ago`,
        },
        {
          key: "awaiting-owner",
          label: "Awaiting owner",
          value: awaitingCount ?? 0,
          tone: (awaitingCount ?? 0) === 0 ? "good" : "neutral",
          subtitle: (awaitingCount ?? 0) > 0 ? "action needed" : "no cards waiting",
          source: `agent_jobs status in ('needs_approval','needs_attention')`,
        },
      ],
    },
    {
      key: "quality",
      label: "Quality",
      cards: [
        gradeCard,
        {
          key: "coaching-count",
          label: "Coaching acts",
          value: coachingCount ?? 0,
          tone: "neutral",
          subtitle: "total director→worker coaching entries",
          source: `agent_coaching_log agent_kind='${agentKind}'`,
        },
      ],
    },
  ];

  return { headline: [onItCard, gradeCard], tiers };
}

// Registry of bespoke definitions. Add a new entry to give an agent kind its own tiers;
// otherwise the generic fallback is used automatically.
const REGISTRY: Record<string, KpiDefinition> = {
  "storefront-optimizer": storefrontOptimizerDefinition,
};

// keep the placeholder referenced so the module is self-contained if callers import it
void genericDefinition;

/**
 * Compute the KPI structure for an agent kind. Bespoke definition when one is registered,
 * generic fallback otherwise. Pure reads.
 */
export async function computeAgentKpis(opts: {
  workspaceId: string;
  agentKind: string;
  admin?: Admin;
}): Promise<AgentKpis> {
  const admin = opts.admin ?? createAdminClient();
  const bespoke = REGISTRY[opts.agentKind];
  const built = bespoke
    ? await bespoke({ workspaceId: opts.workspaceId, admin })
    : await computeGenericTiers({
        agentKind: opts.agentKind,
        workspaceId: opts.workspaceId,
        admin,
      });
  return {
    agentKind: opts.agentKind,
    generatedAt: new Date().toISOString(),
    headline: built.headline,
    tiers: built.tiers,
  };
}

/** Introspection helper — the set of kinds with a bespoke definition (page can show a badge). */
export function bespokeAgentKinds(): string[] {
  return Object.keys(REGISTRY);
}

// Re-export types the loaded policy shape (used by the SDK's tone thresholds) so downstream
// consumers can type-safely reason over the policy without importing storefront-policy.
export type { OptimizerPolicy };
