// Meta Graph API helpers

const META_API_VERSION = "v18.0";
const META_GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

export function getMetaAccountId(id: string): string {
  const stripped = id.replace(/^act_/, "");
  return `act_${stripped}`;
}

export async function metaGraphRequest(
  accessToken: string,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${META_GRAPH_URL}${path}`);
  url.searchParams.set("access_token", accessToken);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meta API error (${res.status}): ${text}`);
  }
  return res.json();
}

// OAuth URLs
export function getMetaAdsLoginUrl(workspaceId: string): string {
  const appId = process.env.META_APP_ID;
  const redirectUri = `${process.env.NEXT_PUBLIC_SITE_URL}/api/meta/ads-callback`;
  const scope = "ads_read,business_management";
  const state = workspaceId;

  return `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&response_type=code&state=${state}`;
}

export async function exchangeCodeForToken(code: string): Promise<{
  accessToken: string;
  expiresIn?: number;
}> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = `${process.env.NEXT_PUBLIC_SITE_URL}/api/meta/ads-callback`;

  const url = new URL(`${META_GRAPH_URL}/oauth/access_token`);
  url.searchParams.set("client_id", appId!);
  url.searchParams.set("client_secret", appSecret!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}
