/**
 * Comment ingestion path off the Meta webhook.
 *
 * Responsibilities (in order):
 *   1. Normalize FB-feed vs IG-comments payloads into a single shape.
 *   2. Hydrate post context — fetch + cache the parent post once so
 *      every subsequent comment on that post is fast.
 *   3. Insert the social_comments row.
 *   4. Apply rule-based moderation BEFORE Sonnet:
 *        a. ban list   → auto-hide via Graph API
 *        b. policy off → leave open for manual moderation
 *   5. Fire `social/comment.created` Inngest event so the Sonnet
 *      moderation handler runs async (the webhook needs to 200 fast).
 *
 * Verbs handled:
 *   - 'add'    → insert new row
 *   - 'edited' → bump body + edited_at
 *   - 'remove' → mark deleted_by_user_at (Meta-side deletion by user)
 *   - 'hide' / others → ignored (Meta confirms our own hide actions)
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { decrypt } from "@/lib/crypto";
import { hideComment, getPostMetadata, getAdDestinationUrlsByMediaId } from "@/lib/meta";
import { resolvePostProductMatch } from "@/lib/meta-product-match";

type Admin = ReturnType<typeof createAdminClient>;

interface MetaPageRow {
  id: string;
  workspace_id: string;
  meta_page_id: string;         // Meta-side numeric page ID (FB page) — needed for Marketing API joins
  page_type: string;
  ai_moderate_ad_comments: boolean;
  ai_moderate_organic_comments: boolean;
  platform: string;
}

interface CommentChangeValue {
  from?: { id: string; name?: string; username?: string };
  item?: string;
  comment_id?: string;
  parent_id?: string;
  post_id?: string;
  message?: string;   // FB feed comment body
  text?: string;      // IG comment body (different field name than FB)
  verb?: string;
  created_time?: number;
  ad_id?: string;
  id?: string;                                 // IG comment ID
  media?: { id?: string; ad_id?: string; ad_title?: string; media_product_type?: string };
}

interface IngestArgs {
  admin: Admin;
  page: MetaPageRow;
  platform: "facebook" | "instagram";
  change: CommentChangeValue;
  changeField: string;
}

export async function ingestSocialComment(args: IngestArgs): Promise<void> {
  const { admin, page, platform, change } = args;

  // Normalize identifiers across FB-feed and IG-comments shapes.
  const commentId = change.comment_id || change.id;
  const senderId = change.from?.id;
  if (!commentId || !senderId) return;

  // IG ships `media.id` as the parent post; FB ships `post_id`.
  // Parent comment ID — present when the user replied to an existing
  // comment rather than the post itself. We thread these as
  // social_comment_replies inbound rows on the existing parent.
  const postId = change.post_id || change.media?.id || "";
  const parentCommentId = change.parent_id && change.parent_id !== postId ? change.parent_id : null;
  const adId = change.ad_id || change.media?.ad_id || null;
  const adTitle = change.media?.ad_title || null;
  const verb = change.verb || "add";
  // FB feed comments ship the body as `message`; IG comments as `text`.
  const body = change.message || change.text || "";

  // ── edited / remove verbs ────────────────────────────────────────
  // These only touch an existing row; if we never saw the original
  // (e.g. ingest gap), nothing to update — drop the event.
  if (verb === "edited") {
    await admin.from("social_comments").update({
      body,
      edited_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("workspace_id", page.workspace_id).eq("meta_comment_id", commentId);
    return;
  }
  if (verb === "remove") {
    await admin.from("social_comments").update({
      deleted_by_user_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("workspace_id", page.workspace_id).eq("meta_comment_id", commentId);
    return;
  }
  if (verb !== "add") return;

  // ── Nested reply to an existing comment ──────────────────────────
  // Threads under the parent — not a new moderation row. Sonnet does
  // NOT re-run on these to avoid loops on long threads (spec rule
  // "AI moderation runs once per comment at ingest").
  if (parentCommentId) {
    const { data: parent } = await admin
      .from("social_comments")
      .select("id")
      .eq("workspace_id", page.workspace_id)
      .eq("meta_comment_id", parentCommentId)
      .maybeSingle();
    if (parent) {
      await admin.from("social_comment_replies").insert({
        workspace_id: page.workspace_id,
        social_comment_id: parent.id,
        meta_reply_id: commentId,
        meta_sender_id: senderId,
        meta_sender_name: change.from?.name || null,
        direction: "inbound",
        author_type: "customer",
        body,
      });
      return;
    }
    // Parent unknown — fall through and treat as a top-level comment.
  }

  // ── Hydrate post cache (first comment on this post) ──────────────
  const { matchedProductId, isAd: cachedIsAd } = await ensurePostCache({
    admin,
    page,
    postId,
    adId,
    adTitle,
    platform,
  });

  const isAd = cachedIsAd || !!adId;

  // ── Insert the moderation row ────────────────────────────────────
  const { data: inserted, error: insertErr } = await admin
    .from("social_comments")
    .insert({
      workspace_id: page.workspace_id,
      meta_page_id: page.id,
      meta_comment_id: commentId,
      meta_parent_comment_id: parentCommentId,
      meta_post_id: postId,
      meta_sender_id: senderId,
      meta_sender_name: change.from?.name || null,
      meta_sender_username: change.from?.username || null,
      body,
      is_ad: isAd,
      page_type: page.page_type,
      ad_id: adId,
      matched_product_id: matchedProductId,
      status: "open",
    })
    .select("id")
    .single();

  // Duplicate webhook deliveries are normal — Meta retries on any
  // non-2xx and occasionally double-delivers regardless. Unique
  // constraint covers us; just drop silently.
  if (insertErr || !inserted) return;

  const socialCommentId = inserted.id;

  // ── Rule: banned sender → auto-hide, skip Sonnet ─────────────────
  const { data: banned } = await admin
    .from("banned_meta_users")
    .select("id")
    .eq("workspace_id", page.workspace_id)
    .eq("meta_sender_id", senderId)
    .is("unbanned_at", null)
    .maybeSingle();

  if (banned) {
    const token = await loadPageAccessToken(admin, page.id);
    if (token) await hideComment(token, commentId, true);
    await admin.from("social_comments").update({
      status: "hidden",
      moderation_source: "rule",
      hidden_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", socialCommentId);
    return;
  }

  // ── Policy gate: should we moderate at all? ─────────────────────
  const moderateThisOne = isAd
    ? page.ai_moderate_ad_comments
    : page.ai_moderate_organic_comments;

  // Even if moderation is off, the row is created so it appears in
  // the manual moderation queue. We just don't fire Sonnet.
  if (!moderateThisOne) return;

  // ── Sandbox mode — Sonnet still runs, but in suggest-only mode.
  // The Inngest handler reads workspaces.sandbox_mode and skips the
  // Graph API call when set, leaving moderation_source='ai_suggested'.
  await inngest.send({
    name: "social/comment.created",
    data: {
      workspace_id: page.workspace_id,
      social_comment_id: socialCommentId,
      platform,
    },
  });
}

interface EnsurePostCacheArgs {
  admin: Admin;
  page: MetaPageRow;
  postId: string;
  adId: string | null;
  adTitle: string | null;
  platform: "facebook" | "instagram";
}

/**
 * Fetch and cache the parent post the first time we see a comment on
 * it. Returns the matched product (if any) and the cached is_ad flag
 * so the caller can write it onto the social_comments row.
 *
 * On Graph API failure we still return — moderation should keep
 * working without the post context, the dashboard just won't have
 * a thumbnail.
 */
async function ensurePostCache(args: EnsurePostCacheArgs): Promise<{
  matchedProductId: string | null;
  isAd: boolean;
}> {
  const { admin, page, postId, adId, adTitle, platform } = args;
  if (!postId) return { matchedProductId: null, isAd: !!adId };

  const { data: existing } = await admin
    .from("meta_post_cache")
    .select("matched_product_id, is_ad")
    .eq("workspace_id", page.workspace_id)
    .eq("meta_post_id", postId)
    .maybeSingle();

  if (existing) {
    return {
      matchedProductId: existing.matched_product_id ?? null,
      isAd: !!existing.is_ad,
    };
  }

  const token = await loadPageAccessToken(admin, page.id);
  if (!token) return { matchedProductId: null, isAd: !!adId };

  const meta = await getPostMetadata(token, postId);
  if (!meta) return { matchedProductId: null, isAd: !!adId };

  // Pull all candidate URLs from the post body + ad attachment targets.
  const messageUrls = extractUrls(meta.message || "");
  const attachmentUrls: string[] = [];
  for (const att of meta.attachments?.data || []) {
    if (att.target?.url) attachmentUrls.push(att.target.url);
    if (att.url) attachmentUrls.push(att.url);
    for (const sub of att.subattachments?.data || []) {
      if (sub.target?.url) attachmentUrls.push(sub.target.url);
    }
  }
  // For ad comments, the destination URL lives on the ad CREATIVE, not on
  // the post body or attachments. The post itself is just the IG media
  // container — its message/attachments don't contain a click-through. Pull
  // the ad's configured destination URL(s) directly via Marketing API.
  // Requires the USER access token (Marketing API rejects page tokens)
  // + ads_read scope.
  // Resolve the ad's destination URL via the IG media id (postId for IG,
  // or pageId_postId for FB). The webhook's `ad_id` is a placement alias
  // that doesn't direct-lookup; media id is stable across title changes
  // and points to the exact creative.
  let adUrls: string[] = [];
  if (adId && postId) {
    const { data: ws } = await admin
      .from("workspaces")
      .select("meta_user_access_token_encrypted")
      .eq("id", page.workspace_id)
      .maybeSingle();
    if (ws?.meta_user_access_token_encrypted) {
      const userToken = decrypt(ws.meta_user_access_token_encrypted as string);
      adUrls = await getAdDestinationUrlsByMediaId(userToken, postId, platform);
    }
  }
  void adTitle;  // no longer used for lookup — media id is the canonical key
  const urls = [...new Set([...adUrls, ...messageUrls, ...attachmentUrls])];

  // Resolve a product match — follows shortlink redirects, matches
  // against products.handle.
  const matchedProductId = await resolvePostProductMatch(admin, page.workspace_id, urls);

  // Cache image URL from first attachment with media.
  let imageUrl: string | null = null;
  for (const att of meta.attachments?.data || []) {
    if (att.media?.image?.src) {
      imageUrl = att.media.image.src;
      break;
    }
  }

  const isAd = !!adId || !!meta.is_eligible_for_promotion;

  await admin.from("meta_post_cache").insert({
    workspace_id: page.workspace_id,
    meta_page_id: page.id,
    meta_post_id: postId,
    is_ad: isAd,
    ad_id: adId,
    permalink_url: meta.permalink_url || null,
    message: meta.message || null,
    image_url: imageUrl,
    posted_at: meta.created_time ? new Date(meta.created_time).toISOString() : null,
    extracted_urls: urls,
    matched_product_id: matchedProductId,
  }).select("id").single();

  return { matchedProductId, isAd };
}

async function loadPageAccessToken(admin: Admin, metaPagesId: string): Promise<string | null> {
  const { data: page } = await admin
    .from("meta_pages")
    .select("access_token_encrypted")
    .eq("id", metaPagesId)
    .single();
  if (!page?.access_token_encrypted) return null;
  try {
    return decrypt(page.access_token_encrypted);
  } catch {
    return null;
  }
}

function extractUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s)]+/g) || [];
  return matches.map(m => m.replace(/[)>,.!?]+$/, ""));
}
