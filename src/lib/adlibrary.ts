/**
 * AdLibrary.com discovery client — winning-static-creative-finder Phase 2.
 *
 * AdLibrary.com is an ad-intelligence index (no KYC, unlike Meta's Ad Library API
 * which is gated behind facebook.com identity confirmation). We use it to pull
 * LONG-RUNNING competitor + category ads — longevity (`days_count` +
 * `resume_advertising_flag`) is our proxy for "this creative is winning". We then
 * reverse-engineer each winner's STRUCTURE (never the asset) in Phase 3.
 *
 * API (tested 2026-06-19):
 *   POST https://adlibrary.com/api/search   Authorization: Bearer ${ADLIBRARY_API_KEY}
 *   body { keyword, appType:"3", geo:["USA"], daysBack, pageSize }
 *   → rows with advertiser, title, scale (all_exposure_value/impression/heat),
 *     longevity (first_seen/last_seen/days_count/resume_advertising_flag),
 *     and creative urls (preview_img_url / resource_urls / video_duration / ads_type / ad_key).
 *
 * Gotchas baked in here:
 *   - `body` copy is thin/empty → the real skeleton lives in the IMAGE. Vision is
 *     mandatory (Phase 3); we only surface the creative urls here.
 *   - Creative fetch needs the Bearer key (preview/resource urls 403 without it).
 *   - Static vs video is detectable at pull time → we tag `media_type` so ingestion
 *     can route statics → vision and videos → the heavier Phase 6 pipeline.
 *   - The API only filters by `keyword` (the /explore UI's niche/brand filters are
 *     NOT in the API). Per-competitor pulls use the brand name AS the keyword.
 *
 * Credits: 1/search, 10/min, 10k/day. Dedup by `ad_key` upstream so we never
 * re-spend on a creative we've already analyzed.
 */

const ADLIBRARY_API_KEY = process.env.ADLIBRARY_API_KEY?.trim();
const ADLIBRARY_BASE = "https://adlibrary.com";

export interface AdLibrarySearchParams {
  /** The brand keyword. Optional ONLY when `domain` is set (a domain-only search — LANE B). */
  keyword?: string;
  /** AdLibrary `domain` filter (undocumented but live) — returns a brand's ads by destination domain even
   *  when its advertiser can't be resolved by name (winners-flow LANE B: Wellah → wellah.com → 20 ads). */
  domain?: string;
  /** "3" = the all-platforms app type we tested. */
  appType?: string;
  geo?: string[];
  daysBack?: number;
  pageSize?: number;
  /** AdLibrary `adsType` filter: "1"=image, "2"=video, "3"=carousel. Omit for all types. The scout
   *  passes `["1"]` (image only) — we research STATIC creative, not video (founder 2026-07-17). */
  adsType?: string[];
  /** AdLibrary `platform` filter (facebook | instagram | tiktok | …). The scout passes
   *  `["facebook","instagram"]` — META ONLY (founder 2026-07-17: "we don't want google results"; the
   *  Google/AdMob text ads have no real creative image). */
  platform?: string[];
}

/**
 * A raw AdLibrary ad row. We capture the COMPLETE payload — destination, full copy, CTA, spend,
 * longevity, engagement, channel — not just the creative (ad-creative-scout Phase 1). The
 * destination (`ecom_advertiser_id` = the store domain per ad) is the bridge to landing-page-scout;
 * the copy/CTA/spend/offer fields power ad-gap analysis. The rest still passes through `raw`.
 */
export interface AdLibraryAd {
  ad_key: string;
  advertiser: string | null;
  title: string | null;
  body: string | null;
  /** Secondary copy line AdLibrary returns alongside title/body. */
  message: string | null;
  /** "Shop Now" / "Learn More" — the ad's CTA button. */
  call_to_action: string | null;
  /** ecom_advertiser_id — the store DOMAIN this specific ad drives traffic to (bare host, no path). */
  destination_domain: string | null;
  /** landing_page_url — the FULL ad destination WITH path (e.g. https://learn.erthlabs.co/women50), the
   *  real advertorial the landing-page-scout should capture. Present on ~half of ads (`has_source_url`);
   *  falls back to `destination_domain` when absent. This is the high-signal bridge — the bare domain
   *  root often 404s (advertorials live at a slug). */
  landing_page_url: string | null;
  /** Meta ad-library render URL: facebook.com/ads/archive/render_ad/?id=<archive_id>&access_token=… */
  ad_snapshot_url: string | null;
  /** The advertiser's Meta page id (for Graph lookups if ever needed). */
  page_id: string | null;
  has_store_url: boolean | null;
  preview_img_url: string | null;
  resource_urls: Array<{ type?: number; url?: string; u?: string }>;
  video_duration: number | null;
  ads_type: number | null;
  /** Platform the ad ran on (e.g. "facebook", "instagram"). */
  platform: string | null;
  fb_merge_channel: string | null;
  estimated_spend: number | null;
  all_exposure_value: number | null;
  impression: number | null;
  heat: number | null;
  /** Engagement counts. */
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  view_count: number | null;
  first_seen: string | null;
  last_seen: string | null;
  days_count: number | null;
  resume_advertising_flag: boolean | null;
  /** Everything from the API, for replay/audit. */
  raw: Record<string, unknown>;
}

/** A creative classified for routing: statics → vision now, videos → Phase 6. */
export type MediaType = "static" | "video";

export interface NormalizedAd extends AdLibraryAd {
  media_type: MediaType;
  /** Best creative url to analyze (preview image for statics; first resource for video). */
  creative_url: string | null;
}

export function hasAdLibraryKey(): boolean {
  return !!ADLIBRARY_API_KEY;
}

function pickNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

function resourceUrl(r: { url?: string; u?: string }): string | null {
  return r.url || r.u || null;
}

function pickStr(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1) return true;
  if (v === "false" || v === 0) return false;
  return null;
}

/**
 * Normalize a destination into a bare store domain (the landing-page-scout bridge): strip protocol,
 * leading "www.", and any path/query — keep the host (incl. subdomain, e.g. shop.ryzesuperfoods.com).
 */
function normalizeDestination(raw: unknown): string | null {
  const s = pickStr(raw);
  if (!s) return null;
  let host = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  host = host.split(/[/?#]/)[0].trim().toLowerCase();
  return host || null;
}

/**
 * Classify static vs video. `video_duration` is the primary signal (0 = static,
 * >0 = video); `ads_type` (1=image, 2=video) and `resource_urls[].type` corroborate.
 */
export function classifyMedia(ad: AdLibraryAd): MediaType {
  if ((ad.video_duration ?? 0) > 0) return "video";
  if (ad.ads_type === 2) return "video";
  if (ad.resource_urls?.some((r) => r.type === 2)) return "video";
  return "static";
}

/** Normalize a raw AdLibrary ad row → `NormalizedAd`. Exported so the winners-flow ([[./adlibrary-winners]])
 *  can reuse the SAME normalization on a `/api/winners/advertiser` concept's `ad` payload as `searchAds` uses. */
export function normalizeAd(row: Record<string, unknown>): NormalizedAd {
  return normalize(row);
}

function normalize(row: Record<string, unknown>): NormalizedAd {
  const resourceUrls = Array.isArray(row.resource_urls)
    ? (row.resource_urls as Array<{ type?: number; url?: string; u?: string }>)
    : [];
  const ad: AdLibraryAd = {
    ad_key: String(row.ad_key ?? row.adKey ?? row.id ?? ""),
    advertiser: (row.advertiser as string) ?? (row.page_name as string) ?? null,
    title: (row.title as string) ?? null,
    body: (row.body as string) ?? null,
    message: pickStr(row.message, row.caption, row.ad_text),
    call_to_action: pickStr(row.call_to_action, row.cta, row.cta_text),
    destination_domain: normalizeDestination(
      row.ecom_advertiser_id ?? row.store_url ?? row.link_url ?? row.destination_url,
    ),
    landing_page_url: pickStr(row.landing_page_url, row.source_url, row.landing_url),
    ad_snapshot_url: pickStr(row.ad_snapshot_url, row.snapshot_url),
    page_id: pickStr(row.page_id, row.advertiser_id),
    has_store_url: pickBool(row.has_store_url),
    preview_img_url: (row.preview_img_url as string) ?? (row.previewImgUrl as string) ?? null,
    resource_urls: resourceUrls,
    video_duration: pickNum(row.video_duration),
    ads_type: pickNum(row.ads_type),
    platform: pickStr(row.platform, row.publisher_platform),
    fb_merge_channel: pickStr(row.fb_merge_channel),
    estimated_spend: pickNum(row.estimated_spend),
    all_exposure_value: pickNum(row.all_exposure_value),
    impression: pickNum(row.impression),
    heat: pickNum(row.heat),
    like_count: pickNum(row.like ?? row.like_count ?? row.likes),
    comment_count: pickNum(row.comment ?? row.comment_count ?? row.comments),
    share_count: pickNum(row.share ?? row.share_count ?? row.shares),
    view_count: pickNum(row.view ?? row.view_count ?? row.views),
    first_seen: (row.first_seen as string) ?? null,
    last_seen: (row.last_seen as string) ?? null,
    days_count: pickNum(row.days_count),
    resume_advertising_flag:
      typeof row.resume_advertising_flag === "boolean" ? row.resume_advertising_flag : null,
    raw: row,
  };
  const media_type = classifyMedia(ad);
  const creative_url =
    media_type === "static"
      ? ad.preview_img_url || resourceUrl(resourceUrls[0] || {})
      : resourceUrl(resourceUrls.find((r) => r.type === 2) || resourceUrls[0] || {}) ||
        ad.preview_img_url;
  return { ...ad, media_type, creative_url };
}

/**
 * Search AdLibrary for ads matching `keyword`. Returns normalized rows with a
 * `media_type` tag. Throws on missing key / non-2xx so the caller can decide
 * (the cron logs + continues to the next keyword).
 */
export async function searchAds(params: AdLibrarySearchParams): Promise<NormalizedAd[]> {
  if (!ADLIBRARY_API_KEY) throw new Error("no_adlibrary_key");
  if (!params.keyword && !params.domain) throw new Error("searchAds: keyword or domain required");
  const body: Record<string, unknown> = {
    appType: params.appType ?? "3",
    geo: params.geo ?? ["USA"],
    daysBack: params.daysBack ?? 30,
    pageSize: params.pageSize ?? 30,
  };
  if (params.keyword) body.keyword = params.keyword;
  // domain filter — LANE B (a brand's ads by destination domain when its advertiser won't resolve by name).
  if (params.domain) body.domain = params.domain;
  // adsType filter: "1"=image, "2"=video, "3"=carousel (AdLibrary API). Only sent when the caller sets it.
  if (params.adsType && params.adsType.length) body.adsType = params.adsType;
  // platform filter (Meta-only for the scout) — only sent when the caller sets it.
  if (params.platform && params.platform.length) body.platform = params.platform;
  const res = await fetch(`${ADLIBRARY_BASE}/api/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADLIBRARY_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`adlibrary_search_${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  // The API nests rows under `data` / `results` / `ads` depending on endpoint version;
  // accept whichever array is present.
  const rows =
    (json.data as Record<string, unknown>[]) ||
    (json.results as Record<string, unknown>[]) ||
    (json.ads as Record<string, unknown>[]) ||
    (Array.isArray(json) ? (json as unknown as Record<string, unknown>[]) : []);
  return (rows || []).filter((r) => r && (r.ad_key || r.adKey || r.id)).map(normalize);
}

/**
 * Fetch a creative (image or video bytes). The preview/resource urls 403 without
 * the Bearer key, so this MUST be used (never a raw fetch). Returns the bytes +
 * content-type for vision (statics) or download (video, Phase 6).
 */
export async function fetchCreative(
  url: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  if (!ADLIBRARY_API_KEY) throw new Error("no_adlibrary_key");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${ADLIBRARY_API_KEY}` },
  });
  if (!res.ok) throw new Error(`adlibrary_creative_${res.status}`);
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

/**
 * A "long-runner" is the ORIGINAL longevity-only winner heuristic. Kept for reference/back-compat;
 * `sweepSeed` now uses `isWinner` (below), which also credits reach + spend.
 */
export function isLongRunner(ad: NormalizedAd, minDays = 14): boolean {
  const days = ad.days_count ?? 0;
  if (days < minDays) return false;
  return ad.resume_advertising_flag !== false;
}

export interface WinnerOpts {
  /** Sustained-run floor. Loosened from the old 14 → 7: DTC brands churn creative fast; a 14-day gate
   *  dropped 72% of Erth's live ads. */
  minDays?: number;
  /** Cumulative-reach floor — Meta's own library sorts winners by total impressions. A high-impression
   *  ad is a proven winner regardless of age (catches fresh-but-scaling creative longevity misses). */
  minImpressions?: number;
  /** Estimated-spend floor — real money behind an ad is a winner signal on its own. */
  minSpend?: number;
}

/**
 * The winner heuristic: an ad is worth analyzing if it shows ANY real signal — sustained run OR
 * meaningful reach OR meaningful spend. This replaces the pure-longevity `isLongRunner` gate (which
 * also required `resume_advertising_flag !== false` and so dropped recently-paused high-impression
 * winners — exactly the creative worth learning from). Thresholds calibrated from live Erth data
 * (winners ran 40-84d / 96K-576K impressions / $0.8-3.2K spend). See scripts/_sweep-erthlabs.ts.
 */
export function isWinner(ad: NormalizedAd, opts: WinnerOpts = {}): boolean {
  const minDays = opts.minDays ?? 7;
  const minImpressions = opts.minImpressions ?? 50_000;
  const minSpend = opts.minSpend ?? 500;
  const days = ad.days_count ?? 0;
  const impressions = Number(ad.impression) || 0;
  const spend = Number(ad.estimated_spend) || 0;
  return days >= minDays || impressions >= minImpressions || spend >= minSpend;
}

/** Rank winners so a capped sweep keeps the BEST — impressions first (Meta's signal), then spend, then
 *  longevity as tiebreaks. Higher = better. */
export function winnerScore(ad: NormalizedAd): number {
  const impressions = Number(ad.impression) || 0;
  const spend = Number(ad.estimated_spend) || 0;
  const days = ad.days_count ?? 0;
  return impressions + spend * 50 + days * 500;
}

export type SeedKind = "category" | "competitor";

export interface Seed {
  keyword: string;
  kind: SeedKind;
  /** Which of our products this seed maps to (provenance only). */
  note?: string;
  /** The approved `competitors.id` this seed was loaded from — stamped onto every skeleton the
   *  sweep ingests (per-product scout, CEO 2026-07-12). Null for legacy category seeds. */
  competitorId?: string;
  /** The `products.id` this competitor was deliberately chosen for — the deliberate imitate link.
   *  Dahlia's getProvenCompetitorAngles reads skeletons by this so a product imitates only ITS
   *  competitors, not the workspace-wide soup. */
  productId?: string;
  /** The competitor's own registrable domain (e.g. `bulletproof.com`). The scout RELEVANCE-FILTERS
   *  search results to ads that actually drive to this domain — brand-keyword search on AdLibrary is
   *  noisy (searching "Bulletproof" returns "Bulletproof Automotive" car ads). See adMatchesCompetitor. */
  expectedDomain?: string;
  /** The competitor's canonical advertiser name (resolved_advertiser ?? brand). Used ONLY as the
   *  fallback when an ad has no determinable domain (opaque AdLibrary `ar…` id + null landing page). */
  expectedAdvertiser?: string;
}

/** Lowercased host of a URL/host string, or null when the value is an opaque id (AdLibrary's `ar…`
 *  ecom_advertiser_id) or otherwise not a real host. */
export function hostOf(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  let s = String(urlOrHost).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0];
  if (!s.includes(".")) return null; // opaque id / not a host
  return s;
}

/** Registrable (eTLD+1-ish) domain: last two dot-labels. `shop.bulletproof.com` → `bulletproof.com`. */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

/** Compact brand handle for exact advertiser matching — mirrors competitors.normalizeBrand. */
function handleize(raw: string | null | undefined): string {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Does this scouted ad actually belong to the intended competitor? Brand-keyword search on AdLibrary is
 * noisy — "Bulletproof" returns "Bulletproof Automotive" (car wheels), "Four Sigmatic" returns "Neubrain"
 * (a content-match), affiliate pages front the brand under their own name. The relevance test:
 *   1. DOMAIN (authoritative when available): the ad's landing-page / destination registrable domain
 *      equals the competitor's. Rejects wrong-brand even when the NAME is similar
 *      (bulletproofautomotive.com ≠ bulletproof.com).
 *   2. ADVERTISER (fallback ONLY when the ad has no determinable domain — opaque `ar…` id + null landing):
 *      exact normalized advertiser match. Rescues real ads like "Mud Wtr, Inc" with an opaque destination.
 * With neither an expected domain nor a determinable ad domain and no name match → reject (don't pollute).
 */
export function adMatchesCompetitor(
  ad: Pick<NormalizedAd, "advertiser" | "destination_domain" | "landing_page_url">,
  expected: { domain?: string | null; advertiser?: string | null },
): boolean {
  const adDomains = [hostOf(ad.landing_page_url), hostOf(ad.destination_domain)]
    .filter((h): h is string => !!h)
    .map(registrableDomain);
  const target = expected.domain ? registrableDomain(hostOf(expected.domain) ?? expected.domain) : null;

  if (target && adDomains.length) return adDomains.includes(target);
  // No determinable ad domain (or no expected domain): fall back to an EXACT advertiser-name match.
  if (expected.advertiser && ad.advertiser) return handleize(ad.advertiser) === handleize(expected.advertiser);
  return false;
}

/**
 * CATEGORY_SEEDS — RETIRED 2026-07-12. Category-keyword sweeps (mushroom coffee, greens powder, …) fed
 * category auto-discovery of competitors, which the fully-deliberate model dropped. The scout now pulls
 * ONLY a product's deliberately-chosen competitor brands (`competitors.product_id`, loaded by
 * `loadApprovedCompetitorsForProduct`). The `SeedKind='category'` value is kept for historical rows.
 *
 * Competitor brands are NEVER hardcoded — they live in the DB-driven `competitors` table
 * (docs/brain/specs/competitor-scout.md), read per-product by the scout ([[creative-scout]]).
 */
