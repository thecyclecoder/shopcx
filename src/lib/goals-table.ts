/**
 * goals-table — the future-canonical read/write surface for `public.goals` + `public.goal_milestones`
 * ([[../tables/goals]] · [[../tables/goal_milestones]]), the DB-resident goal hierarchy
 * (db-driven-specs M5, [[../specs/goals-milestones-tables-and-backfill]] Phase 2).
 *
 * Parallel to [[brain-roadmap]] `getGoals` / `getGoal` (markdown-backed) until
 * [[../specs/goal-readers-from-db-retire-parsegoal]] cuts the readers over. This module ONLY adds the
 * writer + read surface — no caller has been retargeted yet. The backfill
 * ([[../recipes/backfill-goals-from-markdown]]) fills the rows.
 *
 * Key invariants:
 *  - `goal_milestones.status` is rolled up FROM `public.specs.status` by the DB trigger
 *    `specs_milestone_rollup` (NOT in app code). Any child spec in_progress → milestone in_progress;
 *    all child specs shipped|folded → milestone complete; else planned.
 *  - `goals.status` is rolled up FROM `goal_milestones.status` by `goal_milestones_rollup`. A
 *    `proposed` or `folded` goal is terminal-ish — the rollup leaves it alone. Only a `greenlit` goal
 *    auto-flips to `complete` when every milestone is `complete`; **a proposed goal NEVER auto-flips**
 *    (the proposed → greenlit step is the CEO-only path in
 *    [[../specs/goal-greenlight-button-and-author-writes-db]]).
 *  - `goal_milestones.id` is STABLE across reorders + retitles — the `upsertGoal` REPLACE-by-position
 *    rule preserves ids so [[../tables/specs]] `milestone_id` FKs don't silently unattach (the FK is
 *    `on delete set null`; a destroy+recreate would null every child spec's link).
 *  - `parent_goal_id` is acyclic — the `goals_parent_cycle` BEFORE trigger walks the chain on every
 *    write and rejects a self-ancestor.
 *
 * Service-role only (RLS allows read for authenticated; ALL ops for service_role). All callers go
 * through `createAdminClient()`.
 */
import { createAdminClient } from "@/lib/supabase/admin";

/** The full enum the `goals.status` column accepts (CHECK-constrained in migration). */
export type GoalRowStatus = "proposed" | "greenlit" | "complete" | "folded";

/** The full enum the `goal_milestones.status` column accepts (CHECK-constrained in migration). */
export type MilestoneRowStatus = "planned" | "in_progress" | "complete";

export interface GoalMilestoneRow {
  id: string;
  goal_id: string;
  position: number;
  title: string;
  body: string | null;
  status: MilestoneRowStatus;
  created_at: string;
  updated_at: string;
}

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
  status: GoalRowStatus;
  created_at: string;
  updated_at: string;
  milestones: GoalMilestoneRow[];
}

/** Field set callers pass to `upsertGoal` for the parent `goals` row. Defaults applied at DB level. */
export interface GoalRowInput {
  slug: string;
  title: string;
  body: string;
  outcome: string | null;
  success_metric: string | null;
  owner: string;
  proposer_function?: string | null;
  parent_goal_id?: string | null;
  /** Optional explicit status. The DB trigger rolls this from greenlit → complete when every milestone
   *  completes — don't pass `complete` for a still-proposed goal (the rail rejects it via terminal-ish). */
  status?: GoalRowStatus;
}

/** Field set callers pass per-milestone. The `upsertGoal` REPLACE-by-position rule preserves stable id. */
export interface GoalMilestoneInput {
  position: number;
  title: string;
  body: string | null;
  status?: MilestoneRowStatus;
}

export interface UpsertGoalResult {
  goal_id: string;
  /** position (1-indexed) → milestone id, for callers that want to chain milestone-keyed writes. */
  milestone_ids: Record<number, string>;
}

export interface ListGoalsFilter {
  status?: GoalRowStatus;
  owner?: string;
  /** Pass `null` to filter to top-level goals (no parent), a uuid to filter to subgoals of one parent,
   *  or omit to ignore. */
  parent_goal_id?: string | null;
}

interface GoalRowDb {
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
  status: GoalRowStatus;
  created_at: string;
  updated_at: string;
}

const GOAL_COLUMNS =
  "id, workspace_id, slug, title, body, outcome, success_metric, owner, proposer_function, parent_goal_id, status, created_at, updated_at";
const MILESTONE_COLUMNS = "id, goal_id, position, title, body, status, created_at, updated_at";

function goalRowFromDb(db: GoalRowDb, milestones: GoalMilestoneRow[]): GoalRow {
  return {
    id: db.id,
    workspace_id: db.workspace_id,
    slug: db.slug,
    title: db.title,
    body: db.body,
    outcome: db.outcome,
    success_metric: db.success_metric,
    owner: db.owner,
    proposer_function: db.proposer_function,
    parent_goal_id: db.parent_goal_id,
    status: db.status,
    created_at: db.created_at,
    updated_at: db.updated_at,
    milestones,
  };
}

/**
 * One goal by `(workspace, slug)` — the parent `goals` row joined with its `goal_milestones` ordered by
 * position. Returns `null` when no row matches.
 */
export async function getGoal(workspaceId: string, slug: string): Promise<GoalRow | null> {
  const admin = createAdminClient();
  const { data: goal, error } = await admin
    .from("goals")
    .select(GOAL_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  if (!goal) return null;
  const goalDb = goal as GoalRowDb;
  const { data: milestones, error: mErr } = await admin
    .from("goal_milestones")
    .select(MILESTONE_COLUMNS)
    .eq("goal_id", goalDb.id)
    .order("position", { ascending: true });
  if (mErr) throw mErr;
  return goalRowFromDb(goalDb, (milestones ?? []) as GoalMilestoneRow[]);
}

/**
 * Every goal in a workspace, optionally filtered. Milestones joined in one extra round-trip and grouped
 * by `goal_id`. Sorted client-side by slug for a stable order.
 */
export async function listGoals(workspaceId: string, filter: ListGoalsFilter = {}): Promise<GoalRow[]> {
  const admin = createAdminClient();
  let q = admin.from("goals").select(GOAL_COLUMNS).eq("workspace_id", workspaceId);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.owner) q = q.eq("owner", filter.owner);
  if (filter.parent_goal_id !== undefined) {
    q =
      filter.parent_goal_id === null
        ? q.is("parent_goal_id", null)
        : q.eq("parent_goal_id", filter.parent_goal_id);
  }
  const { data: goals, error } = await q;
  if (error) throw error;
  const goalRows = (goals ?? []) as GoalRowDb[];
  if (!goalRows.length) return [];
  const ids = goalRows.map((g) => g.id);
  const { data: milestones, error: mErr } = await admin
    .from("goal_milestones")
    .select(MILESTONE_COLUMNS)
    .in("goal_id", ids)
    .order("position", { ascending: true });
  if (mErr) throw mErr;
  const byId = new Map<string, GoalMilestoneRow[]>();
  for (const m of (milestones ?? []) as GoalMilestoneRow[]) {
    const list = byId.get(m.goal_id) ?? [];
    list.push(m);
    byId.set(m.goal_id, list);
  }
  return goalRows
    .map((g) => goalRowFromDb(g, byId.get(g.id) ?? []))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * UPSERT the parent `goals` row + REPLACE its `goal_milestones` by `(goal_id, position)`:
 *   - matching positions are UPDATED in place (preserving the stable id)
 *   - new positions are INSERTED
 *   - vanished positions are DELETED
 *
 * The DB triggers `specs_milestone_rollup` + `goal_milestones_rollup` keep statuses consistent on each
 * write. Re-running on an unchanged input is idempotent.
 *
 * Not atomic across parent + child writes (supabase-js has no transaction surface). The rollup triggers
 * are the only consistency rail — a partial failure leaves the goal row in place with whatever milestone
 * subset succeeded, and re-running converges.
 */
export async function upsertGoal(
  workspaceId: string,
  row: GoalRowInput,
  milestones: GoalMilestoneInput[],
): Promise<UpsertGoalResult> {
  const admin = createAdminClient();
  const upsertRow: Record<string, unknown> = {
    workspace_id: workspaceId,
    slug: row.slug,
    title: row.title,
    body: row.body,
    outcome: row.outcome,
    success_metric: row.success_metric,
    owner: row.owner,
    proposer_function: row.proposer_function ?? null,
    parent_goal_id: row.parent_goal_id ?? null,
    updated_at: new Date().toISOString(),
  };
  if (row.status !== undefined) upsertRow.status = row.status;

  const { data: upserted, error: upErr } = await admin
    .from("goals")
    .upsert(upsertRow, { onConflict: "workspace_id,slug" })
    .select("id")
    .single();
  if (upErr || !upserted) throw upErr ?? new Error("upsert goals returned no row");
  const goalId = (upserted as { id: string }).id;

  const { data: existingMilestones, error: exErr } = await admin
    .from("goal_milestones")
    .select("id, position")
    .eq("goal_id", goalId);
  if (exErr) throw exErr;
  const byPosition = new Map<number, { id: string }>();
  for (const m of (existingMilestones ?? []) as { id: string; position: number }[]) {
    byPosition.set(m.position, { id: m.id });
  }

  const inputPositions = new Set(milestones.map((m) => m.position));
  const positionsToDelete: number[] = [];
  for (const pos of byPosition.keys()) if (!inputPositions.has(pos)) positionsToDelete.push(pos);
  if (positionsToDelete.length) {
    const { error: dErr } = await admin
      .from("goal_milestones")
      .delete()
      .eq("goal_id", goalId)
      .in("position", positionsToDelete);
    if (dErr) throw dErr;
  }

  const milestoneIds: Record<number, string> = {};
  for (const m of milestones) {
    const existing = byPosition.get(m.position);
    if (existing) {
      const updateRow: Record<string, unknown> = {
        title: m.title,
        body: m.body,
        updated_at: new Date().toISOString(),
      };
      if (m.status !== undefined) updateRow.status = m.status;
      const { error: uErr } = await admin.from("goal_milestones").update(updateRow).eq("id", existing.id);
      if (uErr) throw uErr;
      milestoneIds[m.position] = existing.id;
    } else {
      const insertRow: Record<string, unknown> = {
        goal_id: goalId,
        position: m.position,
        title: m.title,
        body: m.body,
      };
      if (m.status !== undefined) insertRow.status = m.status;
      const { data: inserted, error: iErr } = await admin
        .from("goal_milestones")
        .insert(insertRow)
        .select("id")
        .single();
      if (iErr || !inserted) throw iErr ?? new Error("insert goal_milestones returned no row");
      milestoneIds[m.position] = (inserted as { id: string }).id;
    }
  }

  return { goal_id: goalId, milestone_ids: milestoneIds };
}

/**
 * The CEO-greenlight write surface — flips a goal's status with an actor tag for the audit trail.
 * [[../specs/goal-greenlight-button-and-author-writes-db]] calls this when the CEO taps Greenlight.
 *
 * The DB CHECK constraint enforces the enum; the rollup trigger handles the eventual `greenlit → complete`
 * once every milestone lands. This function is for the EXPLICIT flips: `proposed → greenlit` (CEO action),
 * `greenlit → complete` (manual override; the rollup normally handles it), `* → folded` (fold worker).
 *
 * `actor` is recorded on the goal's `updated_at` bump only — the audit-grade write trail lives in a
 * future history table ([[goal-greenlight-button-and-author-writes-db]] decides where).
 */
export async function setGoalStatus(
  goalId: string,
  status: GoalRowStatus,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
 * Set a milestone's status directly. Rarely needed — the `specs_milestone_rollup` trigger keeps the
 * milestone in sync with its child specs automatically. Exposed for manual overrides (e.g. flipping a
 * milestone to `planned` after lifting all its specs into a new milestone before any rollup fires).
 */
export async function setMilestoneStatus(milestoneId: string, status: MilestoneRowStatus): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("goal_milestones")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", milestoneId);
  if (error) throw error;
}

/**
 * Attach a spec to a milestone (the planner uses this when a leaf lands). A single UPDATE on
 * `public.specs.milestone_id` — the `specs_milestone_rollup` trigger rolls up the new milestone (and the
 * old one when it changed). Pass `null` to DETACH (turn the spec into a standalone fix / regression).
 */
export async function attachSpecToMilestone(specId: string, milestoneId: string | null): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("specs")
    .update({ milestone_id: milestoneId, updated_at: new Date().toISOString() })
    .eq("id", specId);
  if (error) throw error;
}
