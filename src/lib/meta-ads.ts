/**
 * Meta Marketing API — ad publishing (Graph v21.0).
 *
 * The WRITE half of the Meta integration: list ad accounts / campaigns / ad sets
 * / pages, upload a video to the ad-video library, build an ad creative, and
 * create an ad. Reads the per-workspace user token (with `ads_management` scope)
 * from `meta_connections`. Replicates the working flow in the sibling shopgrowth
 * repo. See docs/brain/lifecycles/ad-publish.md.
 *
 * POSTs are form-encoded (`URLSearchParams`; nested objects JSON-stringified) —
 * the Marketing API does NOT accept JSON bodies for these endpoints.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

export interface MetaAdAccount { id: string; name: string; account_status?: number; currency?: string }
export interface MetaCampaign { id: string; name: string; status: string; objective?: string }
export interface MetaAdSet { id: string; name: string; status: string; campaign_id?: string }
export interface MetaPage { id: string; name: string; instagram_user_id: string | null }

/** The active per-workspace user token (ads_management). meta_connections first, workspace token as fallback. */
export async function getMetaUserToken(workspaceId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data: conn } = await admin
    .from("meta_connections")
    .select("access_token_encrypted")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (conn?.access_token_encrypted) return decrypt(conn.access_token_encrypted);
  const { data: ws } = await admin.from("workspaces").select("meta_user_access_token_encrypted").eq("id", workspaceId).single();
  return ws?.meta_user_access_token_encrypted ? decrypt(ws.meta_user_access_token_encrypted) : null;
}

const actId = (id: string) => (id.startsWith("act_") ? id : `act_${id.replace(/^act_/, "")}`);

async function metaGet(path: string, token: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${GRAPH_BASE}/${path}${sep}access_token=${encodeURIComponent(token)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`meta_${res.status}: ${json.error?.message || "graph_error"}`);
  return json;
}

function metaErr(status: number, error: any): Error {
  // Meta's useful detail is in error_user_title/msg, not the terse `message`.
  const detail = error?.error_user_title ? `${error.error_user_title}: ${error.error_user_msg || ""}` : error?.message || "graph_error";
  return new Error(`meta_${status}: ${detail}`.trim());
}

async function metaPost(path: string, body: Record<string, unknown>, token: string): Promise<any> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v == null) continue;
    params.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  params.append("access_token", token);
  const res = await fetch(`${GRAPH_BASE}/${path}`, { method: "POST", body: params });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw metaErr(res.status, json.error);
  return json;
}


// ── Listing (for the publish selectors) ─────────────────────────────────────

export async function listAdAccounts(token: string): Promise<MetaAdAccount[]> {
  const j = await metaGet("me/adaccounts?fields=id,name,account_status,currency&limit=300", token);
  return j.data || [];
}
export async function listCampaigns(token: string, accountId: string): Promise<MetaCampaign[]> {
  const j = await metaGet(`${actId(accountId)}/campaigns?fields=id,name,status,objective&limit=300&effective_status=["ACTIVE","PAUSED"]`, token);
  return j.data || [];
}
export async function listAdSets(token: string, accountId: string, campaignId?: string): Promise<MetaAdSet[]> {
  const filtering = campaignId ? `&filtering=[{"field":"campaign.id","operator":"EQUAL","value":"${campaignId}"}]` : "";
  const j = await metaGet(`${actId(accountId)}/adsets?fields=id,name,status,campaign_id&limit=300&effective_status=["ACTIVE","PAUSED"]${filtering}`, token);
  return j.data || [];
}
export async function listPages(token: string): Promise<MetaPage[]> {
  const j = await metaGet("me/accounts?fields=id,name,instagram_business_account{id,username}&limit=200", token);
  return (j.data || []).map((p: any) => ({ id: p.id, name: p.name, instagram_user_id: p.instagram_business_account?.id || null }));
}

// ── Video → creative → ad ────────────────────────────────────────────────────

/** Upload a video to the ad-video library by URL (Meta downloads it). Returns video_id. */
export async function uploadAdVideo(token: string, accountId: string, fileUrl: string, name: string): Promise<string> {
  const j = await metaPost(`${actId(accountId)}/advideos`, { file_url: fileUrl, name }, token);
  if (!j.id) throw new Error("meta_advideo_no_id");
  return j.id;
}

/** Poll until Meta finishes processing the video (else the ad errors with an unready video). */
export async function waitForVideoReady(token: string, videoId: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 240000);
  for (;;) {
    const j = await metaGet(`${videoId}?fields=status`, token);
    const st = j.status?.video_status;
    if (st === "ready") return;
    if (st === "error") throw new Error(`meta_video_error: ${JSON.stringify(j.status || {}).slice(0, 120)}`);
    if (Date.now() > deadline) throw new Error("meta_video_timeout");
    await new Promise((r) => setTimeout(r, opts?.intervalMs ?? 5000));
  }
}

/** Upload an image (e.g. a thumbnail) → returns its hash for use as image_hash. */
export async function uploadAdImage(token: string, accountId: string, bytes: Buffer, filename = "thumb.jpg"): Promise<string> {
  const fd = new FormData();
  fd.append("filename", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), filename);
  fd.append("access_token", token);
  const res = await fetch(`${GRAPH_BASE}/${actId(accountId)}/adimages`, { method: "POST", body: fd });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`meta_adimage: ${j.error?.message || res.status}`);
  const first = Object.values(j.images || {})[0] as { hash?: string } | undefined;
  if (!first?.hash) throw new Error("meta_adimage_no_hash");
  return first.hash;
}

export interface CreativeArgs {
  accountId: string;
  name: string;
  pageId: string;
  instagramUserId?: string | null;
  videoId: string;
  thumbnailHash?: string | null;
  headlines: string[]; // headline + variations
  primaryTexts: string[]; // primary text + variations
  description?: string | null;
  ctaType: string;
  destinationUrl: string;
  urlTags?: string | null; // UTM query string
}

/** Meta's auto-generated thumbnail URL for a processed video (required by video ads). */
export async function getVideoThumbnail(token: string, videoId: string): Promise<string | null> {
  try {
    const j = await metaGet(`${videoId}/thumbnails?fields=uri,is_preferred`, token);
    const arr = j.data || [];
    const pref = arr.find((t: any) => t.is_preferred) || arr[0];
    return pref?.uri || null;
  } catch {
    return null;
  }
}

/**
 * Create a **non-dynamic, multi-text** video ad creative — one video, multiple
 * headline + primary-text options ("Add text option / Add headline option"),
 * publishable into a **regular** (non-Dynamic-Creative) ad set that holds many ads.
 *
 * The shape (confirmed from shopgrowth's working publisher — see
 * docs/brain/lifecycles/ad-publish.md):
 *   - `asset_feed_spec` carries the variations: `titles[]`, `bodies[]`,
 *     `descriptions[]`, `call_to_action_types`, and the link in `link_urls`.
 *   - **NO `ad_formats`, NO `optimization_type`, NO `asset_customization_rules`** —
 *     those three are what force Dynamic-Creative semantics and trigger "Dynamic
 *     Creative ads can only be created under Dynamic Creative Ad Sets". Omitting
 *     them keeps the creative a plain multi-text ad.
 *   - `object_story_spec: { page_id, instagram_user_id }` — required for accounts
 *     without a default promotable page (ours). Adding it does NOT make it dynamic.
 *   - The **link** goes in `asset_feed_spec.link_urls = [{ website_url }]`, NOT a
 *     top-level `link` and NOT in `call_to_action` (else "link field is required").
 *   - Video ads need a **thumbnail** — `thumbnail_hash` on the video asset.
 *   - UTM tracking stays in the top-level `url_tags` (link_urls can't carry it).
 *   - `degrees_of_freedom_spec.text_optimizations = OPT_OUT` — don't let Meta
 *     auto-rewrite the copy.
 */
export async function createAdCreative(token: string, a: CreativeArgs): Promise<string> {
  const body: Record<string, unknown> = {
    name: a.name,
    object_story_spec: { page_id: a.pageId, ...(a.instagramUserId ? { instagram_user_id: a.instagramUserId } : {}) },
    asset_feed_spec: {
      videos: [{ video_id: a.videoId, ...(a.thumbnailHash ? { thumbnail_hash: a.thumbnailHash } : {}) }],
      titles: a.headlines.filter(Boolean).map((text) => ({ text })),
      bodies: a.primaryTexts.filter(Boolean).map((text) => ({ text })),
      ...(a.description ? { descriptions: [{ text: a.description }] } : {}),
      call_to_action_types: [a.ctaType],
      link_urls: [{ website_url: a.destinationUrl }],
      // intentionally NO ad_formats / optimization_type / asset_customization_rules
    },
    degrees_of_freedom_spec: { creative_features_spec: { text_optimizations: { enroll_status: "OPT_OUT" } } },
    ...(a.urlTags ? { url_tags: a.urlTags } : {}),
  };
  const j = await metaPost(`${actId(a.accountId)}/adcreatives`, body, token);
  if (!j.id) throw new Error("meta_creative_no_id");
  return j.id;
}

/** Create the ad in an ad set. Defaults to PAUSED so nothing spends until reviewed. */
export async function createAd(
  token: string,
  accountId: string,
  args: { name: string; adsetId: string; creativeId: string; status?: "PAUSED" | "ACTIVE" },
): Promise<string> {
  const j = await metaPost(
    `${actId(accountId)}/ads`,
    { name: args.name, adset_id: args.adsetId, creative: { creative_id: args.creativeId }, status: args.status || "PAUSED" },
    token,
  );
  if (!j.id) throw new Error("meta_ad_no_id");
  return j.id;
}
