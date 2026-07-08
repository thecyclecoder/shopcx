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
import { graphFetchJson } from "@/lib/meta/graph-retry";

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

// Both Graph clients retry transient Meta errors (code 1/2, is_transient, 429,
// 5xx) with bounded backoff and surface error_user_title/msg detail on fatal
// errors — see graph-retry.ts.
async function metaGet(path: string, token: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${GRAPH_BASE}/${path}${sep}access_token=${encodeURIComponent(token)}`;
  return graphFetchJson(() => fetch(url), `GET ${path}`);
}

async function metaPost(path: string, body: Record<string, unknown>, token: string): Promise<any> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v == null) continue;
    params.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  params.append("access_token", token);
  return graphFetchJson(() => fetch(`${GRAPH_BASE}/${path}`, { method: "POST", body: params }), `POST ${path}`);
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
  /** Video ad: the uploaded video id (+ optional thumbnail hash). */
  videoId?: string | null;
  thumbnailHash?: string | null;
  /** Image ad (static): the uploaded image hash. When set, builds image_data
   *  instead of video_data (the image itself is the creative — no thumbnail). */
  imageHash?: string | null;
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
 * headline + primary-text options ("Add text option / Add headline option",
 * with text optimization disabled), publishable into a **regular**
 * (non-Dynamic-Creative) ad set that holds many ads.
 *
 * Shape confirmed by a live test publish into our account (the shopgrowth shape —
 * a `videos[]` asset feed with no `ad_formats` — works on accounts that auto-infer
 * the format, but ours rejects it: "an asset feed can have exactly one ad format",
 * and pinning `ad_formats:[SINGLE_VIDEO]` then makes the AD dynamic-rejected). The
 * shape that publishes cleanly here:
 *   - **Video + link + CTA live in `object_story_spec.video_data`** — the video,
 *     its `image_hash` thumbnail, and `call_to_action.value.link`. The link here
 *     satisfies Meta's "link field is required" (subcode 2061015); do NOT use a
 *     top-level `link` or `asset_feed_spec.link_urls`.
 *   - **The text variations live in `asset_feed_spec`** as `titles[]`/`bodies[]`
 *     with **`optimization_type: "DEGREES_OF_FREEDOM"`** — Meta's "multiple text
 *     options" mode. NO `videos[]`, NO `ad_formats`, NO `link_urls`,
 *     NO `asset_customization_rules` in the feed (any of those flips it to Dynamic
 *     Creative → "can only be created under Dynamic Creative Ad Sets").
 *   - `object_story_spec.instagram_user_id` for the IG placement.
 *   - `degrees_of_freedom_spec.text_optimizations = OPT_OUT` ("Optimize text per
 *     person: Disabled") — don't let Meta personalize/rewrite the copy.
 *   - UTM tracking stays in the top-level `url_tags` (the asset feed can't carry it).
 */
export async function createAdCreative(token: string, a: CreativeArgs): Promise<string> {
  // Static (image) ads carry the creative in image_data; video ads in video_data.
  // Everything else (text variations, CTA link, IG placement, UTM) is identical.
  const storyMedia = a.imageHash
    ? {
        image_data: {
          image_hash: a.imageHash,
          // image_data REQUIRES a top-level link (subcode "link field is required");
          // video_data does not. The CTA link alone is not enough for image creatives.
          link: a.destinationUrl,
          ...(a.description ? { link_description: a.description } : {}),
          call_to_action: { type: a.ctaType, value: { link: a.destinationUrl } },
        },
      }
    : {
        video_data: {
          video_id: a.videoId,
          ...(a.thumbnailHash ? { image_hash: a.thumbnailHash } : {}),
          ...(a.description ? { link_description: a.description } : {}),
          call_to_action: { type: a.ctaType, value: { link: a.destinationUrl } },
        },
      };
  const body: Record<string, unknown> = {
    name: a.name,
    object_story_spec: {
      page_id: a.pageId,
      ...(a.instagramUserId ? { instagram_user_id: a.instagramUserId } : {}),
      ...storyMedia,
    },
    asset_feed_spec: {
      titles: a.headlines.filter(Boolean).map((text) => ({ text })),
      bodies: a.primaryTexts.filter(Boolean).map((text) => ({ text })),
      optimization_type: "DEGREES_OF_FREEDOM",
    },
    degrees_of_freedom_spec: { creative_features_spec: { text_optimizations: { enroll_status: "OPT_OUT" } } },
    ...(a.urlTags ? { url_tags: a.urlTags } : {}),
  };
  const j = await metaPost(`${actId(a.accountId)}/adcreatives`, body, token);
  if (!j.id) throw new Error("meta_creative_no_id");
  return j.id;
}

export interface DualAssetCreativeArgs {
  accountId: string;
  name: string;
  pageId: string;
  instagramUserId?: string | null;
  headlines: string[];
  primaryTexts: string[];
  description?: string | null;
  ctaType: string;
  destinationUrl: string;
  urlTags?: string | null;
  // feed placement = the 4:5 asset; stories/reels = the 9:16 asset.
  feedVideoId?: string; storyVideoId?: string;
  feedImageHash?: string; storyImageHash?: string;
}

/**
 * Placement Asset Customization (PAC) creative — ONE ad that serves the **4:5**
 * asset in feed and the **9:16** asset in stories/reels. Mirrors the proven
 * shopgrowth dual-asset shape: `object_story_spec` carries only page identity;
 * the `asset_feed_spec` uses `ad_formats:["AUTOMATIC_FORMAT"]` +
 * `optimization_type:"PLACEMENT"` + placement-labeled assets + customization rules
 * (feed→4:5, stories→9:16, default→9:16). This is NOT Dynamic Creative — it
 * publishes into a regular ad set. (Pinning `ad_formats:["SINGLE_VIDEO"]` is what
 * triggers the "Dynamic Creative Ad Sets" rejection; AUTOMATIC_FORMAT does not.)
 */
export async function createDualAssetCreative(token: string, a: DualAssetCreativeArgs): Promise<string> {
  const isVideo = !!(a.feedVideoId && a.storyVideoId);
  const prefix = `cx_${Date.now()}`;
  const lbl = (kind: string, p: string) => ({ name: `${prefix}_${kind}_${p}` });
  const allBody = [lbl("body", "stories"), lbl("body", "feed"), lbl("body", "default")];
  const allTitle = [lbl("title", "stories"), lbl("title", "feed"), lbl("title", "default")];
  const allUrl = [lbl("url", "stories"), lbl("url", "feed"), lbl("url", "default")];

  const labeledBodies = a.primaryTexts.filter(Boolean).map((text) => ({ text, adlabels: allBody }));
  const labeledTitles = a.headlines.filter(Boolean).map((text) => ({ text, adlabels: allTitle }));
  const labeledLinkUrls = [{ website_url: a.destinationUrl, adlabels: allUrl }];

  // 9:16 → stories + default; 4:5 → feed. video_label / image_label by media kind.
  const assetKey = isVideo ? "videos" : "images";
  const assets = isVideo
    ? [
        { video_id: a.storyVideoId, adlabels: [lbl("vid", "stories"), lbl("vid", "default")] },
        { video_id: a.feedVideoId, adlabels: [lbl("vid", "feed")] },
      ]
    : [
        { hash: a.storyImageHash, adlabels: [lbl("img", "stories"), lbl("img", "default")] },
        { hash: a.feedImageHash, adlabels: [lbl("img", "feed")] },
      ];
  const assetLabel = (p: string) => (isVideo ? { video_label: lbl("vid", p) } : { image_label: lbl("img", p) });

  const rule = (p: string, priority: number, spec: Record<string, unknown>) => ({
    customization_spec: { age_min: 13, age_max: 65, ...spec },
    ...assetLabel(p),
    body_label: lbl("body", p),
    title_label: lbl("title", p),
    link_url_label: lbl("url", p),
    priority,
  });

  const body: Record<string, unknown> = {
    name: a.name,
    object_story_spec: {
      page_id: a.pageId,
      ...(a.instagramUserId ? { instagram_user_id: a.instagramUserId } : {}),
    },
    asset_feed_spec: {
      ad_formats: ["AUTOMATIC_FORMAT"],
      optimization_type: "PLACEMENT",
      [assetKey]: assets,
      bodies: labeledBodies,
      titles: labeledTitles,
      descriptions: [{ text: (a.description || "").trim() }],
      call_to_action_types: [a.ctaType],
      link_urls: labeledLinkUrls,
      asset_customization_rules: [
        rule("feed", 1, {
          publisher_platforms: ["facebook", "instagram"],
          facebook_positions: ["feed", "profile_feed", "marketplace", "search"],
          instagram_positions: ["stream", "explore_home", "profile_feed"],
        }),
        rule("stories", 2, {
          publisher_platforms: ["facebook", "instagram"],
          facebook_positions: ["story", "facebook_reels", "video_feeds"],
          instagram_positions: ["story", "reels"],
        }),
        rule("default", 3, {}),
      ],
    },
    degrees_of_freedom_spec: { creative_features_spec: { text_optimizations: { enroll_status: "OPT_OUT" } } },
    ...(a.urlTags ? { url_tags: a.urlTags } : {}),
  };
  const j = await metaPost(`${actId(a.accountId)}/adcreatives`, body, token);
  if (!j.id) throw new Error("meta_creative_no_id");
  return j.id;
}

// ── Live-object management (Storefront Iteration Engine Phase 6a) ─────────────
// The autonomous engine manages EXISTING live objects only — flip status (pause /
// unpause) and adjust budget (scale up ≤ step cap / scale down) on an adset or
// campaign. All gated upstream by the active policy + ledger (iteration_actions);
// these are the raw Graph writes. It never sets ACTIVE on a draft/new object and
// never creates a new live spend line (those are draft-only — Phase 6b).

/**
 * Flip a Meta object's status. Works for ads, adsets, and campaigns (same
 * `POST /{object_id}` `status=` shape). Returns Graph's `{ success: true }` body.
 */
export async function updateObjectStatus(
  token: string,
  objectId: string,
  status: "ACTIVE" | "PAUSED",
): Promise<Record<string, unknown>> {
  return metaPost(`${objectId}`, { status }, token);
}

/**
 * Adjust an adset's or campaign's budget. Pass exactly one of daily/lifetime in
 * cents (minor units of the account currency) — Meta's `daily_budget` /
 * `lifetime_budget` fields are integer minor units. Same `POST /{object_id}` shape
 * for both levels (ABO adset budget or CBO campaign budget).
 */
export async function updateObjectBudget(
  token: string,
  objectId: string,
  budget: { dailyBudgetCents?: number | null; lifetimeBudgetCents?: number | null },
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (budget.dailyBudgetCents != null) body.daily_budget = Math.round(budget.dailyBudgetCents);
  if (budget.lifetimeBudgetCents != null) body.lifetime_budget = Math.round(budget.lifetimeBudgetCents);
  if (Object.keys(body).length === 0) throw new Error("updateObjectBudget: no budget provided");
  return metaPost(`${objectId}`, body, token);
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

// ── Campaign + ad-set creation (media-buyer loop — hands-off scaling) ─────────
// The autonomous media-buyer needs to STAND UP a new test ad set per creative
// concept without a human hand-building it. These are the raw Graph writes;
// they always create objects PAUSED so nothing goes live behind the human's
// back (going-live is a separate governed step in recommendation-execute).

/** Stable name for the shared ABO testing campaign the media-buyer loop reuses. */
export const MB_TESTING_CAMPAIGN_NAME = "MB — Testing (ABO)";

export interface CreateCampaignArgs {
  name: string;
  /** Meta objective. Default `OUTCOME_SALES` (the sales-optimized funnel). */
  objective?: string;
  /**
   * ABO vs CBO: when true, campaign budget is NOT set here (each ad set carries its
   * own daily_budget). Meta REQUIRES `is_adset_budget_sharing_enabled=false` on a
   * campaign that has no campaign-level budget (proven 2026-07-07). Default true.
   */
  abo?: boolean;
  /** Special ad category (e.g. HOUSING/EMPLOYMENT/CREDIT). Default `[]` (none). */
  specialAdCategories?: string[];
  /** Buying type. Default `AUCTION`. */
  buyingType?: string;
  /** Status. Default `PAUSED` — never create a campaign ACTIVE. */
  status?: "PAUSED" | "ACTIVE";
  /** CBO only — campaign-level daily budget in minor units (cents). Ignored when `abo=true`. */
  dailyBudgetCents?: number | null;
  /** CBO only — campaign-level lifetime budget in minor units. Ignored when `abo=true`. */
  lifetimeBudgetCents?: number | null;
}

/**
 * Create a Meta campaign under the ad account. Defaults to a PAUSED ABO
 * `OUTCOME_SALES` campaign (per the media-buyer scaling methodology): no
 * campaign-level budget + `is_adset_budget_sharing_enabled=false`. Returns the
 * new campaign id.
 */
export async function createCampaign(
  token: string,
  accountId: string,
  args: CreateCampaignArgs,
): Promise<string> {
  const abo = args.abo !== false; // default ABO
  const body: Record<string, unknown> = {
    name: args.name,
    objective: args.objective || "OUTCOME_SALES",
    special_ad_categories: args.specialAdCategories ?? [],
    buying_type: args.buyingType || "AUCTION",
    status: args.status || "PAUSED",
  };
  if (abo) {
    // ABO: ad-set-level budgets. Meta requires this flag when no campaign budget is set.
    body.is_adset_budget_sharing_enabled = false;
  } else {
    if (args.dailyBudgetCents != null) body.daily_budget = Math.round(args.dailyBudgetCents);
    if (args.lifetimeBudgetCents != null) body.lifetime_budget = Math.round(args.lifetimeBudgetCents);
  }
  const j = await metaPost(`${actId(accountId)}/campaigns`, body, token);
  if (!j.id) throw new Error("meta_campaign_no_id");
  return j.id as string;
}

/**
 * Find-or-create the shared MB testing (ABO) campaign for an ad account. The
 * media-buyer loop reuses one testing campaign per account so each concept
 * gets its own ad set under a stable parent. Idempotent by exact name match.
 */
export async function getOrCreateTestingCampaign(token: string, accountId: string): Promise<string> {
  const existing = await listCampaigns(token, accountId);
  const hit = existing.find((c) => c.name === MB_TESTING_CAMPAIGN_NAME);
  if (hit) return hit.id;
  return createCampaign(token, accountId, { name: MB_TESTING_CAMPAIGN_NAME, abo: true, status: "PAUSED" });
}

export interface CreateAdSetArgs {
  name: string;
  campaignId: string;
  /** Ad-set daily budget in minor units (cents). Required for an ABO ad set. */
  dailyBudgetCents?: number | null;
  /** Ad-set lifetime budget in minor units. Use instead of daily_budget when scheduling. */
  lifetimeBudgetCents?: number | null;
  /** Pixel to attribute the purchase optimization against. */
  pixelId: string;
  /** Optimization event on the pixel. Default `PURCHASE`. */
  customEventType?: string;
  /**
   * Targeting spec (`geo_locations`, `age_min`/`age_max`, `custom_audiences`, …).
   * Placements are omitted intentionally so Meta runs Advantage+ (automatic)
   * placements — the researched default for testing. To force manual placements
   * pass `targeting.publisher_platforms`/`facebook_positions`/`instagram_positions`.
   */
  targeting: Record<string, unknown>;
  /** Optimization goal. Default `OFFSITE_CONVERSIONS`. */
  optimizationGoal?: string;
  /** Billing event. Default `IMPRESSIONS`. */
  billingEvent?: string;
  /** Bid strategy. Default `LOWEST_COST_WITHOUT_CAP` (Advantage+ auto-bid). */
  bidStrategy?: string;
  /** Bid amount in minor units — required when bid_strategy is a *_WITH_BID_CAP variant. */
  bidAmountCents?: number | null;
  /** ISO start time. Defaults to Meta's server default (now) when omitted. */
  startTime?: string;
  /** ISO end time. Optional. */
  endTime?: string;
  /** Status. Default `PAUSED`. */
  status?: "PAUSED" | "ACTIVE";
}

/**
 * Create a purchase-optimized ad set under a campaign. Defaults mirror the
 * media-buyer scaling methodology (docs/brain/reference/meta-scaling-methodology.md):
 * `billing_event=IMPRESSIONS`, `optimization_goal=OFFSITE_CONVERSIONS`,
 * `bid_strategy=LOWEST_COST_WITHOUT_CAP`, Advantage+ placements (no
 * publisher_platforms/positions unless the caller opts out), status PAUSED.
 * Returns the new ad-set id.
 */
export async function createAdSet(
  token: string,
  accountId: string,
  args: CreateAdSetArgs,
): Promise<string> {
  const body: Record<string, unknown> = {
    name: args.name,
    campaign_id: args.campaignId,
    optimization_goal: args.optimizationGoal || "OFFSITE_CONVERSIONS",
    billing_event: args.billingEvent || "IMPRESSIONS",
    bid_strategy: args.bidStrategy || "LOWEST_COST_WITHOUT_CAP",
    promoted_object: { pixel_id: args.pixelId, custom_event_type: args.customEventType || "PURCHASE" },
    targeting: args.targeting,
    status: args.status || "PAUSED",
  };
  if (args.dailyBudgetCents != null) body.daily_budget = Math.round(args.dailyBudgetCents);
  if (args.lifetimeBudgetCents != null) body.lifetime_budget = Math.round(args.lifetimeBudgetCents);
  if (args.bidAmountCents != null) body.bid_amount = Math.round(args.bidAmountCents);
  if (args.startTime) body.start_time = args.startTime;
  if (args.endTime) body.end_time = args.endTime;
  const j = await metaPost(`${actId(accountId)}/adsets`, body, token);
  if (!j.id) throw new Error("meta_adset_no_id");
  return j.id as string;
}
