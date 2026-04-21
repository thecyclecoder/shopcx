/**
 * Upload-time image transcoding + responsive variants.
 *
 * Takes whatever the admin uploaded and emits:
 *   - a normalized original (EXIF stripped, rotated, clamped)
 *   - AVIF + WebP at each of three widths (640, 1200, 1920)
 *
 * These variants back a native <picture>/<source srcset> element on
 * the storefront. Because every file is pre-encoded, the hero image
 * can be served directly from object storage — no runtime optimizer,
 * no serverless cold start, no cascading origin miss.
 *
 * Why pre-transcode vs Vercel /_next/image:
 *   1. Public URLs (og bots, crawlers) see AVIF directly, never the
 *      raw PNG.
 *   2. No cold-cache penalty on low-traffic pages — every variant
 *      already exists at its final URL.
 *   3. Strips EXIF + downscales runaway uploads server-side.
 */

import sharp from "sharp";

const MAX_DIMENSION = 2400; // hard clamp on absolute upload size
const WEBP_QUALITY = 78;
const AVIF_QUALITY = 60;
const JPEG_QUALITY = 82;

// Responsive widths. Tuned for mobile-first: 640 covers phones at 2×
// DPR, 1200 covers tablets + desktop, 1920 covers desktop retina.
export const RESPONSIVE_WIDTHS = [640, 1200, 1920] as const;
export type ResponsiveWidth = (typeof RESPONSIVE_WIDTHS)[number];

export interface ResponsiveVariant {
  width: ResponsiveWidth;
  avifBuffer: Buffer | null;
  webpBuffer: Buffer | null;
}

export interface TranscodedImage {
  originalBuffer: Buffer;
  originalContentType: string;
  originalExt: string;
  webpBuffer: Buffer | null; // full-size WebP (backwards compat)
  avifBuffer: Buffer | null; // full-size AVIF (backwards compat)
  variants: ResponsiveVariant[]; // [{ width: 640, avif, webp }, ...]
  width: number | null;
  height: number | null;
}

export async function transcodeUpload(
  input: Buffer,
  sourceMime: string,
): Promise<TranscodedImage> {
  const isSvg = sourceMime === "image/svg+xml";
  const isGif = sourceMime === "image/gif";

  // SVGs + animated GIFs pass through — no meaningful transcode.
  if (isSvg || isGif) {
    return {
      originalBuffer: input,
      originalContentType: isSvg ? "image/svg+xml" : "image/gif",
      originalExt: isSvg ? "svg" : "gif",
      webpBuffer: null,
      avifBuffer: null,
      variants: [],
      width: null,
      height: null,
    };
  }

  const base = sharp(input, { failOn: "none" })
    .rotate()
    .withMetadata({ orientation: undefined });

  const meta = await base.metadata().catch(() => null);
  const origWidth = meta?.width ?? 0;
  const origHeight = meta?.height ?? 0;
  const hasAlpha = !!meta?.hasAlpha;

  const needsClamp =
    origWidth > MAX_DIMENSION || origHeight > MAX_DIMENSION;
  const clamped = needsClamp
    ? base.resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
    : base;

  // Full-size normalized original (PNG if alpha, JPEG otherwise)
  const normalizedOriginal = hasAlpha
    ? await clamped.clone().png({ compressionLevel: 9, palette: true }).toBuffer()
    : await clamped
        .clone()
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, progressive: true })
        .toBuffer();

  const originalContentType = hasAlpha ? "image/png" : "image/jpeg";
  const originalExt = hasAlpha ? "png" : "jpg";

  // Full-size AVIF + WebP (backwards-compat with callers that use
  // bestMediaUrl and just want one high-quality optimized URL).
  const [webpBuffer, avifBuffer] = await Promise.all([
    clamped
      .clone()
      .webp({ quality: WEBP_QUALITY, effort: 4 })
      .toBuffer()
      .catch(() => null),
    clamped
      .clone()
      .avif({ quality: AVIF_QUALITY, effort: 4 })
      .toBuffer()
      .catch(() => null),
  ]);

  // Per-width responsive variants. Skip widths larger than the source.
  const effectiveWidths = RESPONSIVE_WIDTHS.filter(
    (w) => !origWidth || w <= Math.max(origWidth, MAX_DIMENSION),
  );

  const variants = await Promise.all(
    effectiveWidths.map(async (width) => {
      const resized = clamped.clone().resize({
        width,
        withoutEnlargement: true,
        fit: "inside",
      });
      const [w, a] = await Promise.all([
        resized
          .clone()
          .webp({ quality: WEBP_QUALITY, effort: 4 })
          .toBuffer()
          .catch(() => null),
        resized
          .clone()
          .avif({ quality: AVIF_QUALITY, effort: 4 })
          .toBuffer()
          .catch(() => null),
      ]);
      return { width, avifBuffer: a, webpBuffer: w } as ResponsiveVariant;
    }),
  );

  const final = await sharp(normalizedOriginal).metadata().catch(() => null);

  return {
    originalBuffer: normalizedOriginal,
    originalContentType,
    originalExt,
    webpBuffer,
    avifBuffer,
    variants,
    width: final?.width ?? origWidth ?? null,
    height: final?.height ?? origHeight ?? null,
  };
}
