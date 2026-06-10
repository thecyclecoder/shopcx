/**
 * Migrate Shopify-hosted product/variant images onto our own Supabase storage
 * so nothing breaks when Shopify is sunset. Downloads a cdn.shopify.com (or
 * *.myshopify.com) image, uploads it to the `product-media` bucket under
 * `workspaces/{ws}/products/migrated/{sha1}.{ext}`, and returns the absolute
 * Supabase public URL. The storefront's `cdnUrl()` proxies that through
 * /storefront-img for edge caching, so stored URLs work everywhere (pages,
 * JSON-LD, emails) without further rewriting.
 *
 * Idempotent: the object path is a deterministic hash of the source URL, so a
 * re-run overwrites the same object and returns the same URL. Non-Shopify URLs
 * pass through as null (caller leaves them untouched).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { createHash } from "crypto";

const BUCKET = "product-media";
export const SHOPIFY_HOST_RE = /cdn\.shopify\.com|\.myshopify\.com/i;

export function isShopifyImage(url: unknown): url is string {
  return typeof url === "string" && SHOPIFY_HOST_RE.test(url);
}

function extFromUrl(url: string): string {
  const clean = url.split("?")[0];
  const m = clean.match(/\.(jpe?g|png|webp|gif|avif)$/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}
function contentType(ext: string): string {
  return ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : ext === "avif" ? "image/avif" : "image/jpeg";
}

/**
 * Download one Shopify image → upload → return our absolute public URL.
 * Returns null when the URL isn't Shopify-hosted or the fetch/upload fails.
 */
export async function migrateShopifyImage(workspaceId: string, srcUrl: string): Promise<string | null> {
  if (!isShopifyImage(srcUrl)) return null;
  const admin = createAdminClient();
  try {
    const res = await fetch(srcUrl);
    if (!res.ok) {
      console.warn(`[product-image-migrate] fetch ${res.status} for ${srcUrl}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = extFromUrl(srcUrl);
    const name = createHash("sha1").update(srcUrl).digest("hex").slice(0, 20);
    const objectPath = `workspaces/${workspaceId}/products/migrated/${name}.${ext}`;
    const { error } = await admin.storage.from(BUCKET).upload(objectPath, buf, {
      contentType: contentType(ext),
      upsert: true,
    });
    if (error) {
      console.warn("[product-image-migrate] upload failed:", error.message);
      return null;
    }
    return admin.storage.from(BUCKET).getPublicUrl(objectPath).data.publicUrl;
  } catch (e) {
    console.warn("[product-image-migrate] threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Deep-rewrite every Shopify image URL inside an arbitrary JSON value (e.g. the
 * denormalized products.variants array), migrating each and replacing it in
 * place. Returns the rewritten value + how many URLs were migrated. Caches by
 * source URL so a repeated image migrates once.
 */
export async function migrateImagesInJson(
  workspaceId: string,
  value: unknown,
  cache: Map<string, string> = new Map(),
): Promise<{ value: unknown; migrated: number }> {
  let migrated = 0;
  async function walk(v: unknown): Promise<unknown> {
    if (typeof v === "string") {
      if (!isShopifyImage(v)) return v;
      let mapped = cache.get(v);
      if (!mapped) {
        const m = await migrateShopifyImage(workspaceId, v);
        if (!m) return v; // leave untouched on failure
        cache.set(v, m);
        mapped = m;
      }
      migrated++;
      return mapped;
    }
    if (Array.isArray(v)) {
      const out = [];
      for (const item of v) out.push(await walk(item));
      return out;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = await walk(val);
      return out;
    }
    return v;
  }
  const rewritten = await walk(value);
  return { value: rewritten, migrated };
}
