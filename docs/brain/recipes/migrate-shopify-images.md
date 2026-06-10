# Recipe: migrate Shopify-hosted images to our storage

Shopify is being sunset, so any image still served from `cdn.shopify.com` /
`*.myshopify.com` will break. This migrates product/variant/gift images onto our
own Supabase `product-media` bucket and rewrites the DB references.

## Library

[`src/lib/product-image-migrate.ts`](../../../src/lib/product-image-migrate.ts):

- `isShopifyImage(url)` — true for `cdn.shopify.com` / `*.myshopify.com` URLs.
- `migrateShopifyImage(workspaceId, srcUrl)` — download → upload to
  `product-media/workspaces/{ws}/products/migrated/{sha1}.{ext}` → return the
  absolute Supabase public URL. Idempotent (deterministic hash path, upsert).
  Returns null for non-Shopify URLs or on fetch/upload failure.
- `migrateImagesInJson(ws, value, cache?)` — deep-rewrite every Shopify URL
  inside an arbitrary JSON value (e.g. the denormalized `products.variants`).

Stored URLs are the absolute Supabase public URL; the storefront's `cdnUrl()`
([[../lifecycles/storefront-checkout]] · `_lib/image-urls.ts`) proxies them
through `/storefront-img` for edge caching, so they work in pages, JSON-LD, and
emails without further rewriting.

## Run the full pass

```
npx tsx scripts/migrate-shopify-images.ts           # dry run — counts only
npx tsx scripts/migrate-shopify-images.ts --commit  # migrate + verify 0 remain
```

Covers `products.image_url`, `products.variants` (jsonb), `product_variants.image_url`,
`product_variants.isolated_image_url`, `pricing_rules.free_gift_image_url`. A
shared cache migrates an identical image once; re-running is safe. The commit
run prints a per-column count of any remaining Shopify URLs (should be 0).

First run (2026-06): 31 unique images across 32 rows migrated, 0 failures, 0
remaining. See [[../tables/products]] · [[../tables/product_variants]].

## Gotcha

New products synced **from** Shopify re-introduce Shopify URLs. Once Shopify
sync is fully retired this is one-and-done; until then, re-run after a sync (or
call `migrateShopifyImage` from the sync path).

---

[[../README]] · [[../tables/products]] · [[../tables/product_variants]] · [[../tables/coupons]]
