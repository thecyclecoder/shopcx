/**
 * build-goal-materializer — the goal analogue of [[build-spec-materializer]]
 * ([[../specs/goal-fold-from-db-row]] Phase 1).
 *
 * A goal lives in `public.goals` + `public.goal_milestones` ([[../tables/goals]] · [[../tables/goal_milestones]]),
 * with its child specs in `public.specs` (`milestone_id` FK). When a COMPLETE goal is folded, the
 * fold-agent reads the goal's NARRATIVE — but there is NO `docs/brain/goals/{slug}.md` (the per-goal
 * markdown was retired in [[../specs/goal-readers-from-db-retire-parsegoal]]). So, exactly like
 * `materializeSpec` does for a spec row, the worker materializes the goal ROW (+ its milestones + the
 * joined child specs per milestone) to a gitignored temp `{cwd}/.box/goal-{slug}.md` and hands the
 * fold-agent THAT path. The agent folds the durable knowledge into the PERMANENT brain pages
 * (lifecycles/ · dashboard/ · functions/ · tables/ · libraries/) — it NEVER writes
 * `docs/brain/goals/{slug}.md`. The preserved `public.goals` row (flipped to `status='folded'`) IS the
 * archive.
 *
 * Mirrors `materializeSpec`'s contract: write to a temp `.box` file, return its absolute path, never
 * touch `docs/brain/goals/`.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getGoal, type GoalRow, type GoalMilestoneRow } from "@/lib/goals-table";
import { listSpecs, type SpecRow } from "@/lib/specs-table";

/** One milestone rendered as a `### {title}` block with its child specs, for the fold renderer. */
export interface MaterializedMilestone {
  milestone: GoalMilestoneRow;
  specs: SpecRow[];
}

/**
 * Render a COMPLETE goal row to disk in a markdown shape the fold-agent reads — the H1, the goal's
 * meta (Owner / Outcome / Why now / Model / Target / Success metric), and the milestone → child-spec
 * decomposition. Returns the absolute path written. Throws when no `goals` row exists for
 * `(workspaceId, slug)`. The file lands in `dir` (the worker passes `{worktree}/.box`), NEVER in
 * `docs/brain/goals/`.
 */
export async function materializeGoal(workspaceId: string, slug: string, dir: string): Promise<string> {
  const row = await getGoal(workspaceId, slug);
  if (!row) throw new Error(`materializeGoal: no goals row for workspace ${workspaceId} slug ${slug}`);

  // Resolve each milestone's child specs (the FULL spec set for the workspace, grouped by milestone_id).
  const allSpecs = await listSpecs(workspaceId);
  const byMilestone = new Map<string, SpecRow[]>();
  for (const s of allSpecs) {
    if (!s.milestone_id) continue;
    const list = byMilestone.get(s.milestone_id) ?? [];
    list.push(s);
    byMilestone.set(s.milestone_id, list);
  }
  const milestones: MaterializedMilestone[] = row.milestones.map((m) => ({
    milestone: m,
    specs: (byMilestone.get(m.id) ?? []).sort((a, b) => a.slug.localeCompare(b.slug)),
  }));

  const body = renderGoalRow(row, milestones);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `goal-${slug}.md`);
  writeFileSync(path, body, "utf8");
  return path;
}

/**
 * Pure renderer (no I/O) — joins a `goals` row + its `goal_milestones` + the joined child `specs` into
 * the goal-narrative markdown the fold-agent reads. Exported so tests / the brain page can show the
 * exact shape without disk. NO status emoji on the H1 (status is DB-driven, mirroring `renderSpecRow`).
 */
export function renderGoalRow(row: GoalRow, milestones: MaterializedMilestone[]): string {
  const parts: string[] = [];

  parts.push(`# ${row.title}`, "");

  const meta: string[] = [];
  if (row.owner) meta.push(`**Owner:** [[../functions/${row.owner}]]`);
  if (row.proposer_function) meta.push(`**Proposed-by:** [[../functions/${row.proposer_function}]]`);
  meta.push(`**Status:** ${row.status}`);
  if (meta.length) parts.push(meta.join(" · "), "");

  if (row.outcome && row.outcome.trim()) parts.push(`**Outcome:** ${row.outcome.trim()}`, "");
  if (row.success_metric && row.success_metric.trim()) {
    parts.push(`**Success metric:** ${row.success_metric.trim()}`, "");
  }

  // The goal's free-form body (Why now / Model / Target / decomposition prose) — verbatim. It already
  // carries the **Target:** / **Why now:** / **Model:** lines the GoalCard surfaces.
  if (row.body && row.body.trim()) parts.push(row.body.trim(), "");

  if (milestones.length) {
    parts.push("## Decomposition", "");
    for (const { milestone, specs } of milestones) {
      parts.push(`### ${milestone.title}  _(${milestone.status})_`);
      if (milestone.body && milestone.body.trim()) parts.push(milestone.body.trim());
      if (specs.length) {
        parts.push("");
        for (const s of specs) {
          parts.push(`- [[../specs/${s.slug}]] — ${s.title} _(${s.status})_`);
        }
      }
      parts.push("");
    }
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
