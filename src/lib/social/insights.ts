/**
 * Meta Insights ingestion for the social scheduler's optimizer.
 * See docs/brain/specs/automated-social-scheduler.md.
 *
 * Two pulls:
 *  - per-post engagement (reach/likes/comments/saves/shares) → scheduled_social_posts
 *  - audience-online-by-hour per page → social_audience_hours
 *
 * Graph response shapes vary by media type / platform / API version, so every
 * parse is defensive: store what comes back, null otherwise.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

type Admin = ReturnType<typeof createAdminClient>;
const GRAPH = "https://graph.facebook.com/v21.0";

async function gget(path: string, token: string, extra = ""): Promise<any> {
  try { return await fetch(`${GRAPH}/${path}?access_token=${token}${extra}`).then((r) => r.json()); }
  catch { return null; }
}

interface Metrics { reach: number | null; likes: number | null; comments: number | null; saves: number | null; shares: number | null; engagement: number | null; }

async function fetchInstagramMetrics(mediaId: string, token: string): Promise<Metrics> {
  const fields = await gget(mediaId, token, "&fields=like_count,comments_count");
  const ins = await gget(`${mediaId}/insights`, token, "&metric=reach,saved,shares");
  const m: Record<string, number> = {};
  for (const row of ins?.data || []) {
    const v = row.values?.[0]?.value ?? row.total_value?.value;
    if (typeof v === "number") m[row.name] = v;
  }
  const likes = fields?.like_count ?? null, comments = fields?.comments_count ?? null;
  const saves = m.saved ?? null, shares = m.shares ?? null, reach = m.reach ?? null;
  const engagement = [likes, comments, saves, shares].some((x) => x != null)
    ? (likes || 0) + (comments || 0) + (saves || 0) + (shares || 0) : null;
  return { reach, likes, comments, saves, shares, engagement };
}

/** FB post unique reach. Meta retired `post_impressions_unique` in favor of
 *  the media-view metrics (late 2025), so try the new name first and fall
 *  back. A metric the API doesn't know errors the whole call, hence one
 *  request per name. Needs the `read_insights` scope. */
const FB_REACH_METRICS = ["post_total_media_view_unique", "post_impressions_unique"];

async function fetchFacebookReach(postId: string, token: string): Promise<number | null> {
  for (const metric of FB_REACH_METRICS) {
    const d = await gget(`${postId}/insights`, token, `&metric=${metric}`);
    const v = d?.data?.find((r: any) => r.name === metric)?.values?.[0]?.value;
    if (typeof v === "number") return v;
  }
  return null;
}

async function fetchFacebookMetrics(postId: string, token: string): Promise<Metrics> {
  const d = await gget(postId, token, "&fields=likes.summary(true).limit(0),comments.summary(true).limit(0),shares");
  const likes = d?.likes?.summary?.total_count ?? null;
  const comments = d?.comments?.summary?.total_count ?? null;
  const shares = d?.shares?.count ?? null;
  const reach = await fetchFacebookReach(postId, token);
  const engagement = [likes, comments, shares].some((x) => x != null) ? (likes || 0) + (comments || 0) + (shares || 0) : null;
  return { reach, likes, comments, saves: null, shares, engagement };
}

/** Refresh engagement metrics for one posted row. */
export async function syncPostMetrics(admin: Admin, postId: string): Promise<boolean> {
  const { data: post } = await admin
    .from("scheduled_social_posts")
    .select("id, platform, meta_page_id, published_platform_id, status")
    .eq("id", postId).maybeSingle();
  if (!post || post.status !== "posted" || !post.published_platform_id) return false;
  const { data: page } = await admin.from("meta_pages").select("access_token_encrypted").eq("id", post.meta_page_id).single();
  if (!page?.access_token_encrypted) return false;
  let token: string; try { token = decrypt(page.access_token_encrypted); } catch { return false; }

  const m = post.platform === "instagram"
    ? await fetchInstagramMetrics(post.published_platform_id, token)
    : await fetchFacebookMetrics(post.published_platform_id, token);

  await admin.from("scheduled_social_posts").update({
    reach: m.reach, likes: m.likes, comments: m.comments, saves: m.saves, shares: m.shares,
    engagement: m.engagement, metrics_synced_at: new Date().toISOString(),
  }).eq("id", postId);
  return true;
}

/** Refresh the audience-online-by-hour heatmap for one IG page. (FB metric is deprecated.) */
export async function syncAudienceHours(admin: Admin, workspaceId: string, metaPageRowId: string, igUserId: string, token: string): Promise<boolean> {
  const ins = await gget(`${igUserId}/insights`, token, "&metric=online_followers&period=lifetime");
  const rows = ins?.data?.[0]?.values || [];
  if (!rows.length) return false;
  // Average the per-day hour maps into a single 0..23 vector.
  const sum: number[] = Array(24).fill(0); let days = 0;
  for (const r of rows) {
    const v = r.value || {};
    if (!Object.keys(v).length) continue;
    days++;
    for (let h = 0; h < 24; h++) sum[h] += Number(v[String(h)] || 0);
  }
  if (!days) return false;
  const avg = sum.map((s) => s / days);
  const max = Math.max(...avg, 1);
  const now = new Date().toISOString();
  const upserts = avg.map((a, h) => ({ workspace_id: workspaceId, meta_page_id: metaPageRowId, hour: h, score: a / max, updated_at: now }));
  await admin.from("social_audience_hours").upsert(upserts, { onConflict: "meta_page_id,hour" });
  return true;
}
