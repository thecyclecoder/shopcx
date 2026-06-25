/**
 * goals-table — the future-canonical read/write surface for the `goals` + `goal_milestones` DB rows.
 *
 * Parallel to `specs-table` (M1 of [[../goals/db-driven-specs]]); authored by
 * [[../specs/goals-milestones-tables-and-backfill]] (Phase 2, M5). Today the goal markdown at
 * `docs/brain/goals/{slug}.md` is still authoritative — `getGoals` / `getGoal` in
 * [[./brain-roadmap]] read it directly via `parseGoal`. This module is the secondary copy + the
 * writer surface that the eventual reader cutover ([[../specs/goal-readers-from-db-retire-parsegoal]])
 * will lean on. The CEO greenlight button ([[../specs/goal-greenlight-button-and-author-writes-db]])
 * calls `setGoalStatus` directly without waiting for the cutover.
 *
 * All writes go through `createAdminClient()` (service role). No client-side goal writes. The DB
 * triggers installed in `20260714120000_goals_and_goal_milestones.sql` enforce the rollup +
 * acyclicity rails — this module never bypasses them.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type GoalStatus = "proposed" | "greenlit" | "complete" | "folded";
export type MilestoneStatus = "planned" | "in_progress" | "complete";

export interface GoalRow {
  id: string;
  workspace_id: string;
  slug: string;
  title: string;
  body: string;
  outcome: string | null;
  success_metric: string | null;
  owner: string;
  proposer_function: string | null;
  parent_goal_id: string | null;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
}

export interface MilestoneRow {
  id: string;
  goal_id: string;
  position: number;
  title: string;
  body: string | null;
  status: MilestoneStatus;
  created_at: string;
  updated_at: string;
}

/** A goal joined with its milestones (ordered by position) — the shape readers compose against. */
export interface GoalWithMilestones extends GoalRow {
  milestones: MilestoneRow[];
}

/** What `upsertGoal` accepts for the milestone list: a desired sequence (position is the array index +
 * 1). Existing rows are matched by `(goal_id, position)` so the milestone's `id` survives a retitle. */
export interface MilestoneInput {
  title: string;
  body?: string | null;
  /** Optional initial status — usually omitted; the rollup trigger derives status from attached specs. */
  status?: MilestoneStatus;
}

/** What `upsertGoal` accepts for the goal card. `slug` is the upsert key (paired with workspace_id). */
export interface GoalInput {
  slug: string;
  title: string;
  body: string;
  outcome?: string | null;
  success_metric?: string | null;
  owner: string;
  proposer_function?: string | null;
  parent_goal_id?: string | null;
  /** Initial status — usually `proposed`; the CEO greenlight surface flips to `greenlit`. */
  status?: GoalStatus;
}

/** Filter knobs for `listGoals` — leave undefined for "all". */
export interface ListGoalsFilter {
  status?: GoalStatus | GoalStatus[];
  owner?: string;
  parent_goal_id?: string | null;
}

/**
 * Read one goal (and its ordered milestones) by `(workspace_id, slug)`. Returns null if no row exists
 * — callers fall back to the markdown reader during the dual-write window.
 */
export async function getGoal(workspaceId: string, slug: string): Promise<GoalWithMilestones | null> {
  const admin = createAdminClient();
  const { data: goal, error: gErr } = await admin
    .from("goals")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (gErr) throw gErr;
  if (!goal) return null;

  const { data: milestones, error: mErr } = await admin
    .from("goal_milestones")
    .select("*")
    .eq("goal_id", goal.id)
    .order("position", { ascending: true });
  if (mErr) throw mErr;

  return { ...(goal as GoalRow), milestones: (milestones ?? []) as MilestoneRow[] };
}

/** List goals for one workspace, optionally filtered. Returns the card rows without milestones — call
 *  `getGoal` for the joined shape. */
export async function listGoals(workspaceId: string, filter?: ListGoalsFilter): Promise<GoalRow[]> {
  const admin = createAdminClient();
  let q = admin.from("goals").select("*").eq("workspace_id", workspaceId);
  if (filter?.status) {
    if (Array.isArray(filter.status)) q = q.in("status", filter.status);
    else q = q.eq("status", filter.status);
  }
  if (filter?.owner) q = q.eq("owner", filter.owner);
  if (filter?.parent_goal_id === null) q = q.is("parent_goal_id", null);
  else if (filter?.parent_goal_id) q = q.eq("parent_goal_id", filter.parent_goal_id);

  const { data, error } = await q.order("title", { ascending: true });
  if (error) throw error;
  return (data ?? []) as GoalRow[];
}

/**
 * UPSERT a goal by `(workspace_id, slug)` + REPLACE its milestones by position. Preserves the
 * milestone `id` across retitle/body-edit (the upsert key on goal_milestones is `(goal_id, position)`),
 * so any `specs.milestone_id` FK pointing at the milestone survives. A position no longer present
 * is DELETED (cascades nothing — `specs.milestone_id` FK is `on delete set null`, so a removed
 * milestone unattaches its specs instead of cascading them out).
 *
 * Returns the resulting `GoalWithMilestones` shape. Status is intentionally never UPSERTed once the
 * row exists (so a re-run backfill doesn't blow away a CEO greenlight) — pass `status` only when
 * INSERTing for the first time; updates to an existing row leave `status` alone.
 */
export async function upsertGoal(
  workspaceId: string,
  goal: GoalInput,
  milestones: MilestoneInput[],
): Promise<GoalWithMilestones> {
  const admin = createAdminClient();

  const { data: existing, error: eErr } = await admin
    .from("goals")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("slug", goal.slug)
    .maybeSingle();
  if (eErr) throw eErr;

  const upsertRow: Record<string, unknown> = {
    workspace_id: workspaceId,
    slug: goal.slug,
    title: goal.title,
    body: goal.body,
    outcome: goal.outcome ?? null,
    success_metric: goal.success_metric ?? null,
    owner: goal.owner,
    proposer_function: goal.proposer_function ?? null,
    parent_goal_id: goal.parent_goal_id ?? null,
    updated_at: new Date().toISOString(),
  };
  // Only set status on FIRST insert — a re-upsert leaves a CEO-greenlit row alone.
  if (!existing && goal.status) upsertRow.status = goal.status;

  const { data: upserted, error: uErr } = await admin
    .from("goals")
    .upsert(upsertRow, { onConflict: "workspace_id,slug" })
    .select("*")
    .single();
  if (uErr) throw uErr;
  const goalRow = upserted as GoalRow;

  // Replace milestones by position. Match existing by (goal_id, position) so id survives.
  const { data: existingMs, error: mErr } = await admin
    .from("goal_milestones")
    .select("id, position")
    .eq("goal_id", goalRow.id);
  if (mErr) throw mErr;
  const existingByPos = new Map<number, string>();
  for (const m of (existingMs ?? []) as Array<{ id: string; position: number }>) {
    existingByPos.set(m.position, m.id);
  }

  const desiredPositions = new Set<number>();
  for (let i = 0; i < milestones.length; i++) {
    const position = i + 1;
    desiredPositions.add(position);
    const ms = milestones[i];
    const prevId = existingByPos.get(position);
    const row: Record<string, unknown> = {
      goal_id: goalRow.id,
      position,
      title: ms.title,
      body: ms.body ?? null,
      updated_at: new Date().toISOString(),
    };
    if (prevId) row.id = prevId;
    // Same status-on-first-insert-only rule: don't clobber a rolled-up status with a stale input.
    if (!prevId && ms.status) row.status = ms.status;

    const { error: msErr } = await admin
      .from("goal_milestones")
      .upsert(row, { onConflict: "goal_id,position" });
    if (msErr) throw msErr;
  }

  // Delete milestones that fell off the end of the list (positions no longer present). Removed
  // milestones unattach their specs via the `on delete set null` FK — they don't cascade out.
  const toDelete: string[] = [];
  for (const [pos, id] of existingByPos) {
    if (!desiredPositions.has(pos)) toDelete.push(id);
  }
  if (toDelete.length) {
    const { error: dErr } = await admin.from("goal_milestones").delete().in("id", toDelete);
    if (dErr) throw dErr;
  }

  const { data: finalMs, error: fErr } = await admin
    .from("goal_milestones")
    .select("*")
    .eq("goal_id", goalRow.id)
    .order("position", { ascending: true });
  if (fErr) throw fErr;

  return { ...goalRow, milestones: (finalMs ?? []) as MilestoneRow[] };
}

/**
 * Set a goal's lifecycle status — the CEO-greenlight write surface for
 * [[../specs/goal-greenlight-button-and-author-writes-db]] (`proposed → greenlit`), and the rare
 * manual override (e.g. `greenlit → complete` when the rollup hasn't caught up). The DB trigger
 * `goal_milestones_rollup` handles the common `greenlit → complete` auto-flip — call this only for
 * actor-driven transitions. `actor` is recorded for audit (free-text — `ceo`, the function slug, or
 * `backfill`).
 */
export async function setGoalStatus(
  goalId: string,
  status: GoalStatus,
  _actor: string,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("goals")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", goalId);
  if (error) throw error;
}

/**
 * Set a milestone's status directly. Rare — the spec-side trigger `specs_milestone_rollup` keeps
 * `goal_milestones.status` consistent with the attached specs. Use only when the rollup would
 * disagree intentionally (e.g. a director cuts a milestone the rollup can't observe).
 */
export async function setMilestoneStatus(milestoneId: string, status: MilestoneStatus): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("goal_milestones")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", milestoneId);
  if (error) throw error;
}

/**
 * Attach a spec to a milestone via `public.specs.milestone_id`. A single UPDATE — the planner calls
 * this when a leaf spec lands. Pass `null` to detach (the standalone-spec shape). The spec-side
 * trigger fires the milestone + goal rollups automatically.
 */
export async function attachSpecToMilestone(specId: string, milestoneId: string | null): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("specs")
    .update({ milestone_id: milestoneId, updated_at: new Date().toISOString() })
    .eq("id", specId);
  if (error) throw error;
}
