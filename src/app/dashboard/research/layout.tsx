import { Suspense } from "react";

// Segment layout for /dashboard/research/*. Wraps children in Suspense so future sibling routes
// (ad gaps, landers, gap queue) can safely read dynamic data under cacheComponents. The section
// heading itself lives on each page — the sidebar's "Research" section is the shared frame.
export default function ResearchLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
