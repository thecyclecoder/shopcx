/**
 * Push our review aggregates into Shopify's standard product rating metafields
 * — `reviews.rating` + `reviews.rating_count` — so the Shopify storefront keeps
 * its stars after the Klaviyo Reviews app goes away.
 *
 * **Why this exists.** Those two metafields are not a widget we can swap out.
 * They are read all over the live theme:
 *
 *   - `snippets/product-rating.liquid` + `product-rating-special.liquid` — PDP stars
 *   - `snippets/card-product.liquid` + `card-product-recommended.liquid` — collection + recommendation cards
 *   - `snippets/product-schema.liquid` — the Google rich-snippet `aggregateRating`
 *
 * The Klaviyo Reviews app was writing them. When that app is uninstalled its
 * metafield VALUES go with it, and every star on the store plus the search
 * result stars disappear. The definitions themselves are shop-owned with
 * `admin: PUBLIC_READ_WRITE` access, so our own Shopify token can write them —
 * verified against the live store. Run this BEFORE uninstalling the app, and
 * confirm the values hold.
 *
 * **Keyed by Shopify product id, deliberately.** 1,027 reviews carry a
 * `shopify_product_id` for a Shopify product that never landed in our
 * `products` table — 246 of them are ACV Gummies, whose live PDP shows 214
 * reviews. Aggregating by our internal `product_id` alone would push ACV to
 * zero. So the aggregate is built over the union of both match paths, exactly
 * like the theme-facing feed in
 * `src/app/api/storefront/[workspace]/product-reviews/route.ts` — the two MUST
 * agree or a PDP contradicts its own product card.
 *
 * **Scope: every published/featured review carrying a rating — text or not.**
 * A rating-only review still counts toward "4.8 from 3,180 reviews", which is
 * how Klaviyo counted and what the live metafields reflect. Requiring a body
 * here would have cut Superfood Tabs from 3,180 to 2,879 and Amazing Creamer by
 * 16% — a visible social-proof and rich-snippet downgrade, self-inflicted. The
 * widget LIST still requires a body (you cannot render a textless review); the
 * COUNT does not. `product-reviews/route.ts` splits the same two ways so the
 * PDP header and the product card never disagree.
 *
 * Idempotent — recomputes from `product_reviews` every run and writes the
 * current value. Safe to re-run; safe to run while the Klaviyo app is still
 * installed (last writer wins, and we write the same numbers).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { errText } from "@/lib/error-text";

const SHOWN_STATUSES = ["published", "featured"];

/**
 * Duplicate Shopify products whose reviews belong to a canonical product.
 *
 * The "(Free Gift)" listings are separate Shopify products for the same
 * physical item — a customer reviewing the free Bamboo Coffee Mug is reviewing
 * the Bamboo Coffee Mug. Their reviews are stranded on the duplicate id (which
 * is not in our `products` table), so without this fold the Tumbler PDP would
 * drop from 15 reviews to 6.
 *
 * Deliberately explicit rather than fuzzy title matching — a wrong fold puts
 * one product's reviews on another product's page.
 */
export const SHOPIFY_PRODUCT_ALIASES: Record<string, string> = {
  "7902173069485": "7497755820205", // Bamboo Coffee Mug (Free Gift)   → Bamboo Coffee Mug
  "7902148624557": "7497753755821", // Handheld Mixer (Free Gift)      → Handheld Drink Mixer
  "7902086725805": "7497753460909", // Superfoods Tumbler (Free Gift)  → Superfoods Tumbler
};

/** Fold a duplicate Shopify product id onto its canonical one. */
export function canonicalShopifyId(id: string): string {
  return SHOPIFY_PRODUCT_ALIASES[id] || id;
}

/**
 * Every Shopify product id whose reviews belong on `id`'s page — `id` itself
 * plus any duplicate that folds into it. The theme-facing feed uses this so a
 * PDP header shows the same number this sync writes to the product card.
 */
export function shopifyIdsFoldingInto(id: string): string[] {
  const canonical = canonicalShopifyId(id);
  const dupes = Object.entries(SHOPIFY_PRODUCT_ALIASES)
    .filter(([, target]) => target === canonical)
    .map(([dupe]) => dupe);
  return Array.from(new Set([id, canonical, ...dupes]));
}

export type ReviewAggregate = {
  shopifyProductId: string;
  rating: number;
  count: number;
};

export type SyncResult = {
  workspace_id: string;
  products: number;
  written: number;
  skipped: number;
  errors: string[];
};

type ShopifyCreds = { shop: string; token: string };

async function getShopifyCreds(workspaceId: string): Promise<ShopifyCreds | null> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain, shopify_access_token_encrypted")
    .eq("id", workspaceId)
    .single();
  if (!ws?.shopify_myshopify_domain || !ws?.shopify_access_token_encrypted) return null;
  return { shop: ws.shopify_myshopify_domain, token: decrypt(ws.shopify_access_token_encrypted) };
}

/**
 * Build the per-Shopify-product aggregate from `product_reviews`.
 *
 * Paginates explicitly: PostgREST caps a select at 1000 rows, and Superfood
 * Tabs alone has 3,158 shown reviews — a single unpaginated read would compute
 * a confidently wrong average over the first page only.
 */
export async function buildReviewAggregates(workspaceId: string): Promise<ReviewAggregate[]> {
  const admin = createAdminClient();

  // shopify_product_id per internal product, so reviews linked only by
  // `product_id` land on the right Shopify product.
  const { data: products } = await admin
    .from("products")
    .select("id, shopify_product_id")
    .eq("workspace_id", workspaceId)
    .not("shopify_product_id", "is", null);
  const shopifyIdByProductId = new Map<string, string>(
    (products || []).map((p) => [p.id as string, String(p.shopify_product_id)]),
  );

  const totals = new Map<string, { sum: number; n: number }>();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error } = await admin
      .from("product_reviews")
      .select("rating, product_id, shopify_product_id")
      .eq("workspace_id", workspaceId)
      .in("status", SHOWN_STATUSES)
      .not("rating", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`read product_reviews failed: ${error.message}`);
    if (!page || page.length === 0) break;

    for (const row of page) {
      // Prefer the internal link (it survives Shopify product churn); fall back
      // to the raw Shopify id the review row carries.
      const raw =
        (row.product_id ? shopifyIdByProductId.get(row.product_id as string) : null) ||
        (row.shopify_product_id && row.shopify_product_id !== "unknown"
          ? String(row.shopify_product_id)
          : null);
      if (!raw) continue;
      const target = canonicalShopifyId(raw);
      const cur = totals.get(target) || { sum: 0, n: 0 };
      cur.sum += row.rating as number;
      cur.n += 1;
      totals.set(target, cur);
    }

    if (page.length < PAGE) break;
  }

  return [...totals.entries()]
    .map(([shopifyProductId, { sum, n }]) => ({
      shopifyProductId,
      rating: Math.round((sum / n) * 100) / 100,
      count: n,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Write one batch of aggregates via `metafieldsSet`. Shopify caps the mutation
 * at 25 metafields per call; each product needs 2, so batches are 12 products.
 */
async function writeBatch(
  creds: ShopifyCreds,
  batch: ReviewAggregate[],
): Promise<{ written: number; errors: string[] }> {
  const metafields = batch.flatMap((a) => [
    {
      ownerId: `gid://shopify/Product/${a.shopifyProductId}`,
      namespace: "reviews",
      key: "rating",
      type: "rating",
      // Shopify's `rating` type wants the scale echoed back with the value.
      value: JSON.stringify({ value: a.rating.toFixed(2), scale_min: "1.0", scale_max: "5.0" }),
    },
    {
      ownerId: `gid://shopify/Product/${a.shopifyProductId}`,
      namespace: "reviews",
      key: "rating_count",
      type: "number_integer",
      value: String(a.count),
    },
  ]);

  const res = await fetch(`https://${creds.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": creds.token, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `mutation SetReviewMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key }
          userErrors { field message }
        }
      }`,
      variables: { metafields },
    }),
  });

  if (!res.ok) {
    return { written: 0, errors: [`shopify ${res.status}: ${(await res.text()).slice(0, 200)}`] };
  }

  const json = (await res.json()) as {
    data?: { metafieldsSet?: { metafields?: unknown[]; userErrors?: { message: string }[] } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) return { written: 0, errors: json.errors.map((e) => e.message) };

  const userErrors = json.data?.metafieldsSet?.userErrors || [];
  return {
    written: json.data?.metafieldsSet?.metafields?.length || 0,
    errors: userErrors.map((e) => e.message),
  };
}

/**
 * Recompute every product's rating aggregate and write it to Shopify.
 * Returns a per-run summary; never throws on a partial failure — a single bad
 * product must not stop the other 15 from keeping their stars.
 */
export async function syncReviewMetafields(workspaceId: string): Promise<SyncResult> {
  const result: SyncResult = { workspace_id: workspaceId, products: 0, written: 0, skipped: 0, errors: [] };

  const creds = await getShopifyCreds(workspaceId);
  if (!creds) {
    result.errors.push("Shopify not configured for this workspace");
    return result;
  }

  let aggregates: ReviewAggregate[];
  try {
    aggregates = await buildReviewAggregates(workspaceId);
  } catch (err) {
    result.errors.push(errText(err));
    return result;
  }
  result.products = aggregates.length;

  // 25-metafield cap ÷ 2 per product.
  const BATCH = 12;
  for (let i = 0; i < aggregates.length; i += BATCH) {
    const batch = aggregates.slice(i, i + BATCH);
    try {
      const { written, errors } = await writeBatch(creds, batch);
      result.written += written;
      result.errors.push(...errors);
      if (errors.length) result.skipped += batch.length;
    } catch (err) {
      result.skipped += batch.length;
      result.errors.push(errText(err));
    }
  }

  return result;
}
