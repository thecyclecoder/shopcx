# posts

Our own copy of blog/resource articles — the canonical, storefront-renderable blog object. Seeded by importing the Shopify "Superfood Scoop" ([[../lifecycles/storefront-blog]]) and also written by the AI post generator ([[../specs/auto-blog-generation]]). Some posts are flagged as **product resources** (`is_resource`) and grouped, which is what the portal Resources section + product→grouping nav read.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `workspace_id` | uuid | → [[workspaces]] |
| `shopify_article_id` | text | **NOT NULL**, import idempotency key. AI posts use the synthetic `ai:{handle}` convention to satisfy this. |
| `blog_handle` | text | source blog handle, e.g. `superfood-scoop` |
| `handle` | text | article slug — the `/blog/{handle}` URL segment |
| `title` | text | NOT NULL |
| `excerpt` | text | ≤240-char plain-text summary |
| `content_html` | text | body HTML; **image URLs rewritten to OUR storage** (no Shopify CDN) |
| `content_text` | text | stripped plain text — search + future embedding |
| `featured_image_url` | text | OUR storage (migrated off Shopify) |
| `seo_title`, `seo_description` | text | from Shopify `global.title_tag` / `description_tag` metafields |
| `tags` | text[] | NOT NULL default `{}` |
| `is_resource` | bool | NOT NULL default false — AI: product resource vs blog-only |
| `grouping` | text | fixed vocab `recipes\|how_it_works\|how_to_use\|science\|general`; **null when not a resource** |
| `published` | bool | NOT NULL default true (auto-publish — no review gate) |
| `published_at` | timestamptz | |
| `source` | text | NOT NULL default `shopify_blog`; AI posts use `ai_generated` |
| `author_slug` | text | persona key (AI posts); null for imports — see [[../specs/auto-blog-generation]] |
| `social_image_url` | text | 4:5 social variant (AI posts) — see [[../lifecycles/social-scheduler]] |
| `created_at`, `updated_at` | timestamptz | |

**Constraints / indexes:** `UNIQUE (workspace_id, shopify_article_id)` (idempotency) · `(workspace_id, is_resource, published)` · `(workspace_id, handle)`.

## Foreign keys

- **Out:** `workspace_id` → [[workspaces]].
- **In:** [[post_products]] `post_id` → `posts.id` (ON DELETE CASCADE) — the product→resource join.

## RLS

`ENABLE ROW LEVEL SECURITY`. `authenticated` may SELECT rows for their own `workspace_id` (`posts_ws_read`); `service_role` has full access (`posts_service`). The **storefront is anonymous**, so the public blog + portal both read through the **admin/service-role client** ([[../libraries/posts-import-article]], `_lib/blog-data.ts`), never client-side.

## Common queries

```ts
// Published resources for the portal/search (admin client).
await admin.from("posts")
  .select("id, title, excerpt, featured_image_url, handle, grouping")
  .eq("workspace_id", ws).eq("is_resource", true).eq("published", true);

// One article for the storefront, by handle.
await admin.from("posts").select("*")
  .eq("workspace_id", ws).eq("handle", handle).eq("published", true).maybeSingle();
```

## Gotchas

- **`shopify_article_id` is NOT NULL** — AI-generated posts keep the `ai:{handle}` synthetic key to satisfy the column + the unique idempotency constraint.
- **`grouping` is from a closed vocabulary** the AI classifier picks from; it is **null whenever `is_resource` is false**.
- Images in `content_html` are guaranteed on our storage post-import — safe to `dangerouslySetInnerHTML` directly.

## Related

[[post_products]] · [[products]] · [[../lifecycles/storefront-blog]] · [[../libraries/posts-import-article]] · [[../tables/kb_chunks]] · [[../README]]
