# posts/migrate-images

`src/lib/posts/migrate-images.ts` — moves a blog post's images off Shopify's CDN onto our Supabase storage and rewrites the HTML so **no Shopify-hosted image survives**. Called by [[posts-import-article]] during import ([[../lifecycles/storefront-blog]]).

## Exports

| Symbol | Signature | What |
|---|---|---|
| `migratePostImages` | `(workspaceId, handle, contentHtml, featuredUrl) → Promise<MigratedImages>` | Collects every `<img src>` in the body + the featured image, migrates each once, rewrites the HTML, returns `{ html, featuredImageUrl, migratedCount }`. |

## Behavior notes

- **Shopify-only** — only URLs matching `cdn.shopify.com` / `*.myshopify.com` are migrated; anything already on our domain is left untouched (and a featured URL already on our storage passes through).
- **Bucket + path** — uploads to `product-media` at `workspaces/{ws}/posts/{handle}/{sha1(srcUrl).slice(0,16)}.{ext}` with `upsert: true`. The deterministic, source-URL-derived name means **re-runs overwrite the same object** (no duplicates).
- **Fail-soft** — a fetch/upload failure on one image returns null for that src; the original URL stays in the HTML rather than throwing, and `migratedCount` only counts successes.
- Rewrites by string-replacing every occurrence of each migrated src (handles the same image referenced multiple times).

## Gotchas

- Runs **before** the `posts` upsert, so the persisted `content_html` is always our-storage-only.
- Content-type is inferred from the URL extension (defaults to `image/jpeg`); query strings are stripped when detecting the extension.

## Related

[[posts-import-article]] · [[../tables/posts]] · [[../lifecycles/storefront-blog]] · [[../integrations/shopify]]
