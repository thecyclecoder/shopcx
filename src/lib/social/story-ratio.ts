/**
 * Ensure a story image is 9:16 (spec: automated-social-scheduler).
 *
 * Instagram/Facebook Stories are 9:16. Posting a square/portrait image as a
 * Story makes Meta zoom-crop it badly (text cut off, product oversized). When a
 * story slot's image isn't ~9:16, we extend it with Nano Banana Pro (outpaint
 * the scene above/below — never crop/zoom the subject) to a clean 1080×1920, and
 * point the post at that.
 *
 * Done at SCHEDULE time (in the planner), not at publish time: generation is
 * slow + failable, and publishing must stay deterministic + previewable. Promo
 * story graphics are already generated at 9:16, so they skip the (no-op) check.
 */
import sharp from "sharp";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateNanoBananaProCombine } from "@/lib/gemini";

const TARGET = 9 / 16; // 0.5625
const TOLERANCE = 0.03; // treat 0.53–0.59 as already-fine
const SIGNED_TTL = 600;
const BUCKET = "product-media";

const EXTEND_PROMPT =
  "Extend this exact image into a tall vertical 9:16 Instagram Story. The provided image is the CENTER of the frame — keep it fully visible, unchanged, uncropped, and undistorted. Generate natural, matching content ABOVE and BELOW it to fill a 9:16 canvas, seamlessly continuing the same background, lighting, and scene. Do NOT zoom, crop, cut off, or alter the original subject or any of its text. Keep everything important within the central safe area. Photorealistic, seamless, single continuous image, no borders or letterboxing.";

export interface StoryMedia {
  workspaceId: string;
  /** Stable id for the output path (e.g. source asset id). */
  key: string;
  mediaBucket?: string | null;
  mediaPath?: string | null;
  mediaUrl?: string | null;
}

/** Download the source bytes + a fetchable URL (signed for private buckets). */
async function loadSource(m: StoryMedia): Promise<{ buf: Buffer; url: string } | null> {
  const admin = createAdminClient();
  if (m.mediaBucket && m.mediaPath) {
    const { data: blob } = await admin.storage.from(m.mediaBucket).download(m.mediaPath);
    if (!blob) return null;
    const { data: signed } = await admin.storage.from(m.mediaBucket).createSignedUrl(m.mediaPath, SIGNED_TTL);
    if (!signed?.signedUrl) return null;
    return { buf: Buffer.from(await blob.arrayBuffer()), url: signed.signedUrl };
  }
  if (m.mediaUrl) {
    const res = await fetch(m.mediaUrl);
    if (!res.ok) return null;
    return { buf: Buffer.from(await res.arrayBuffer()), url: m.mediaUrl };
  }
  return null;
}

export interface StoryRatioResult {
  /** True when a new 9:16 image was generated; mediaUrl is its public URL. */
  changed: boolean;
  mediaUrl?: string;
  fromRatio?: number;
}

/**
 * Make a story image 9:16 if it isn't already. Returns {changed:false} when the
 * source is already ~9:16, {changed:true, mediaUrl} after extending, or null on
 * failure (caller keeps the original). Idempotent on `key`.
 */
export async function ensureStoryRatio(m: StoryMedia): Promise<StoryRatioResult | null> {
  const src = await loadSource(m);
  if (!src) return null;

  const meta = await sharp(src.buf, { failOn: "none" }).metadata().catch(() => null);
  if (!meta?.width || !meta?.height) return null;
  const ratio = meta.width / meta.height;
  if (Math.abs(ratio - TARGET) <= TOLERANCE) return { changed: false, fromRatio: ratio };

  // Outpaint to 9:16, then normalize to exactly 1080×1920 JPEG.
  const { buffer: raw } = await generateNanoBananaProCombine({
    workspaceId: m.workspaceId,
    prompt: EXTEND_PROMPT,
    imageUrls: [src.url],
  });
  const out = await sharp(raw, { failOn: "none" })
    .resize(1080, 1920, { fit: "cover" })
    .jpeg({ quality: 88 })
    .toBuffer();

  const admin = createAdminClient();
  const path = `workspaces/${m.workspaceId}/social-story-9x16/${m.key}.jpg`;
  const { error } = await admin.storage.from(BUCKET).upload(path, out, { contentType: "image/jpeg", upsert: true });
  if (error) return null;
  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(path);
  return { changed: true, mediaUrl: `${pub.publicUrl}?v=${Date.now()}`, fromRatio: ratio };
}
