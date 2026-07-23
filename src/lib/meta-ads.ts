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

/**
 * List ads under a campaign with each ad's linked creative id — the idempotency
 * source behind [[../media-buyer/graduate-scaler]] `graduateCrownedWinnerToScaler`.
 * Returns `{ adId, creativeId }` pairs (any ad whose `creative.id` is missing is
 * dropped). Includes ACTIVE + PAUSED + DELETED + ARCHIVED so a previously-
 * graduated ad that was later archived still counts as "this creative already
 * published under the scaler" — the graduate flow must not silently double-
 * mint against the same creative after a manual archive. Introduced by
 * [[../../docs/brain/specs/graduate-crowned-winners-into-the-cold-scaler-mint-campaign-and-duplicate]]
 * Phase 2.
 */
export async function listAdsForCampaignWithCreative(
  token: string,
  campaignId: string,
): Promise<Array<{ adId: string; creativeId: string }>> {
  const j = await metaGet(
    `${campaignId}/ads?fields=id,creative{id}&limit=300&effective_status=["ACTIVE","PAUSED","DELETED","ARCHIVED"]`,
    token,
  );
  const rows = (j.data || []) as Array<{ id?: string; creative?: { id?: string } }>;
  return rows
    .map((r) => ({ adId: (r.id ?? "") as string, creativeId: (r.creative?.id ?? "") as string }))
    .filter((r) => r.adId.length > 0 && r.creativeId.length > 0);
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

/** Upload an image (e.g. a thumbnail) → returns its hash for use as image_hash.
 *  Routed through graphFetchJson so a transient Meta error (code 1/2, is_transient,
 *  429, 5xx) retries with bounded backoff instead of failing the whole publish job.
 *  The multipart body is rebuilt inside the thunk because a FormData wrapping a
 *  Blob can't be re-sent across attempts — each attempt gets a fresh copy. */
export async function uploadAdImage(token: string, accountId: string, bytes: Buffer, filename = "thumb.jpg"): Promise<string> {
  const path = `${actId(accountId)}/adimages`;
  const j = await graphFetchJson(() => {
    const fd = new FormData();
    fd.append("filename", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), filename);
    fd.append("access_token", token);
    return fetch(`${GRAPH_BASE}/${path}`, { method: "POST", body: fd });
  }, `POST ${path}`);
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
  /** Single link description — used by link_data image ads (Meta's link_data.description
   *  is 1:1, not an array). Also the single-element fallback for asset_feed_spec.descriptions[]
   *  when `descriptions` is unset. */
  description?: string | null;
  /** dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection Phase 1 — multi-variant
   *  link descriptions. When non-empty, video-ad asset_feed_spec.descriptions[] is built 1:1
   *  from this array (N entries → N descriptions Meta rotates like titles/bodies); when unset
   *  or empty, the single-string `description` fallback fires so byte-identical to today. */
  descriptions?: string[] | null;
  ctaType: string;
  destinationUrl: string;
  urlTags?: string | null; // UTM query string
}

/** Shared helper — build the `asset_feed_spec.descriptions[]` payload from the N-entry variant array
 *  (when present) or the legacy single `description` (when the caller only supplies one). Returns an
 *  empty array when neither source has content, so the caller can decide to omit the key entirely. */
function buildAssetFeedDescriptions(a: {
  descriptions?: string[] | null;
  description?: string | null;
}): Array<{ text: string }> {
  const source = a.descriptions && a.descriptions.length
    ? a.descriptions
    : (a.description ? [a.description] : []);
  return source
    .map((text) => (text ?? "").trim())
    .filter((t) => t.length > 0)
    .map((text) => ({ text }));
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
  const igPart = a.instagramUserId ? { instagram_user_id: a.instagramUserId } : {};

  // ── Static (image) ads are LINK ADS → object_story_spec.link_data. ──────────
  // `image_data` REJECTS the destination link with "link field is required" (subcode 2061015) even
  // when `link` IS set — on every account (verified against Graph v21.0, 2026-07-12: image_data fails,
  // link_data with the same image_hash + link succeeds). This silently broke EVERY static media-buyer
  // ad. `link_data` carries ONE headline (`name`) + ONE body (`message`) — exactly the per-test model
  // (one copy set per creative). `asset_feed_spec` copy-variation is not used for link ads (it also
  // fails the link check); a static test creative pins its single hook.
  if (a.imageHash) {
    const body: Record<string, unknown> = {
      name: a.name,
      object_story_spec: {
        page_id: a.pageId,
        ...igPart,
        link_data: {
          image_hash: a.imageHash,
          link: a.destinationUrl,
          message: a.primaryTexts.filter(Boolean)[0] ?? "",
          name: a.headlines.filter(Boolean)[0] ?? "",
          ...(a.description ? { description: a.description } : {}),
          call_to_action: { type: a.ctaType },
        },
      },
      ...(a.urlTags ? { url_tags: a.urlTags } : {}),
    };
    const j = await metaPost(`${actId(a.accountId)}/adcreatives`, body, token);
    if (!j.id) throw new Error("meta_creative_no_id");
    return j.id;
  }

  // ── Video ads: video_data + asset_feed_spec (link not required for video_data). ──
  const body: Record<string, unknown> = {
    name: a.name,
    object_story_spec: {
      page_id: a.pageId,
      ...igPart,
      video_data: {
        video_id: a.videoId,
        ...(a.thumbnailHash ? { image_hash: a.thumbnailHash } : {}),
        ...(a.description ? { link_description: a.description } : {}),
        call_to_action: { type: a.ctaType, value: { link: a.destinationUrl } },
      },
    },
    asset_feed_spec: (() => {
      const descs = buildAssetFeedDescriptions(a);
      return {
        titles: a.headlines.filter(Boolean).map((text) => ({ text })),
        bodies: a.primaryTexts.filter(Boolean).map((text) => ({ text })),
        ...(descs.length ? { descriptions: descs } : {}),
        optimization_type: "DEGREES_OF_FREEDOM",
      };
    })(),
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
  /** dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection Phase 1 — see CreativeArgs. */
  descriptions?: string[] | null;
  ctaType: string;
  destinationUrl: string;
  urlTags?: string | null;
  // feed placement = the 4:5 asset; stories/reels = the 9:16 asset.
  feedVideoId?: string; storyVideoId?: string;
  feedImageHash?: string; storyImageHash?: string;
  /** bianca-static-publish-uses-all-5-copy-variations-and-correct-right-column-placement
   *  Phase 2 — the right-column 1:1 static. When present, `createDualAssetCreative` adds the
   *  asset to the images list + an `asset_customization_rule` tagging it to Facebook's
   *  `right_hand_column` (+ `search`) placement so that placement renders its correct-aspect
   *  asset instead of falling through to the 9:16 story image via the default rule. Feed 4:5
   *  becomes the safe default fallback (the priority-4 rule) in this branch — every placement
   *  Meta may serve resolves to its correct-aspect asset with feed 4:5 as the failsafe. Absent
   *  (a caller that never opted in) preserves the pre-Phase-2 2-bucket shape byte-identically. */
  rightColumnImageHash?: string;
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
export interface PlacementCreativeArgs {
  accountId: string;
  name: string;
  pageId: string;
  instagramUserId?: string | null;
  /** 4 headlines — each is adlabel'd to every placement so Meta rotates all four per placement. */
  headlines: string[];
  /** 4 primary texts — each is adlabel'd to every placement so Meta rotates all four per placement. */
  primaryTexts: string[];
  description?: string | null;
  /** dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection Phase 1 — see CreativeArgs. */
  descriptions?: string[] | null;
  ctaType: string;
  destinationUrl: string;
  displayUrl?: string | null;
  urlTags?: string | null;
  /** Feed 4:5 static (also serves as the `default` placement asset via a shared adlabel). */
  feedImageHash: string;
  /** Stories/reels 9:16 static. */
  storyImageHash: string;
  /** Right-column 1:1 static (also targets FB search). */
  rightColumnImageHash: string;
}

/**
 * 3-bucket PLACEMENT-customized static creative — ONE **portable** (NOT Dynamic
 * Creative) ad that serves a 4:5 in feed, 9:16 in stories/reels, and 1:1 in
 * right-column/search, carrying N headlines + N primary texts each rotated across
 * every placement. Battle-tested 2026-07-16 by creative `780957111743379` / ad
 * `120252471398980184` (PAUSED in the Amazing Coffee advertorial adset), which
 * proved Meta accepts this exact shape and renders it across feed / IG story /
 * FB story / IG standard / right column. Because it stays portable (no
 * `is_dynamic_creative`, no pinned SINGLE_* format), a winner can be duplicated
 * into scaling campaigns.
 *
 * Shape (each field carries a load-bearing invariant):
 * - `object_story_spec: { page_id, instagram_user_id }` — page identity only,
 *   never a `link_data` / `image_data` here (any placement-bearing content on
 *   the story spec fights `asset_customization_rules`).
 * - `asset_feed_spec.ad_formats: ['AUTOMATIC_FORMAT']` — a pinned `SINGLE_IMAGE`
 *   is what flips the creative to Dynamic Creative and gets it rejected outside
 *   a DCO adset. `AUTOMATIC_FORMAT` keeps the ad portable into scaling.
 * - `asset_feed_spec.optimization_type: 'PLACEMENT'` — the customization rules
 *   only apply under `PLACEMENT`; `DEGREES_OF_FREEDOM` ignores them.
 * - `images` — 3 hashes each `adlabels`-tagged. The feed image carries BOTH the
 *   `feed` and `default` adlabels so the `default` customization rule (priority 4)
 *   has an asset to render if a placement isn't covered by rules 1-3. Stories
 *   image carries only the `stories` label; right-column image only `rightcol`.
 * - `titles` / `bodies` — each entry is `adlabels`-tagged to ALL FOUR placement
 *   labels (feed, stories, rightcol, default), so Meta rotates every headline
 *   and every primary text across every placement.
 * - `link_urls: [{ website_url, [display_url], adlabels: <all> }]` — one link,
 *   tagged to every placement.
 * - `call_to_action_types: [ctaType]` — a single CTA rotated across placements.
 * - `asset_customization_rules` — one rule per bucket, each pointing at its
 *   image/title/body/link adlabel plus a `customization_spec` narrowing the
 *   platform + positions: feed rule (priority 1) → FB feed/profile_feed/marketplace
 *   + IG stream/explore_home/profile_feed; stories rule (priority 2) → FB
 *   story/facebook_reels/video_feeds + IG story/reels; rightcol rule (priority 3)
 *   → FB right_hand_column + search; default rule (priority 4) → empty spec,
 *   catches everything not matched above.
 * - `degrees_of_freedom_spec.creative_features_spec.text_optimizations.enroll_status:
 *   'OPT_OUT'` — Meta must NOT rewrite our copy.
 */
export async function createPlacementCreative(token: string, a: PlacementCreativeArgs): Promise<string> {
  const prefix = `cx_${Date.now()}`;
  const lbl = (kind: string, p: string) => ({ name: `${prefix}_${kind}_${p}` });

  const PLACEMENTS = ["feed", "stories", "rightcol", "default"] as const;
  const allBody = PLACEMENTS.map((p) => lbl("body", p));
  const allTitle = PLACEMENTS.map((p) => lbl("title", p));
  const allUrl = PLACEMENTS.map((p) => lbl("url", p));

  const labeledBodies = a.primaryTexts.filter(Boolean).map((text) => ({ text, adlabels: allBody }));
  const labeledTitles = a.headlines.filter(Boolean).map((text) => ({ text, adlabels: allTitle }));
  const labeledLinkUrls = [{
    website_url: a.destinationUrl,
    ...(a.displayUrl ? { display_url: a.displayUrl } : {}),
    adlabels: allUrl,
  }];

  // 3 images. Feed image also carries the `default` adlabel — the priority-4 rule
  // renders it for any placement not matched by rules 1-3.
  const images = [
    { hash: a.feedImageHash, adlabels: [lbl("img", "feed"), lbl("img", "default")] },
    { hash: a.storyImageHash, adlabels: [lbl("img", "stories")] },
    { hash: a.rightColumnImageHash, adlabels: [lbl("img", "rightcol")] },
  ];

  const rule = (p: string, priority: number, spec: Record<string, unknown>) => ({
    customization_spec: { age_min: 13, age_max: 65, ...spec },
    image_label: lbl("img", p),
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
      images,
      bodies: labeledBodies,
      titles: labeledTitles,
      // Phase 1 — multi-variant descriptions[] from the temperature-banded pack. Empty string
      // pack (legacy single-description caller with a blank string) preserved as [{text:""}]
      // for byte-identical Meta submit, so existing test assertions don't drift.
      descriptions: (() => {
        const built = buildAssetFeedDescriptions(a);
        return built.length ? built : [{ text: "" }];
      })(),
      call_to_action_types: [a.ctaType],
      link_urls: labeledLinkUrls,
      asset_customization_rules: [
        rule("feed", 1, {
          publisher_platforms: ["facebook", "instagram"],
          facebook_positions: ["feed", "profile_feed", "marketplace"],
          instagram_positions: ["stream", "explore_home", "profile_feed"],
        }),
        rule("stories", 2, {
          publisher_platforms: ["facebook", "instagram"],
          facebook_positions: ["story", "facebook_reels", "video_feeds"],
          instagram_positions: ["story", "reels"],
        }),
        rule("rightcol", 3, {
          publisher_platforms: ["facebook"],
          facebook_positions: ["right_hand_column", "search"],
        }),
        rule("default", 4, {}),
      ],
    },
    degrees_of_freedom_spec: { creative_features_spec: { text_optimizations: { enroll_status: "OPT_OUT" } } },
    ...(a.urlTags ? { url_tags: a.urlTags } : {}),
  };
  const j = await metaPost(`${actId(a.accountId)}/adcreatives`, body, token);
  if (!j.id) throw new Error("meta_creative_no_id");
  return j.id;
}

export async function createDualAssetCreative(token: string, a: DualAssetCreativeArgs): Promise<string> {
  const isVideo = !!(a.feedVideoId && a.storyVideoId);
  const prefix = `cx_${Date.now()}`;
  const lbl = (kind: string, p: string) => ({ name: `${prefix}_${kind}_${p}` });
  // bianca-static-publish-uses-all-5-copy-variations-and-correct-right-column-placement Phase 2 —
  // when the caller supplies the right-column 1:1 static hash, the creative carries a 3-bucket
  // customization set (feed 4:5 + stories/reels 9:16 + right_column 1:1 + a default fallback to
  // feed 4:5). Videos never carry a 1:1 asset — the right-column placement is image-only for
  // this shape — so the video branch keeps the pre-Phase-2 2-bucket adlabel set unchanged.
  const hasRightCol = !isVideo && !!a.rightColumnImageHash;
  const placements: string[] = hasRightCol
    ? ["stories", "feed", "rightcol", "default"]
    : ["stories", "feed", "default"];
  const allBody = placements.map((p) => lbl("body", p));
  const allTitle = placements.map((p) => lbl("title", p));
  const allUrl = placements.map((p) => lbl("url", p));

  const labeledBodies = a.primaryTexts.filter(Boolean).map((text) => ({ text, adlabels: allBody }));
  const labeledTitles = a.headlines.filter(Boolean).map((text) => ({ text, adlabels: allTitle }));
  const labeledLinkUrls = [{ website_url: a.destinationUrl, adlabels: allUrl }];

  // Video branch — pre-Phase-2 2-bucket adlabel set: 9:16 story video carries stories + default,
  // 4:5 feed video carries feed. Right-column placement is image-only for this creative shape;
  // a right-column hash is never passed alongside videos.
  //
  // Image branch — Phase 2 promotes feed 4:5 to `default` (the safer failsafe per spec Phase 2:
  // "with the feed 4:5 as the safe default fallback") when the caller opts into the right-column
  // shape. When the hash is absent the pre-Phase-2 shape stays byte-identical (story 9:16 keeps
  // the `default` adlabel) so every existing caller and test path is preserved.
  const assetKey = isVideo ? "videos" : "images";
  const assets = isVideo
    ? [
        { video_id: a.storyVideoId, adlabels: [lbl("vid", "stories"), lbl("vid", "default")] },
        { video_id: a.feedVideoId, adlabels: [lbl("vid", "feed")] },
      ]
    : hasRightCol
      ? [
          { hash: a.feedImageHash, adlabels: [lbl("img", "feed"), lbl("img", "default")] },
          { hash: a.storyImageHash, adlabels: [lbl("img", "stories")] },
          { hash: a.rightColumnImageHash, adlabels: [lbl("img", "rightcol")] },
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

  // Phase 2 — when the right-column 1:1 hash is present, the customization set mirrors
  // `createPlacementCreative` for the right-column placement (facebook right_hand_column +
  // search) so Meta serves the 1:1 asset there instead of the 9:16 story via the default rule.
  // Feed's asset_customization_rule loses `search` from its facebook_positions in that branch
  // because the rightcol rule now covers it. When no right-column hash is passed, the shape
  // stays pre-Phase-2 (feed rule includes search, no rightcol rule) so the legacy caller /
  // video branch is byte-identical.
  const assetCustomizationRules = hasRightCol
    ? [
        rule("feed", 1, {
          publisher_platforms: ["facebook", "instagram"],
          facebook_positions: ["feed", "profile_feed", "marketplace"],
          instagram_positions: ["stream", "explore_home", "profile_feed"],
        }),
        rule("stories", 2, {
          publisher_platforms: ["facebook", "instagram"],
          facebook_positions: ["story", "facebook_reels", "video_feeds"],
          instagram_positions: ["story", "reels"],
        }),
        rule("rightcol", 3, {
          publisher_platforms: ["facebook"],
          facebook_positions: ["right_hand_column", "search"],
        }),
        rule("default", 4, {}),
      ]
    : [
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
      ];

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
      // Phase 1 — multi-variant descriptions[] from the temperature-banded pack; falls back to
      // the single-string `description` (or an empty [{text:""}] placeholder) so byte-identical
      // to today for callers that never opted in to a variant pack.
      descriptions: (() => {
        const built = buildAssetFeedDescriptions(a);
        return built.length ? built : [{ text: "" }];
      })(),
      call_to_action_types: [a.ctaType],
      link_urls: labeledLinkUrls,
      asset_customization_rules: assetCustomizationRules,
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
  /**
   * Advantage+ Sales — percentage of campaign spend allocated to EXISTING customers.
   * `0` = new-customer-only (the Bianca cold-scaler shape); `null` = leave the knob
   * off the POST body entirely (existing test-campaign creation stays unchanged).
   * Forwards to Meta's `existing_customer_budget_percentage` field on
   * `/act_{id}/campaigns` (documented in [[integrations/meta-marketing]] §
   * Campaign + ad-set creation).
   */
  newCustomerBudgetPercentage?: number | null;
  /**
   * Advantage+ Sales campaign type — maps to Meta's `smart_promotion_type` field.
   * `"AUTOMATED_SHOPPING_ADS"` mints an Advantage+ Sales campaign; `null` = leave
   * the knob off entirely so the existing ABO test-campaign flow is untouched.
   */
  smartPromotionType?: string | null;
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
  if (args.newCustomerBudgetPercentage != null) {
    body.existing_customer_budget_percentage = args.newCustomerBudgetPercentage;
  }
  if (args.smartPromotionType != null) {
    body.smart_promotion_type = args.smartPromotionType;
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

/**
 * Build the stable name for a cohort's cold-scaler campaign. Uses the first 8
 * chars of the cohort UUID so the name is human-legible + short enough to fit
 * Meta's 400-char campaign name limit even alongside future suffixes.
 */
export function coldScalerCampaignName(cohortId: string): string {
  return `MB — Cold Scaler (${cohortId.slice(0, 8)})`;
}

/**
 * Find-or-create the ONE consolidated cold-scaler campaign for a
 * `media_buyer_cold_scaler_cohorts` row — Bianca M4 payoff spec
 * ([[../specs/bianca-cold-scaler-graduate-crowned-winners-to-advantage-plus-new-customers]] Phase 1).
 *
 * Shape (per docs/brain/reference/meta-scaling-methodology.md § Account structure
 * "SCALING campaign (CBO / Advantage+ Sales) ~85% of budget"):
 *  - `OUTCOME_SALES` objective
 *  - CBO (`abo=false`) — campaign-level `daily_budget` is the cohort's ceiling
 *  - Advantage+ Sales (`smart_promotion_type='AUTOMATED_SHOPPING_ADS'`)
 *  - New-customer-only from the very first mint (`existing_customer_budget_percentage=0`)
 *  - PAUSED at mint — an unmonitored campaign never goes live on its own
 *
 * Idempotent by exact name match on `coldScalerCampaignName(cohortId)` via
 * `listCampaigns`. Returns the bare Meta campaign id; the caller
 * (`executeGraduateActionAgainstMeta` in Phase 3) then compare-and-set-stamps
 * it onto `media_buyer_cold_scaler_cohorts.scaler_meta_campaign_id` via
 * `setColdScalerCampaignId` so a race can't double-mint.
 */
export async function getOrCreateColdScalerCampaign(
  token: string,
  accountId: string,
  opts: { cohortId: string; dailyCeilingCents: number; name?: string },
): Promise<string> {
  const name = opts.name || coldScalerCampaignName(opts.cohortId);
  const existing = await listCampaigns(token, accountId);
  const hit = existing.find((c) => c.name === name);
  if (hit) return hit.id;
  return createCampaign(token, accountId, {
    name,
    objective: "OUTCOME_SALES",
    abo: false,
    dailyBudgetCents: opts.dailyCeilingCents,
    status: "PAUSED",
    newCustomerBudgetPercentage: 0,
    smartPromotionType: "AUTOMATED_SHOPPING_ADS",
  });
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

// ── Custom audiences (bianca cold-test recent-purchaser exclusion) ───────────
// The pixel-side purchaser audience Bianca excludes on every per-test ad set so
// the cold read is against actual cold traffic (docs/brain/specs/
// bianca-cold-test-recent-purchaser-exclusion.md Phase 1). One of TWO exclusion
// audiences composed into targeting.excluded_custom_audiences — the sibling
// customer-list audience ships as bianca-full-order-history-customer-list-exclusion-audience.

export interface MetaCustomAudience {
  id: string;
  name: string;
  subtype?: string;
  retention_days?: number;
}

/**
 * List custom audiences on a Meta ad account. The find-first idempotency
 * source behind {@link getOrCreateRecentPurchaserAudience} — a bare
 * `GET /act_{id}/customaudiences` with the fields the caller needs to match
 * by name.
 */
export async function listCustomAudiences(
  token: string,
  accountId: string,
): Promise<MetaCustomAudience[]> {
  const j = await metaGet(
    `${actId(accountId)}/customaudiences?fields=id,name,subtype,retention_days&limit=200`,
    token,
  );
  return (j.data || []) as MetaCustomAudience[];
}

/**
 * Find-or-create the pixel-side "recent purchasers" website custom audience
 * for a given (ad account, pixel). Idempotent by exact name match — the
 * canonical name is `MB — Purchasers (${retentionDays}d) — pixel ${pixelId}`,
 * so repeat calls (for the same retention window against the same pixel)
 * return the existing audience id rather than creating a duplicate. Returns
 * the BARE Meta customaudience id (not our uuid).
 *
 * The rule matches Meta's `Purchase` pixel event across the retention window
 * (default 180 days — Meta's max, per the founder refinement 2026-07-15). The
 * bianca cold-test spec composes this id into every per-test ad set's
 * `targeting.excluded_custom_audiences` so existing buyers cannot see the cold
 * ad and contaminate the read.
 */
export async function getOrCreateRecentPurchaserAudience(
  token: string,
  accountId: string,
  pixelId: string,
  opts?: { retentionDays?: number; name?: string },
): Promise<string> {
  const retentionDays = opts?.retentionDays ?? 180;
  const name = opts?.name ?? `MB — Purchasers (${retentionDays}d) — pixel ${pixelId}`;
  const existing = await listCustomAudiences(token, accountId);
  const hit = existing.find((a) => a.name === name);
  if (hit) return hit.id;
  const rule = {
    inclusions: {
      operator: "or",
      rules: [
        {
          event_sources: [{ id: pixelId, type: "pixel" }],
          retention_seconds: retentionDays * 86400,
          filter: {
            operator: "and",
            filters: [{ field: "event", operator: "=", value: "Purchase" }],
          },
        },
      ],
    },
  };
  const j = await metaPost(
    `${actId(accountId)}/customaudiences`,
    {
      name,
      // Graph v21: a rule-based WEBSITE audience is created from `rule` ALONE. A top-level
      // `subtype: "WEBSITE"` + `pixel_id` are rejected ("parameter 'subtype' is not supported
      // in the current API version") — the pixel + retention live inside
      // rule.inclusions.rules[].event_sources / retention_seconds. `prefill: 1` backfills the
      // audience from the pixel's existing history. Verified live 2026-07-20.
      rule,
      prefill: 1,
    },
    token,
  );
  if (!j.id) throw new Error("meta_customaudience_no_id");
  return j.id as string;
}

// ── CUSTOMER_LIST audience (bianca full-order-history exclusion) ─────────────
// The upload-based audience Bianca excludes on every per-test ad set alongside
// the pixel WEBSITE audience. Uploads SHA256(email) + SHA256(phone) for every
// customer who has ever ordered (all three sources — Shopify, Internal,
// Amazon), giving complete existing-customer coverage the 180d pixel audience
// misses. See docs/brain/specs/bianca-full-order-history-customer-list-exclusion-audience.md
// Phase 1. Both audience ids compose into targeting.excluded_custom_audiences
// through the sibling spec's provision/replenish/publish-gate plumbing.
//
// Compliance: only SHA256 hex leaves the box; email is lowercase-trimmed and
// phone is normalized to E.164 before hashing. Plaintext PII is never uploaded
// and never logged (the uploader logs counts only). Chunks are ≤10k rows per
// Meta's docs on the customaudience users endpoint.

/**
 * Find-or-create the CUSTOMER_LIST (upload-based) custom audience the cohort
 * uses to exclude our ENTIRE existing-customer base (across all three order
 * sources) from cold-prospecting reach. Idempotent by exact name match — the
 * canonical name is `MB — All customers (all sources) — hashed`, so repeat
 * calls return the existing audience id rather than creating a duplicate.
 * Returns the BARE Meta customaudience id (not our uuid).
 *
 * The audience carries no rule — a CUSTOMER_LIST is populated by uploading
 * hashed users via {@link addUsersToCustomAudience}. `customer_file_source`
 * is `USER_PROVIDED_ONLY` (we own the data; not partner-supplied).
 */
export async function getOrCreateAllCustomersAudience(
  token: string,
  accountId: string,
  opts?: { name?: string; description?: string },
): Promise<string> {
  const name = opts?.name ?? "MB — All customers (all sources) — hashed";
  const description =
    opts?.description ??
    "Full-history existing-customer exclusion for cold-prospecting adsets. Hashed email+phone, all three order sources. Refreshed weekly.";
  const existing = await listCustomAudiences(token, accountId);
  const hit = existing.find((a) => a.name === name);
  if (hit) return hit.id;
  const j = await metaPost(
    `${actId(accountId)}/customaudiences`,
    {
      name,
      // Graph v21: "CUSTOMER_LIST" is no longer an accepted subtype (the valid set is
      // {CUSTOM, WEBSITE, APP, OFFLINE_CONVERSION, ...}). An upload-based (hashed customer list)
      // audience is `subtype: "CUSTOM"` + `customer_file_source`. Verified live 2026-07-20.
      subtype: "CUSTOM",
      customer_file_source: "USER_PROVIDED_ONLY",
      description,
    },
    token,
  );
  if (!j.id) throw new Error("meta_customaudience_no_id");
  return j.id as string;
}

/**
 * Normalize a raw email for hashing per Meta's rules: lowercase + trim. Empty
 * strings and non-strings return null (skip the row's email slot).
 */
export function normalizeEmailForHash(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize a phone number to E.164 (digits only, `+` stripped) for hashing.
 * Meta's docs specify country code + digits, no punctuation. Numbers with 10
 * digits are assumed US (`1` prefixed); numbers already carrying a country
 * code pass through digit-only.
 */
export function normalizePhoneForHash(phone: string | null | undefined): string | null {
  if (typeof phone !== "string") return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export const META_CUSTOMAUDIENCE_USERS_CHUNK = 10_000;

export interface CustomAudienceUserRow {
  email?: string | null;
  phone?: string | null;
}

/**
 * Upload hashed users to a CUSTOMER_LIST custom audience. Chunks at
 * {@link META_CUSTOMAUDIENCE_USERS_CHUNK} rows per POST (Meta's upper bound),
 * emits SHA256 hex per column with normalized inputs, and skips rows whose
 * email AND phone both normalize to null. Returns per-chunk POST responses
 * (the audience_id + num_received) so callers can sum totals for observability.
 *
 * Plaintext PII never leaves the box: emails are lowercase-trimmed and phones
 * digit-normalized in-process before hashing, and only the hex outputs are
 * placed on the Graph body.
 */
export async function addUsersToCustomAudience(
  token: string,
  audienceId: string,
  rows: CustomAudienceUserRow[],
  opts?: { chunkSize?: number },
): Promise<Array<{ audience_id: string; num_received: number }>> {
  const chunkSize = Math.min(
    Math.max(1, opts?.chunkSize ?? META_CUSTOMAUDIENCE_USERS_CHUNK),
    META_CUSTOMAUDIENCE_USERS_CHUNK,
  );
  const results: Array<{ audience_id: string; num_received: number }> = [];
  const hashed: Array<[string, string]> = [];
  for (const row of rows) {
    const email = normalizeEmailForHash(row.email);
    const phone = normalizePhoneForHash(row.phone);
    if (!email && !phone) continue;
    hashed.push([email ? await sha256Hex(email) : "", phone ? await sha256Hex(phone) : ""]);
  }
  for (let i = 0; i < hashed.length; i += chunkSize) {
    const slice = hashed.slice(i, i + chunkSize);
    const payload = {
      schema: ["EMAIL_SHA256", "PHONE_SHA256"],
      data: slice,
    };
    const j = await metaPost(
      `${audienceId}/users`,
      { payload },
      token,
    );
    results.push({
      audience_id: (j.audience_id as string) ?? audienceId,
      num_received: (j.num_received as number) ?? slice.length,
    });
  }
  return results;
}
