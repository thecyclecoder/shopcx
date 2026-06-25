import { Suspense } from "react";

/**
 * cacheComponents is ON (for the storefront's fast cached PDPs). The customer-portal pages read uncached,
 * per-customer data (workspace + the authed customer's subscriptions/orders) at request time. Wrapping
 * {children} in a <Suspense> boundary puts that dynamic access INSIDE a boundary, so Cache Components can
 * prerender the static shell and stream the page instead of failing with "Uncached data accessed outside of
 * <Suspense>". (A layout-level `connection()` does NOT cover this — the child page still prerenders; the
 * Suspense boundary is what wraps it.)
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
