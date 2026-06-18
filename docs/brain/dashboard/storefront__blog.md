# Dashboard · storefront/blog

Read-only overview of the [[../tables/posts]] object that powers the public storefront blog + the portal Resources section. See [[../lifecycles/storefront-blog]].

**Route:** `/dashboard/storefront/blog` (sidebar **Storefront › Blog**)

## Features

**Page title:** Blog

- **Summary stats** — total posts, published, product resources, distinct groupings.
- **Posts table** — thumbnail, title + `/handle`, grouping pill, product-link count (from [[../tables/post_products]]), published/draft status, published date, and a **View** link → the preview article URL (`/store/{slug}/blog/{handle}`).
- **View live blog** header link → `/store/{slug}/blog`.

**Rendering:** `force-dynamic` server component. Reads via the admin client off `getActiveWorkspaceId()` (RLS on `posts` is service-role only). No mutations — editing happens by re-import or directly in the DB for now.

## Permissions

All workspace members (middleware auth + workspace membership only).

## Files touched

- `src/app/dashboard/storefront/blog/page.tsx`

## Related

[[../lifecycles/storefront-blog]] · [[../tables/posts]] · [[../tables/post_products]] · [[storefront]]

---

[[../README]] · [[../../CLAUDE]]
