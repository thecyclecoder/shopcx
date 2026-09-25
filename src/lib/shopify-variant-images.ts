/**
 * Push our own variant imagery onto Shopify.
 *
 * `product_variants.isolated_image_url` is the ad-tool cut-out shot: one
 * consistent, context-free product photo per variant, stored on our Supabase
 * `product-media` bucket. Shopify's own per-variant image (`image_url`, synced
 * back from the store) is whatever was uploaded over the years — lifestyle
 * shots, packshots, sometimes nothing — so variant swatches look inconsistent
 * on the storefront. This module makes Shopify match us.
 *
 * ## Why it is three calls, not a field update
 *
 * Shopify will not accept an arbitrary external URL as a variant image. The
 * image has to become PRODUCT MEDIA that Shopify hosts, and only then can it be
 * attached to a variant:
 *
 *   1. `productCreateMedia`  — hand Shopify the URL; it fetches and hosts it.
 *   2. poll `product.media`  — media processing is ASYNC. A freshly created
 *                              media sits at status PROCESSING and cannot be
 *                              attached yet; attaching too early fails.
 *   3. `productVariantsBulkUpdate` — attach the READY media id to the variant.
 *
 * On API 2025-07 the old REST shortcut (`POST /products/{id}/images.json` with
 * `variant_ids`, which did all three in one call) is gone, so this is the path.
 *
 * ## Idempotency
 *
 * Every media we create is tagged with a deterministic `alt`:
 *   `shopcx-isolated:<sha1(sourceUrl)>`
 * Before creating anything we read the product's existing media and reuse a
 * match. So a re-run after a partial failure costs lookups, not duplicate
 * uploads, and never leaves a product accumulating copies of the same cut-out.
 *
 * ## Scopes
 *
 * Needs `write_products` only — `productCreateMedia` fetches the URL server-side,
 * so `write_files` is NOT required (we do not hold that scope). Note that the
 * `SHOPIFY_SCOPES` constant in [[shopify]] is stale relative to what the live
 * token was actually granted; verify against `/admin/oauth/access_scopes.json`
 * rather than trusting the constant.
 *
 * Reversible: each variant's pre-change Shopify image stays in
 * `product_variants.image_url` until the next sync overwrites it, so a rollback
 * is re-pointing variants at those URLs.
 */
import { createHash } from "crypto";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";

/** Marker written into each created media's `alt`, so re-runs can find it again. */
export function isolatedAltMarker(sourceUrl: string): string {
  return `shopcx-isolated:${createHash("sha1").update(sourceUrl).digest("hex").slice(0, 16)}`;
}

export interface VariantImagePlanRow {
  variantId: string;
  shopifyVariantId: string;
  productId: string;
  shopifyProductId: string;
  title: string;
  sku: string | null;
  /** What Shopify shows today (may be null — plenty of variants have no image). */
  currentImageUrl: string | null;
  /** What we want it to show. */
  isolatedImageUrl: string;
}

export interface VariantImagePlan {
  rows: VariantImagePlanRow[];
  /** Variants that have an isolated shot but no Shopify id — nothing to push to. */
  skippedNoShopifyId: number;
  /** Variants with no isolated shot — left alone. */
  skippedNoIsolated: number;
}

/**
 * READ-ONLY. Work out which variants would change and how. Safe to run anywhere;
 * this is what the script prints in dry-run.
 */
export async function planVariantImageSync(workspaceId: string): Promise<VariantImagePlan> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("product_variants")
    .select("id, product_id, shopify_variant_id, sku, title, image_url, isolated_image_url")
    .eq("workspace_id", workspaceId)
    .order("product_id", { ascending: true });
  if (error) throw new Error(`variant read failed: ${errText(error)}`);

  const variants = data || [];
  const productIds = [...new Set(variants.map((v) => v.product_id as string))];
  const { data: products } = await admin
    .from("products")
    .select("id, shopify_product_id, title")
    .in("id", productIds);
  const shopifyProductById = new Map(
    (products || []).map((p) => [p.id as string, p.shopify_product_id as string | null]),
  );

  const rows: VariantImagePlanRow[] = [];
  let skippedNoShopifyId = 0;
  let skippedNoIsolated = 0;

  for (const v of variants) {
    const isolated = v.isolated_image_url as string | null;
    if (!isolated) {
      skippedNoIsolated++;
      continue;
    }
    const shopifyVariantId = v.shopify_variant_id as string | null;
    const shopifyProductId = shopifyProductById.get(v.product_id as string) || null;
    if (!shopifyVariantId || !shopifyProductId) {
      skippedNoShopifyId++;
      continue;
    }
    rows.push({
      variantId: v.id as string,
      shopifyVariantId,
      productId: v.product_id as string,
      shopifyProductId,
      title: (v.title as string) || (v.sku as string) || "(untitled)",
      sku: (v.sku as string) || null,
      currentImageUrl: (v.image_url as string) || null,
      isolatedImageUrl: isolated,
    });
  }

  return { rows, skippedNoShopifyId, skippedNoIsolated };
}

// ── Shopify plumbing ────────────────────────────────────────────────────────

async function gql<T = Record<string, unknown>>(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`Shopify GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data as T;
}

const gidProduct = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`);
const gidVariant = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`);

interface MediaNode {
  id: string;
  alt: string | null;
  status: string;
}

/** Existing media on a product, so we can reuse instead of re-uploading. */
async function listProductMedia(shop: string, token: string, shopifyProductId: string): Promise<MediaNode[]> {
  const data = await gql<{ product: { media: { nodes: MediaNode[] } } | null }>(
    shop,
    token,
    `query($id: ID!) { product(id: $id) { media(first: 250) { nodes { id alt ... on MediaImage { status } } } } }`,
    { id: gidProduct(shopifyProductId) },
  );
  return data.product?.media?.nodes || [];
}

async function createProductMedia(
  shop: string,
  token: string,
  shopifyProductId: string,
  sourceUrl: string,
  alt: string,
): Promise<string> {
  const data = await gql<{
    productCreateMedia: { media: { id: string }[]; mediaUserErrors: { message: string }[] };
  }>(
    shop,
    token,
    `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
       productCreateMedia(productId: $productId, media: $media) {
         media { ... on MediaImage { id } }
         mediaUserErrors { message }
       }
     }`,
    {
      productId: gidProduct(shopifyProductId),
      media: [{ originalSource: sourceUrl, alt, mediaContentType: "IMAGE" }],
    },
  );
  const errs = data.productCreateMedia?.mediaUserErrors || [];
  if (errs.length) throw new Error(`productCreateMedia: ${errs.map((e) => e.message).join("; ")}`);
  const id = data.productCreateMedia?.media?.[0]?.id;
  if (!id) throw new Error("productCreateMedia returned no media id");
  return id;
}

/**
 * Media is processed asynchronously. Attaching a PROCESSING media to a variant
 * fails, so wait for READY. Throws on FAILED rather than silently attaching
 * nothing.
 */
async function waitForMediaReady(
  shop: string,
  token: string,
  mediaId: string,
  { attempts = 20, delayMs = 1500 }: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const data = await gql<{ node: { status?: string } | null }>(
      shop,
      token,
      `query($id: ID!) { node(id: $id) { ... on MediaImage { status } } }`,
      { id: mediaId },
    );
    const status = data.node?.status;
    if (status === "READY") return;
    if (status === "FAILED") throw new Error(`media ${mediaId} failed to process`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`media ${mediaId} still not READY after ${attempts} polls`);
}

async function attachMediaToVariant(
  shop: string,
  token: string,
  shopifyProductId: string,
  shopifyVariantId: string,
  mediaId: string,
): Promise<void> {
  const data = await gql<{
    productVariantsBulkUpdate: { userErrors: { message: string }[] };
  }>(
    shop,
    token,
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         userErrors { message }
       }
     }`,
    {
      productId: gidProduct(shopifyProductId),
      variants: [{ id: gidVariant(shopifyVariantId), mediaId }],
    },
  );
  const errs = data.productVariantsBulkUpdate?.userErrors || [];
  if (errs.length) throw new Error(`productVariantsBulkUpdate: ${errs.map((e) => e.message).join("; ")}`);
}

export interface SyncOutcome {
  variantId: string;
  title: string;
  status: "updated" | "reused-media" | "failed";
  mediaId?: string;
  error?: string;
}

/**
 * MUTATES SHOPIFY. Walk the plan and make each variant's image the isolated shot.
 *
 * Sequential on purpose: this is a handful of variants, and Shopify's GraphQL
 * cost budget punishes bursts of media mutations. A failure on one variant is
 * recorded and the walk continues, so one bad image cannot strand the rest.
 */
export async function applyVariantImageSync(
  workspaceId: string,
  plan: VariantImagePlan,
): Promise<SyncOutcome[]> {
  // Throws "Shopify not connected for this workspace" if creds are absent.
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  // Cache per product so N variants of one product cost one media listing.
  const mediaCache = new Map<string, MediaNode[]>();
  const outcomes: SyncOutcome[] = [];

  for (const row of plan.rows) {
    try {
      const alt = isolatedAltMarker(row.isolatedImageUrl);
      if (!mediaCache.has(row.shopifyProductId)) {
        mediaCache.set(row.shopifyProductId, await listProductMedia(shop, accessToken, row.shopifyProductId));
      }
      const existing = mediaCache.get(row.shopifyProductId)!.find((m) => m.alt === alt);

      let mediaId: string;
      let reused = false;
      if (existing && existing.status === "READY") {
        mediaId = existing.id;
        reused = true;
      } else if (existing) {
        mediaId = existing.id;
        reused = true;
        await waitForMediaReady(shop, accessToken, mediaId);
      } else {
        mediaId = await createProductMedia(shop, accessToken, row.shopifyProductId, row.isolatedImageUrl, alt);
        await waitForMediaReady(shop, accessToken, mediaId);
        mediaCache.get(row.shopifyProductId)!.push({ id: mediaId, alt, status: "READY" });
      }

      await attachMediaToVariant(shop, accessToken, row.shopifyProductId, row.shopifyVariantId, mediaId);
      outcomes.push({ variantId: row.variantId, title: row.title, status: reused ? "reused-media" : "updated", mediaId });
    } catch (e) {
      outcomes.push({ variantId: row.variantId, title: row.title, status: "failed", error: errText(e) });
    }
  }

  return outcomes;
}
