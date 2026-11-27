/**
 * Organic reel ingest — the backend for the operator "Add reel" path in Marketing › Social
 * (organic-nugget-engine Phase 4). The Hidden Four animated videos become organic reels: offer-free
 * cuts with NO price, NO 'shop now' CTA, ending on a soft in-style brand card. The source mp4s live
 * outside the app (shared project files); the operator uploads them here.
 *
 * Stores the mp4 in the private bucket and inserts an organic_content format='reel' row as a DRAFT
 * (a human approves it in Marketing › Social before it posts). Write goes through the organic SDK.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { uploadBuffer, AD_BUCKET } from "@/lib/ad-storage";
import { insertOrganicContentDraft, type OrganicContent } from "@/lib/social/organic-content";

function slugify(s: string): string {
  return (s || "reel").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "reel";
}

export interface IngestReelInput {
  /** The mp4 bytes uploaded by the operator. */
  mp4: Buffer;
  title: string;
  hook?: string;
  dinnerLine?: string;
  productId?: string | null;
  createdBy?: string;
}

/**
 * Upload one organic reel mp4 and insert it into the organic library as a draft. Returns the row.
 */
export async function ingestOrganicReel(workspaceId: string, input: IngestReelInput): Promise<OrganicContent> {
  const admin = createAdminClient();
  const path = `organic/reels/${workspaceId}/${slugify(input.title)}-${Date.now()}.mp4`;
  await uploadBuffer(path, input.mp4, "video/mp4");
  return insertOrganicContentDraft(admin, workspaceId, {
    format: "reel",
    title: input.title,
    hook: input.hook ?? null,
    dinner_line: input.dinnerLine ?? null,
    video_bucket: AD_BUCKET,
    video_path: path,
    product_id: input.productId ?? null,
    created_by: input.createdBy ?? "operator",
    status: "draft",
  });
}
