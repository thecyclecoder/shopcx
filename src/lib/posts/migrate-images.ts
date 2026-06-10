/**
 * Migrate a blog post's images off Shopify's CDN onto our Supabase storage,
 * rewriting the HTML so no Shopify-hosted image survives (spec: blog-resources).
 *
 * Downloads each Shopify-CDN <img src> in the body + the featured image,
 * uploads to the `product-media` bucket under
 * `workspaces/{ws}/posts/{handle}/{file}`, and returns the rewritten HTML +
 * featured URL. Idempotent on re-run (upsert; same object path per source URL).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { createHash } from "crypto";

const BUCKET = "product-media";
// Only migrate Shopify-hosted images; leave anything already on our domain alone.
const SHOPIFY_HOST_RE = /cdn\.shopify\.com|\.myshopify\.com/i;

function extFromUrl(url: string): string {
  const clean = url.split("?")[0];
  const m = clean.match(/\.(jpe?g|png|webp|gif|avif)$/i);
  return m ? m[1].toLowerCase() : "jpg";
}
function contentType(ext: string): string {
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : ext === "avif" ? "image/avif" : "image/jpeg";
}

/** Download one image URL → upload → return our public URL (or null on failure). */
async function migrateOne(workspaceId: string, handle: string, srcUrl: string): Promise<string | null> {
  if (!srcUrl || !SHOPIFY_HOST_RE.test(srcUrl)) return null;
  const admin = createAdminClient();
  try {
    const res = await fetch(srcUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = extFromUrl(srcUrl);
    // Deterministic name from the source URL → re-runs overwrite the same object.
    const name = createHash("sha1").update(srcUrl).digest("hex").slice(0, 16);
    const objectPath = `workspaces/${workspaceId}/posts/${handle}/${name}.${ext}`;
    const { error } = await admin.storage.from(BUCKET).upload(objectPath, buf, {
      contentType: contentType(ext),
      upsert: true,
    });
    if (error) { console.warn("[migrate-images] upload failed:", error.message); return null; }
    return admin.storage.from(BUCKET).getPublicUrl(objectPath).data.publicUrl;
  } catch (e) {
    console.warn("[migrate-images] fetch/upload threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

export interface MigratedImages {
  html: string;
  featuredImageUrl: string | null;
  migratedCount: number;
}

export async function migratePostImages(
  workspaceId: string,
  handle: string,
  contentHtml: string,
  featuredUrl: string | null,
): Promise<MigratedImages> {
  let migratedCount = 0;

  // Collect every <img src> + the featured image, dedupe, migrate once each.
  const srcs = new Set<string>();
  const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(contentHtml || "")) !== null) srcs.add(m[1]);
  if (featuredUrl) srcs.add(featuredUrl);

  const map = new Map<string, string>();
  for (const src of srcs) {
    const our = await migrateOne(workspaceId, handle, src);
    if (our) { map.set(src, our); migratedCount++; }
  }

  // Rewrite the HTML (replace every occurrence of each migrated src).
  let html = contentHtml || "";
  for (const [from, to] of map) html = html.split(from).join(to);
  const featuredImageUrl = featuredUrl ? map.get(featuredUrl) || (SHOPIFY_HOST_RE.test(featuredUrl) ? null : featuredUrl) : null;

  return { html, featuredImageUrl, migratedCount };
}
