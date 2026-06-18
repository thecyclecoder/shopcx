/**
 * agent_jobs — the build queue (server-side helpers). The dashboard "Build" button
 * inserts a row; the box worker claims it via claim_agent_job() and drives it to a PR.
 * See docs/brain/specs/roadmap-build-console.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type JobStatus =
  | "queued"
  | "claimed"
  | "building"
  | "needs_input"
  | "needs_approval"
  | "queued_resume"
  | "completed"
  | "merged"
  | "failed"
  | "needs_attention";

export interface JobQuestion {
  id: string;
  q: string;
  options?: string[];
}

// "spec" is the planner's proposed-branch action (Goal Decomposition Engine): approving it means
// "author this spec + queue its build" — no shell command, the worker authors it on resume.
export type GatedActionType = "apply_migration" | "run_prod_script" | "merge_pr" | "spec";

/** A prod-side-effect the build needs the owner to approve. `cmd` is the exact command the worker runs on approval (also shown as the preview). */
export interface PendingAction {
  id: string;
  type: GatedActionType;
  summary: string;
  cmd?: string;
  preview?: string;
  status: "pending" | "approved" | "declined" | "done" | "failed";
  result?: string;
  /** For type "spec": the slug the worker will author as docs/brain/specs/{slug}.md on approval. */
  specSlug?: string;
}

/** A build job builds a spec → PR; a plan job decomposes a goal → proposed spec tree. */
export type JobKind = "build" | "plan";

export interface AgentJob {
  id: string;
  workspace_id: string;
  /** For a build job: the spec slug. For a plan job: the GOAL slug being decomposed. */
  spec_slug: string;
  spec_branch: string | null;
  kind: JobKind;
  status: JobStatus;
  claude_session_id: string | null;
  questions: JobQuestion[];
  answers: { id: string; answer: string }[];
  pending_actions: PendingAction[];
  pr_url: string | null;
  pr_number: number | null;
  log_tail: string | null;
  error: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Statuses where a build is live (no new build should be queued for the same spec). */
export const ACTIVE_STATUSES: JobStatus[] = ["queued", "claimed", "building", "needs_input", "queued_resume"];

export function isActive(status: JobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** Latest job per spec for a workspace (newest wins) — drives the board's per-card status. */
export async function getLatestJobsBySlug(workspaceId: string): Promise<Record<string, AgentJob>> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(500);
  const map: Record<string, AgentJob> = {};
  for (const j of (data ?? []) as AgentJob[]) {
    if (!map[j.spec_slug]) map[j.spec_slug] = j;
  }
  return map;
}

/**
 * Latest PLAN job for a goal (Goal Decomposition Engine). Filtered by kind in JS (not a `.eq`) so
 * it's safe before the `agent_jobs.kind` migration is applied — pre-migration rows have no kind, so
 * none match and this returns null. A goal slug shares the spec_slug column; kind disambiguates.
 */
export async function getLatestPlanJob(workspaceId: string, goalSlug: string): Promise<AgentJob | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", goalSlug)
    .order("created_at", { ascending: false })
    .limit(20);
  const rows = (data ?? []) as AgentJob[];
  return rows.find((j) => j.kind === "plan") ?? null;
}

const GH_REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
function ghToken() {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

/**
 * Self-heal: a `completed` job whose PR was merged/closed OUTSIDE the dashboard (e.g. merged on
 * GitHub directly) still shows a stale "Squash & merge" button. Check GitHub; if the PR is no
 * longer open, flip the job to `merged` (mutates the passed jobs in place + persists).
 */
export async function reconcileMergedJobs(jobs: AgentJob[]): Promise<void> {
  const tok = ghToken();
  if (!tok) return;
  const stale = jobs.filter((j) => j.status === "completed" && j.pr_number);
  if (!stale.length) return;
  const admin = createAdminClient();
  await Promise.all(
    stale.map(async (j) => {
      try {
        const res = await fetch(`https://api.github.com/repos/${GH_REPO}/pulls/${j.pr_number}`, {
          headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json" },
          cache: "no-store",
        });
        if (!res.ok) return;
        const pr = (await res.json()) as { merged?: boolean; state?: string };
        if (pr.merged || pr.state === "closed") {
          j.status = "merged";
          await admin.from("agent_jobs").update({ status: "merged", updated_at: new Date().toISOString() }).eq("id", j.id);
        }
      } catch {
        /* transient — try again next load */
      }
    }),
  );
}
