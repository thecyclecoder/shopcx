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
import { hideComment, getPostMetadata } from "@/lib/meta";
import { resolvePostProductMatch, matchPostToProductViaAI } from "@/lib/meta-product-match";

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
  let imageUrl: string | null = null;
  for (const att of meta.attachments?.data || []) {
    if (att.target?.url) attachmentUrls.push(att.target.url);
    if (att.url) attachmentUrls.push(att.url);
    if (!imageUrl && att.media?.image?.src) imageUrl = att.media.image.src;
    for (const sub of att.subattachments?.data || []) {
      if (sub.target?.url) attachmentUrls.push(sub.target.url);
    }
  }
  void adTitle;  // no longer used for lookup — media id is the canonical key

  // Note: Marketing API doesn't support `EQUAL` filtering on
  // effective_object_story_id / effective_instagram_media_id (returns
  // #100 "filtering field with operation 'equal' is not supported").
  // So we can't do a JIT creative lookup keyed on the post id. The
  // long-term fix is a one-time + daily sync of all adcreatives into
  // a local `meta_ad_creatives` table indexed by post — TODO.
  // Until then, ad classification relies on the four-signal cascade
  // below; destination URLs only come from the post body/attachments
  // (IG ad-only destination URLs will be missing until we ship the
  // creative sync).
  const urls = [...new Set([...messageUrls, ...attachmentUrls])];

  // Resolve a product match — follows shortlink redirects, matches
  // against products.handle.
  let matchedProductId = await resolvePostProductMatch(admin, page.workspace_id, urls);

  // Haiku fallback: when URL matching comes up empty (common on
  // organic posts whose captions mention the product but don't link
  // to it — "Where are our Peach Mango fans at? ... Superfood Tabs"),
  // read the caption with Haiku and match against the catalog. One
  // call per uncached post; result cached below.
  if (!matchedProductId && meta.message) {
    matchedProductId = await matchPostToProductViaAI(admin, page.workspace_id, meta.message);
  }

  // Mark as ad via a three-signal cascade, most authoritative first:
  //   1. Webhook ad_id → ad served via paid placement right now
  //   2. is_published === false → dark post (page post that only
  //      exists as an ad creative, never published to timeline)
  //   3. promotion_status active/extendable/not_extendable → currently
  //      running ad
  // We previously used `is_eligible_for_promotion` which is TRUE for
  // nearly every public organic post on a business page (Maria Gundlach
  // false-positive). And we missed dark posts that had
  // promotion_status=inactive because the campaign ended (Suzy Doucet
  // false-negative). is_published=false catches the dark-post case.
  const promotionStatus = (meta.promotion_status || "").toLowerCase();
  const isCurrentlyPromoted = promotionStatus === "extendable"
    || promotionStatus === "not_extendable"
    || promotionStatus === "active";
  const isAd = !!adId || meta.is_published === false || isCurrentlyPromoted;

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
