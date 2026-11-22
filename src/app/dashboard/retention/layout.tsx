import { Suspense } from "react";

// Segment layout for /dashboard/retention/*. Wraps children in Suspense so the renewal-reminder
// results page (and future retention siblings) can safely read dynamic data under cacheComponents.
// The section heading lives on each page — the sidebar's "Retention" section is the shared frame.
export default function RetentionLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
