import { Suspense } from "react";

/**
 * cacheComponents is ON (for the storefront's fast cached PDPs). The customer-portal pages read uncached,
 * per-customer data (workspace + the authed customer's subscriptions/orders) at request time. Wrapping
 * {children} in a <Suspense> boundary puts that dynamic access INSIDE a boundary, so Cache Components can
 * prerender the static shell and stream the page instead of failing with "Uncached data accessed outside of
 * <Suspense>". (A layout-level `connection()` does NOT cover this — the child page still prerenders; the
 * Suspense boundary is what wraps it.)
 *
 * The outer <div> is the host-element root: the child [slug]/layout.tsx exports `generateMetadata`, so Next
 * streams a <__next_metadata_boundary__> into THIS layout's children slot as a sibling of the [slug] layout
 * output. Without a stable host element wrapping the Suspense, the PPR resume sees the metadata boundary in
 * the slot where it cached the page's root <div> and forces a full client re-render (Vercel digest
 * 5942e69f6e405813). See operational-rules.md § "Layouts that export metadata must wrap children in a host
 * element" — the rule applies whenever a child layout (not just this one) emits a metadata boundary into
 * this slot. Same fix shape as src/app/help/layout.tsx and src/app/widget/[workspaceId]/layout.tsx.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="portal-root">
      <Suspense fallback={null}>{children}</Suspense>
    </div>
  );
}
