import { Suspense, type ReactNode } from "react";

// cacheComponents guard — the child page is a client component that fetches workspace-scoped
// cohort + authorization data at render time. Wrap in a Suspense boundary at the segment
// layout so the production `next build` doesn't fail on the "Uncached data accessed outside
// of <Suspense>" gate. Mirrors dashboard/marketing/ads/shadow-reviews/layout.tsx.
export default function MediaBuyerCohortsLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
