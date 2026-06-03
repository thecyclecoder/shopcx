/**
 * Ad tool — private Supabase Storage helpers.
 *
 * Reference photos, generated audio, intermediate clips, and final renders live
 * in the PRIVATE `ad-tool` bucket. Higgsfield needs publicly-readable inputs, so
 * we hand it short-lived signed URLs (1h TTL) at call time rather than making
 * anything public. See docs/brain/specs/ad-tool.md "Safety / invariants".
 */
import { createAdminClient } from "@/lib/supabase/admin";

export const AD_BUCKET = "ad-tool";
export const SIGNED_TTL_SEC = 3600; // 1 hour — comfortably longer than any job

/** Upload a remote asset (e.g. a Higgsfield output URL) into our private bucket. */
export async function uploadFromUrl(path: string, sourceUrl: string, contentType: string): Promise<string> {
  const admin = createAdminClient();
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`ad_storage_fetch_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { error } = await admin.storage.from(AD_BUCKET).upload(path, buf, { contentType, upsert: true });
  if (error) throw new Error(`ad_storage_upload: ${error.message}`);
  return path;
}

export async function uploadBuffer(path: string, buffer: Buffer, contentType: string): Promise<string> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(AD_BUCKET).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`ad_storage_upload: ${error.message}`);
  return path;
}

/** Permanently remove stored objects (e.g. a discarded avatar face). */
export async function removeObjects(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const admin = createAdminClient();
  await admin.storage.from(AD_BUCKET).remove(paths);
}

/** Short-lived signed URL for a stored object (for Higgsfield inputs + UI previews). */
export async function signedUrl(path: string, ttlSec = SIGNED_TTL_SEC): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(AD_BUCKET).createSignedUrl(path, ttlSec);
  if (error || !data) throw new Error(`ad_storage_sign: ${error?.message || "no_url"}`);
  return data.signedUrl;
}

/** Ensure the private bucket exists (idempotent — called by the apply script). */
export async function ensureAdBucket(): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.storage.getBucket(AD_BUCKET);
  if (!data) {
    await admin.storage.createBucket(AD_BUCKET, { public: false });
  }
}
