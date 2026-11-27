/**
 * organic_content SDK — the WRITE chokepoint for the organic social library, separate from ads
 * (docs/brain/tables/organic_content.md · Phase 1 of the organic-nugget-engine spec).
 *
 * CLAUDE.md "raw .from with no SDK → STOP": every organic_content write goes through here so a
 * wrong column can't silently read/write empty, and so the organic feed never again reaches back
 * into the ads system (ad_campaigns / ad_videos) for what it posts. Enforced by
 * scripts/_check-organic-content-sdk-compliance.ts (chained into predeploy).
 *
 * The library holds three formats — carousel (nugget slideshows), reel (animated story reels),
 * review (review highlights) — and the scheduler reads organic content ONLY from this library.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export type OrganicFormat = "carousel" | "reel" | "review";
export type OrganicPillar = "body" | "food_first" | "superfoods";
export type OrganicStatus = "draft" | "approved" | "retired";

/** One ordered carousel slide (or the single rendered card of a review). */
export interface OrganicSlide {
  headline: string;
  body?: string | null;
  /** Private-bucket media — re-signed at publish (never persist a signed URL). */
  image_bucket?: string | null;
  image_path?: string | null;
}

export interface OrganicContent {
  id: string;
  workspace_id: string;
  format: OrganicFormat;
  pillar: OrganicPillar | null;
  title: string | null;
  hook: string | null;
  slides: OrganicSlide[];
  dinner_line: string | null;
  study_citation: string | null;
  video_bucket: string | null;
  video_path: string | null;
  product_id: string | null;
  review_id: string | null;
  status: OrganicStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, workspace_id, format, pillar, title, hook, slides, dinner_line, study_citation, video_bucket, video_path, product_id, review_id, status, created_by, created_at, updated_at";

function rowToContent(r: Record<string, unknown>): OrganicContent {
  return {
    ...(r as unknown as OrganicContent),
    slides: (r.slides as OrganicSlide[] | null) ?? [],
  };
}

/**
 * Approved organic assets the scheduler is allowed to post, newest first. Optionally narrowed to a
 * single format (e.g. only `carousel` for the daily nugget slot).
 */
export async function listApprovedOrganicContent(
  admin: Admin,
  workspaceId: string,
  opts: { format?: OrganicFormat } = {},
): Promise<OrganicContent[]> {
  let q = admin
    .from("organic_content")
    .select(COLS)
    .eq("workspace_id", workspaceId)
    .eq("status", "approved")
    .order("created_at", { ascending: false });
  if (opts.format) q = q.eq("format", opts.format);
  const { data, error } = await q;
  if (error) throw new Error(`listApprovedOrganicContent: ${error.message}`);
  return (data ?? []).map(rowToContent);
}

/** A single organic asset by id (workspace-scoped), or null. */
export async function getOrganicContent(
  admin: Admin,
  workspaceId: string,
  id: string,
): Promise<OrganicContent | null> {
  const { data, error } = await admin
    .from("organic_content")
    .select(COLS)
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getOrganicContent: ${error.message}`);
  return data ? rowToContent(data) : null;
}

export interface InsertOrganicDraftInput {
  format: OrganicFormat;
  pillar?: OrganicPillar | null;
  title?: string | null;
  hook?: string | null;
  slides?: OrganicSlide[];
  dinner_line?: string | null;
  study_citation?: string | null;
  video_bucket?: string | null;
  video_path?: string | null;
  product_id?: string | null;
  review_id?: string | null;
  created_by?: string;
  /**
   * Lifecycle override. Defaults to 'draft' (supervisable autonomy: the generator proposes, a human
   * approves). Review highlights are rendered from already-human-featured reviews, so the review
   * mover inserts them 'approved' to preserve their auto-posting behaviour.
   */
  status?: OrganicStatus;
}

/**
 * Insert one organic asset. Lands as status='draft' unless overridden — the nugget generator
 * (Phase 3) proposes drafts a human approves in Marketing › Social. Returns the new row.
 */
export async function insertOrganicContentDraft(
  admin: Admin,
  workspaceId: string,
  input: InsertOrganicDraftInput,
): Promise<OrganicContent> {
  const { data, error } = await admin
    .from("organic_content")
    .insert({
      workspace_id: workspaceId,
      format: input.format,
      pillar: input.pillar ?? null,
      title: input.title ?? null,
      hook: input.hook ?? null,
      slides: input.slides ?? [],
      dinner_line: input.dinner_line ?? null,
      study_citation: input.study_citation ?? null,
      video_bucket: input.video_bucket ?? null,
      video_path: input.video_path ?? null,
      product_id: input.product_id ?? null,
      review_id: input.review_id ?? null,
      status: input.status ?? "draft",
      created_by: input.created_by ?? "system",
    })
    .select(COLS)
    .single();
  if (error || !data) throw new Error(`insertOrganicContentDraft: ${error?.message ?? "no row"}`);
  return rowToContent(data);
}

/** Flip an organic asset's lifecycle status (approve a draft, retire an asset). */
export async function setOrganicContentStatus(
  admin: Admin,
  workspaceId: string,
  id: string,
  status: OrganicStatus,
): Promise<void> {
  const { error } = await admin
    .from("organic_content")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", id);
  if (error) throw new Error(`setOrganicContentStatus: ${error.message}`);
}

/**
 * Draft-or-approved assets of a format (the "queued" set) — newest first. The nugget generator uses
 * this to keep ≥7 carousels queued and to dedupe new drafts against existing titles.
 */
export async function listQueuedOrganicContent(
  admin: Admin,
  workspaceId: string,
  format: OrganicFormat,
): Promise<OrganicContent[]> {
  const { data, error } = await admin
    .from("organic_content")
    .select(COLS)
    .eq("workspace_id", workspaceId)
    .eq("format", format)
    .in("status", ["draft", "approved"])
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listQueuedOrganicContent: ${error.message}`);
  return (data ?? []).map(rowToContent);
}

/**
 * review_ids that already have an organic review card in this workspace — the idempotency read for
 * the featured-review mover, so a daily run cards each featured review exactly once. Read-only;
 * kept in the SDK so featured-review-cards never touches `.from('organic_content')` directly.
 */
export async function existingOrganicReviewIds(
  admin: Admin,
  workspaceId: string,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from("organic_content")
    .select("review_id")
    .eq("workspace_id", workspaceId)
    .eq("format", "review")
    .not("review_id", "is", null);
  if (error) throw new Error(`existingOrganicReviewIds: ${error.message}`);
  const set = new Set<string>();
  for (const r of data ?? []) if (r.review_id) set.add(r.review_id as string);
  return set;
}
