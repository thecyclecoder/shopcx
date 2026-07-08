import { Suspense, type ReactNode } from "react";

// cacheComponents guard — the child page is a client component that fetches workspace-scoped
// director_activity + media_buyer_shadow_reviews data at render time. Wrap in a Suspense
// boundary at the segment layout so the production `next build` doesn't fail on the
// "Uncached data accessed outside of <Suspense>" gate. Mirrors marketing/landers/content/layout.tsx.
export default function ShadowReviewsLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
