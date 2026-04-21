/**
 * URL helpers for storefront images.
 *
 * Every hero URL flows through /storefront-img/[...path], an edge
 * route handler that proxies Supabase Storage and adds the correct
 * Cache-Control header so Vercel's CDN can actually cache the bytes.
 * Supabase's public bucket responds with `cache-control: no-cache`,
 * which defeats edge caching; the proxy overrides that.
 *
 * This also insulates the page from the Supabase project ref — if we
 * ever migrate storage backends, only this helper changes.
 */

const SUPABASE_STORAGE_RE =
  /^https?:\/\/[^/]+\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/i;

/**
 * Convert a Supabase public object URL to a cached edge-proxy URL.
 * Non-Supabase URLs and empty values pass through untouched.
 */
export function cdnUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(SUPABASE_STORAGE_RE);
  if (!m) return raw;
  const [, bucket, objectPath] = m;
  return `/storefront-img/${bucket}/${objectPath}`;
}

export interface PictureSources {
  avifSrc: string | null;
  webpSrc: string | null;
  fallbackSrc: string;
  avifSrcSet?: string;
  webpSrcSet?: string;
  sizes?: string;
  width?: number | null;
  height?: number | null;
  alt: string;
}

/**
 * Build a <picture> data shape for a given MediaItem-like object.
 * Prefers responsive variant URLs when they exist, falling back to
 * the full-size AVIF/WebP and ultimately the normalized original.
 */
export function pictureSources(m: {
  url: string | null;
  webp_url: string | null;
  avif_url: string | null;
  avif_640_url: string | null;
  webp_640_url: string | null;
  avif_1200_url: string | null;
  webp_1200_url: string | null;
  avif_1920_url: string | null;
  webp_1920_url: string | null;
  alt_text: string | null;
} | null | undefined, altFallback: string, sizes: string): PictureSources | null {
  if (!m?.url) return null;

  const avif640 = cdnUrl(m.avif_640_url);
  const avif1200 = cdnUrl(m.avif_1200_url);
  const avif1920 = cdnUrl(m.avif_1920_url);
  const webp640 = cdnUrl(m.webp_640_url);
  const webp1200 = cdnUrl(m.webp_1200_url);
  const webp1920 = cdnUrl(m.webp_1920_url);

  const avifSet = [
    avif640 && `${avif640} 640w`,
    avif1200 && `${avif1200} 1200w`,
    avif1920 && `${avif1920} 1920w`,
  ].filter(Boolean).join(", ");

  const webpSet = [
    webp640 && `${webp640} 640w`,
    webp1200 && `${webp1200} 1200w`,
    webp1920 && `${webp1920} 1920w`,
  ].filter(Boolean).join(", ");

  // Pick a single `src` for the fallback <img>. Browsers that honor
  // <source type=image/*> never hit this; it's only used by bots and
  // very old browsers. Prefer the smallest still-reasonable size so
  // that path is cheap too.
  const fallback =
    webp640 ||
    avif640 ||
    webp1200 ||
    avif1200 ||
    cdnUrl(m.webp_url) ||
    cdnUrl(m.avif_url) ||
    cdnUrl(m.url) ||
    m.url;

  return {
    avifSrc: avif1200 || cdnUrl(m.avif_url),
    webpSrc: webp1200 || cdnUrl(m.webp_url),
    fallbackSrc: fallback || "",
    avifSrcSet: avifSet || undefined,
    webpSrcSet: webpSet || undefined,
    sizes,
    alt: m.alt_text || altFallback,
  };
}
