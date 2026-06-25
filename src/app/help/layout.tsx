import { Suspense } from "react";

/**
 * cacheComponents is ON (for the storefront's fast cached PDPs). The help-center / KB minisite pages read
 * uncached data (workspace + article from the DB) and `headers()` at request time. Wrapping {children} in a
 * <Suspense> boundary puts that dynamic access INSIDE a boundary, so Cache Components can prerender the
 * static shell and stream the page instead of failing with "Uncached data accessed outside of <Suspense>".
 * (A layout-level `connection()` does NOT cover this — the child page is a separate render unit that still
 * prerenders; the Suspense boundary is what actually wraps it.)
 */
export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
