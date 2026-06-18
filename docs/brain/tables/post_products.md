# post_products

Join table: a [[posts|post]] → many [[products]]. A recipe that uses Amazing Creamer + Amazing Coffee shows under **both** products in the portal Resources nav. See [[../lifecycles/blog-resources]].

## Summary

Many-to-many link between blog posts and products, written at import time by the AI classifier ([[../libraries/posts__import-article]] `classifyArticle`). The posts are untagged in Shopify, so product membership is **inferred** from title + content against the product catalog.

## Columns

| Column | Type | Notes |
|---|---|---|
| `post_id` | uuid | FK → [[posts]] |
| `product_id` | uuid | FK → [[products]] |
| `workspace_id` | uuid | FK → [[workspaces]] |

UNIQUE `(post_id, product_id)`.

## Foreign keys

- **out:** `post_id` → [[posts]], `product_id` → [[products]], `workspace_id` → [[workspaces]]

## Gotchas

- **Grouping is NOT here** — it lives on [[posts]].`grouping` (a recipe is a recipe regardless of which product it links). The UI nests product → grouping → posts.
- **Replace, don't append** — the import upserts the post then replaces its `post_products` rows, so a re-classified post doesn't accumulate stale links.
- A blog-only post (`is_resource:false`) has **zero** `post_products` rows.

## Related

[[posts]] · [[products]] · [[../lifecycles/blog-resources]] · [[../libraries/posts__import-article]]
