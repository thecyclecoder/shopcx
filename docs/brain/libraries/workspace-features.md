# workspace-features.ts

`src/lib/workspace-features.ts` — per-workspace dashboard feature access (workspace-feature-access spec, Phase 1).

Each workspace carries an `enabled_features text[]` allow-list on [[../tables/workspaces]]. The sidebar renders only the nav items whose feature is granted; a direct-URL guard (Phase 2) enforces the same on the server. Role flags (`ownerOnly`/`adminOnly`) still apply on top of the feature filter.

## The model

- A **feature key** is the first path segment under `/dashboard` — `tickets`, `customers`, `subscriptions`, `orders`, `analytics`, `storefront`, `logistics`, `knowledge-base`, `marketing`, `research`, `developer`, and `dashboard` for the home page.
- `workspaces.enabled_features = NULL` → **every** feature enabled. This is the Superfoods (and every pre-existing workspace's) default, so the migration backfills nothing and nobody loses a page.
- An array → **only** those keys are enabled. ShopGrowth ships as `array['tickets']` (CEO 2026-11-12).
- `'settings'` is **always** enabled, regardless of the allow-list — a workspace must be able to configure itself (incl. the chat widget).

## Exports

| Export | Signature | Notes |
|---|---|---|
| `hasWorkspaceFeature` | `(enabled: string[] \| null, feature: string) => boolean` | `null → true`; `feature === 'settings' → true`; otherwise `enabled.includes(feature)`. |
| `featureForHref` | `(href: string) => string \| null` | First `/dashboard` path segment. `/dashboard → 'dashboard'`; `'#'`/non-dashboard/empty → `null` (no feature gate). |

## Callers

- [[../../../src/app/dashboard/sidebar.tsx]] — `NavItem`/`NavSection` gain an optional `feature` key (default derived from the href via `featureForHref`). An item is hidden when its feature isn't granted; a section is hidden when none of its items is visible (feature + role).
- [[../../../src/app/dashboard/layout.tsx]] — server-side direct-URL guard (Phase 2). The proxy stamps the request path onto an `x-pathname` request header (see `src/lib/supabase/middleware.ts` `updateSession` → `forwardedHeaders`); the layout resolves its feature via `featureForHref` and `redirect()`s to the first enabled feature (Tickets for ShopGrowth, else the first `enabled_features` entry, else `/dashboard/settings`) when `hasWorkspaceFeature` is false. Superfoods (`null`) never redirects; API routes are out of scope.
- `enabled_features` loads onto the workspace row via `getUserWorkspaces` (`workspaces(*)`) in [[workspace]] and reaches the sidebar through the dashboard layout's `workspace` prop.

## Tests

`src/lib/workspace-features.test.ts`, registered as `npm run test:workspace-features` (`tsx --test`). Covers the null/settings/allow-list/empty cases of `hasWorkspaceFeature` and the segment derivation of `featureForHref`.

## Status / open work

- ✅ Phase 1 — `enabled_features` column + `hasWorkspaceFeature`/`featureForHref` helper + sidebar filter + test.
- ✅ Phase 2 — server-side direct-URL guard in `src/app/dashboard/layout.tsx` via the proxy `x-pathname` header (a hidden page redirects to `/dashboard/tickets`).
