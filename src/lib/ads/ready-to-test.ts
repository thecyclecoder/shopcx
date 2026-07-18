/**
 * Ready-to-test reader — surface creatives produced by the ad pipeline that the Growth Director
 * could promote into a PAUSED Meta ad, but that nobody has launched yet.
 *
 * Phase 1 of docs/brain/specs/growth-adopt-creative-makers.md — the supervisable-autonomy proxy for
 * "always have a pipeline of killer ads": find every [[../tables/ad_campaigns]] row that has at least
 * one renderable child in [[../tables/ad_videos]] (a `status='ready'` row OR a `media_kind='static'`
 * row with a final JPG), a `landing_url` set, AND no in-flight [[../tables/ad_publish_jobs]] row
 * pointing at it (`publish_status` in queued|uploading|creating|published). Pure read; no schema
 * change. Phase 2 wires the Director's `promote_ready_to_test_creative` action onto this surface.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** A `publish_status` value that marks an `ad_publish_jobs` row as "already in flight" — its parent
 * campaign is NOT ready-to-test. Mirrors the brain page lifecycle (queued → uploading → creating →
 * published | failed); `failed` is excluded because a failed job means the campaign is still pending
 * a launch. */
const ACTIVE_PUBLISH_STATUSES = ["queued", "uploading", "creating", "published"] as const;

/** Shape returned per ready-to-test campaign. `archetype` is from `ad_videos.meta->>'archetype'` (null
 * for video campaigns); `formats` is the distinct set of `ad_videos.format` values that backed the
 * "has a ready creative" decision. */
export interface ReadyToTestRow {
  ad_campaign_id: string;
  archetype: string | null;
  lander_url: string;
  status: "ready_no_active_ad";
  formats: string[];
  created_at: string;
  /**
   * `dahlia-andromeda-concept-diversity-tags` Phase 1 — the Andromeda concept token stamped on
   * the campaign at author-mode ship (one of the 10 tokens; see [[../ads/creative-agent]]
   * `ANDROMEDA_CONCEPT_TAGS`). NULL for deterministic-mode creatives or pre-Phase-1 rows.
   * Consumed by Phase 2's [[../media-buyer/agent]] `computeMediaBuyerPlan` replenish diversity
   * gate — NULL is its own 'untagged' bucket that never conflicts with an Andromeda token.
   */
  concept_tag: string | null;
  /**
   * `bianca-route-ready-creatives-by-dahlia-temperature-tag` Phase 1 — the temperature band the
   * creative was authored for (per Dahlia's audience_temperature stamp on ad_campaigns; see
   * [[../ads/creative-agent]] `resolveAudienceTemperature`). Values match the DB check constraint:
   * `'cold' | 'warm' | 'hot' | null`. Bianca's replenish path filters this reader to
   * `'cold'` for every cold-test cohort pass so a Warm/Hot creative can never leak into the cold
   * rail; the exposed column also lets the audit trail cite the routed value verbatim.
   */
  audience_temperature: "cold" | "warm" | "hot" | null;
}

export interface ListReadyToTestResult {
  readyToTest: ReadyToTestRow[];
}

interface AdVideoRow {
  campaign_id: string;
  format: string | null;
  media_kind: string | null;
  status: string | null;
  static_jpg_url: string | null;
  meta: { archetype?: string | null } | null;
}

interface AdCampaignRow {
  id: string;
  landing_url: string | null;
  status: string | null;
  created_at: string;
  concept_tag: string | null;
  audience_temperature: "cold" | "warm" | "hot" | null;
  /** max-qc-always-bins-ad-7of10-gates-only-bianca-postability Phase 2 — Max's copy-QC
   *  eligibility. Read at the DB filter (`.not("max_qc_eligible","is",false)`) so only TRUE +
   *  NULL rows land here; a FALSE row is a binned-but-ineligible creative still visible on the
   *  detail page. Present in the row shape as a defensive belt-and-suspenders — a filter miss
   *  would still surface here for a downstream reader to see. */
  max_qc_eligible: boolean | null;
}

interface AdPublishJobRow {
  campaign_id: string;
  publish_status: string | null;
}

/** A child `ad_videos` row "counts" as a ready creative for its parent campaign if it is `status='ready'`
 * OR it is a static row with a final JPG. The OR keeps the reader honest when a static lands its JPG
 * before its status row gets stamped — the spec asks for both signals. */
function isReadyCreative(v: AdVideoRow): boolean {
  if (v.status === "ready") return true;
  if (v.media_kind === "static" && !!v.static_jpg_url) return true;
  return false;
}

/**
 * List the ready-to-test ad campaigns for a workspace.
 *
 * A campaign is ready-to-test when:
 *   - it has a `landing_url` set, AND
 *   - it has at least one `ad_videos` child that is a ready creative (per `isReadyCreative`), AND
 *   - it has NO `ad_publish_jobs` row whose `publish_status` is queued|uploading|creating|published.
 *
 * The reader is pure SELECT — no writes, no side-effects — and small enough to run per Director sweep.
 *
 * [[../../../docs/brain/specs/media-buyer-product-scoped-test-rail]] Phase 2 — an
 * optional `productId` narrows the read to a single product's campaigns
 * (`ad_campaigns.product_id = productId`) so the media-buyer's replenish never
 * feeds product B's ready creative into product A's cohort adset. Omitting the
 * filter (or passing null) preserves the pre-Phase-2 workspace-wide read used
 * by the null-product default cohort.
 *
 * [[../../../docs/brain/specs/bianca-route-ready-creatives-by-dahlia-temperature-tag]] Phase 1 —
 * an optional `temperature` narrows the read to a single `audience_temperature` band
 * (`ad_campaigns.audience_temperature = temperature`). Bianca's replenish path passes
 * `'cold'` for every cold-test cohort so a Warm/Hot creative Dahlia tagged cannot leak
 * into the cold rail's deficit fill. Omitting the filter (or passing null) preserves the
 * pre-Phase-1 workspace/product read verbatim — nothing regresses when the column is missing
 * or the caller doesn't care about the band.
 */
export async function listReadyToTest(
  admin: Admin,
  opts: {
    workspaceId: string;
    productId?: string | null;
    temperature?: "cold" | "warm" | "hot" | null;
  },
): Promise<ListReadyToTestResult> {
  const { workspaceId, productId = null, temperature = null } = opts;

  const { data: videoData } = await admin
    .from("ad_videos")
    .select("campaign_id, format, media_kind, status, static_jpg_url, meta")
    .eq("workspace_id", workspaceId);
  const videos = ((videoData || []) as AdVideoRow[]).filter(isReadyCreative);
  if (videos.length === 0) return { readyToTest: [] };

  // Group the ready-creative videos by parent campaign to derive formats[] + archetype per campaign.
  const byCampaign = new Map<string, { formats: Set<string>; archetype: string | null }>();
  for (const v of videos) {
    if (!v.campaign_id) continue;
    const bucket = byCampaign.get(v.campaign_id) ?? { formats: new Set<string>(), archetype: null };
    if (v.format) bucket.formats.add(v.format);
    const arch = v.meta?.archetype ?? null;
    if (arch && !bucket.archetype) bucket.archetype = arch;
    byCampaign.set(v.campaign_id, bucket);
  }
  const candidateCampaignIds = [...byCampaign.keys()];
  if (candidateCampaignIds.length === 0) return { readyToTest: [] };

  // Pull the parent campaigns — workspace scoped + has a landing_url — only for the candidates.
  // Phase 2 product-scoped narrowing: when productId is passed, the anti-cross-contamination
  // guard restricts the ad_campaigns read to that product (a null productId keeps the reader
  // workspace-wide — the null-product default cohort still catches Superfood Tabs today).
  let campaignsQuery = admin
    .from("ad_campaigns")
    .select("id, landing_url, status, created_at, concept_tag, audience_temperature, max_qc_eligible")
    .eq("workspace_id", workspaceId)
    .in("id", candidateCampaignIds)
    .not("landing_url", "is", null)
    // Retiring a campaign (removing its landing URL) sets status='archived'; excluding these keeps
    // Dahlia's deficit truthful, /director-training's depth honest, and stops the media-buyer's
    // replenish from ever picking a retired creative.
    .neq("status", "archived")
    // max-qc-always-bins-ad-7of10-gates-only-bianca-postability Phase 2 — the always-bin flow
    // means every finished creative lands in `ad_campaigns`, but only Max-eligible ones (or
    // legacy / deterministic / kill-switch-off rows where Max never ran) should reach Bianca's
    // postable list. `IS NOT FALSE` includes TRUE + NULL and excludes only FALSE (the explicit
    // binned-but-ineligible marker stamped by insertReadyCreative on Max-below-floor
    // exhaustion). Pre-Phase-2 rows stay NULL, so today's byte-for-byte behavior is preserved.
    .not("max_qc_eligible", "is", false);
  if (productId) campaignsQuery = campaignsQuery.eq("product_id", productId);
  // Phase 1 (bianca-route-ready-creatives-by-dahlia-temperature-tag) — when the caller pins a
  // temperature band, restrict at the DB. The null-default preserves the pre-Phase-1 shape byte-
  // identically so untagged / unfiltered reads keep working.
  if (temperature) campaignsQuery = campaignsQuery.eq("audience_temperature", temperature);
  const { data: campaignData } = await campaignsQuery;
  const campaigns = (campaignData || []) as AdCampaignRow[];
  if (campaigns.length === 0) return { readyToTest: [] };

  // Exclude any campaign with an in-flight or already-published publish job. `failed` doesn't count
  // — a failed job means the campaign is still pending a successful launch.
  const { data: publishData } = await admin
    .from("ad_publish_jobs")
    .select("campaign_id, publish_status")
    .eq("workspace_id", workspaceId)
    .in("campaign_id", campaigns.map((c) => c.id))
    .in("publish_status", ACTIVE_PUBLISH_STATUSES as unknown as string[]);
  const activeSet = new Set<string>(ACTIVE_PUBLISH_STATUSES);
  const blocked = new Set<string>();
  for (const row of (publishData || []) as AdPublishJobRow[]) {
    if (!row.campaign_id) continue;
    // Belt-and-suspenders: the SELECT already filters to ACTIVE_PUBLISH_STATUSES, but a stray row (e.g.
    // a new publish_status value the DB has but this file doesn't yet) shouldn't silently block.
    if (row.publish_status && activeSet.has(row.publish_status)) blocked.add(row.campaign_id);
  }

  const rows: ReadyToTestRow[] = [];
  for (const c of campaigns) {
    if (blocked.has(c.id)) continue;
    if (!c.landing_url) continue;
    if (c.status === "archived") continue;
    // max-qc-always-bins-ad-7of10-gates-only-bianca-postability Phase 2 — JS-side belt-and-
    // suspenders mirror of the `.not("max_qc_eligible","is",false)` DB filter. A binned-but-
    // ineligible row (Max ran and rejected) must NEVER surface here even if the DB filter is
    // bypassed by a chain-mock, a schema drift, or a stray null-vs-false coercion. NULL rows
    // (Max never ran — deterministic / kill-switch off / legacy) stay through so today's
    // byte-for-byte behavior is preserved.
    if (c.max_qc_eligible === false) continue;
    const bucket = byCampaign.get(c.id);
    if (!bucket) continue;
    rows.push({
      ad_campaign_id: c.id,
      archetype: bucket.archetype,
      lander_url: c.landing_url,
      status: "ready_no_active_ad",
      formats: [...bucket.formats].sort(),
      created_at: c.created_at,
      concept_tag: c.concept_tag ?? null,
      audience_temperature: c.audience_temperature ?? null,
    });
  }
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return { readyToTest: rows };
}
