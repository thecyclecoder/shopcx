/**
 * specs-table — the future-canonical read/write surface for `public.specs` + `public.spec_phases`
 * ([[../tables/specs]] · [[../tables/spec_phases]]), the DB-resident spec BODY (db-driven-specs M1,
 * [[../specs/spec-body-table-and-backfill]] Phase 2).
 *
 * Parallel to [[spec-card-state]] (status-only mirror) until [[../specs/spec-readers-from-db-retire-parser]]
 * cuts readers over to read FROM here instead of `docs/brain/specs/*.md`. This module ONLY adds the writer
 * + read surface — no caller has been retargeted yet. Backfill ([[../recipes/backfill-specs-from-markdown]])
 * fills the rows.
 *
 * Key invariants:
 *  - `specs.status` is rolled up FROM `spec_phases` by the DB trigger `spec_phases_rollup` (NOT in app
 *    code). It's impossible to commit `specs.status='shipped'` while a phase is still `planned` — the
 *    [[../specs/spec-review-agent]] "shipped with 1 phase" class. `in_review` and `folded` are terminal-ish
 *    (the rollup leaves them alone until an explicit flip clears them).
 *  - `spec_phases.id` is STABLE across moves — `movePhase(phaseId, newSpecId, newPosition)` is a SINGLE
 *    UPDATE that preserves the id + pr + merge_sha + created_at, so a phase's PR provenance chain
 *    ([[../specs/spec-status-phase-pr-provenance]]) survives a lift between specs.
 *  - `upsertSpec` replaces a spec's `spec_phases` by `(spec_id, position)` — phases at the same
 *    position retain their stable id (and pr/merge_sha unless explicitly overridden). New positions
 *    INSERT, vanished positions DELETE.
 *
 * Service-role only (RLS allows read for authenticated; ALL ops for service_role). All callers go
 * through `createAdminClient()`.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { Phase } from "@/lib/brain-roadmap";

export type { Phase } from "@/lib/brain-roadmap";

/** The full enum the `specs.status` column accepts (CHECK-constrained in migration). */
export type SpecStatus = "in_review" | "planned" | "in_progress" | "shipped" | "deferred" | "folded";

export interface SpecPhaseRow {
  id: string;
  spec_id: string;
  position: number;
  title: string;
  body: string;
  status: Phase;
  pr: number | null;
  merge_sha: string | null;
  verification: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpecRow {
  id: string;
  workspace_id: string;
  slug: string;
  title: string;
  summary: string | null;
  owner: string;
  parent: string;
  blocked_by: string[];
  priority: string | null;
  deferred: boolean;
  intended_status: "planned" | "deferred" | null;
  status: SpecStatus;
  intended_status_set_by: string | null;
  repair_signature: string | null;
  /** spec-authoring-writes-db-and-worker-materialize Phase 1 — when set, the spec is a regression-agent-
   *  authored fix for this slug (mirrors the `**Regression-of:** [[<slug>]]` header line). */
  regression_of_slug: string | null;
  /** spec-authoring-writes-db-and-worker-materialize Phase 1 — the regression-agent's signature for this
   *  fix (mirrors the `**Regression-signature:** `<sig>`` header line). Same-signature recurrences converge
   *  on one spec, sibling to repair_signature. */
  regression_signature: string | null;
  auto_build: boolean;
  milestone_id: string | null;
  created_at: string;
  updated_at: string;
  phases: SpecPhaseRow[];
}

/** Field set callers can pass to `upsertSpec` for the parent `specs` row. Defaults applied at DB level. */
export interface SpecRowInput {
  slug: string;
  title: string;
  summary: string | null;
  owner: string;
  parent: string;
  blocked_by: string[];
  priority: string | null;
  deferred: boolean;
  intended_status: "planned" | "deferred" | null;
  /** Optional explicit status. The DB trigger may roll this to a different value once phases land — that's
   *  the whole point of the rollup ([[../specs/spec-review-agent]] guard). Omit to default to `in_review`. */
  status?: SpecStatus;
  intended_status_set_by?: string | null;
  repair_signature?: string | null;
  /** When set, mirrors the regression-agent header `**Regression-of:** [[<slug>]]` (the regressed spec slug). */
  regression_of_slug?: string | null;
  /** When set, mirrors the regression-agent header `**Regression-signature:** `<sig>``. */
  regression_signature?: string | null;
  auto_build?: boolean;
  milestone_id?: string | null;
}

/** Field set callers pass per-phase. `pr`/`merge_sha`/`verification` are optional — preserved when omitted. */
export interface SpecPhaseInput {
  position: number;
  title: string;
  body: string;
  status: Phase;
  /** PASS `null` to CLEAR. OMIT (undefined) to PRESERVE an existing value on update. */
  pr?: number | null;
  merge_sha?: string | null;
  verification?: string | null;
}

export interface UpsertSpecResult {
  spec_id: string;
  /** position (1-indexed) → phase id, for callers that want to chain phase-keyed writes. */
  phase_ids: Record<number, string>;
}

export interface ListSpecsFilter {
  status?: SpecStatus;
  owner?: string;
  /** Pass `null` to filter to standalone specs (no milestone link), a uuid to filter to one milestone, or
   *  omit to ignore. */
  milestone_id?: string | null;
}

interface SpecRowDb {
  id: string;
  workspace_id: string;
  slug: string;
  title: string;
  summary: string | null;
  owner: string;
  parent: string;
  blocked_by: string[] | null;
  priority: string | null;
  deferred: boolean;
  intended_status: "planned" | "deferred" | null;
  status: SpecStatus;
  intended_status_set_by: string | null;
  repair_signature: string | null;
  regression_of_slug: string | null;
  regression_signature: string | null;
  auto_build: boolean;
  milestone_id: string | null;
  created_at: string;
  updated_at: string;
}

const SPEC_COLUMNS =
  "id, workspace_id, slug, title, summary, owner, parent, blocked_by, priority, deferred, intended_status, status, intended_status_set_by, repair_signature, regression_of_slug, regression_signature, auto_build, milestone_id, created_at, updated_at";
const PHASE_COLUMNS =
  "id, spec_id, position, title, body, status, pr, merge_sha, verification, created_at, updated_at";

function specRowFromDb(db: SpecRowDb, phases: SpecPhaseRow[]): SpecRow {
  return {
    id: db.id,
    workspace_id: db.workspace_id,
    slug: db.slug,
    title: db.title,
    summary: db.summary,
    owner: db.owner,
    parent: db.parent,
    blocked_by: db.blocked_by ?? [],
    priority: db.priority,
    deferred: db.deferred,
    intended_status: db.intended_status,
    status: db.status,
    intended_status_set_by: db.intended_status_set_by,
    repair_signature: db.repair_signature,
    regression_of_slug: db.regression_of_slug,
    regression_signature: db.regression_signature,
    auto_build: db.auto_build,
    milestone_id: db.milestone_id,
    created_at: db.created_at,
    updated_at: db.updated_at,
    phases,
  };
}

/**
 * One spec by (workspace, slug) — the parent `specs` row joined with its `spec_phases` ordered by position.
 * Returns `null` when no row matches. Read by authenticated users (RLS) — the admin client just bypasses RLS.
 */
export async function getSpec(workspaceId: string, slug: string): Promise<SpecRow | null> {
  const admin = createAdminClient();
  const { data: spec, error } = await admin
    .from("specs")
    .select(SPEC_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  if (!spec) return null;
  const specDb = spec as SpecRowDb;
  const { data: phases, error: pErr } = await admin
    .from("spec_phases")
    .select(PHASE_COLUMNS)
    .eq("spec_id", specDb.id)
    .order("position", { ascending: true });
  if (pErr) throw pErr;
  return specRowFromDb(specDb, (phases ?? []) as SpecPhaseRow[]);
}

/**
 * Every spec in a workspace, optionally filtered. Phases for each are joined in one extra round-trip and
 * grouped by `spec_id`. Sorted client-side by slug for a stable order.
 */
export async function listSpecs(workspaceId: string, filter: ListSpecsFilter = {}): Promise<SpecRow[]> {
  const admin = createAdminClient();
  let q = admin.from("specs").select(SPEC_COLUMNS).eq("workspace_id", workspaceId);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.owner) q = q.eq("owner", filter.owner);
  if (filter.milestone_id !== undefined) {
    q = filter.milestone_id === null ? q.is("milestone_id", null) : q.eq("milestone_id", filter.milestone_id);
  }
  const { data: specs, error } = await q;
  if (error) throw error;
  const specRows = (specs ?? []) as SpecRowDb[];
  if (!specRows.length) return [];
  const ids = specRows.map((s) => s.id);
  const { data: phases, error: pErr } = await admin
    .from("spec_phases")
    .select(PHASE_COLUMNS)
    .in("spec_id", ids)
    .order("position", { ascending: true });
  if (pErr) throw pErr;
  const byId = new Map<string, SpecPhaseRow[]>();
  for (const p of (phases ?? []) as SpecPhaseRow[]) {
    const list = byId.get(p.spec_id) ?? [];
    list.push(p);
    byId.set(p.spec_id, list);
  }
  return specRows
    .map((s) => specRowFromDb(s, byId.get(s.id) ?? []))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * UPSERT the parent `specs` row + REPLACE its `spec_phases` by (spec_id, position):
 *   - matching positions are UPDATED in place (preserving id + pr/merge_sha unless explicitly overridden)
 *   - new positions are INSERTED (with optional pr/merge_sha if supplied)
 *   - vanished positions are DELETED
 * The DB trigger `spec_phases_rollup` rolls `specs.status` up from the resulting phase set after each
 * write (terminal-ish `in_review`/`folded` are left alone — only an explicit flip clears them).
 *
 * Not atomic across the parent + child writes (supabase-js has no transaction surface). The trigger
 * keeps status consistent on EACH write, and re-running the same `upsertSpec` is idempotent (the
 * read-modify-write of phases by position is deterministic).
 */
export async function upsertSpec(
  workspaceId: string,
  row: SpecRowInput,
  phases: SpecPhaseInput[],
): Promise<UpsertSpecResult> {
  const admin = createAdminClient();
  const upsertRow: Record<string, unknown> = {
    workspace_id: workspaceId,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    owner: row.owner,
    parent: row.parent,
    blocked_by: row.blocked_by,
    priority: row.priority,
    deferred: row.deferred,
    intended_status: row.intended_status,
    intended_status_set_by: row.intended_status_set_by ?? null,
    repair_signature: row.repair_signature ?? null,
    regression_of_slug: row.regression_of_slug ?? null,
    regression_signature: row.regression_signature ?? null,
    auto_build: row.auto_build ?? false,
    milestone_id: row.milestone_id ?? null,
    updated_at: new Date().toISOString(),
  };
  if (row.status !== undefined) upsertRow.status = row.status;

  const { data: upserted, error: upErr } = await admin
    .from("specs")
    .upsert(upsertRow, { onConflict: "workspace_id,slug" })
    .select("id")
    .single();
  if (upErr || !upserted) throw upErr ?? new Error("upsert specs returned no row");
  const specId = (upserted as { id: string }).id;

  const { data: existingPhases, error: exErr } = await admin
    .from("spec_phases")
    .select("id, position, pr, merge_sha")
    .eq("spec_id", specId);
  if (exErr) throw exErr;
  const byPosition = new Map<number, { id: string; pr: number | null; merge_sha: string | null }>();
  for (const p of (existingPhases ?? []) as { id: string; position: number; pr: number | null; merge_sha: string | null }[]) {
    byPosition.set(p.position, { id: p.id, pr: p.pr, merge_sha: p.merge_sha });
  }

  const inputPositions = new Set(phases.map((p) => p.position));
  const positionsToDelete: number[] = [];
  for (const pos of byPosition.keys()) if (!inputPositions.has(pos)) positionsToDelete.push(pos);
  if (positionsToDelete.length) {
    const { error: dErr } = await admin
      .from("spec_phases")
      .delete()
      .eq("spec_id", specId)
      .in("position", positionsToDelete);
    if (dErr) throw dErr;
  }

  const phaseIds: Record<number, string> = {};
  for (const phase of phases) {
    const existing = byPosition.get(phase.position);
    if (existing) {
      const updateRow: Record<string, unknown> = {
        title: phase.title,
        body: phase.body,
        status: phase.status,
        updated_at: new Date().toISOString(),
      };
      if (phase.pr !== undefined) updateRow.pr = phase.pr;
      if (phase.merge_sha !== undefined) updateRow.merge_sha = phase.merge_sha;
      if (phase.verification !== undefined) updateRow.verification = phase.verification;
      const { error: uErr } = await admin.from("spec_phases").update(updateRow).eq("id", existing.id);
      if (uErr) throw uErr;
      phaseIds[phase.position] = existing.id;
    } else {
      const insertRow: Record<string, unknown> = {
        spec_id: specId,
        position: phase.position,
        title: phase.title,
        body: phase.body,
        status: phase.status,
        pr: phase.pr ?? null,
        merge_sha: phase.merge_sha ?? null,
        verification: phase.verification ?? null,
      };
      const { data: inserted, error: iErr } = await admin
        .from("spec_phases")
        .insert(insertRow)
        .select("id")
        .single();
      if (iErr || !inserted) throw iErr ?? new Error("insert spec_phases returned no row");
      phaseIds[phase.position] = (inserted as { id: string }).id;
    }
  }

  return { spec_id: specId, phase_ids: phaseIds };
}

/**
 * Lift one phase between specs (or to a new slot in the same spec) preserving its stable `id`, `pr`,
 * `merge_sha`, `created_at` — the [[../specs/spec-status-phase-pr-provenance]] provenance chain.
 *
 * Single UPDATE → the trigger fires twice (old + new spec_id when those differ) and rolls both rollups
 * consistently in one transaction. The unique `(spec_id, position)` index may reject the move if the
 * destination slot is already occupied; the caller is responsible for shifting positions first when so.
 */
export async function movePhase(
  phaseId: string,
  newSpecId: string,
  newPosition: number,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("spec_phases")
    .update({ spec_id: newSpecId, position: newPosition, updated_at: new Date().toISOString() })
    .eq("id", phaseId);
  if (error) throw error;
}
