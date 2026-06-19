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
  keyword: string;
  /** "3" = the all-platforms app type we tested. */
  appType?: string;
  geo?: string[];
  daysBack?: number;
  pageSize?: number;
}

/** A raw AdLibrary ad row (only the fields we read are typed; the rest pass through `raw`). */
export interface AdLibraryAd {
  ad_key: string;
  advertiser: string | null;
  title: string | null;
  body: string | null;
  preview_img_url: string | null;
  resource_urls: Array<{ type?: number; url?: string; u?: string }>;
  video_duration: number | null;
  ads_type: number | null;
  all_exposure_value: number | null;
  impression: number | null;
  heat: number | null;
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

function normalize(row: Record<string, unknown>): NormalizedAd {
  const resourceUrls = Array.isArray(row.resource_urls)
    ? (row.resource_urls as Array<{ type?: number; url?: string; u?: string }>)
    : [];
  const ad: AdLibraryAd = {
    ad_key: String(row.ad_key ?? row.adKey ?? row.id ?? ""),
    advertiser: (row.advertiser as string) ?? (row.page_name as string) ?? null,
    title: (row.title as string) ?? null,
    body: (row.body as string) ?? null,
    preview_img_url: (row.preview_img_url as string) ?? (row.previewImgUrl as string) ?? null,
    resource_urls: resourceUrls,
    video_duration: pickNum(row.video_duration),
    ads_type: pickNum(row.ads_type),
    all_exposure_value: pickNum(row.all_exposure_value),
    impression: pickNum(row.impression),
    heat: pickNum(row.heat),
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
  const body = {
    keyword: params.keyword,
    appType: params.appType ?? "3",
    geo: params.geo ?? ["USA"],
    daysBack: params.daysBack ?? 30,
    pageSize: params.pageSize ?? 30,
  };
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
 * A "long-runner" is our winner heuristic: it's been running a while AND is still
 * active (resume flag). `minDays` defaults conservatively — repetition across
 * brands (Phase 4) is the real signal, but we only spend vision on proven ads.
 */
export function isLongRunner(ad: NormalizedAd, minDays = 14): boolean {
  const days = ad.days_count ?? 0;
  if (days < minDays) return false;
  // resume flag is the strongest "still winning" signal when present; if the API
  // omitted it, fall back to longevity alone.
  return ad.resume_advertising_flag !== false;
}

export type SeedKind = "category" | "competitor";

export interface Seed {
  keyword: string;
  kind: SeedKind;
  /** Which of our products this seed maps to (provenance only). */
  note?: string;
}

/**
 * Curated discovery seeds for Superfoods' categories. Per-competitor pulls use the
 * brand name AS the keyword (the API has no brand filter). The daily sweep also
 * runs category keywords; new heavy advertisers surfaced there can be promoted
 * into the competitor list over time.
 *
 * Categories we compete in: inflammation / energy / longevity / weight-loss / anti-aging.
 */
export const CATEGORY_SEEDS: Seed[] = [
  { keyword: "superfood coffee", kind: "category" },
  { keyword: "mushroom coffee", kind: "category" },
  { keyword: "adaptogen coffee", kind: "category" },
  { keyword: "energy without jitters", kind: "category" },
  { keyword: "anti-inflammatory", kind: "category" },
  { keyword: "longevity supplement", kind: "category" },
  { keyword: "anti-aging", kind: "category" },
  { keyword: "weight loss coffee", kind: "category" },
  { keyword: "ashwagandha", kind: "category" },
  { keyword: "greens powder", kind: "category" },
];

/**
 * Competitor brands (curated + data-surfaced). Amazing Coffee competes with the
 * coffee/adaptogen set; Ashwavana with Onnit; superfood/greens crosses to Bloom.
 */
export const COMPETITOR_SEEDS: Seed[] = [
  { keyword: "everydaydose", kind: "competitor", note: "Amazing Coffee" },
  { keyword: "ryze", kind: "competitor", note: "Amazing Coffee" },
  { keyword: "lifeboost", kind: "competitor", note: "Amazing Coffee" },
  { keyword: "urthlabs", kind: "competitor", note: "Amazing Coffee · anti-aging" },
  { keyword: "erthlabs", kind: "competitor", note: "Amazing Coffee · anti-aging (alt spelling)" },
  { keyword: "leanjoebean", kind: "competitor", note: "Amazing Coffee · weight-loss" },
  { keyword: "atlascoffeeclub", kind: "competitor", note: "Amazing Coffee" },
  { keyword: "piquelife", kind: "competitor", note: "Amazing Coffee" },
  { keyword: "mudwtr", kind: "competitor", note: "Amazing Coffee" },
  { keyword: "onnit", kind: "competitor", note: "Ashwavana" },
  { keyword: "bloomnu", kind: "competitor", note: "superfood/greens cross" },
];

export const ALL_SEEDS: Seed[] = [...COMPETITOR_SEEDS, ...CATEGORY_SEEDS];
