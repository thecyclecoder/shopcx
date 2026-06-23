/**
 * Director XP — the derived, display-only "gamification" stats per director
 * (directors-board-gamified spec, Phase 3).
 *
 * A per-function XP view computed ENTIRELY from existing truth — no new event capture
 * (the spec's invariant: "XP is derived, not gospel … a gamified proxy, never an objective
 * the directors optimize", docs/brain/operational-rules.md § North star). Four counts per
 * director (function slug):
 *
 *   - specsShipped   — merged builds owned by the function (agent_jobs kind='build' status='merged',
 *                      mapped to its owner via the live spec→owner map from brain-roadmap).
 *   - bugsFixed      — approved repair/regression fixes it handled (approval_decisions decision='approved'
 *                      whose raising agent_jobs row is kind ∈ {repair, regression}, by raised_by_function).
 *   - goalsEscorted  — milestones advanced: shipped milestones across the goals the function owns
 *                      (brain-roadmap getGoals × the function's goalSlugs).
 *   - streak         — consecutive active UTC days in director_activity for the function.
 *
 * Server-only (createAdminClient + brain-roadmap fs reads). Surfaced by GET /api/developer/agents/xp →
 * the XP card on each director's row in the Agents hub. See docs/brain/libraries/director-xp.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap, getFunctions, getGoals } from "@/lib/brain-roadmap";

export interface DirectorXp {
  /** merged builds owned by the function. */
  specsShipped: number;
  /** approved repair/regression fixes it handled. */
  bugsFixed: number;
  /** milestones advanced (shipped) across the goals it owns. */
  goalsEscorted: number;
  /** consecutive active UTC days in director_activity. */
  streak: number;
}

export type DirectorXpMap = Record<string, DirectorXp>;

const emptyXp = (): DirectorXp => ({ specsShipped: 0, bugsFixed: 0, goalsEscorted: 0, streak: 0 });

/** The job kinds whose approved request is a "bug fixed" (the Platform repair/regression workers). */
const FIX_JOB_KINDS = new Set(["repair", "regression"]);

const DAY_MS = 86_400_000;
const utcDay = (iso: string): string => iso.slice(0, 10); // timestamptz serializes UTC → leading YYYY-MM-DD is the UTC date

/**
 * Consecutive active days ending today (UTC). The streak is unbroken if there's activity today; a day with
 * no activity yet doesn't break it until it passes, so we anchor on today OR yesterday, then count back while
 * each prior day is present. An empty set or a gap older than yesterday ⇒ 0.
 */
function computeStreak(days: Set<string>): number {
  if (days.size === 0) return 0;
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  let cursor: number;
  if (days.has(fmt(todayMs))) cursor = todayMs;
  else if (days.has(fmt(todayMs - DAY_MS))) cursor = todayMs - DAY_MS;
  else return 0;

  let streak = 0;
  while (days.has(fmt(cursor))) {
    streak++;
    cursor -= DAY_MS;
  }
  return streak;
}

/**
 * Compute the XP map for every director (function slug) in one pass. Each metric reads from an existing
 * signal — display-only, reconciles against agent_jobs / approval_decisions / brain-roadmap on inspection.
 */
export async function getDirectorXp(workspaceId: string): Promise<DirectorXpMap> {
  const admin = createAdminClient();
  const [{ specs }, functions, goals] = await Promise.all([getRoadmap(), getFunctions(), getGoals()]);

  // Seed a zeroed entry for every known function — we only ever attribute to a real director.
  const xp: DirectorXpMap = {};
  for (const fn of functions) xp[fn.slug] = emptyXp();

  // spec slug → owner function (live specs only — a folded spec leaves specs/, so this is a display proxy).
  const ownerBySpec = new Map<string, string>();
  for (const s of specs) if (s.owner) ownerBySpec.set(s.slug, s.owner);

  // 1. specsShipped — merged builds owned by the function.
  const { data: merged } = await admin
    .from("agent_jobs")
    .select("spec_slug")
    .eq("workspace_id", workspaceId)
    .eq("kind", "build")
    .eq("status", "merged");
  for (const row of (merged ?? []) as { spec_slug: string | null }[]) {
    const owner = row.spec_slug ? ownerBySpec.get(row.spec_slug) : undefined;
    if (owner && xp[owner]) xp[owner].specsShipped++;
  }

  // 2. bugsFixed — approved approval_decisions whose raising job is a repair/regression fix.
  const { data: approvals } = await admin
    .from("approval_decisions")
    .select("agent_job_id, raised_by_function")
    .eq("workspace_id", workspaceId)
    .eq("decision", "approved");
  const approvalRows = (approvals ?? []) as { agent_job_id: string | null; raised_by_function: string }[];
  const jobIds = [...new Set(approvalRows.map((r) => r.agent_job_id).filter((id): id is string => !!id))];
  const jobKind = new Map<string, string>();
  if (jobIds.length) {
    const { data: jobs } = await admin.from("agent_jobs").select("id, kind").in("id", jobIds);
    for (const j of (jobs ?? []) as { id: string; kind: string }[]) jobKind.set(j.id, j.kind);
  }
  for (const r of approvalRows) {
    if (!r.agent_job_id) continue;
    const kind = jobKind.get(r.agent_job_id);
    if (kind && FIX_JOB_KINDS.has(kind) && xp[r.raised_by_function]) xp[r.raised_by_function].bugsFixed++;
  }

  // 3. goalsEscorted — shipped milestones across the goals the function owns/contributes to.
  const goalBySlug = new Map(goals.map((g) => [g.slug, g]));
  for (const fn of functions) {
    let escorted = 0;
    for (const gslug of fn.goalSlugs) {
      const goal = goalBySlug.get(gslug);
      if (!goal) continue;
      escorted += goal.milestones.filter((m) => m.status === "shipped" || m.completion >= 1).length;
    }
    xp[fn.slug].goalsEscorted = escorted;
  }

  // 4. streak — consecutive active UTC days from director_activity.
  const { data: activity } = await admin
    .from("director_activity")
    .select("director_function, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(5000);
  const daysByFn = new Map<string, Set<string>>();
  for (const a of (activity ?? []) as { director_function: string; created_at: string }[]) {
    if (!xp[a.director_function]) continue;
    const set = daysByFn.get(a.director_function) ?? new Set<string>();
    set.add(utcDay(a.created_at));
    daysByFn.set(a.director_function, set);
  }
  for (const [fn, days] of daysByFn) xp[fn].streak = computeStreak(days);

  return xp;
}
