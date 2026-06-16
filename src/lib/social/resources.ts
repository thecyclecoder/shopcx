/**
 * Resource selection for the social scheduler. Picks the next asset of a given
 * kind, skipping anything posted within the workspace's reuse window so the
 * feed stays varied. See docs/brain/specs/automated-social-scheduler.md.
 *
 * Private-bucket assets (avatar / ad_video / testimonial) return {bucket, path}
 * so the publisher re-signs a fresh URL at post time. Resources return a public
 * media_url + a summary for caption grounding.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { isSeasonallyAppropriate } from "@/lib/social/seasonality";

type Admin = ReturnType<typeof createAdminClient>;

export interface PickedAsset {
  sourceRefId: string;          // campaign_id | ad_video_id | post_id
  productId: string | null;
  mediaBucket?: string;
  mediaPath?: string;
  mediaUrl?: string;            // public assets (resources / blog)
  resourceSummary?: string;     // resources / blog only
  linkUrl?: string;             // blog only — public article URL (FB link card)
  title?: string;               // blog only — article title (caption grounding)
}

/** Parse `{bucket, path}` out of a Supabase storage object URL (signed or public). */
export function parseStorageUrl(url: string): { bucket: string; path: string } | null {
  const m = url.match(/\/object\/(?:sign|public)\/([^/]+)\/([^?]+)/);
  if (!m) return null;
  return { bucket: m[1], path: decodeURIComponent(m[2]) };
}

/** source_ref_ids of this kind posted (or scheduled) within `sinceDays`. */
export async function recentlyUsedRefIds(admin: Admin, workspaceId: string, sourceKind: string, sinceDays: number): Promise<Set<string>> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { data } = await admin
    .from("scheduled_social_posts")
    .select("source_ref_id")
    .eq("workspace_id", workspaceId)
    .eq("source_kind", sourceKind)
    .gte("scheduled_at", since)
    .not("source_ref_id", "is", null);
  return new Set((data || []).map((r) => r.source_ref_id as string));
}

function pickRandom<T>(arr: T[]): T | null {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

/** Campaign hero image — an avatar holding the product. */
export async function pickAvatar(admin: Admin, workspaceId: string, exclude: Set<string>): Promise<PickedAsset | null> {
  const { data } = await admin
    .from("ad_campaigns")
    .select("id, product_id, hero_image_url")
    .eq("workspace_id", workspaceId)
    .not("hero_image_url", "is", null)
    .not("product_id", "is", null);
  const eligible = (data || []).filter((c) => !exclude.has(c.id) && parseStorageUrl(c.hero_image_url));
  const pick = pickRandom(eligible);
  if (!pick) return null;
  const s = parseStorageUrl(pick.hero_image_url)!;
  return { sourceRefId: pick.id, productId: pick.product_id, mediaBucket: s.bucket, mediaPath: s.path };
}

async function campaignProduct(admin: Admin, campaignId: string): Promise<string | null> {
  const { data } = await admin.from("ad_campaigns").select("product_id").eq("id", campaignId).maybeSingle();
  return (data?.product_id as string) || null;
}

/** Finished ad video (reel). */
export async function pickAdVideo(admin: Admin, workspaceId: string, exclude: Set<string>): Promise<PickedAsset | null> {
  const { data } = await admin
    .from("ad_videos")
    .select("id, campaign_id, final_mp4_url")
    .eq("workspace_id", workspaceId)
    .eq("status", "ready")
    .eq("format", "reels_9x16")
    .not("final_mp4_url", "is", null);
  const eligible = (data || []).filter((v) => !exclude.has(v.id) && parseStorageUrl(v.final_mp4_url));
  const pick = pickRandom(eligible);
  if (!pick) return null;
  const s = parseStorageUrl(pick.final_mp4_url)!;
  return { sourceRefId: pick.id, productId: await campaignProduct(admin, pick.campaign_id), mediaBucket: s.bucket, mediaPath: s.path };
}

/** Testimonial / review static (5-star card). */
export async function pickTestimonial(admin: Admin, workspaceId: string, exclude: Set<string>): Promise<PickedAsset | null> {
  const { data } = await admin
    .from("ad_videos")
    .select("id, campaign_id, static_jpg_url, meta")
    .eq("workspace_id", workspaceId)
    .eq("status", "ready")
    .eq("media_kind", "static")
    .eq("meta->>archetype", "review");
  const eligible = (data || []).filter((v) => !exclude.has(v.id) && (v.meta?.storage_path || parseStorageUrl(v.static_jpg_url || "")));
  const pick = pickRandom(eligible);
  if (!pick) return null;
  let bucket: string, path: string;
  if (pick.meta?.storage_path) { bucket = "ad-tool"; path = pick.meta.storage_path as string; }
  else { const s = parseStorageUrl(pick.static_jpg_url)!; bucket = s.bucket; path = s.path; }
  return { sourceRefId: pick.id, productId: await campaignProduct(admin, pick.campaign_id), mediaBucket: bucket, mediaPath: path };
}

/** Blog resource (recipe / guide). Public image URL + summary for the caption. */
export async function pickResource(admin: Admin, workspaceId: string, exclude: Set<string>, now: Date = new Date()): Promise<PickedAsset | null> {
  const { data } = await admin
    .from("posts")
    .select("id, title, tags, excerpt, content_text, featured_image_url, social_image_url")
    .eq("workspace_id", workspaceId)
    .eq("is_resource", true)
    .eq("published", true)
    .not("featured_image_url", "is", null);
  // Skip resources that read as off-season for `now` (e.g. a fall chai recipe in
  // June, a July-4th post in October). Evergreen resources always pass.
  const eligible = (data || []).filter((p) =>
    !exclude.has(p.id) &&
    isSeasonallyAppropriate(`${p.title || ""} ${(p.tags || []).join(" ")} ${(p.excerpt || p.content_text || "").slice(0, 800)}`, now));
  const pick = pickRandom(eligible);
  if (!pick) return null;
  let productId: string | null = null;
  const { data: link } = await admin.from("post_products").select("product_id").eq("post_id", pick.id).limit(1).maybeSingle();
  productId = (link?.product_id as string) || null;
  return {
    sourceRefId: pick.id,
    productId,
    // Prefer the post's purpose-built 4:5 portrait (auto-blog generates one for
    // IG/FB feed); fall back to the landscape hero for older posts that lack one.
    mediaUrl: (pick as { social_image_url?: string | null }).social_image_url || pick.featured_image_url,
    resourceSummary: (pick.excerpt || pick.content_text || "").slice(0, 1500),
  };
}

/**
 * The single freshest blog the brand hasn't recently posted — for the always-on
 * daily blog slot. Unlike `pickResource` (random evergreen recipe), this is
 * newest-first and deterministic, so a brand-new blog goes out the soonest open
 * day and the 7-day window spreads the most-recent distinct articles across days.
 * Returns a public 4:5 image (auto-blog generates `social_image_url`) + the
 * article URL for Facebook's link card. Off-season posts are skipped.
 */
export async function pickNewestBlog(admin: Admin, workspaceId: string, exclude: Set<string>, now: Date = new Date()): Promise<PickedAsset | null> {
  const { data } = await admin
    .from("posts")
    .select("id, title, handle, tags, excerpt, content_text, featured_image_url, social_image_url, published_at, created_at")
    .eq("workspace_id", workspaceId)
    .eq("is_resource", true)
    .eq("published", true)
    .not("featured_image_url", "is", null)
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(40);
  const eligible = (data || []).filter((p) =>
    !exclude.has(p.id) && (p as { handle?: string }).handle &&
    isSeasonallyAppropriate(`${p.title || ""} ${(p.tags || []).join(" ")} ${(p.excerpt || p.content_text || "").slice(0, 800)}`, now));
  const pick = eligible[0]; // newest eligible (already sorted desc)
  if (!pick) return null;

  // Public article URL for the FB link card. Falls back to null (no domain →
  // FB posts the image instead of a link card).
  const { data: ws } = await admin.from("workspaces").select("storefront_domain, storefront_slug").eq("id", workspaceId).maybeSingle();
  const handle = (pick as { handle: string }).handle;
  const domain = (ws as { storefront_domain?: string | null })?.storefront_domain;
  const slug = (ws as { storefront_slug?: string | null })?.storefront_slug;
  const linkUrl = domain ? `https://${domain}/blog/${handle}` : (slug ? `https://shopcx.ai/store/${slug}/blog/${handle}` : undefined);

  let productId: string | null = null;
  const { data: link } = await admin.from("post_products").select("product_id").eq("post_id", pick.id).limit(1).maybeSingle();
  productId = (link?.product_id as string) || null;

  return {
    sourceRefId: pick.id,
    productId,
    mediaUrl: (pick as { social_image_url?: string | null }).social_image_url || pick.featured_image_url,
    resourceSummary: (pick.excerpt || pick.content_text || "").slice(0, 1500),
    linkUrl,
    title: (pick.title as string) || undefined,
  };
}

export type SourceKind = "avatar" | "ad_video" | "testimonial" | "resource" | "blog";

export async function pickBySourceKind(admin: Admin, workspaceId: string, kind: SourceKind, reuseDays: number, now: Date = new Date()): Promise<PickedAsset | null> {
  const exclude = await recentlyUsedRefIds(admin, workspaceId, kind, reuseDays);
  switch (kind) {
    case "avatar": return pickAvatar(admin, workspaceId, exclude);
    case "ad_video": return pickAdVideo(admin, workspaceId, exclude);
    case "testimonial": return pickTestimonial(admin, workspaceId, exclude);
    case "resource": return pickResource(admin, workspaceId, exclude, now);
    case "blog": return pickNewestBlog(admin, workspaceId, exclude, now);
  }
}
