# libraries/developer-nav

The **single source of truth** for the Developer portal's sub-navigation — shared by the sidebar takeover and the Overview cards so there is never a second list to keep in sync.

**File:** `src/lib/developer-nav.ts` (pure data — no imports — safe to import from client or server components)

## Why this exists

"Developer" is a [[../dashboard/developer|portal]], not a collapsing section: the main sidebar shows one top-level item, and entering it swaps the tree for the developer sub-nav. Both that **sidebar takeover** (`src/app/dashboard/sidebar.tsx`) and the **Overview card grid** (`src/app/dashboard/developer/page.tsx`) render the same set of surfaces — so the set is defined once here. Add a developer surface to `DEVELOPER_NAV` and it appears in both with no other edit.

## Exports

- **`DEVELOPER_NAV: DeveloperNavItem[]`** — the developer surfaces in sidebar order (Goals · Pipeline · Build box · Control Tower · Approvals · Taxonomy map · Message Center · Spec Tests · Human QA · Regressions · Security tests · Brain · Branches). Excludes the Overview itself (the portal home). Each item: `href` · `label` · `icon` (heroicon path) · `desc` (Overview card copy) · optional `badge`.
- **`DeveloperNavItem`** / **`DeveloperBadgeKey`** (`approvals｜security｜regressions｜humanQA｜branches`) — the item shape + the live-count keys the sidebar/Overview look up to render a badge.
- **`DEVELOPER_OVERVIEW_HREF`** (`/dashboard/developer`) · **`DEVELOPER_OVERVIEW_ICON`** (the 2×2-grid icon) · **`DEVELOPER_PORTAL_ICON`** (the angle-brackets icon for the main-tree item).
- **`isInDeveloperPortal(pathname)`** → `boolean` — is the path inside the portal (any sub-surface or the Overview)? Drives the sidebar's pathname-based takeover (vs the director-profile context takeover — see the section-nav context (`src/lib/section-nav-context.tsx`)).
- **`isDeveloperHrefActive(pathname, href, allHrefs)`** → `boolean` — most-specific-wins active test (so `/dashboard/roadmap` doesn't light up on `/dashboard/roadmap/box`).

## Callers

- `src/app/dashboard/sidebar.tsx` — the takeover block (back · Overview · the `DEVELOPER_NAV` links + badges) + `isInDeveloperPortal` membership test.
- `src/app/dashboard/developer/page.tsx` — the Overview card grid.

## Related

[[../dashboard/developer]] · the section-nav context (`src/lib/section-nav-context.tsx`) · [[../ui-conventions]]
