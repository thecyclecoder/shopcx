/**
 * Meta Ad Library client — the competitor-ad source of record (replaces AdLibrary.com).
 *
 * WHY the switch (founder 2026-08-24): Dylan's Meta identity confirmation landed, unlocking
 * `GET /{version}/ads_archive`. It is free, official, and carries data AdLibrary never had —
 * true per-ad delivery dates (real longevity, not a vendor's opaque `heat`), targeting
 * (`target_ages`/`target_gender`), platform placement, and Meta's own `media_type`
 * classification. See [[../../docs/brain/integrations/meta-ad-library.md]].
 *
 * ── AUTH IS PER-WORKSPACE, NOT ENV ────────────────────────────────────────────────────
 * This is the sharpest break from [[./adlibrary]], whose `ADLIBRARY_API_KEY` was a process-wide
 * env var (`hasAdLibraryKey()` was sync). `/ads_archive` answers ONLY to a USER access token
 * belonging to an ID-confirmed person — an APP token and a PAGE token are both rejected with
 * `code=10/2332004 "Application does not have permission for this action"` (verified 2026-08-24
 * against all three). So the credential is `workspaces.meta_user_access_token_encrypted`, and
 * every entry point takes a `workspaceId` and is async.
 *
 * ── CREATIVE BYTES NEED A BROWSER ─────────────────────────────────────────────────────
 * The archive exposes NO media url. Meta's own ArchivedAd node has 28 fields and exactly one
 * carries the creative: `ad_snapshot_url`, documented as "displays uncompressed images and
 * videos" — a JS-rendered page. Verified dead ends (2026-08-24): bare fetch returns a 174KB
 * shell with zero creative urls; a browser User-Agent on the same url 400s; the public
 * `/ads/library/?id=` permalink 403s. So `creative_url` here is the SNAPSHOT url, and turning
 * it into bytes is a render step that runs on the BOX (Playwright), never on Vercel — see
 * `renderCreativeFromSnapshot` in [[./meta-ad-library-render]].
 *
 * ── ADS META TOOK DOWN HAVE NO CREATIVE ───────────────────────────────────────────────
 * When Meta removes an ad for Advertising Standards it STRIPS the creative from the archive;
 * the snapshot renders copy + a 60px avatar and nothing else. Those ads are unrenderable by
 * construction, so `isCreativeRemoved` flags them at ingestion and the render step skips them
 * (22 of Erth's 44 statics were in this state). Filtering them is what took a render pass from
 * 14/26 to 22/22.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import type { MediaType, NormalizedAd } from "@/lib/competitor-ad-types";

export const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/** Countries we pull. US is the market we sell into; the archive is per-country by law. */
export const DEFAULT_COUNTRIES = ["US"] as const;

/** Meta's `media_type` vocabulary. MEME is a static with heavy text overlay — founder 2026-08-24:
 *  "what we consider as a static ad is probably what meta calls Meme and that's ok". So the static
 *  pool is IMAGE + MEME. (Erth: 0 IMAGE, 26 MEME, 53 VIDEO — a brand running only meme-statics
 *  would look like it had NO statics if we filtered on IMAGE alone.) */
export type MetaMediaType = "IMAGE" | "MEME" | "VIDEO" | "NONE";
export const STATIC_MEDIA_TYPES: readonly MetaMediaType[] = ["IMAGE", "MEME"];

/** The fields we request. Anything absent for US commercial ads (impressions, spend,
 *  demographic_distribution, estimated_audience_size) is deliberately NOT requested — Meta only
 *  populates those for political/issue ads and for the EU, and we don't sell on those signals. */
const AD_FIELDS = [
  "id",
  "page_id",
  "page_name",
  "ad_creative_bodies",
  "ad_creative_link_titles",
  "ad_creative_link_captions",
  "ad_creative_link_descriptions",
  "ad_creation_time",
  "ad_delivery_start_time",
  "ad_delivery_stop_time",
  "ad_snapshot_url",
  "publisher_platforms",
  "languages",
  "target_ages",
  "target_gender",
  "eu_total_reach",
].join(",");

// ── credentials ────────────────────────────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; at: number }>();
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** The ID-confirmed user token for a workspace, or null when the workspace hasn't connected Meta.
 *  Cached briefly — the sweep resolves the same workspace many times per run. */
export async function getAdLibraryToken(workspaceId: string): Promise<string | null> {
  const hit = tokenCache.get(workspaceId);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workspaces")
    .select("meta_user_access_token_encrypted")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error || !data?.meta_user_access_token_encrypted) return null;
  try {
    const token = decrypt(data.meta_user_access_token_encrypted as string);
    tokenCache.set(workspaceId, { token, at: Date.now() });
    return token;
  } catch {
    return null;
  }
}

/** Replaces `hasAdLibraryKey()`. Async + per-workspace because the credential is per-workspace. */
export async function hasAdLibraryAccess(workspaceId: string): Promise<boolean> {
  return (await getAdLibraryToken(workspaceId)) !== null;
}

// ── low-level call ─────────────────────────────────────────────────────────────────────

export class MetaAdLibraryError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly status: number,
  ) {
    super(message);
    this.name = "MetaAdLibraryError";
  }
}

/** Graph error codes that mean "retry later" rather than "this will never work". `4`/`17`/`613` are
 *  rate/throughput limits; `2` is a transient platform fault. `190` (bad token) and `10` (permission)
 *  are terminal — a retry loop on those just burns the sweep. */
const RETRYABLE_GRAPH_CODES = new Set([1, 2, 4, 17, 341, 613]);

export function isRetryableGraphError(err: unknown): boolean {
  if (!(err instanceof MetaAdLibraryError)) return false;
  if (err.status === 429 || err.status >= 500) return true;
  return err.code !== null && RETRYABLE_GRAPH_CODES.has(err.code);
}

async function graphGet(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const error = json?.error as
    | { message?: string; code?: number; error_subcode?: number }
    | undefined;
  if (error) {
    throw new MetaAdLibraryError(
      error.message ?? "meta ad library error",
      error.code ?? null,
      error.error_subcode ?? null,
      res.status,
    );
  }
  if (!res.ok || !json) {
    throw new MetaAdLibraryError(`HTTP ${res.status}`, null, null, res.status);
  }
  return json;
}

interface PageOpts {
  /** Hard cap on pages walked. The archive pages at 100/req; a brand with thousands of ads would
   *  otherwise walk forever. 20 pages = 2000 ads, far above any real competitor. */
  maxPages?: number;
  countries?: readonly string[];
  mediaType?: MetaMediaType;
}

/** Walk `paging.next` to exhaustion (or `maxPages`), returning the raw archive rows. */
async function archiveAll(
  token: string,
  params: Record<string, string>,
  opts: PageOpts = {},
): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams({
    access_token: token,
    ad_reached_countries: JSON.stringify([...(opts.countries ?? DEFAULT_COUNTRIES)]),
    ad_type: "ALL",
    limit: "100",
    fields: AD_FIELDS,
    ...(opts.mediaType ? { media_type: opts.mediaType } : {}),
    ...params,
  });
  let url = `${GRAPH}/ads_archive?${qs}`;
  const out: Record<string, unknown>[] = [];
  const maxPages = opts.maxPages ?? 20;
  for (let page = 0; page < maxPages; page++) {
    const json = await graphGet(url);
    const data = (json.data as Record<string, unknown>[]) ?? [];
    out.push(...data);
    const next = (json.paging as { next?: string } | undefined)?.next;
    if (!next) break;
    url = next;
  }
  return out;
}

// ── normalization ──────────────────────────────────────────────────────────────────────

const firstOf = (v: unknown): string | null => {
  if (Array.isArray(v) && v.length && typeof v[0] === "string") return (v[0] as string).trim() || null;
  return null;
};

/** Meta strips the creative from ads it took down; the caption carries the notice instead of a
 *  destination. Detect it so the render step never wastes a page-load on an ad with no image. */
export function isCreativeRemoved(row: Record<string, unknown>): boolean {
  const captions = JSON.stringify(row.ad_creative_link_captions ?? []);
  return /Advertising Standards|we later disabled/i.test(captions);
}

/** Days the ad has been live — the winner proxy. Meta gives real dates, so this is a measured
 *  number rather than AdLibrary's opaque score. An ad with no stop time is still running. */
export function daysRunning(row: Record<string, unknown>): number {
  const startRaw = row.ad_delivery_start_time as string | undefined;
  if (!startRaw) return 0;
  const start = Date.parse(startRaw);
  if (Number.isNaN(start)) return 0;
  const stopRaw = row.ad_delivery_stop_time as string | undefined;
  const stop = stopRaw ? Date.parse(stopRaw) : Date.now();
  return Math.max(0, Math.round((stop - start) / 86_400_000));
}

export function classifyMetaMedia(mediaType: MetaMediaType | null): MediaType {
  return mediaType === "VIDEO" ? "video" : "static";
}

/**
 * Map an archive row onto the shared `NormalizedAd` shape so every downstream consumer
 * (creative-skeleton, landing-page-scout, ad-gap) keeps working unchanged.
 *
 * Fields AdLibrary supplied that Meta has no equivalent for are NULL by design, not by omission —
 * `heat`, `impression`, `estimated_spend`, and the like/comment/share/view counts are vendor
 * engagement estimates Meta does not publish for US commercial ads. Founder 2026-08-24: "we don't
 * care about the engagement etc.". Longevity replaces them as the ranking signal.
 */
export function normalizeMetaAd(
  row: Record<string, unknown>,
  mediaType: MetaMediaType | null,
): NormalizedAd {
  const caption = firstOf(row.ad_creative_link_captions);
  // A caption is sometimes a bare host ("learn.erthlabs.co") and sometimes a full url with the
  // advertorial path ("https://learn.erthlabs.co/reasons2"). The landing-page-scout wants the FULL
  // url when present — the bare root frequently 404s because the advertorial lives at a slug.
  const captionIsUrl = !!caption && /^https?:\/\//i.test(caption);
  const removed = isCreativeRemoved(row);

  return {
    // Meta's archive id is globally unique and stable → the dedup key.
    ad_key: String(row.id ?? ""),
    advertiser: (row.page_name as string) ?? null,
    title: firstOf(row.ad_creative_link_titles),
    body: firstOf(row.ad_creative_bodies),
    message: firstOf(row.ad_creative_link_descriptions),
    // Meta does not expose the CTA button label anywhere in the archive.
    call_to_action: null,
    destination_domain: removed ? null : hostOfCaption(caption),
    landing_page_url: removed ? null : captionIsUrl ? caption : null,
    ad_snapshot_url: (row.ad_snapshot_url as string) ?? null,
    page_id: (row.page_id as string) ?? null,
    has_store_url: removed ? null : !!caption,
    // No direct media url exists — the creative comes from rendering the snapshot.
    preview_img_url: null,
    resource_urls: [],
    video_duration: mediaType === "VIDEO" ? 1 : 0,
    ads_type: mediaType === "VIDEO" ? 2 : 1,
    platform: firstOf(row.publisher_platforms),
    fb_merge_channel: null,
    // ── no Meta equivalent (see docblock) ──
    estimated_spend: null,
    all_exposure_value: null,
    impression: null,
    heat: null,
    like_count: null,
    comment_count: null,
    share_count: null,
    view_count: null,
    // ── longevity: measured, not estimated ──
    first_seen: (row.ad_delivery_start_time as string) ?? null,
    last_seen: (row.ad_delivery_stop_time as string) ?? null,
    days_count: daysRunning(row),
    resume_advertising_flag: !row.ad_delivery_stop_time,
    raw: row,
    media_type: classifyMetaMedia(mediaType),
    // The snapshot url IS the creative handle; the box render turns it into bytes.
    creative_url: removed ? null : ((row.ad_snapshot_url as string) ?? null),
  };
}

function hostOfCaption(caption: string | null): string | null {
  if (!caption) return null;
  try {
    return new URL(/^https?:\/\//i.test(caption) ? caption : `https://${caption}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ── collection ─────────────────────────────────────────────────────────────────────────

export interface CollectOpts {
  countries?: readonly string[];
  maxPages?: number;
  /** Only pull the static pool (IMAGE + MEME). We research statics; video is a separate lane. */
  staticsOnly?: boolean;
  /** Drop ads whose creative Meta stripped — they cannot be rendered. Default true. */
  excludeRemoved?: boolean;
}

/**
 * Every ad a page is running, by Meta page id. This is the LANE A collection call and it replaces
 * BOTH AdLibrary steps at once: there is no separate paid "winners" endpoint because the archive
 * returns the brand's FULL library with real dates, so longevity is computed rather than bought.
 */
export async function collectAdsByPage(
  workspaceId: string,
  pageId: string,
  opts: CollectOpts = {},
): Promise<NormalizedAd[]> {
  const token = await getAdLibraryToken(workspaceId);
  if (!token) return [];

  const wanted: (MetaMediaType | null)[] = opts.staticsOnly ? [...STATIC_MEDIA_TYPES] : [null];
  const out: NormalizedAd[] = [];
  const seen = new Set<string>();

  for (const mt of wanted) {
    const rows = await archiveAll(
      token,
      { search_page_ids: JSON.stringify([pageId]) },
      { countries: opts.countries, maxPages: opts.maxPages, mediaType: mt ?? undefined },
    );
    for (const row of rows) {
      if (opts.excludeRemoved !== false && isCreativeRemoved(row)) continue;
      const ad = normalizeMetaAd(row, mt);
      if (!ad.ad_key || seen.has(ad.ad_key)) continue;
      seen.add(ad.ad_key);
      out.push(ad);
    }
  }
  return out;
}

/**
 * Keyword search. NOTE the semantics differ sharply from AdLibrary's brand search: Meta matches
 * `search_terms` against the ad's COPY, not the advertiser name. Searching "everydaydose" returns
 * UGC affiliates who merely MENTION the brand and not necessarily the brand's own ads. That makes
 * this useful for DISCOVERY (finding who advertises a term / who pushes a domain) but wrong as a
 * per-brand collection call — use `collectAdsByPage` for that.
 */
export async function searchAdsByTerm(
  workspaceId: string,
  term: string,
  opts: CollectOpts = {},
): Promise<NormalizedAd[]> {
  const token = await getAdLibraryToken(workspaceId);
  if (!token) return [];
  const rows = await archiveAll(
    token,
    { search_terms: term },
    { countries: opts.countries, maxPages: opts.maxPages ?? 5 },
  );
  return rows
    .filter((r) => (opts.excludeRemoved !== false ? !isCreativeRemoved(r) : true))
    .map((r) => normalizeMetaAd(r, null));
}
