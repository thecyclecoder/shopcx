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
 *  - Milestone completion is PURELY DERIVED from child specs — there is NO `goal_milestones.status`
 *    column. The rollup trigger that used to maintain it was dropped (derive-rollup-status P3): a
 *    milestone is complete iff every linked spec is shipped|folded, in_progress if any has progress, else
 *    planned. The deriver lives in [[brain-roadmap]] `milestoneRowToCard`.
 *  - `goals.status` holds the CEO-greenlight input (`proposed` / `greenlit` / `folded`); the `complete`
 *    state is DERIVED by the reader (`goalRowToCard`) when every milestone rolls up complete. There is no
 *    longer a DB rollup trigger writing it — the proposed → greenlit step is the CEO-only path in
 *    [[../specs/goal-greenlight-button-and-author-writes-db]].
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

export interface GoalMilestoneRow {
  id: string;
  goal_id: string;
  position: number;
  title: string;
  body: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this milestone exists. Paired with `what`.
   *  App-layer gate: the goal-authoring path warns when empty (upgrade to a HARD gate once decomposition
   *  authoring paths supply it). */
  why: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this milestone lands. */
  what: string | null;
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
  /** spec-goal-branch-pm-flow M5 — explicit parent-goal flag. A parent goal contains sub-goals (not direct
   *  buildable specs) and is EXEMPT from the atomic goal→main promotion (its children promote independently).
   *  See `isGoalParentExempt`, which also OR's the structural fallbacks (has-children / no-buildable-specs). */
  is_parent: boolean;
  status: GoalRowStatus;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this goal exists (the motivation the CEO +
   *  directors + humans + agents share). Reconcile-don't-duplicate: `outcome` IS the goal's WHAT — we did
   *  NOT add a `goals.what` column; treat `outcome` as the what everywhere. The chokepoint (`proposeGoal`
   *  and future goal-authoring surfaces) gates this non-empty going forward. */
  why: string | null;
  /** goal-promotion-fold-collision-and-held-surfacing Phase 2 — the M5 atomic goal→main merge SHA. Stamped
   *  by `promoteCompleteGoalsToMain` (via [[stampGoalPromotedToMain]]) the moment `mergeGoalBranchIntoMain`
   *  returns merged. NULL while the goal branch has not landed on main. A folded/complete goal reading NULL
   *  is the silent-stall shape — the roadmap card reader flips it to HELD (backstop) so the goal never
   *  renders as fully shipped while its code isn't on main. */
  main_merge_sha: string | null;
  /** goal-promotion-fold-collision-and-held-surfacing Phase 2 — the human-readable conflict reason from a
   *  failed `mergeGoalBranchIntoMain` (409). Written by [[stampGoalPromotionHeld]] on the pass that saw the
   *  conflict; cleared to NULL by [[stampGoalPromotedToMain]] when a subsequent merge succeeds. Non-NULL →
   *  `GoalCard.promotionHeld = true` with this reason on the badge; also forces the card status OFF
   *  `complete`, so the roadmap board never leaks a HELD goal as fully shipped. */
  promotion_held_reason: string | null;
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
  /** spec-goal-branch-pm-flow M5 — mark this goal a PARENT (contains sub-goals; exempt from atomic promotion).
   *  Omit to leave the DB default (false). */
  is_parent?: boolean;
  /** Optional explicit greenlight status (`proposed` / `greenlit` / `folded`). `complete` is DERIVED by
   *  the reader when every milestone rolls up complete — don't write it here for a still-proposed goal. */
  status?: GoalRowStatus;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this goal exists. Reconcile with the
   *  existing `outcome` (which IS the WHAT — no duplicate column). PASS `null` to CLEAR; OMIT to PRESERVE. */
  why?: string | null;
}

/** Field set callers pass per-milestone. The `upsertGoal` REPLACE-by-position rule preserves stable id. */
export interface GoalMilestoneInput {
  position: number;
  title: string;
  body: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this milestone exists. */
  why?: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this milestone lands. */
  what?: string | null;
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
  is_parent: boolean;
  status: GoalRowStatus;
  why: string | null;
  // goal-promotion-fold-collision-and-held-surfacing Phase 2 — atomic promotion state.
  main_merge_sha: string | null;
  promotion_held_reason: string | null;
  created_at: string;
  updated_at: string;
}

const GOAL_COLUMNS =
  "id, workspace_id, slug, title, body, outcome, success_metric, owner, proposer_function, parent_goal_id, is_parent, status, why, main_merge_sha, promotion_held_reason, created_at, updated_at";
const MILESTONE_COLUMNS = "id, goal_id, position, title, body, why, what, created_at, updated_at";

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
    is_parent: db.is_parent,
    status: db.status,
    why: db.why,
    // goal-promotion-fold-collision-and-held-surfacing Phase 2 — fall back to null when the migration hasn't
    // been applied yet (defensive; Supabase omits absent columns from the row rather than 500ing on
    // .select(), so this preserves the safe "not held / no merge SHA on record" state).
    main_merge_sha: db.main_merge_sha ?? null,
    promotion_held_reason: db.promotion_held_reason ?? null,
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
  // spec-read-eff-pool — Phase 2 of docs/brain/specs/spec-read-efficiency-for-scaling-fleet.md.
  // Pooled straggler read: ONE pooled query returns every workspace goal + its milestones (jsonb
  // aggregated), retiring the TWO PostgREST round-trips (goals + goal_milestones IN ids) each with
  // its own set_config preamble. Filters are applied in-memory over the bounded workspace set —
  // behavior-preserving vs the DB-level filter (same rows, same sort). `null` = pool unavailable /
  // query error → fall through to the supabase-js two-call path (same fail-open contract as
  // [[pg-pool]] `getSpecWithPhases`).
  try {
    const { listGoalsWithMilestones } = await import("@/lib/pg-pool");
    const pooled = await listGoalsWithMilestones<GoalRowDb, GoalMilestoneRow>(workspaceId);
    if (pooled !== null) {
      let goalPairs = pooled;
      if (filter.status) goalPairs = goalPairs.filter((p) => p.goal.status === filter.status);
      if (filter.owner) goalPairs = goalPairs.filter((p) => p.goal.owner === filter.owner);
      if (filter.parent_goal_id !== undefined) {
        const wanted = filter.parent_goal_id;
        goalPairs =
          wanted === null
            ? goalPairs.filter((p) => p.goal.parent_goal_id === null)
            : goalPairs.filter((p) => p.goal.parent_goal_id === wanted);
      }
      return goalPairs
        .map((p) => goalRowFromDb(p.goal, [...p.milestones].sort((a, b) => a.position - b.position)))
        .sort((a, b) => a.slug.localeCompare(b.slug));
    }
  } catch {
    /* fall through to the supabase-js two-call path */
  }
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
 * Milestone + goal completion is DERIVED by the readers from child specs (no rollup column / trigger),
 * so this writer only persists structure (titles, bodies, positions). Re-running on unchanged input is
 * idempotent.
 *
 * Not atomic across parent + child writes (supabase-js has no transaction surface) — a partial failure
 * leaves the goal row in place with whatever milestone subset succeeded, and re-running converges.
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
  if (row.is_parent !== undefined) upsertRow.is_parent = row.is_parent;
  // pm-structured-intent-and-refs Phase 1 — persist the plain-language WHY column (reconciled: `outcome`
  // remains the WHAT). PASS through only when the caller explicitly touched it (idempotent re-authors leave
  // it alone).
  if (row.why !== undefined) upsertRow.why = row.why;

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
      // pm-structured-intent-and-refs Phase 1 — preserve on undefined (idempotent re-author), write on
      // explicit string/null (real author-time update).
      if (m.why !== undefined) updateRow.why = m.why;
      if (m.what !== undefined) updateRow.what = m.what;
      const { error: uErr } = await admin.from("goal_milestones").update(updateRow).eq("id", existing.id);
      if (uErr) throw uErr;
      milestoneIds[m.position] = existing.id;
    } else {
      const insertRow: Record<string, unknown> = {
        goal_id: goalId,
        position: m.position,
        title: m.title,
        body: m.body,
        // pm-structured-intent-and-refs Phase 1 — persist whatever the caller passed (null keeps the
        // pre-intent shape; a string writes it through). Milestones from goal-decomposition parsing today
        // hand `undefined` (backfill lands later), so an unstamped milestone reads as `null`.
        why: m.why ?? null,
        what: m.what ?? null,
      };
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
 * goal-promotion-fold-collision-and-held-surfacing Phase 2 — the sanctioned writer for `goals.main_merge_sha`.
 * Called by `promoteCompleteGoalsToMain` the moment `mergeGoalBranchIntoMain` returns merged (M5's atomic
 * goal→main merge landed). ALSO clears any lingering `promotion_held_reason` from a prior 409 pass, so a
 * previously-HELD goal that just landed drops its HELD badge in the same write.
 *
 * Compare-and-set on `id` (the goal-row primary key) — the caller resolved the goal via `listGoals` /
 * `getGoal` seconds earlier, so a stale-row race is not a concern; but we still `.select("id")` and require
 * exactly one row transitioned so a wrong id (deleted goal, cross-workspace mismatch) surfaces as a throw
 * rather than a silent no-op. Idempotent: re-running with the same SHA re-writes the same value.
 */
export async function stampGoalPromotedToMain(
  goalId: string,
  mergeSha: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _actor: string,
): Promise<void> {
  if (!mergeSha || !mergeSha.trim()) {
    throw new Error(`stampGoalPromotedToMain: mergeSha required (goalId=${goalId})`);
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("goals")
    .update({
      main_merge_sha: mergeSha,
      promotion_held_reason: null, // atomic clear of the prior 409 reason (if any) on success
      updated_at: new Date().toISOString(),
    })
    .eq("id", goalId)
    .select("id");
  if (error) throw error;
  if (!data || data.length !== 1) {
    throw new Error(`stampGoalPromotedToMain: expected 1 row transitioned for goalId=${goalId}, got ${data?.length ?? 0}`);
  }
}

/**
 * goal-promotion-fold-collision-and-held-surfacing Phase 2 — the sanctioned writer for
 * `goals.promotion_held_reason`. Called by `promoteCompleteGoalsToMain` on a 409 from
 * `mergeGoalBranchIntoMain` (or any other "atomic promotion cannot land" branch). Records the reason so
 * the roadmap reader can surface the HELD/needs-owner badge AND flip the card status off `complete`.
 *
 * Does NOT touch `main_merge_sha` — a prior successful landing (if any; would be atypical) stays visible.
 * Guarded the same way `stampGoalPromotedToMain` is: `.eq("id", …).select("id")` re-asserts exactly one
 * row transitioned so a stale/wrong goal id surfaces as a throw. Idempotent: re-running with the same
 * reason re-writes the same value.
 */
export async function stampGoalPromotionHeld(
  goalId: string,
  reason: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _actor: string,
): Promise<void> {
  const clean = (reason ?? "").trim();
  if (!clean) {
    throw new Error(`stampGoalPromotionHeld: reason required (goalId=${goalId})`);
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("goals")
    .update({
      promotion_held_reason: clean,
      updated_at: new Date().toISOString(),
    })
    .eq("id", goalId)
    .select("id");
  if (error) throw error;
  if (!data || data.length !== 1) {
    throw new Error(`stampGoalPromotionHeld: expected 1 row transitioned for goalId=${goalId}, got ${data?.length ?? 0}`);
  }
}

/**
 * Attach a spec to a milestone (the planner uses this when a leaf lands). A single UPDATE on
 * `public.specs.milestone_id`. Milestone completion is DERIVED from its linked specs at read time, so no
 * rollup fires on this write. Pass `null` to DETACH (turn the spec into a standalone fix / regression).
 */
export async function attachSpecToMilestone(specId: string, milestoneId: string | null): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("specs")
    .update({ milestone_id: milestoneId, updated_at: new Date().toISOString() })
    .eq("id", specId);
  if (error) throw error;
}

/** One milestone by its stable id (the join-free read for spec→milestone tooling). */
export async function getMilestone(milestoneId: string): Promise<GoalMilestoneRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("goal_milestones")
    .select(MILESTONE_COLUMNS)
    .eq("id", milestoneId)
    .maybeSingle();
  if (error) throw error;
  return (data as GoalMilestoneRow) ?? null;
}

/** Every milestone of a goal, ordered by position. */
export async function listMilestones(goalId: string): Promise<GoalMilestoneRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("goal_milestones")
    .select(MILESTONE_COLUMNS)
    .eq("goal_id", goalId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data as GoalMilestoneRow[]) ?? [];
}

/**
 * CEO greenlight by slug — `proposed → greenlit`. Thin wrapper over `setGoalStatus` that resolves the slug
 * within a workspace ([[../specs/goal-greenlight-button-and-author-writes-db]]).
 */
export async function greenlightGoal(workspaceId: string, slug: string, actor: string): Promise<void> {
  const admin = createAdminClient();
  const { data: goal, error } = await admin
    .from("goals")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  if (!goal) throw new Error(`greenlightGoal: no goal '${slug}' in workspace ${workspaceId}`);
  await setGoalStatus((goal as { id: string }).id, "greenlit", actor);
}

/**
 * Re-parent a goal — make it a subgoal of another (CEO Mode → Fully-Autonomous-CTO), or pass `null` to make
 * it top-level. The `goals_parent_cycle` BEFORE trigger rejects any assignment that would create a cycle.
 */
export async function reparentGoal(goalId: string, parentGoalId: string | null): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("goals")
    .update({ parent_goal_id: parentGoalId, updated_at: new Date().toISOString() })
    .eq("id", goalId);
  if (error) throw error;
}

/**
 * spec-goal-branch-pm-flow M5 — set/clear a goal's explicit PARENT flag (`goals.is_parent`). A parent goal
 * contains sub-goals (not direct buildable specs) and is EXEMPT from the atomic goal→main promotion. The
 * sanctioned SDK writer for the column (no raw PM SQL). `getGoal`/`listGoals` already select it; this is the
 * write side for the (future) "mark CEO Mode a parent" path. A single slug-resolved UPDATE.
 */
export async function setGoalIsParent(workspaceId: string, slug: string, isParent: boolean): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("goals")
    .update({ is_parent: isParent, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("slug", slug);
  if (error) throw error;
}

/** spec-goal-branch-pm-flow M5 — does this goal HAVE child goals (≥1 other goal names it as parent_goal_id)?
 *  One of the structural fallbacks `isGoalParentExempt` ORs (a goal with children is a parent even if the
 *  explicit flag was never set — e.g. CEO Mode today). Read-only; fails CLOSED (treat-as-parent) on error so
 *  an unknown parent-ness never force-promotes a goal that might be a parent. */
export async function goalHasChildGoals(goalId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { count } = await admin
      .from("goals")
      .select("id", { count: "exact", head: true })
      .eq("parent_goal_id", goalId);
    return (count ?? 0) > 0;
  } catch {
    return true; // fail closed — unknown ⇒ treat as a parent (don't force-promote)
  }
}

/**
 * spec-goal-branch-pm-flow M5 — is this goal EXEMPT from the atomic goal→main promotion (a PARENT goal)?
 *
 * A parent goal CONTAINS sub-goals, not direct buildable specs — there is no `goal/{slug}` branch to merge
 * and its children promote INDEPENDENTLY on their own completion. `promoteCompleteGoalsToMain` SKIPS an
 * exempt goal. Exempt iff ANY of:
 *   (a) `is_parent === true` — the explicit, intentional override (CEO Mode can be marked this going forward); OR
 *   (b) it HAS child goals (`goalHasChildGoals`) — the structural signal that exempts CEO Mode TODAY before
 *       anyone sets the flag; OR
 *   (c) it has NO buildable member specs (no spec linked through any of its milestones) — a goal with nothing
 *       to ship has no goal branch to promote.
 *
 * Reads through the goals/specs SDK only (no raw PM tables). Fails CLOSED on a read error (returns exempt) —
 * an unknown goal must never be force-promoted to main.
 */
export async function isGoalParentExempt(workspaceId: string, slug: string): Promise<{ exempt: boolean; reason: string }> {
  try {
    const goal = await getGoal(workspaceId, slug);
    if (!goal) return { exempt: true, reason: "no goal row — nothing to promote" };
    if (goal.is_parent) return { exempt: true, reason: "is_parent flag set" };
    if (await goalHasChildGoals(goal.id)) return { exempt: true, reason: "has child goals (structural parent)" };
    // (c) no buildable member specs across any milestone.
    const { specsForMilestone } = await import("@/lib/specs-table");
    let buildable = 0;
    for (const m of goal.milestones) {
      buildable += (await specsForMilestone(workspaceId, m.id)).length;
      if (buildable > 0) break;
    }
    if (buildable === 0) return { exempt: true, reason: "no buildable member specs" };
    return { exempt: false, reason: "leaf goal with buildable specs — promotable" };
  } catch (e) {
    return { exempt: true, reason: `parent-exemption read failed (treated exempt): ${e instanceof Error ? e.message : String(e)}` };
  }
}
