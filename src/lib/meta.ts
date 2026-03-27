const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

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

/**
 * Exchange short-lived user token for a long-lived page access token
 */
export async function exchangeForPageToken(
  appId: string,
  appSecret: string,
  shortLivedToken: string
): Promise<{ pageAccessToken: string; pageId: string; pageName: string; instagramId?: string } | { error: string }> {
  // Step 1: Exchange for long-lived user token
  const longLivedRes = await fetch(
    `${GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`
  );

  if (!longLivedRes.ok) {
    const err = await longLivedRes.json().catch(() => ({}));
    return { error: err?.error?.message || "Failed to exchange for long-lived token" };
  }

  const { access_token: longLivedUserToken } = await longLivedRes.json();

  // Step 2: Get pages with page access tokens
  const pagesRes = await fetch(
    `${GRAPH_BASE}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${longLivedUserToken}`
  );

  if (!pagesRes.ok) {
    const err = await pagesRes.json().catch(() => ({}));
    return { error: err?.error?.message || "Failed to get pages" };
  }

  const pagesData = await pagesRes.json();
  const pages = pagesData.data;

  if (!pages || pages.length === 0) {
    return { error: "No Facebook Pages found. Make sure you have admin access to a Facebook Page." };
  }

  // Use first page (most common use case)
  const page = pages[0];

  return {
    pageAccessToken: page.access_token,
    pageId: page.id,
    pageName: page.name,
    instagramId: page.instagram_business_account?.id,
  };
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
