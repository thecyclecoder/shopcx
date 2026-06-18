# post_products

Join table: a [[posts]] resource → the [[products]] it's a resource for. Many-to-many — a recipe using Creamer + Coffee shows under both. **Grouping lives on the post** (a recipe is a recipe across products); this table is only the product link. Read by the portal Resources owned-product nav ([[../lifecycles/storefront-blog]]).

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `workspace_id` | uuid | → [[workspaces]] |
| `post_id` | uuid | → [[posts]] (ON DELETE CASCADE) |
| `product_id` | uuid | → [[products]] (ON DELETE CASCADE) |
| `created_at` | timestamptz | |

**Constraints / indexes:** `UNIQUE (post_id, product_id)` · `(workspace_id, product_id)`.

## Foreign keys

- **Out:** `workspace_id` → [[workspaces]], `post_id` → [[posts]], `product_id` → [[products]].

## Gotchas

- **Replaced, not merged, on re-import** — `importBlogArticle` deletes all rows for a `post_id` and re-inserts from the fresh classification ([[../libraries/posts-import-article]]). Don't store anything here you can't regenerate.
- Always join on the UUID `product_id` — never a `shopify_*_id`.

## Related

[[posts]] · [[products]] · [[../lifecycles/storefront-blog]] · [[../libraries/posts-import-article]] · [[../README]]
