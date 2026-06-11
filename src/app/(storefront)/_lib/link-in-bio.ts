/**
 * Link-in-bio feed (spec: automated-social-scheduler · link-in-bio).
 *
 * The /links page mirrors **what we recently posted to social**, Instagram-feed
 * style: each entry shows **the exact image we posted** (so a viewer recognizes
 * it from memory) plus the full content below. Source of truth is
 * `scheduled_social_posts` (status='posted') — the poster already records the
 * post image (`media_*`) and the content linkage (`source_ref_id`), so nothing
 * extra to write. Newest first, deduped by content. Each post type → an entry:
 *
 *   review/testimonial → post image + FULL review text + Shop {Product}
 *   blog resource      → post image + the post (→ /blog) + Shop {Product}
 *   avatar / reel      → post image + Shop {Product}
 *   promo              → post image + the offer + Shop {Product}
 *
 * Falls back to recent blog posts so the page is never empty.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface LinkProduct { handle: string; title: string }

export type LinkEntry =
  | { kind: "review"; key: string; image: string | null; product: LinkProduct | null; reviewerName: string; rating: number; headline: string; body: string }
  | { kind: "post"; key: string; image: string | null; product: LinkProduct | null; title: string; handle: string }
  | { kind: "shop"; key: string; image: string | null; product: LinkProduct }
  | { kind: "offer"; key: string; image: string | null; product: LinkProduct | null; title: string; brief: string };

interface PostedRow { source_kind: string; source_ref_id: string | null; product_id: string | null; published_at: string | null; media_bucket: string | null; media_path: string | null; media_url: string | null }

const SIGN_TTL = 60 * 60; // 1h; the page revalidates well within this
const IMG_TRANSFORM = { width: 800, quality: 62 } as const; // feed thumbnails

/** Downscale a public Supabase storage URL via the image transform endpoint. */
function thumbPublic(admin: ReturnType<typeof createAdminClient>, url: string): string {
  const m = url.match(/\/object\/public\/([^/]+)\/([^?]+)/);
  if (!m) return url;
  return admin.storage.from(m[1]).getPublicUrl(decodeURIComponent(m[2]), { transform: IMG_TRANSFORM }).data.publicUrl;
}

/** Downscale any image URL: Supabase via transform, Shopify CDN via its width param. */
function thumbAny(admin: ReturnType<typeof createAdminClient>, url: string): string {
  if (/\/object\/public\//.test(url)) return thumbPublic(admin, url);
  if (/cdn\.shopify\.com/.test(url)) return `${url}${url.includes("?") ? "&" : "?"}width=${IMG_TRANSFORM.width}`;
  return url;
}

export async function listLinkInBioEntries(workspaceId: string, max = 12): Promise<LinkEntry[]> {
  const admin = createAdminClient();
  const { data: posted } = await admin
    .from("scheduled_social_posts")
    .select("source_kind, source_ref_id, product_id, published_at, media_bucket, media_path, media_url")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .order("published_at", { ascending: false })
    .limit(80);
  const rows = (posted || []) as PostedRow[];

  // ── Batch-resolve content behind each post ──
  const adIds = uniq(rows.filter((r) => r.source_kind === "testimonial").map((r) => r.source_ref_id));
  const postIds = uniq(rows.filter((r) => r.source_kind === "resource").map((r) => r.source_ref_id));
  const campaignIds = uniq(rows.filter((r) => r.source_kind === "promo").map((r) => r.source_ref_id));

  const [adRows, postRows, campRows] = await Promise.all([
    adIds.length ? admin.from("ad_videos").select("id, meta").in("id", adIds) : empty(),
    postIds.length ? admin.from("posts").select("id, title, handle").in("id", postIds) : empty(),
    campaignIds.length ? admin.from("social_campaigns").select("id, name, brief, emphasis_product_id").in("id", campaignIds) : empty(),
  ]);
  const adById = new Map((adRows.data || []).map((a) => [a.id, a.meta as { review_id?: string } | null]));
  const postById = new Map((postRows.data || []).map((p) => [p.id, p]));
  const campById = new Map((campRows.data || []).map((c) => [c.id, c]));

  const postProductId = new Map<string, string>();
  if (postIds.length) {
    const { data: links } = await admin.from("post_products").select("post_id, product_id").in("post_id", postIds);
    for (const l of links || []) if (!postProductId.has(l.post_id)) postProductId.set(l.post_id, l.product_id);
  }
  const reviewIds = uniq(Array.from(adById.values()).map((m) => m?.review_id || null));
  const reviewById = new Map<string, { reviewer_name: string | null; rating: number | null; smart_quote: string | null; body: string | null; product_id: string }>();
  if (reviewIds.length) {
    const { data: revs } = await admin.from("product_reviews").select("id, reviewer_name, rating, smart_quote, body, product_id").in("id", reviewIds);
    for (const r of revs || []) reviewById.set(r.id, r);
  }
  const productIds = uniq([
    ...rows.filter((r) => r.source_kind === "avatar" || r.source_kind === "ad_video").map((r) => r.product_id),
    ...Array.from(reviewById.values()).map((r) => r.product_id),
    ...Array.from(postProductId.values()),
    ...Array.from(campById.values()).map((c) => c.emphasis_product_id),
  ]);
  const productById = new Map<string, LinkProduct>();
  const productImg = new Map<string, string>(); // a still product image (reels have no still)
  if (productIds.length) {
    const [{ data: prods }, { data: vars }] = await Promise.all([
      admin.from("products").select("id, handle, title, image_url").in("id", productIds),
      admin.from("product_variants").select("product_id, isolated_image_url, image_url").in("product_id", productIds).order("position"),
    ]);
    for (const p of prods || []) {
      if (p.handle) productById.set(p.id, { handle: p.handle, title: p.title });
      if (p.image_url) productImg.set(p.id, p.image_url as string);
    }
    for (const v of vars || []) {
      const img = (v.isolated_image_url as string | null) || (v.image_url as string | null);
      if (img) productImg.set(v.product_id, img); // prefer the variant shot
    }
  }
  const prod = (id: string | null | undefined) => (id ? productById.get(id) || null : null);

  // The exact image the post used, downscaled for the feed (Supabase image
  // transform — the cards are full-res 1080px JPEGs, far too heavy otherwise).
  const imageFor = async (r: PostedRow): Promise<string | null> => {
    if (r.media_bucket && r.media_path) {
      const { data } = await admin.storage.from(r.media_bucket).createSignedUrl(r.media_path, SIGN_TTL, { transform: IMG_TRANSFORM });
      return data?.signedUrl || null;
    }
    if (r.media_url) return thumbPublic(admin, r.media_url);
    return null;
  };

  // ── Build deduped, newest-first entries ──
  const entries: LinkEntry[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (entries.length >= max) break;
    let e: LinkEntry | null = null;
    if (r.source_kind === "testimonial" && r.source_ref_id) {
      const reviewId = adById.get(r.source_ref_id)?.review_id;
      const rev = reviewId ? reviewById.get(reviewId) : null;
      if (rev) e = { kind: "review", key: `review:${reviewId}`, image: null, reviewerName: rev.reviewer_name?.trim() || "Verified Customer", rating: Math.round(rev.rating ?? 5), headline: (rev.smart_quote || rev.body || "").trim(), body: (rev.body || "").trim(), product: prod(rev.product_id) };
    } else if (r.source_kind === "resource" && r.source_ref_id) {
      const p = postById.get(r.source_ref_id);
      if (p?.handle) e = { kind: "post", key: `post:${p.handle}`, image: null, title: p.title, handle: p.handle, product: prod(postProductId.get(p.id)) };
    } else if (r.source_kind === "promo" && r.source_ref_id) {
      const c = campById.get(r.source_ref_id);
      if (c) e = { kind: "offer", key: `offer:${c.id}`, image: null, title: c.name || "Special offer", brief: c.brief || "", product: prod(c.emphasis_product_id) };
    } else if ((r.source_kind === "avatar" || r.source_kind === "ad_video") && r.product_id) {
      const p = prod(r.product_id);
      if (p) e = { kind: "shop", key: `shop:${p.handle}`, image: null, product: p };
    }
    if (!e || seen.has(e.key)) continue;
    seen.add(e.key);
    // Reels post a video (no still) — use the product image; everything else
    // posts the actual image we put out.
    if (e.kind === "shop" && r.source_kind === "ad_video" && r.product_id) {
      const pi = productImg.get(r.product_id);
      e.image = pi ? thumbAny(admin, pi) : null;
    } else {
      e.image = await imageFor(r);
    }
    entries.push(e);
  }

  // Fallback so the page is never empty: recent published posts.
  if (entries.length < 3) {
    const { data: recent } = await admin
      .from("posts").select("title, handle, featured_image_url")
      .eq("workspace_id", workspaceId).eq("published", true).not("handle", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false }).limit(6);
    for (const p of recent || []) {
      if (entries.length >= max) break;
      const key = `post:${p.handle}`;
      if (!p.handle || seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind: "post", key, title: p.title, handle: p.handle, product: null, image: p.featured_image_url ? thumbPublic(admin, p.featured_image_url) : null });
    }
  }

  return entries;
}

function uniq(arr: Array<string | null | undefined>): string[] {
  return Array.from(new Set(arr.filter((x): x is string => !!x)));
}
async function empty() { return { data: [] as Array<Record<string, unknown>> }; }
