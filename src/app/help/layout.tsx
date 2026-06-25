import { Suspense } from "react";

/**
 * cacheComponents is ON (for the storefront's fast cached PDPs). The help-center / KB minisite pages read
 * uncached data (workspace + article from the DB) and `headers()` at request time. Wrapping {children} in a
 * <Suspense> boundary puts that dynamic access INSIDE a boundary, so Cache Components can prerender the
 * static shell and stream the page instead of failing with "Uncached data accessed outside of <Suspense>".
 * (A layout-level `connection()` does NOT cover this — the child page is a separate render unit that still
 * prerenders; the Suspense boundary is what actually wraps it.)
 *
 * The outer <div> is the host-element root: the child help pages (src/app/help/[slug]/page.tsx and
 * src/app/help/[slug]/[articleSlug]/page.tsx) export `generateMetadata`, so Next streams a
 * <__next_metadata_boundary__> into this layout's child slot. Without a stable host element wrapping both,
 * the PPR resume sees the metadata boundary in the slot where it cached the page's root <div> and forces
 * a full client re-render (Vercel digest 34312922 — 'Expected the resume to render <div> in this slot but
 * instead it rendered <__next_metadata_boundary__>'). Same fix as widget/[workspaceId]/layout.tsx and
 * (storefront)/layout.tsx.
 */
export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="help-root">
      <Suspense fallback={null}>{children}</Suspense>
    </div>
  );
}
