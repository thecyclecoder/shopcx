/**
 * Shared competitor-ad shapes + pure helpers.
 *
 * Extracted from the retired `src/lib/adlibrary.ts` when the collection source moved to Meta's own
 * Ad Library ([[./meta-ad-library]], founder 2026-08-24). These types and predicates are
 * SOURCE-AGNOSTIC on purpose — they describe a competitor ad, not a vendor's payload — so the
 * downstream consumers (creative-skeleton, landing-page-scout, ad-gap, video-skeleton) never had to
 * care which upstream produced the row.
 *
 * See [[../../docs/brain/integrations/meta-ad-library.md]].
 */

/**
 * `creative_skeletons.source` values.
 *
 * New rows are written as `meta_ad_library`. The legacy `adlibrary` value is NOT rewritten — 1,330
 * historical rows carry it, and rewriting them would destroy the provenance that says which upstream
 * produced a given skeleton (they have real `heat`/`impression` values no Meta row will ever have).
 * So writes use `COMPETITOR_AD_SOURCE` and reads use `COMPETITOR_AD_SOURCES`.
 */
export const COMPETITOR_AD_SOURCE = "meta_ad_library";
// Deliberately a mutable string[] — supabase-js `.in()` rejects a readonly tuple.
export const COMPETITOR_AD_SOURCES: string[] = ["adlibrary", "meta_ad_library"];

/** A competitor ad, normalized. Fields the current source can't supply are null, never absent —
 *  callers branch on null rather than on which vendor produced the row. */
export interface CompetitorAd {
  /** Stable dedup key. Meta's globally-unique archive id. */
  ad_key: string;
  advertiser: string | null;
  title: string | null;
  body: string | null;
  message: string | null;
  call_to_action: string | null;
  /** Bare host the ad drives to (no path). */
  destination_domain: string | null;
  /** FULL destination WITH path when known (e.g. https://learn.erthlabs.co/reasons2) — the real
   *  advertorial. The landing-page-scout PREFERS this over `destination_domain`, whose bare root
   *  often 404s because the advertorial lives at a slug. */
  landing_page_url: string | null;
  /** Meta ad-library render url. The ONLY handle to the creative — it renders to bytes, it is not
   *  a direct media url. See [[./meta-ad-library]] § creative bytes need a browser. */
  ad_snapshot_url: string | null;
  page_id: string | null;
  has_store_url: boolean | null;
  /** Direct creative url. Always null on the Meta source (no such url exists); retained because
   *  legacy `creative_skeletons` rows carry one from the AdLibrary era. */
  preview_img_url: string | null;
  resource_urls: Array<{ type?: number; url?: string; u?: string }>;
  video_duration: number | null;
  ads_type: number | null;
  platform: string | null;
  fb_merge_channel: string | null;
  /** ── Engagement / scale. NULL on the Meta source. ──────────────────────────────────────────
   *  Meta does not publish impressions, spend, or engagement for US commercial ads (political and
   *  EU ads only). Founder 2026-08-24: "we don't care about the engagement etc." — longevity is
   *  the ranking signal now. Kept on the interface because historical rows hold real values. */
  estimated_spend: number | null;
  all_exposure_value: number | null;
  impression: number | null;
  heat: number | null;
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  view_count: number | null;
  /** Delivery start — a real date from Meta, not a vendor estimate. */
  first_seen: string | null;
  /** Delivery stop. Null ⇒ still running. */
  last_seen: string | null;
  /** Days between delivery start and stop (or now). The winner proxy. */
  days_count: number | null;
  /** True when the ad has no stop time, i.e. still running. */
  resume_advertising_flag: boolean | null;
  raw: Record<string, unknown>;
}

/** Statics go to vision now; video routes to the video pipeline. */
export type MediaType = "static" | "video";

export interface NormalizedAd extends CompetitorAd {
  media_type: MediaType;
  /** Best handle for obtaining the creative. On the Meta source this is the SNAPSHOT url, which a
   *  browser must render — it is not directly fetchable. Null when the creative is unavailable
   *  (Meta strips it from ads it took down). */
  creative_url: string | null;
}

/** Back-compat alias — `AdLibraryAd` was the pre-Meta name for this shape. */
export type AdLibraryAd = CompetitorAd;

// ── creative render errors ─────────────────────────────────────────────────────────────

/**
 * A creative could not be turned into bytes.
 *
 * Lives HERE rather than in [[./meta-ad-library-render]] so the ingest path can classify a render
 * failure without importing the render module (and therefore without any chance of pulling
 * Playwright toward a serverless bundle).
 */
export class CreativeRenderError extends Error {
  constructor(
    message: string,
    /** True when the ad simply HAS no creative — Meta strips the asset from ads it takes down, so
     *  the snapshot will render copy and an avatar forever. Permanent failures are RECORDED
     *  (`status='failed'`); transient ones are RETHROWN so the ad stays eligible next sweep. */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "CreativeRenderError";
  }
}

/** A render failure worth retrying — i.e. anything that isn't a confirmed missing creative. */
export function isTransientRenderError(err: unknown): boolean {
  return err instanceof CreativeRenderError && !err.permanent;
}

// ── winner heuristics ──────────────────────────────────────────────────────────────────

export interface WinnerOpts {
  /** Sustained-run floor in days. 7 by default: DTC brands churn creative fast, and a 14-day gate
   *  dropped 72% of Erth's live ads. */
  minDays?: number;
}

/**
 * Is this ad worth analyzing?
 *
 * LONGEVITY-ONLY as of the Meta migration (2026-08-24). The prior heuristic also accepted an ad on
 * an impressions floor (50K) or a spend floor ($500), but Meta publishes neither for US commercial
 * ads — those terms evaluated to 0 and the gate silently collapsed to longevity anyway. Making it
 * explicit so the threshold that actually runs is the one you can read.
 *
 * This is a sounder signal than it sounds: Meta gives REAL delivery dates, so "still running after
 * N days" is measured, where AdLibrary's `heat`/`impression` were vendor estimates.
 */
export function isWinner(ad: Pick<NormalizedAd, "days_count">, opts: WinnerOpts = {}): boolean {
  return (ad.days_count ?? 0) >= (opts.minDays ?? 7);
}

/** Strict longevity gate: long-running AND still live. */
export function isLongRunner(
  ad: Pick<NormalizedAd, "days_count" | "resume_advertising_flag">,
  minDays = 14,
): boolean {
  if ((ad.days_count ?? 0) < minDays) return false;
  return ad.resume_advertising_flag !== false;
}

/** Rank so a capped sweep keeps the BEST. Longevity is the signal; a still-running ad outranks a
 *  same-age dead one because the advertiser is still paying for it. */
export function winnerScore(ad: Pick<NormalizedAd, "days_count" | "resume_advertising_flag">): number {
  const days = ad.days_count ?? 0;
  return days * 10 + (ad.resume_advertising_flag !== false ? 5 : 0);
}

// ── seeds ──────────────────────────────────────────────────────────────────────────────

export type SeedKind = "category" | "competitor";

export interface Seed {
  keyword: string;
  kind: SeedKind;
  /** Which of our products this seed maps to (provenance only). */
  note?: string;
  /** The approved `competitors.id` this seed came from — stamped onto every ingested skeleton. */
  competitorId?: string;
  /** The `products.id` this competitor was deliberately chosen for — the imitate link. */
  productId?: string;
  /** The competitor's registrable domain. The scout relevance-filters to ads that drive here. */
  expectedDomain?: string;
  /** Canonical advertiser name. Fallback when an ad has no determinable domain. */
  expectedAdvertiser?: string;
  /** The competitor's Meta page id, when resolved. LANE A collection pulls the page's full library
   *  directly — no keyword search, no relevance filtering needed. */
  metaPageId?: string | null;
}

// ── domain helpers ─────────────────────────────────────────────────────────────────────

/** Lowercased host of a url/host string, or null when the value isn't a real host. */
export function hostOf(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  let s = String(urlOrHost).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0];
  if (!s.includes(".")) return null;
  return s;
}

/** Registrable (eTLD+1-ish) domain: last two dot-labels. `shop.bulletproof.com` → `bulletproof.com`. */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

/** Compact brand handle for exact advertiser matching — mirrors competitors.normalizeBrand. */
function handleize(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Does this scouted ad actually belong to the intended competitor?
 *
 * Still required under Meta: `search_terms` matches ad COPY, not advertiser name, so a brand-term
 * search returns affiliates and unrelated advertisers who merely mention the brand (searching
 * "everydaydose" returned travel influencers). LANE A (`collectAdsByPage`) doesn't need this — a
 * page id is authoritative — but keyword discovery does.
 *   1. DOMAIN (authoritative when available): the ad's registrable destination equals the
 *      competitor's. Rejects wrong-brand even when the name is similar.
 *   2. ADVERTISER (fallback only when no domain is determinable): exact normalized name match.
 */
export function adMatchesCompetitor(
  ad: Pick<NormalizedAd, "advertiser" | "destination_domain" | "landing_page_url">,
  expected: { domain?: string | null; advertiser?: string | null },
): boolean {
  const adDomains = [hostOf(ad.landing_page_url), hostOf(ad.destination_domain)]
    .filter((h): h is string => !!h)
    .map(registrableDomain);
  const target = expected.domain
    ? registrableDomain(hostOf(expected.domain) ?? expected.domain)
    : null;

  if (target && adDomains.length) return adDomains.includes(target);
  if (expected.advertiser && ad.advertiser)
    return handleize(ad.advertiser) === handleize(expected.advertiser);
  return false;
}
