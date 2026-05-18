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
 */
export async function exchangeForPageTokens(
  appId: string,
  appSecret: string,
  shortLivedToken: string
): Promise<{ pages: ExchangedPage[] } | { error: string }> {
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

  return { pages };
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
