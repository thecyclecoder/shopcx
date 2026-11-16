// Per-workspace feature access (workspace-feature-access spec, Phase 1).
//
// Each workspace carries an `enabled_features text[]` allow-list on public.workspaces:
//   - NULL  → every feature is enabled (the Superfoods default; nothing changes for it).
//   - []/[…] → only the listed features are enabled.
// A feature key is the first path segment under /dashboard (e.g. `tickets`, `customers`,
// `subscriptions`, `orders`, `analytics`, `storefront`, `logistics`, `knowledge-base`,
// `marketing`, `research`, `developer`, `dashboard` for the home page).
//
// `settings` is ALWAYS enabled — a workspace must be able to configure itself (incl. the
// chat widget) regardless of its feature allow-list. See docs/brain/libraries/workspace-features.md.

/**
 * Does `enabled` grant access to `feature`?
 * - null → true (the workspace has every feature).
 * - 'settings' → always true (workspace configuration is never gated).
 * - otherwise → true iff the feature is in the allow-list.
 */
export function hasWorkspaceFeature(
  enabled: string[] | null,
  feature: string
): boolean {
  if (feature === "settings") return true;
  if (enabled == null) return true;
  return enabled.includes(feature);
}

/**
 * Derive a feature key from a /dashboard href — the first path segment after /dashboard.
 *   /dashboard                     → 'dashboard' (the home page)
 *   /dashboard/tickets             → 'tickets'
 *   /dashboard/marketing/text      → 'marketing'
 *   '#' / non-dashboard / '' href  → null (no feature gate; role + comingSoon still apply)
 */
export function featureForHref(href: string): string | null {
  if (!href || href === "#") return null;
  if (href === "/dashboard") return "dashboard";
  const m = href.match(/^\/dashboard\/([^/?#]+)/);
  return m ? m[1] : null;
}

/**
 * Every column `Workspace` declares, and nothing else (never `*`: that would ship *_encrypted blobs to
 * the browser). `enabled_features` must stay listed: the dashboard layout + sidebar gate on it, and a
 * select that drops it reads as NULL = "all features enabled" (the guard silently fails open).
 */
export const WORKSPACE_ROW_COLUMNS =
  "id, name, shopify_domain, meta_page_id, stripe_account_id, plan, created_at, enabled_features";
