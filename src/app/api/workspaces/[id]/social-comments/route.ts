import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET — list social_comments rows with filters.
 * Query params:
 *   status        open | hidden | replied | deleted | escalated | ignored
 *                 (omit or 'all' = no filter)
 *   sentiment     positive | negative | neutral | spam | abusive
 *   page_id       meta_pages.id filter
 *   page_type     brand | creator
 *   product_id    products.id filter
 *   ad            'true' | 'false'
 *   from          ISO date — created_at >= from
 *   to            ISO date — created_at <  to
 *   limit         default 50, max 200
 *   offset        default 0
 *
 * Returns:
 *   { comments: [...], total: number }
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const sentiment = url.searchParams.get("sentiment");
  const pageId = url.searchParams.get("page_id");
  const pageType = url.searchParams.get("page_type");
  const productId = url.searchParams.get("product_id");
  const ad = url.searchParams.get("ad");
  const aiAction = url.searchParams.get("ai_action");
  const humanRating = url.searchParams.get("human_rating");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  // meta_post_cache has no FK from social_comments — meta_post_id is just
  // text on both sides, and a comment can land before the cache row exists
  // (if Graph metadata fetch failed). Join in JS instead of using
  // PostgREST embeds for that one relation.
  let query = admin
    .from("social_comments")
    .select(
      `id, meta_page_id, meta_comment_id, meta_post_id, meta_sender_id, meta_sender_name, meta_sender_username,
       body, is_ad, page_type, ad_id, sentiment, matched_product_id, status, moderation_source,
       ai_action, ai_reasoning, ai_reply_body, ai_visibility, ai_considers, ai_kb_sources, ai_model,
       human_rating, human_rating_notes, human_rated_at,
       liked_at, hidden_at, replied_at, deleted_at, created_at, updated_at,
       meta_pages!inner(meta_page_name, platform, page_type),
       products(title, handle)`,
      { count: "exact" },
    )
    .eq("workspace_id", workspaceId);

  if (status && status !== "all") query = query.eq("status", status);
  if (sentiment) query = query.eq("sentiment", sentiment);
  if (pageId) query = query.eq("meta_page_id", pageId);
  if (pageType) query = query.eq("page_type", pageType);
  if (productId) query = query.eq("matched_product_id", productId);
  if (ad === "true") query = query.eq("is_ad", true);
  if (ad === "false") query = query.eq("is_ad", false);
  if (aiAction) query = query.eq("ai_action", aiAction);
  if (humanRating === "null") query = query.is("human_rating", null);
  else if (humanRating) query = query.eq("human_rating", humanRating);
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lt("created_at", to);

  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Manual join: stitch in meta_post_cache fields by (workspace_id, meta_post_id).
  const postIds = Array.from(new Set((data || []).map((c) => (c as { meta_post_id: string }).meta_post_id).filter(Boolean)));
  let cacheByPost: Map<string, { permalink_url: string | null; message: string | null; image_url: string | null; is_ad: boolean }> = new Map();
  if (postIds.length) {
    const { data: cacheRows } = await admin
      .from("meta_post_cache")
      .select("meta_post_id, permalink_url, message, image_url, is_ad")
      .eq("workspace_id", workspaceId)
      .in("meta_post_id", postIds);
    cacheByPost = new Map((cacheRows || []).map((r) => [r.meta_post_id as string, r]));
  }
  const comments = (data || []).map((c) => {
    const cached = cacheByPost.get((c as { meta_post_id: string }).meta_post_id);
    return { ...c, meta_post_cache: cached || null };
  });

  return NextResponse.json({ comments, total: count || 0 });
}
