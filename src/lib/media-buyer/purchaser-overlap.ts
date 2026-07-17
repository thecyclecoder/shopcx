/**
 * purchaser-overlap — the structural read the M2 recent-purchaser-exclusion
 * build ([[../../../docs/brain/goals/bianca-temperature-aware-campaign-structure]]
 * M2) consults to decide whether the exclusion actually ships.
 *
 * Phase 2 of [[../../../docs/brain/specs/bianca-measure-cold-test-purchaser-overlap]].
 *
 * Phase 1 landed the `_measure-cold-test-purchaser-overlap` one-shot that
 * writes ONE `media_buyer_purchaser_overlap_measured`
 * [[../../../docs/brain/tables/director_activity]] row per active per-test
 * cohort carrying the CITED overlap number. This file exposes:
 *
 *   readLatestPurchaserOverlap(admin, { workspaceId, cohortId })
 *     → { verdict, overlapRatio, spendCentsAllocatedToPriorPurchasers,
 *          windowDays, measuredAt } | null
 *
 * over the newest row for that cohort (ordered `created_at desc, limit 1`),
 * and:
 *
 *   classifyPurchaserOverlap(row, threshold = 0.15) → 'proceed' | 'defer'
 *
 * as a PURE function so the goal's verify-scale-numbers 15% threshold can be
 * unit-pinned. `readLatestPurchaserOverlap` returns null when no
 * measurement exists — the exclusion build treats that as "defer" (never
 * ship on an unmeasured cohort).
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The goal's verify-scale-numbers threshold: ship the exclusion at overlap ≥ 15%. */
export const PURCHASER_OVERLAP_DEFAULT_THRESHOLD = 0.15;

/** The action_kind literal the Phase-1 measurement writes. */
export const PURCHASER_OVERLAP_ACTION_KIND = "media_buyer_purchaser_overlap_measured";

/** The Growth Director owns the audit row. */
export const PURCHASER_OVERLAP_DIRECTOR_FUNCTION = "growth";

export type PurchaserOverlapVerdict = "proceed" | "defer";

export interface PurchaserOverlapRow {
  verdict: PurchaserOverlapVerdict | null;
  overlapRatio: number | null;
  spendCentsAllocatedToPriorPurchasers: number | null;
  windowDays: number | null;
  measuredAt: string | null;
}

/**
 * PURE — classify a measurement against the M2 threshold. Extracted so the
 * unit test can pin the 15% branch without the DB read. Returns `'defer'`
 * when the row's overlapRatio is null (missing / unparseable) — an
 * unmeasured cohort NEVER auto-proceeds.
 */
export function classifyPurchaserOverlap(
  row: Pick<PurchaserOverlapRow, "overlapRatio"> | null | undefined,
  threshold: number = PURCHASER_OVERLAP_DEFAULT_THRESHOLD,
): PurchaserOverlapVerdict {
  const ratio = row?.overlapRatio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "defer";
  return ratio >= threshold ? "proceed" : "defer";
}

interface DirectorActivityMetadata {
  cohort_id?: unknown;
  window_days?: unknown;
  overlap_ratio?: unknown;
  spend_cents_allocated_to_prior_purchasers?: unknown;
  verdict?: unknown;
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function coerceVerdict(v: unknown): PurchaserOverlapVerdict | null {
  return v === "proceed" || v === "defer" ? v : null;
}

/**
 * Newest overlap-measurement row for `(workspaceId, cohortId)`, or null when
 * no measurement has landed yet. Reads `director_activity` filtered by
 * `director_function='growth' AND action_kind='media_buyer_purchaser_overlap_measured'
 * AND metadata @> { cohort_id }`, ordered `created_at desc limit 1`.
 */
export async function readLatestPurchaserOverlap(
  admin: Admin,
  args: { workspaceId: string; cohortId: string },
): Promise<PurchaserOverlapRow | null> {
  const { workspaceId, cohortId } = args;
  const { data, error } = await admin
    .from("director_activity")
    .select("created_at, metadata")
    .eq("workspace_id", workspaceId)
    .eq("director_function", PURCHASER_OVERLAP_DIRECTOR_FUNCTION)
    .eq("action_kind", PURCHASER_OVERLAP_ACTION_KIND)
    .contains("metadata", { cohort_id: cohortId })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = (data ?? []) as { created_at: string; metadata: DirectorActivityMetadata | null }[];
  const row = rows[0];
  if (!row) return null;
  const meta = row.metadata ?? {};
  return {
    verdict: coerceVerdict(meta.verdict),
    overlapRatio: coerceNumber(meta.overlap_ratio),
    spendCentsAllocatedToPriorPurchasers: coerceNumber(meta.spend_cents_allocated_to_prior_purchasers),
    windowDays: coerceNumber(meta.window_days),
    measuredAt: row.created_at,
  };
}
