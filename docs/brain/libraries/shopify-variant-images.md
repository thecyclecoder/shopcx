# libraries/shopify-variant-images

Pushes our own variant imagery onto Shopify, so the storefront's variant swatches
are consistent.

**File:** `src/lib/shopify-variant-images.ts`
**Script:** `scripts/_sync-variant-images-to-shopify.ts`

## Why

[[../tables/product_variants]] carries two image columns, and they mean different
things:

| Column | Meaning |
|---|---|
| `image_url` | Whatever Shopify currently shows, synced back by [[shopify-sync]] |
| `isolated_image_url` | Our own cut-out product shot on the Supabase `product-media` bucket — one consistent, context-free photo per variant |

`image_url` accumulated over years: lifestyle shots on some variants, packshots on
others, nothing on a few. `isolated_image_url` is uniform by construction (it was
built as Higgsfield reference imagery for the ad tool). This module makes Shopify
match us, so the flavour swatches on a PDP read as one set.

## Exports

### `planVariantImageSync(workspaceId)` — READ-ONLY

```ts
async function planVariantImageSync(workspaceId: string): Promise<VariantImagePlan>
```

Returns `{ rows, skippedNoShopifyId, skippedNoIsolated }`. Each row pairs the
variant's current Shopify image with the isolated shot that would replace it.
Safe anywhere; this is what the script prints in dry-run.

### `applyVariantImageSync(workspaceId, plan)` — MUTATES SHOPIFY

```ts
async function applyVariantImageSync(workspaceId: string, plan: VariantImagePlan): Promise<SyncOutcome[]>
```

Returns one outcome per row (`updated` · `reused-media` · `failed`). A failure on
one variant is recorded and the walk continues, so a single bad image cannot
strand the rest.

### `isolatedAltMarker(sourceUrl)`

The deterministic `alt` written onto every media we create —
`shopcx-isolated:<sha1(url) first 16>`. Also the way to VERIFY a sync landed: read
`productVariant.image.altText` back off Shopify and compare.

## Gotchas

### It is three calls, not a field update

Shopify will not accept an arbitrary external URL as a variant image:

1. **`productCreateMedia`** — hand Shopify the URL, it fetches and hosts it.
2. **Poll `node(id).status`** — media processing is **async**. Fresh media sits at
   `PROCESSING`, and attaching it then fails. `waitForMediaReady` polls to `READY`
   and throws on `FAILED` rather than silently attaching nothing.
3. **`productVariantsBulkUpdate`** with `{ id, mediaId }` — attach to the variant.

On API `2025-07` the old REST shortcut (`POST /products/{id}/images.json` with
`variant_ids`, which did all three at once) is gone.

### The SHOPIFY_SCOPES constant is stale — do not trust it

[[shopify]] `SHOPIFY_SCOPES` lists `read_products` and no `write_products`, which
suggests this module cannot work. The live token **does** hold `write_products`
(and `write_themes`, `write_returns`, `write_pixels`, and more that the constant
omits). Verify against `/admin/oauth/access_scopes.json`, not the constant.

`write_files` is **not** required and we do not hold it — `productCreateMedia`
fetches the source URL server-side, so we never upload bytes ourselves.

### Idempotent by alt marker

Before creating media, the product's existing media is listed and matched on the
alt marker. A re-run after a partial failure costs lookups, not duplicate uploads,
and a product never accumulates copies of the same cut-out. Media listing is
cached per product, so N variants of one product cost one listing.

### Rollback

Each variant's pre-change Shopify image stays in `product_variants.image_url`
until the next [[shopify-sync]] run overwrites it with the new one. Undoing is
re-pointing variants at those URLs — so roll back *before* the next sync, or
recover the old URLs from a backup.

## Reviewing a sync before applying

Filenames are useless here (every isolated shot is named `isolated.png`), so the
script renders the pairs as images instead:

```bash
npx tsx scripts/_sync-variant-images-to-shopify.ts --html ~/Desktop/sync.html   # review
npx tsx scripts/_sync-variant-images-to-shopify.ts --apply                      # write
```

## History

**2026-09-25 — first run.** 13 variants across 7 products (Peach Mango, Mixed
Berry, Strawberry Lemonade, Strawberry, Salted Caramel, Vanilla, Cinnamon Roll,
Black Cherry, Pina Colada, Cocoa French Roast, Hazelnut French Roast, Cocoa,
Orange Passion Fruit). 13 succeeded, 0 failed, and all 13 were verified by reading
`productVariant.image.altText` back off Shopify. 10 further variants have no
isolated shot and were left untouched.

## Related

[[product-variants]] · [[shopify-sync]] · [[shopify]] · [[../tables/product_variants]] ·
[[../integrations/shopify]]
