# dashboard/storefront/blog

Read-only admin view of every imported blog post. Sidebar: **Storefront › Blog**. See [[../lifecycles/blog-resources]].

**Route:** `src/app/dashboard/storefront/blog/page.tsx`

## Purpose

A server-component table of every [[../tables/posts|post]] for the active workspace (`getActiveWorkspaceId()` + admin client) — the operator's window into what the AI import classified, so misclassifications can be spotted and fixed.

## Features

- Table columns: thumbnail (`featured_image_url`), title, **grouping**, **product-link count** ([[../tables/post_products]]), published state, date.
- **"View"** per row → the preview article URL (`shopcx.ai/store/{ws}/blog/{handle}`, `noindex`).
- **"View live blog"** → the public custom-domain blog index.

## Permissions

Workspace-scoped via `getActiveWorkspaceId()`; read-only (no mutations from this page — classification is auto-applied at import, edits happen at the data layer for now).

## Related

[[../lifecycles/blog-resources]] · [[../tables/posts]] · [[../tables/post_products]] · [[storefront__funnel]] · [[../libraries/posts__import-article]]
