/**
 * CEO postability override SDK for `ad_campaigns` — the read/set/clear chokepoint
 * for the five override columns (override_postable / override_score /
 * override_reason / override_by / override_at) added by
 * bianca-posts-only-at-9of10-plus-ceo-manual-score-override-oversight-gate Phase 2.
 *
 * Why this file exists (CLAUDE.md § "Raw `.from(...)` with no SDK → STOP"):
 * every override read/write flows through the helpers here so the shape of the
 * override record cannot drift between the publish gate, the `ready-to-test`
 * reader, and the ad-detail API route. Max's real grade lives on
 * `ad_creative_copy_qc_verdicts` and is NEVER touched by this SDK — the whole
 * point of the CEO override is that the disagreement (Max says 6/10; CEO says
 * post) is preserved next to Max's real number as the tuning signal for live
 * Claude sessions.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The persisted override record. `null` semantics mirror the migration:
 * every field is nullable and travels together — the whole record is either
 * "override present" (override_postable === true) or "no override" (all
 * fields null). Reversible = clear all five.
 */
export interface PostabilityOverride {
  override_postable: boolean | null;
  override_score: number | null;
  override_reason: string | null;
  override_by: string | null;
  override_at: string | null;
}

/** Pure predicate — does this override record actually make the creative postable?
 *  TRUE iff `override_postable === true`. NULL / FALSE / absent record → false. */
export function isPostabilityOverrideActive(o: PostabilityOverride | null): boolean {
  if (!o) return false;
  return o.override_postable === true;
}

/**
 * Read the CEO postability override for ONE ad campaign. Returns the record even
 * when no override has been set (all fields null) so the caller can distinguish
 * "row exists, override absent" from "row missing" (the latter is `null`).
 */
export async function readPostabilityOverride(
  admin: Admin,
  opts: { workspaceId: string; adCampaignId: string },
): Promise<PostabilityOverride | null> {
  const { workspaceId, adCampaignId } = opts;
  const { data, error } = await admin
    .from("ad_campaigns")
    .select("override_postable, override_score, override_reason, override_by, override_at")
    .eq("id", adCampaignId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as Record<string, unknown>;
  return {
    override_postable: (r.override_postable as boolean | null) ?? null,
    override_score: (r.override_score as number | null) ?? null,
    override_reason: (r.override_reason as string | null) ?? null,
    override_by: (r.override_by as string | null) ?? null,
    override_at: (r.override_at as string | null) ?? null,
  };
}

/** Sanitize the CEO-supplied override reason — trims + rejects empty strings.
 *  The API layer surfaces a `missing_reason` error when this yields null. Kept
 *  as a small pure helper so the API test can pin the trim/reject shape. */
export function normalizeOverrideReason(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  // Keep the record compact — the reason surfaces on the ad detail page next to
  // Max's real grade + gets echoed in the director_activity audit row, but it
  // should never balloon a card. 1000 chars is generous for a reasoned note.
  return trimmed.slice(0, 1000);
}

/** Sanitize the CEO-supplied override score — clamps to the 0..10 range the DB
 *  CHECK constraint enforces. Returns null for null/undefined/NaN input; the
 *  caller passes `MAX_QC_ELIGIBILITY_FLOOR` (9) as the default. */
export function normalizeOverrideScore(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 10) return 10;
  return n;
}

/** Result of a set/clear write. The write is compare-and-set (workspace_id
 *  scoped + campaign id filtered + `.select("id")`) so a mismatched
 *  workspace/campaign returns `matched:false` instead of silently writing to
 *  a wrong row (CLAUDE.md coaching #11-12: mutating calls gate on a confirming
 *  predicate + assert exactly one row transitioned). */
export interface OverrideWriteResult {
  matched: boolean;
  override: PostabilityOverride | null;
}

/**
 * Set (or update) the CEO postability override on ONE ad campaign. Idempotent —
 * writing over an existing override replaces the reason/score/attribution/timestamp
 * and leaves Max's real grade on `ad_creative_copy_qc_verdicts` untouched (this
 * write only touches `ad_campaigns` override_* columns; the QC verdicts table
 * is never read or written here).
 *
 * `scoreFloor` is the caller's default score when the CEO didn't supply one —
 * usually `MAX_QC_ELIGIBILITY_FLOOR` from `creative-agent.ts` (9 after Phase 1
 * of this spec).
 */
export async function setPostabilityOverride(
  admin: Admin,
  opts: {
    workspaceId: string;
    adCampaignId: string;
    reason: string;
    userId: string;
    score?: number | null;
    scoreFloor: number;
  },
): Promise<OverrideWriteResult> {
  const { workspaceId, adCampaignId, reason, userId, score, scoreFloor } = opts;
  const cleanReason = normalizeOverrideReason(reason);
  if (!cleanReason) return { matched: false, override: null };
  const cleanScore = normalizeOverrideScore(score ?? scoreFloor) ?? scoreFloor;
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from("ad_campaigns")
    .update({
      override_postable: true,
      override_score: cleanScore,
      override_reason: cleanReason,
      override_by: userId,
      override_at: nowIso,
    })
    .eq("id", adCampaignId)
    .eq("workspace_id", workspaceId)
    .select("id, override_postable, override_score, override_reason, override_by, override_at")
    .maybeSingle();
  if (error || !data) return { matched: false, override: null };
  const r = data as Record<string, unknown>;
  return {
    matched: true,
    override: {
      override_postable: (r.override_postable as boolean | null) ?? null,
      override_score: (r.override_score as number | null) ?? null,
      override_reason: (r.override_reason as string | null) ?? null,
      override_by: (r.override_by as string | null) ?? null,
      override_at: (r.override_at as string | null) ?? null,
    },
  };
}

/**
 * Clear the CEO postability override — nulls the five columns. Reversible per
 * the spec. Same compare-and-set discipline as `setPostabilityOverride`.
 */
export async function clearPostabilityOverride(
  admin: Admin,
  opts: { workspaceId: string; adCampaignId: string },
): Promise<OverrideWriteResult> {
  const { workspaceId, adCampaignId } = opts;
  const { data, error } = await admin
    .from("ad_campaigns")
    .update({
      override_postable: null,
      override_score: null,
      override_reason: null,
      override_by: null,
      override_at: null,
    })
    .eq("id", adCampaignId)
    .eq("workspace_id", workspaceId)
    .select("id, override_postable, override_score, override_reason, override_by, override_at")
    .maybeSingle();
  if (error || !data) return { matched: false, override: null };
  const r = data as Record<string, unknown>;
  return {
    matched: true,
    override: {
      override_postable: (r.override_postable as boolean | null) ?? null,
      override_score: (r.override_score as number | null) ?? null,
      override_reason: (r.override_reason as string | null) ?? null,
      override_by: (r.override_by as string | null) ?? null,
      override_at: (r.override_at as string | null) ?? null,
    },
  };
}
