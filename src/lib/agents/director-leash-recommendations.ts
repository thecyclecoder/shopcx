/**
 * Director-grade feedback → leash-adjustment recommendations (director-loop-grading spec, Phase 4;
 * M5 of the devops-director goal). The other half of the grading loop: Phase 3 WROTE the grades
 * (director_decision_grades); this reads them back and turns a SUSTAINED grade signal into an
 * owner-confirmed recommendation to tighten/loosen the Platform/DevOps Director's autonomy envelope.
 *
 * One level up the org chart from the storefront campaign loop's loadLeverGradeSignal: there a
 * sustained per-lever grade nudges the optimizer's lever selection; here a sustained per-dimension /
 * per-leash-category grade RECOMMENDS widening or narrowing the director's `live + autonomous` leash
 * (function_autonomy). It mirrors the same shape — read grades, aggregate by category, compute a
 * trend — one supervisory level higher.
 *
 * THE NORTH-STAR INVARIANT (operational-rules § supervisable autonomy; spec § Safety): this is a
 * SUPERVISED TOOL that only RECOMMENDS. It NEVER writes function_autonomy, never widens the leash.
 * The CEO disposes — the actual envelope change is the owner toggling Autonomy on the Agents hub
 * (POST /api/developer/agents/autonomy). A recommendation is advisory text + the current envelope so
 * the CEO can act; the loop can never promote itself.
 *
 * Pure read + aggregation (best-effort): no side effects, computed on demand for the report surface
 * (GET /api/developer/agents/grades). See docs/brain/libraries/director-leash-recommendations.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { loadAutonomyMap } from "@/lib/agents/approval-router";
import { PLATFORM } from "@/lib/agents/platform-director";
import { GROWTH } from "@/lib/agents/growth-director";
import type { GradeDimension } from "@/lib/agents/director-grader";

type Admin = ReturnType<typeof createAdminClient>;

/** Director-function slugs the leash report knows how to render — Platform and Growth today. */
export const REPORTABLE_DIRECTOR_FUNCTIONS = [PLATFORM, GROWTH] as const;
export type DirectorFunction = (typeof REPORTABLE_DIRECTOR_FUNCTIONS)[number];

// ── Tuning (the thresholds that turn a grade trend into a recommendation) ──────────────────────────
/** Min graded calls in a scope before we'll recommend anything — no envelope move on one lucky call. */
export const MIN_SAMPLE = 3;
/** A sustained average at/above this → the director's calls are reliably sound → recommend LOOSEN. */
export const LOOSEN_AVG = 8;
/** A sustained average at/below this → the director's calls are shaky → recommend TIGHTEN (revert to CEO). */
export const TIGHTEN_AVG = 4.5;
/** How many of the most-recent grades define the "recent" half of the trend. */
const RECENT_WINDOW = 8;
/** A recent-vs-prior delta beyond this flips the trend arrow off flat. */
const TREND_EPSILON = 0.75;
/** A human override that moves the grade by ≥ this many points is a calibration signal → propose a rule. */
export const OVERRIDE_GAP_RULE_THRESHOLD = 3;

/** The leash-action type → leash category map, mirrored from platform-director's LEASH_ACTION_TYPES
 *  (kept local so this read-only report never imports the runner's action-shape plumbing). */
const LEASH_ACTION_CATEGORY: Record<string, string> = {
  repair_build: "error_fix",
  db_health_build: "db_health",
  apply_migration: "additive_migration",
};

export type RecommendationAction = "loosen" | "tighten" | "hold";
export type Trend = "up" | "down" | "flat" | null;

export interface DimensionStat {
  dimension: GradeDimension;
  graded: number;
  avgGrade: number | null;
  recentAvg: number | null;
  priorAvg: number | null;
  trend: Trend;
  trendPoints: Array<{ at: string; grade: number }>;
}

export interface CategoryStat {
  /** A leash category (error_fix | db_health | additive_migration | monitoring_fix). */
  category: string;
  graded: number;
  avgGrade: number | null;
}

export interface LeashRecommendation {
  /** Stable key for the UI (e.g. "loosen:auto-approval" or "tighten:auto-approval:db_health"). */
  id: string;
  scope: "dimension" | "category";
  dimension: GradeDimension;
  category: string | null;
  action: Exclude<RecommendationAction, "hold">;
  sampleSize: number;
  avgGrade: number;
  rationale: string;
}

export interface DirectorGradeRow {
  id: string;
  dimension: GradeDimension;
  grade: number | null;
  reasoning: string | null;
  graded_by: "agent" | "human";
  overridden_by: string | null;
  /** A human-readable label for the graded call (e.g. "db_health · spec-foo" or "goal-x · M4"). */
  target_label: string;
  /** The leash category for an auto-approval row (null for goal-escort / when underivable). */
  leash_category: string | null;
  created_at: string;
}

export interface DirectorGradeReport {
  dimensions: DimensionStat[];
  categories: CategoryStat[];
  /** Only the ACTIONABLE recommendations (loosen / tighten); a "hold" scope is omitted. */
  recommendations: LeashRecommendation[];
  rows: DirectorGradeRow[];
  proposedRules: Array<{ id: string; title: string; content: string; created_at: string }>;
  /** The current Platform autonomy envelope — so the report shows state vs. recommendation. */
  autonomy: { function: string; live: boolean; autonomous: boolean };
  generatedAt: string;
}

interface RawGradeRow {
  id: string;
  dimension: GradeDimension;
  approval_decision_id: string | null;
  goal_slug: string | null;
  milestone: string | null;
  grade: number | null;
  reasoning: string | null;
  graded_by: "agent" | "human";
  overridden_by: string | null;
  created_at: string;
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

/**
 * Resolve each auto-approval grade's leash category: grade → approval_decisions.agent_job_id →
 * agent_jobs.pending_actions → the approved action's type → LEASH_ACTION_CATEGORY. Best-effort,
 * two batched reads; a row we can't resolve simply gets a null category (and a fallback label).
 */
async function resolveAutoApprovalContext(
  admin: Admin,
  rows: RawGradeRow[],
): Promise<Map<string, { category: string | null; specSlug: string | null }>> {
  const out = new Map<string, { category: string | null; specSlug: string | null }>();
  const decisionIds = rows
    .filter((r) => r.dimension === "auto-approval" && r.approval_decision_id)
    .map((r) => r.approval_decision_id as string);
  if (!decisionIds.length) return out;

  const { data: decisions } = await admin
    .from("approval_decisions")
    .select("id, agent_job_id")
    .in("id", decisionIds);
  const decById = new Map((decisions || []).map((d) => [d.id as string, (d.agent_job_id as string | null) ?? null]));

  const jobIds = Array.from(new Set((decisions || []).map((d) => d.agent_job_id as string | null).filter(Boolean) as string[]));
  const jobById = new Map<string, { spec_slug: string | null; pending_actions: Array<{ type?: string; status?: string }> | null }>();
  if (jobIds.length) {
    const { data: jobs } = await admin.from("agent_jobs").select("id, spec_slug, pending_actions").in("id", jobIds);
    for (const j of jobs || []) {
      jobById.set(j.id as string, {
        spec_slug: (j.spec_slug as string | null) ?? null,
        pending_actions: (j.pending_actions as Array<{ type?: string; status?: string }> | null) ?? null,
      });
    }
  }

  for (const r of rows) {
    if (r.dimension !== "auto-approval" || !r.approval_decision_id) continue;
    const jobId = decById.get(r.approval_decision_id) ?? null;
    const job = jobId ? jobById.get(jobId) : undefined;
    const action = (job?.pending_actions || []).find((a) => a.status === "approved") || (job?.pending_actions || [])[0];
    const category = action?.type ? LEASH_ACTION_CATEGORY[action.type] ?? null : null;
    out.set(r.id, { category, specSlug: job?.spec_slug ?? null });
  }
  return out;
}

/** Compute the recent-vs-prior trend over a dimension's grades (oldest→newest input). */
function trendOf(gradesOldestFirst: number[]): { recentAvg: number | null; priorAvg: number | null; trend: Trend } {
  if (gradesOldestFirst.length < 2) return { recentAvg: avg(gradesOldestFirst), priorAvg: null, trend: null };
  const recent = gradesOldestFirst.slice(-Math.min(RECENT_WINDOW, Math.ceil(gradesOldestFirst.length / 2)));
  const prior = gradesOldestFirst.slice(0, gradesOldestFirst.length - recent.length);
  const recentAvg = avg(recent);
  const priorAvg = avg(prior);
  let trend: Trend = "flat";
  if (recentAvg != null && priorAvg != null) {
    if (recentAvg - priorAvg >= TREND_EPSILON) trend = "up";
    else if (priorAvg - recentAvg >= TREND_EPSILON) trend = "down";
  } else {
    trend = null;
  }
  return { recentAvg, priorAvg, trend };
}

function dimensionLabel(d: GradeDimension): string {
  return d === "auto-approval" ? "auto-approvals" : "goal escorts";
}

/** Turn a scope's (sample, avg, trend) into a loosen/tighten recommendation, or null for "hold". */
function recommendFor(opts: {
  scope: "dimension" | "category";
  dimension: GradeDimension;
  category: string | null;
  graded: number;
  avgGrade: number | null;
  trend?: Trend;
}): LeashRecommendation | null {
  const { scope, dimension, category, graded, avgGrade, trend } = opts;
  if (graded < MIN_SAMPLE || avgGrade == null) return null;
  const what = category ? `${category} ${dimensionLabel(dimension)}` : dimensionLabel(dimension);

  if (avgGrade >= LOOSEN_AVG && trend !== "down") {
    return {
      id: `loosen:${dimension}${category ? `:${category}` : ""}`,
      scope,
      dimension,
      category,
      action: "loosen",
      sampleSize: graded,
      avgGrade,
      rationale: `Sustained high grades (avg ${avgGrade}/10 over ${graded} ${what}). The director's calls here are reliably sound — you can widen its autonomy envelope to cover this category. Confirm via the Autonomy toggle; the loop never widens its own leash.`,
    };
  }
  if (avgGrade <= TIGHTEN_AVG) {
    return {
      id: `tighten:${dimension}${category ? `:${category}` : ""}`,
      scope,
      dimension,
      category,
      action: "tighten",
      sampleSize: graded,
      avgGrade,
      rationale: `Low grades (avg ${avgGrade}/10 over ${graded} ${what}). These calls aren't holding up — narrow the leash (revert this category to CEO-gated) by turning Autonomy off until the grades recover.`,
    };
  }
  return null;
}

/**
 * Read every director grade for the workspace and compute the Phase-4 feedback report: per-dimension
 * + per-leash-category stats with a trend, the actionable leash-adjustment recommendations, the
 * recent grade rows (for the table + override), the proposed calibration rules awaiting CEO review,
 * and the current director-function autonomy envelope. Best-effort: a read failure degrades to an
 * empty report.
 *
 * `directorFunction` selects which director's grades + autonomy envelope the report covers. Default
 * is PLATFORM (the original Phase-4 caller); growth-adopt-meta-iteration-engine Phase 2 adds GROWTH
 * so the API can return a per-director slice for the Agents-hub Director-grades tab.
 */
export async function computeDirectorGradeReport(opts: {
  workspaceId: string;
  admin?: Admin;
  directorFunction?: string;
}): Promise<DirectorGradeReport> {
  const admin = opts.admin ?? createAdminClient();
  const directorFunction = opts.directorFunction || PLATFORM;
  const generatedAt = new Date().toISOString();
  const empty: DirectorGradeReport = {
    dimensions: [],
    categories: [],
    recommendations: [],
    rows: [],
    proposedRules: [],
    autonomy: { function: directorFunction, live: false, autonomous: false },
    generatedAt,
  };

  try {
    const [{ data: gradeData }, autonomyMap, { data: ruleData }] = await Promise.all([
      admin
        .from("director_decision_grades")
        .select("id, dimension, approval_decision_id, goal_slug, milestone, grade, reasoning, graded_by, overridden_by, created_at")
        .eq("workspace_id", opts.workspaceId)
        .eq("director_function", directorFunction)
        .order("created_at", { ascending: false })
        .limit(500),
      loadAutonomyMap(),
      admin
        .from("director_grader_prompts")
        .select("id, title, content, created_at")
        .eq("workspace_id", opts.workspaceId)
        .eq("status", "proposed")
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

    const raw = (gradeData as RawGradeRow[] | null) ?? [];
    const autonomy = autonomyMap[directorFunction] ?? { live: false, autonomous: false };
    const ctxById = await resolveAutoApprovalContext(admin, raw);

    // ── rows (newest-first, for the table + override) ──────────────────────────────────────────────
    const rows: DirectorGradeRow[] = raw.map((r) => {
      const ctx = ctxById.get(r.id);
      const leashCategory = r.dimension === "auto-approval" ? ctx?.category ?? null : null;
      const target_label =
        r.dimension === "goal-escort"
          ? `${r.goal_slug ?? "—"}${r.milestone ? ` · ${r.milestone}` : ""}`
          : `${leashCategory ?? "auto-approval"}${ctx?.specSlug ? ` · ${ctx.specSlug}` : ""}`;
      return {
        id: r.id,
        dimension: r.dimension,
        grade: r.grade,
        reasoning: r.reasoning,
        graded_by: r.graded_by,
        overridden_by: r.overridden_by,
        target_label,
        leash_category: leashCategory,
        created_at: r.created_at,
      };
    });

    // ── per-dimension stats + trend (oldest→newest within each dimension) ──────────────────────────
    const dimensions: DimensionStat[] = [];
    for (const dim of ["auto-approval", "goal-escort"] as GradeDimension[]) {
      const inDim = raw.filter((r) => r.dimension === dim && typeof r.grade === "number");
      const oldestFirst = [...inDim].reverse(); // raw is newest-first
      const grades = oldestFirst.map((r) => r.grade as number);
      if (!grades.length) continue;
      const { recentAvg, priorAvg, trend } = trendOf(grades);
      dimensions.push({
        dimension: dim,
        graded: grades.length,
        avgGrade: avg(grades),
        recentAvg,
        priorAvg,
        trend,
        trendPoints: oldestFirst.map((r) => ({ at: r.created_at, grade: r.grade as number })),
      });
    }

    // ── per-leash-category stats (auto-approval only) ──────────────────────────────────────────────
    const catGrades = new Map<string, number[]>();
    for (const r of raw) {
      if (r.dimension !== "auto-approval" || typeof r.grade !== "number") continue;
      const cat = ctxById.get(r.id)?.category;
      if (!cat) continue;
      const list = catGrades.get(cat) ?? [];
      list.push(r.grade);
      catGrades.set(cat, list);
    }
    const categories: CategoryStat[] = Array.from(catGrades.entries())
      .map(([category, grades]) => ({ category, graded: grades.length, avgGrade: avg(grades) }))
      .sort((a, b) => b.graded - a.graded);

    // ── recommendations (loosen / tighten only — "hold" is omitted) ────────────────────────────────
    const recommendations: LeashRecommendation[] = [];
    for (const d of dimensions) {
      const rec = recommendFor({ scope: "dimension", dimension: d.dimension, category: null, graded: d.graded, avgGrade: d.avgGrade, trend: d.trend });
      if (rec) recommendations.push(rec);
    }
    for (const c of categories) {
      const rec = recommendFor({ scope: "category", dimension: "auto-approval", category: c.category, graded: c.graded, avgGrade: c.avgGrade });
      if (rec) recommendations.push(rec);
    }

    return {
      dimensions,
      categories,
      recommendations,
      rows,
      proposedRules: (ruleData as Array<{ id: string; title: string; content: string; created_at: string }> | null) ?? [],
      autonomy: { function: directorFunction, live: !!autonomy.live, autonomous: !!autonomy.autonomous },
      generatedAt,
    };
  } catch (e) {
    console.warn(`[director-leash-recommendations] report failed ws=${opts.workspaceId} fn=${directorFunction}: ${errText(e)}`);
    return empty;
  }
}
