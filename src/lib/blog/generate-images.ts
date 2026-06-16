/**
 * Blog image generation — Nano Banana Pro + compression, for the auto-blog
 * pipeline (spec: auto-blog-generation).
 *
 * Every image is generated with [[gemini]] `generateNanoBananaProCombine`
 * (the hero composites the product's REAL isolated pouch), then **compressed
 * with sharp to WebP at a sane width** before upload — the raw model output is
 * 600KB–900KB JPEG at ~1400px, far too heavy for a blog page. WebP @ ~1600px
 * cuts that ~3-4x with no visible loss.
 *
 * The main image is generated twice: a **16:9 landscape** hero for the blog page,
 * and a **4:3 social variant** stored on the post but never shown on the blog —
 * the organic social scheduler picks that up for the blog-on-social feed posts.
 *
 * Quick-win now; the full AVIF/WebP multi-width pipeline ([[image-transcode]])
 * is a spec line item.
 */
import sharp from "sharp";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateNanoBananaProCombine, type NanoBananaAspect } from "@/lib/gemini";

const BUCKET = "product-media";

export interface CompressOpts {
  /** Max width in px (height scales). Default 1600. */
  maxWidth?: number;
  /** WebP quality 1-100. Default 80. */
  quality?: number;
}

/** Resize (down only) + encode to WebP. Returns the compressed buffer + dims. */
export async function compressToWebp(
  input: Buffer,
  opts: CompressOpts = {},
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const maxWidth = opts.maxWidth ?? 1600;
  const quality = opts.quality ?? 80;
  const pipeline = sharp(input, { failOn: "none" })
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality });
  const buffer = await pipeline.toBuffer();
  const meta = await sharp(buffer).metadata().catch(() => null);
  return { buffer, width: meta?.width ?? 0, height: meta?.height ?? 0 };
}

/** Upload a buffer to the post's media folder, return the public URL. */
export async function uploadPostImage(
  workspaceId: string,
  handle: string,
  slot: string,
  buffer: Buffer,
  contentType: string,
  ext: string,
): Promise<string> {
  const admin = createAdminClient();
  const path = `workspaces/${workspaceId}/posts/${handle}/${slot}.${ext}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`upload ${slot} failed: ${error.message}`);
  return admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

export interface GeneratedImage {
  slot: string;
  url: string;
  width: number;
  height: number;
}

/**
 * Generate one image with Nano Banana Pro, compress to WebP, upload.
 * `inputImageUrls` (e.g. the isolated product pouch) are composited into the
 * scene; pass `[]` for pure text-to-image.
 */
export async function genCompressUpload(args: {
  workspaceId: string;
  handle: string;
  slot: string;
  prompt: string;
  inputImageUrls?: string[];
  maxWidth?: number;
  quality?: number;
  aspectRatio?: NanoBananaAspect;
}): Promise<GeneratedImage> {
  const { buffer: raw } = await generateNanoBananaProCombine({
    workspaceId: args.workspaceId,
    prompt: args.prompt,
    imageUrls: args.inputImageUrls || [],
    aspectRatio: args.aspectRatio,
  });
  const { buffer, width, height } = await compressToWebp(raw, {
    maxWidth: args.maxWidth,
    quality: args.quality,
  });
  const url = await uploadPostImage(args.workspaceId, args.handle, args.slot, buffer, "image/webp", "webp");
  return { slot: args.slot, url, width, height };
}

/** Standard widths per slot kind. Hero/social a bit larger; in-body lean. */
export const SLOT_MAX_WIDTH: Record<string, number> = {
  hero: 1600,
  social: 1080, // 4:5 → 1080×1350 (IG/FB feed portrait)
  body: 1280,
};

/**
 * The 4:5 portrait social variant of the main image — composited from the same
 * isolated product, framed for the blog-on-social feed posts. Stored on the
 * post (social_image_url) but never rendered on the blog. 4:5 is the tallest
 * ratio IG/FB feed allows, so it claims the most vertical real estate.
 */
export async function genSocialVariant(args: {
  workspaceId: string;
  handle: string;
  prompt: string;
  inputImageUrls?: string[];
}): Promise<GeneratedImage> {
  return genCompressUpload({
    workspaceId: args.workspaceId,
    handle: args.handle,
    slot: "social",
    prompt: args.prompt,
    inputImageUrls: args.inputImageUrls,
    maxWidth: SLOT_MAX_WIDTH.social,
    quality: 82,
    aspectRatio: "4:5",
  });
}
