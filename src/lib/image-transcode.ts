/**
 * Upload-time image transcoding.
 *
 * Takes whatever the admin uploaded (PNG, JPG, HEIC, etc.) and writes
 * three files: the original (normalized + EXIF stripped), a WebP, and
 * an AVIF. Callers then persist the URLs for <picture>-style delivery.
 *
 * Why do this at upload instead of leaving it to Vercel's /_next/image?
 * 1. Og-image bots and direct Supabase URLs skip the Vercel optimizer.
 *    They'd otherwise get the raw 5 MB PNG.
 * 2. Warms the edge cache the first time the image is requested — no
 *    cold cache on-demand resize.
 * 3. Strips EXIF metadata (privacy + byte savings).
 * 4. Clamps dimensions so a misclick doesn't store a 10000×10000 photo.
 */

import sharp from "sharp";

const MAX_DIMENSION = 2400; // any side larger than this is downscaled
const WEBP_QUALITY = 78;
const AVIF_QUALITY = 60;
const JPEG_QUALITY = 82;

export interface TranscodedImage {
  originalBuffer: Buffer;
  originalContentType: string;
  originalExt: string;
  webpBuffer: Buffer | null;
  avifBuffer: Buffer | null;
  width: number | null;
  height: number | null;
}

/**
 * Normalize + transcode in one pass. Returns all three buffers plus
 * resolved dimensions. On any failure the caller can still fall back
 * to the original buffer (transcoded variants will be null).
 */
export async function transcodeUpload(
  input: Buffer,
  sourceMime: string,
): Promise<TranscodedImage> {
  const isSvg = sourceMime === "image/svg+xml";
  const isGif = sourceMime === "image/gif";

  // SVGs are already efficient — don't rasterize them. Just pass
  // through and skip variant generation.
  if (isSvg) {
    return {
      originalBuffer: input,
      originalContentType: "image/svg+xml",
      originalExt: "svg",
      webpBuffer: null,
      avifBuffer: null,
      width: null,
      height: null,
    };
  }

  // Animated GIFs would be static-ified by sharp — skip transcoding.
  if (isGif) {
    return {
      originalBuffer: input,
      originalContentType: "image/gif",
      originalExt: "gif",
      webpBuffer: null,
      avifBuffer: null,
      width: null,
      height: null,
    };
  }

  const base = sharp(input, { failOn: "none" })
    .rotate() // respect EXIF orientation then strip it
    .withMetadata({ orientation: undefined });

  const meta = await base.metadata().catch(() => null);
  const needsDownscale =
    !!meta?.width &&
    !!meta?.height &&
    (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION);

  const pipeline = needsDownscale
    ? base.resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
    : base;

  // Normalize original to JPEG (photos) or PNG (anything with alpha).
  const hasAlpha = !!meta?.hasAlpha;
  const normalizedOriginal = hasAlpha
    ? await pipeline.clone().png({ compressionLevel: 9, palette: true }).toBuffer()
    : await pipeline.clone().jpeg({ quality: JPEG_QUALITY, mozjpeg: true, progressive: true }).toBuffer();

  const originalContentType = hasAlpha ? "image/png" : "image/jpeg";
  const originalExt = hasAlpha ? "png" : "jpg";

  // WebP — near-universal support, smaller than JPEG for photos and
  // smaller than PNG for graphics.
  const webpBuffer = await pipeline
    .clone()
    .webp({ quality: WEBP_QUALITY, effort: 4 })
    .toBuffer()
    .catch(() => null);

  // AVIF — smallest, but slowest encode; modern browsers only.
  const avifBuffer = await pipeline
    .clone()
    .avif({ quality: AVIF_QUALITY, effort: 4 })
    .toBuffer()
    .catch(() => null);

  const final = await sharp(normalizedOriginal).metadata().catch(() => null);

  return {
    originalBuffer: normalizedOriginal,
    originalContentType,
    originalExt,
    webpBuffer,
    avifBuffer,
    width: final?.width ?? meta?.width ?? null,
    height: final?.height ?? meta?.height ?? null,
  };
}
