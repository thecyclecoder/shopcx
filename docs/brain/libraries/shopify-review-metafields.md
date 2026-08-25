# libraries/shopify-review-metafields

Push our review aggregates into Shopify's standard product rating metafields, so the Shopify storefront keeps its stars after the Klaviyo Reviews app goes away.

**File:** `src/lib/shopify-review-metafields.ts`
**Cron:** [[../inngest/shopify-review-metafields-sync]] — daily 09:00 UTC

## Why this exists

`reviews.rating` + `reviews.rating_count` are **not a widget we can swap out**. They're Shopify product metafields read all over the live theme:

| Reader | What breaks without them |
|---|---|
| `snippets/product-rating.liquid` · `product-rating-special.liquid` | PDP star ratings |
| `snippets/card-product.liquid` · `card-product-recommended.liquid` | Collection + recommendation card stars |
| `snippets/product-schema.liquid` | The Google rich-snippet `aggregateRating` — **search-result stars** |

The Klaviyo Reviews app wrote them; its values disappear when the app is uninstalled. The definitions are shop-owned with `admin: PUBLIC_READ_WRITE` (verified against the live store), so our own Shopify token can write them.

⚠️ **Run this BEFORE uninstalling the Klaviyo app, and confirm the values hold.**

## Exports

- `syncReviewMetafields(workspaceId)` → `SyncResult` — recompute + write. Never throws on partial failure; one bad product must not cost the other 17 their stars.
- `buildReviewAggregates(workspaceId)` → `ReviewAggregate[]` — the pure aggregation, safe to dry-run.
- `canonicalShopifyId(id)` · `shopifyIdsFoldingInto(id)` · `SHOPIFY_PRODUCT_ALIASES` — the duplicate-product fold.

## The +10,000 off-platform bump

`workspaces.storefront_off_platform_review_count` (10,000 for Superfoods) covers **four years of Yotpo reviews lost when that system was retired** — real reviews from real customers whose rows we no longer hold. It is folded into the count this sync writes.

It was previously hardcoded in the Shopify theme as `plus: 10107` (rating snippets) and `plus: 10114` (product schema), and applied nowhere else — so the Shopify store, the in-house storefront ([[../../../src/app/(storefront)/_lib/page-data.ts]] `reviewsBump`), and the portal ([[portal__handlers__bootstrap]] `reviewBump`) each carried their own idea of the number. Applying it here and **removing those literals** (done in the same theme commit) leaves one source of truth. Re-adding a `plus:` filter anywhere in the theme double-counts it.

- **The RATING is never bumped** — you cannot average in reviews whose scores are gone. Only the count.
- `buildReviewAggregates` stays honest and returns the TRUE count; only `syncReviewMetafields` adds the bump, because only the published value is a display number.
- It applies to every product, matching what the in-house storefront does. Note that add-on products (Shipping Protection, Mystery Item) therefore read ~10,000 too.

## Three things it gets right

1. **Counts rating-only reviews.** A 5★ with no text still counts toward "4.8 from 3,158 reviews" — that's how Klaviyo counted. Requiring a body would have cut Superfood Tabs 3,180 → 2,879 and Amazing Creamer by 16%: a self-inflicted social-proof and rich-snippet downgrade. The widget **list** requires a body (you can't render a textless review); the **count** doesn't.
2. **Keyed by Shopify product id, not our `product_id`.** 1,027 reviews carry a `shopify_product_id` for a Shopify product that never landed in our `products` table — 246 are ACV Gummies, whose live PDP shows 214 reviews. Aggregating on the internal id alone would push ACV to zero.
3. **Folds duplicate Shopify products.** The "(Free Gift)" listings are separate Shopify products for the same physical item. Without the fold the Tumbler PDP drops 15 → 6. `SHOPIFY_PRODUCT_ALIASES` is deliberately explicit — a fuzzy title match would put one product's reviews on another's page.

## Verified parity

Dry-run against the live store, our aggregate vs Klaviyo's values:

| Product | Klaviyo (live) | Ours |
|---|---|---|
| Superfood Tabs | 4.75 / 3180 | 4.75 / 3158 |
| Amazing Coffee | 4.74 / 1901 | 4.74 / 1879 |
| Creatine Prime+ | 4.8 / 1353 | 4.80 / 1353 |
| Amazing Coffee K-Cups | 4.78 / 1126 | 4.78 / 1118 |
| Amazing Creamer | 4.84 / 731 | 4.84 / 720 |
| ACV Gummies | 4.84 / 214 | 4.84 / 214 |
| Ashwavana Zen Relax | 4.78 / 80 | 4.78 / 80 |
| Sleep Gummies | 4.83 / 42 | 4.83 / 42 |

(Counts shown pre-bump. The published metafield adds the +10,000 off-platform bump on top — Creatine Prime+ publishes as 11,353.)

Ratings match to 2dp on every product. Counts run a hair under because a few Klaviyo rows never synced. Accessories run **higher** (Mug 3 → 116, Mixer 28 → 83, Tumbler 15 → 73) because Klaviyo split them across the free-gift duplicates and we fold them back.

## Gotchas

- `metafieldsSet` caps at **25 metafields per call**; each product needs 2, so batches are 12 products.
- The `rating` metafield type wants the scale echoed back: `{"value":"4.75","scale_min":"1.0","scale_max":"5.0"}`. Liquid then exposes `.value.rating`, `.value.scale_max`.
- Idempotent and safe to run while the Klaviyo app is still installed — last writer wins and we write the same numbers.
- The theme-facing feed (`src/app/api/storefront/[workspace]/product-reviews/route.ts`) applies the **same** scope + fold. If you change one, change both, or a PDP header will contradict its own product card.

## Related

[[../integrations/klaviyo]] · [[klaviyo-retired]] · [[../tables/product_reviews]] · [[../inngest/shopify-review-metafields-sync]] · [[../integrations/shopify]]

---

[[../README]] · [[../../CLAUDE]]
