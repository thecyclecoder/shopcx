# Dashboard · research/competitors

The **Research › Competitors** surface — the owner-facing, product-filtered, read-only browse of the workspace's approved + proposed competitor set from [[../tables/competitors]]. First page under the new top-level **Research** sidebar section (surface 1 of N; siblings to follow: Ad Creative gaps, Landing-page snapshots, the unified gap queue from [[../libraries/acquisition-hub]]). Owner of the surface: [[../functions/growth]]. Read-only — discovery + approval stay on [[marketing__acquisition]].

**Route:** `/dashboard/research/competitors` · **owner-only** (nav item `ownerOnly`; the client also gates on `workspace.role === "owner"`, mirroring the [[marketing__acquisition]] "owner-only" fallback).

## Phase 1 — shell (this page)

**Rendering:** `"use client"` component. Renders the heading + a placeholder empty state (Phase 2 fills the table).

Nav plumbing lives in `src/app/dashboard/sidebar.tsx` — a new collapsible `NAV_STRUCTURE` section labeled "Research" (magnifying-glass icon), `ownerOnly: true`, with one child item `Competitors` at this route. Sibling items (Ad Gaps, Landers, Gap Queue) plug in as one-line additions to `section.items`. The segment layout `src/app/dashboard/research/layout.tsx` wraps children in `<Suspense fallback={null}>` so later dynamic-read siblings work under `cacheComponents: true`.

## Phase 2 — competitors table + product filter (planned)

- Product filter defaulting to "All products", populated from the workspace's products (same source the [[marketing__acquisition]] hub uses).
- Filter semantics: selecting a product shows rows WHERE `product_id = <selected> OR product_id IS NULL` — the workspace-level (null-scoped) seeds always stay visible. Otherwise the current all-null data reads as an empty list.
- Columns (from [[../tables/competitors]]): Brand · Domain · Category · Product scope · Source badge · Status badge · Spend signal · PDP-URL count · Evidence (truncate + expand).
- Sort: approved-first, then brand.
- Reads GET `/api/ads/competitors` (owner/admin-gated); `?productId=` added there for the filter. No page control writes to competitors.

## API endpoints called

- Phase 2 → `GET /api/ads/competitors?workspaceId=&productId=` (read-only).

See [[../tables/competitors]] · [[../libraries/competitors]] · [[../libraries/acquisition-hub]] · [[marketing__acquisition]].
