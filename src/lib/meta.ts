import { createHmac, timingSafeEqual } from "crypto";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Verify the X-Hub-Signature-256 header on an incoming Meta webhook.
 *
 * Meta signs the raw request body with HMAC-SHA256(appSecret, body)
 * and sends it in the header as `sha256=<hex>`. We compute the same
 * signature and constant-time compare. Reject when:
 *  - header is missing or malformed
 *  - app secret isn't configured
 *  - hex string length doesn't match (timingSafeEqual throws otherwise)
 *  - digests don't match
 *
 * The raw body string MUST be the exact bytes as received. Once JSON
 * parsing happens, key ordering / whitespace can change the bytes and
 * the signature won't match.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const [algo, providedHex] = signatureHeader.split("=");
  if (algo !== "sha256" || !providedHex) return false;

  const computed = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  if (computed.length !== providedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(providedHex, "hex"));
  } catch {
    return false;
  }
}

/**
 * Send a DM reply via Meta Messenger / Instagram
 */
export async function sendMetaDM(
  pageAccessToken: string,
  recipientId: string,
  message: string
): Promise<{ messageId?: string; error?: string }> {
  const res = await fetch(`${GRAPH_BASE}/me/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pageAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: message },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err?.error?.message || `Meta API error ${res.status}` };
  }

  const data = await res.json();
  return { messageId: data.message_id };
}

/**
 * Reply to a Facebook/Instagram comment
 */
export async function replyToComment(
  pageAccessToken: string,
  commentId: string,
  message: string
): Promise<{ commentId?: string; error?: string }> {
  const res = await fetch(`${GRAPH_BASE}/${commentId}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pageAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err?.error?.message || `Meta API error ${res.status}` };
  }

  const data = await res.json();
  return { commentId: data.id };
}

/**
 * Hide an offensive comment
 */
export async function hideComment(
  pageAccessToken: string,
  commentId: string,
  hide = true
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${GRAPH_BASE}/${commentId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pageAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ is_hidden: hide }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { success: false, error: err?.error?.message || `Meta API error ${res.status}` };
  }

  return { success: true };
}

/**
 * Delete a comment
 */
export async function deleteComment(
  pageAccessToken: string,
  commentId: string
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${GRAPH_BASE}/${commentId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${pageAccessToken}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { success: false, error: err?.error?.message || `Meta API error ${res.status}` };
  }

  return { success: true };
}

/**
 * Like a comment on behalf of the Page (Graph API: POST /{comment-id}/likes).
 * Used as a moderation action — Sonnet may decide a positive customer
 * comment is best acknowledged with a like rather than a written reply.
 */
export async function likeComment(
  pageAccessToken: string,
  commentId: string,
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${GRAPH_BASE}/${commentId}/likes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pageAccessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { success: false, error: err?.error?.message || `Meta API error ${res.status}` };
  }
  return { success: true };
}

/**
 * Fetch a post's metadata + attachments. Used to cache post context
 * (caption, permalink, image, ad flag) and to extract product URLs
 * for product matching.
 *
 * Returns null on error rather than throwing — the moderation pipeline
 * should keep working even if a single post fetch fails.
 */
export interface MetaPostMetadata {
  id: string;
  permalink_url?: string;
  message?: string;
  created_time?: string;
  is_eligible_for_promotion?: boolean;
  attachments?: {
    data: Array<{
      type?: string;
      url?: string;
      media?: { image?: { src?: string }; source?: string };
      target?: { url?: string };
      subattachments?: { data: Array<{ media?: { image?: { src?: string } }; target?: { url?: string } }> };
    }>;
  };
}

export async function getPostMetadata(
  pageAccessToken: string,
  postId: string,
): Promise<MetaPostMetadata | null> {
  const fields = "id,permalink_url,message,created_time,is_eligible_for_promotion,attachments{media,target,subattachments,type,url}";
  const url = `${GRAPH_BASE}/${postId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(pageAccessToken)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

interface CreativeShape {
  effective_instagram_media_id?: string;
  effective_object_story_id?: string;
  object_story_spec?: { link_data?: { link?: string } };
  asset_feed_spec?: { link_urls?: Array<{ website_url?: string }> };
}

function extractDestinationUrls(c: CreativeShape): string[] {
  const out: string[] = [];
  const single = c.object_story_spec?.link_data?.link;
  if (single) out.push(single);
  for (const lu of c.asset_feed_spec?.link_urls || []) {
    if (lu.website_url) out.push(lu.website_url);
  }
  return out;
}

/**
 * Resolve the destination URLs of the ad that promoted a given post.
 *
 * Why we look up by media id instead of the webhook's `ad_id`:
 * Meta's IG comments webhook ships a placement-variant alias as `ad_id`
 * (e.g. 120246490668840184) that direct /{id} lookup rejects. The
 * `media.id` field — the IG post being promoted — IS stable, never
 * changes, and resolves to a single ad creative via the
 * `effective_instagram_media_id` field on adcreatives.
 *
 * For FB-side ads (rare on this surface), the equivalent is
 * `effective_object_story_id` on the creative, formatted as
 * `{page_id}_{post_id}`.
 *
 * Strategy:
 *   1. Walk active ad accounts (account_status=1) first.
 *   2. For each account, paginate /act_X/adcreatives requesting
 *      effective_instagram_media_id + object_story_spec + asset_feed_spec.
 *   3. First creative whose effective_instagram_media_id matches our
 *      media id wins. Extract URLs and return.
 *
 * Caller persists the result on meta_post_cache keyed by media_id (post_id),
 * so this expensive cross-account scan only runs once per ad campaign.
 *
 * Requires ads_read on the USER access token (Marketing API rejects page
 * tokens for adcreatives).
 */
export async function getAdDestinationUrlsByMediaId(
  userAccessToken: string,
  mediaId: string,
  platform: "instagram" | "facebook",
): Promise<string[]> {
  // For IG ads: creative.effective_instagram_media_id == webhook media.id (raw IG media id).
  // For FB ads: creative.effective_object_story_id == webhook post_id (already in
  //             "{pageId}_{postId}" format — no extra concat needed).
  const matchField: "effective_instagram_media_id" | "effective_object_story_id" =
    platform === "instagram" ? "effective_instagram_media_id" : "effective_object_story_id";
  const matchValue = mediaId;

  let accounts: Array<{ id: string; account_status: number }>;
  try {
    const r = await fetch(`${GRAPH_BASE}/me/adaccounts?fields=id,account_status&limit=200&access_token=${encodeURIComponent(userAccessToken)}`);
    if (!r.ok) return [];
    accounts = ((await r.json()).data || []) as Array<{ id: string; account_status: number }>;
  } catch {
    return [];
  }
  // Active first; disabled accounts only as last resort.
  accounts.sort((a, b) => (a.account_status === 1 ? 0 : 1) - (b.account_status === 1 ? 0 : 1));

  const fields = "id,name,effective_instagram_media_id,effective_object_story_id,object_story_spec{link_data{link}},asset_feed_spec{link_urls}";

  for (const acct of accounts) {
    let next: string | null = `${GRAPH_BASE}/${acct.id}/adcreatives?fields=${encodeURIComponent(fields)}&limit=200&access_token=${encodeURIComponent(userAccessToken)}`;
    let pages = 0;
    while (next && pages < 5) {   // cap pagination per account at 1000 creatives
      let json: { data?: CreativeShape[]; paging?: { next?: string } } = {};
      try {
        const r: Response = await fetch(next);
        if (!r.ok) break;
        json = await r.json();
      } catch {
        break;
      }
      for (const c of json.data || []) {
        const stored = matchField === "effective_instagram_media_id"
          ? c.effective_instagram_media_id
          : c.effective_object_story_id;
        if (stored === matchValue) {
          const urls = extractDestinationUrls(c);
          if (urls.length) return urls;
        }
      }
      next = json.paging?.next || null;
      pages++;
    }
  }

  return [];
}

/**
 * Get Page profile info
 */
export async function getPageProfile(
  pageAccessToken: string
): Promise<{ id: string; name: string; instagram_business_account?: { id: string } } | null> {
  const res = await fetch(
    `${GRAPH_BASE}/me?fields=id,name,instagram_business_account&access_token=${pageAccessToken}`
  );

  if (!res.ok) return null;
  return res.json();
}

export interface ExchangedPage {
  pageAccessToken: string;
  pageId: string;
  pageName: string;
  instagramId?: string;
  instagramName?: string;
}

/**
 * Exchange short-lived user token for long-lived page access tokens for
 * ALL pages the user authorized — not just the first. Returns one entry
 * per FB page; Instagram business accounts come through as `instagramId`
 * + `instagramName` on the parent FB page (Meta links IG to a page).
 *
 * Also returns the long-lived USER access token. Pages tokens can hit
 * pages/comments/messages endpoints; Marketing API endpoints (e.g.
 * /{ad_id}?fields=creative) require the user token + ads_read scope.
 */
export async function exchangeForPageTokens(
  appId: string,
  appSecret: string,
  shortLivedToken: string
): Promise<{ pages: ExchangedPage[]; userAccessToken: string } | { error: string }> {
  const longLivedRes = await fetch(
    `${GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`
  );

  if (!longLivedRes.ok) {
    const err = await longLivedRes.json().catch(() => ({}));
    return { error: err?.error?.message || "Failed to exchange for long-lived token" };
  }

  const { access_token: longLivedUserToken } = await longLivedRes.json();

  const pagesRes = await fetch(
    `${GRAPH_BASE}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name}&access_token=${longLivedUserToken}`
  );

  if (!pagesRes.ok) {
    const err = await pagesRes.json().catch(() => ({}));
    return { error: err?.error?.message || "Failed to get pages" };
  }

  const pagesData = await pagesRes.json();
  const raw = (pagesData.data || []) as Array<{
    id: string;
    name: string;
    access_token: string;
    instagram_business_account?: { id: string; username?: string; name?: string };
  }>;

  if (raw.length === 0) {
    return { error: "No Facebook Pages found. Make sure you have admin access to a Facebook Page." };
  }

  const pages: ExchangedPage[] = raw.map((p) => ({
    pageAccessToken: p.access_token,
    pageId: p.id,
    pageName: p.name,
    instagramId: p.instagram_business_account?.id,
    instagramName: p.instagram_business_account?.name || p.instagram_business_account?.username,
  }));

  return { pages, userAccessToken: longLivedUserToken };
}

/**
 * Subscribe a page to webhook events
 */
export async function subscribePageWebhooks(
  pageId: string,
  pageAccessToken: string
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(
    `${GRAPH_BASE}/${pageId}/subscribed_apps`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pageAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subscribed_fields: ["messages", "feed", "mention"],
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { success: false, error: err?.error?.message || `Failed to subscribe: ${res.status}` };
  }

  return { success: true };
}

/**
 * Build Meta OAuth authorization URL
 */
export function buildMetaAuthUrl(params: {
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const scopes = [
    "pages_messaging",
    "pages_read_engagement",
    "pages_manage_metadata",
    "instagram_basic",
    "instagram_manage_messages",
    "instagram_manage_comments",
    // ads_read = lets us call /{ad_id} for creative.object_story_spec.link_data.link
    // so ad-comment moderation can match the comment to the destination product.
    "ads_read",
  ].join(",");

  return `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?client_id=${params.appId}&redirect_uri=${encodeURIComponent(params.redirectUri)}&state=${params.state}&scope=${scopes}`;
}

/**
 * Exchange Meta OAuth code for access token
 */
export async function exchangeMetaCode(params: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ access_token: string } | { error: string }> {
  const res = await fetch(
    `${GRAPH_BASE}/oauth/access_token?client_id=${params.appId}&redirect_uri=${encodeURIComponent(params.redirectUri)}&client_secret=${params.appSecret}&code=${params.code}`
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err?.error?.message || "Failed to exchange code" };
  }

  return res.json();
}
