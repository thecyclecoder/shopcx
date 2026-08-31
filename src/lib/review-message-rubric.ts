/**
 * Rubric SDK — the source-of-truth reader + renderer for the versioned
 * review-request message rubric (Phase 2 of review-request-sol-session).
 *
 * The rubric is DATA, not a hardcoded prompt string — 8 criteria, 100 points,
 * floor 75, versioned per workspace in `public.review_message_rubrics`. Sol
 * self-scores her draft against the ACTIVE rubric and MUST revise once below
 * the floor; the independent QC session reads the same rubric so both sides
 * of the check are grounded in the same criteria set. A later grader sweep
 * can tune weights on evidence by inserting a new version + flipping
 * `is_active` — no code change, no prompt-string edit.
 *
 * This module is intentionally split into two halves:
 *
 *   • `parseRubricRow` — PURE, no DB dependency. Turns a row into a
 *     validated `ReviewMessageRubric` or throws a named error. Unit-tested in
 *     isolation without a Supabase client.
 *
 *   • `getActiveReviewRubric` — the live reader. Wraps `parseRubricRow`
 *     around a `.from("review_message_rubrics")` fetch. Returns `null` when
 *     the workspace has no active rubric (Phase 3's send path treats that as
 *     a hard SKIP — a missing rubric is never treated as an implicit pass).
 *
 * The rubric SHAPE is pinned in this file's types + parser so a later
 * migration that adds a new criterion (or a workspace with a hand-tuned
 * rubric) fails LOUD at load time rather than silently mis-scoring.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** ONE weighted criterion in the rubric. */
export interface ReviewMessageRubricCriterion {
  /** Stable slug so a later grader sweep can join across versions. */
  key: string;
  /** Integer point value; the sum across criteria must equal 100. */
  weight: number;
  /** Verbatim instruction the self-scoring + QC prompt renders — the whole
   * rubric truly is data. */
  instruction: string;
}

/** The parsed rubric a caller reads. */
export interface ReviewMessageRubric {
  id: string;
  workspaceId: string;
  version: number;
  floor: number;
  criteria: ReviewMessageRubricCriterion[];
  notes: string | null;
}

/** The initial rubric version the migration seeds — pinned so a Phase 2 test
 * can assert the seeded shape. */
export const INITIAL_REVIEW_RUBRIC_VERSION = 1;
/** The initial floor the migration seeds — 75 mirrors dahlia-copy-author. */
export const INITIAL_REVIEW_RUBRIC_FLOOR = 75;
/** The number of criteria the initial rubric ships with, per the spec. */
export const INITIAL_REVIEW_RUBRIC_CRITERION_COUNT = 8;

/**
 * Parse a raw `review_message_rubrics` row (as returned by `select *`) into a
 * validated `ReviewMessageRubric`. Throws a named error on any structural
 * miss so a caller doesn't silently ship a mis-shaped rubric to Sol. Pure —
 * no I/O, no side effects.
 */
export function parseRubricRow(raw: unknown): ReviewMessageRubric {
  if (!raw || typeof raw !== "object") {
    throw new Error("parseRubricRow: row is not an object");
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  if (!id) throw new Error("parseRubricRow: missing id");
  const workspaceId = typeof r.workspace_id === "string" ? r.workspace_id : "";
  if (!workspaceId) throw new Error("parseRubricRow: missing workspace_id");
  const version = Number.isFinite(r.version) ? Number(r.version) : NaN;
  if (!Number.isFinite(version) || version < 1) {
    throw new Error("parseRubricRow: version must be a positive integer");
  }
  const floor = Number.isFinite(r.floor) ? Number(r.floor) : NaN;
  if (!Number.isFinite(floor) || floor < 0 || floor > 100) {
    throw new Error("parseRubricRow: floor must be an integer in [0, 100]");
  }
  const rawCriteria = r.criteria;
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) {
    throw new Error("parseRubricRow: criteria must be a non-empty array");
  }
  const criteria: ReviewMessageRubricCriterion[] = [];
  for (const c of rawCriteria) {
    if (!c || typeof c !== "object") {
      throw new Error("parseRubricRow: criterion is not an object");
    }
    const cr = c as Record<string, unknown>;
    const key = typeof cr.key === "string" ? cr.key.trim() : "";
    if (!key) throw new Error("parseRubricRow: criterion missing key");
    const weight = Number.isFinite(cr.weight) ? Number(cr.weight) : NaN;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`parseRubricRow: criterion ${key} has non-positive weight`);
    }
    const instruction = typeof cr.instruction === "string" ? cr.instruction : "";
    if (!instruction) {
      throw new Error(`parseRubricRow: criterion ${key} missing instruction`);
    }
    criteria.push({ key, weight, instruction });
  }
  const totalWeight = criteria.reduce((n, c) => n + c.weight, 0);
  if (totalWeight !== 100) {
    throw new Error(
      `parseRubricRow: criterion weights sum to ${totalWeight}, expected 100`,
    );
  }
  const notes = typeof r.notes === "string" ? r.notes : null;
  return { id, workspaceId, version, floor, criteria, notes };
}

/**
 * Render the rubric as a plain-text block suitable for baking into Sol's
 * self-score prompt or the independent-QC prompt. The renderer keeps the
 * criteria order stable (as stored) so a self-score row's `per_criterion`
 * map lines up 1:1 with the block the LLM read. Pure — safe to unit-test.
 */
export function formatRubricForPrompt(rubric: ReviewMessageRubric): string {
  const lines: string[] = [];
  lines.push(
    `REVIEW-REQUEST MESSAGE RUBRIC (workspace v${rubric.version} — floor ${rubric.floor} / 100)`,
  );
  lines.push(
    `Score EACH criterion out of its weight; total is the sum. Below floor ⇒ revise once; below floor twice ⇒ skip.`,
  );
  lines.push("");
  for (const c of rubric.criteria) {
    lines.push(`- (${c.weight}) ${c.key} — ${c.instruction}`);
  }
  return lines.join("\n");
}

/**
 * The live reader — resolves the ACTIVE rubric for a workspace. Returns null
 * when no active row exists (the caller — Phase 3's send path — treats that
 * as a hard SKIP rather than an implicit pass).
 */
export async function getActiveReviewRubric(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<ReviewMessageRubric | null> {
  const { data, error } = await admin
    .from("review_message_rubrics")
    .select("id, workspace_id, version, floor, criteria, notes, is_active")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return parseRubricRow(data);
}
