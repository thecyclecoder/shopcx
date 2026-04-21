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
  avif_480_url: string | null;
  webp_480_url: string | null;
  avif_750_url: string | null;
  webp_750_url: string | null;
  avif_1080_url: string | null;
  webp_1080_url: string | null;
  avif_1500_url: string | null;
  webp_1500_url: string | null;
  avif_1920_url: string | null;
  webp_1920_url: string | null;
  alt_text: string | null;
} | null | undefined, altFallback: string, sizes: string): PictureSources | null {
  if (!m?.url) return null;

  const widths = [480, 750, 1080, 1500, 1920] as const;
  const urls = widths.map((w) => ({
    width: w,
    avif: cdnUrl(m[`avif_${w}_url` as keyof typeof m] as string | null),
    webp: cdnUrl(m[`webp_${w}_url` as keyof typeof m] as string | null),
  }));

  const avifSet = urls
    .filter((u) => u.avif)
    .map((u) => `${u.avif} ${u.width}w`)
    .join(", ");
  const webpSet = urls
    .filter((u) => u.webp)
    .map((u) => `${u.webp} ${u.width}w`)
    .join(", ");

  // Pick a single `src` for the fallback <img>. Browsers that honor
  // <source type=image/*> never hit this; bots / very old browsers
  // do. Prefer the 750-wide variant — cheapest realistic size that
  // still renders sharp on a typical 2× DPR phone.
  const webp750 = urls.find((u) => u.width === 750)?.webp;
  const avif750 = urls.find((u) => u.width === 750)?.avif;
  const fallback =
    webp750 ||
    avif750 ||
    urls.find((u) => u.webp)?.webp ||
    urls.find((u) => u.avif)?.avif ||
    cdnUrl(m.webp_url) ||
    cdnUrl(m.avif_url) ||
    cdnUrl(m.url) ||
    m.url;

  // Pick the single-URL AVIF/WebP src — used by <source> without srcset
  // (edge case) and by some legacy consumers of pictureSources().
  const mid = urls.find((u) => u.width === 1080);

  return {
    avifSrc: mid?.avif || cdnUrl(m.avif_url),
    webpSrc: mid?.webp || cdnUrl(m.webp_url),
    fallbackSrc: fallback || "",
    avifSrcSet: avifSet || undefined,
    webpSrcSet: webpSet || undefined,
    sizes,
    alt: m.alt_text || altFallback,
  };
}
