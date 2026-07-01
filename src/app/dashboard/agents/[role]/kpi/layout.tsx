import { Suspense } from "react";

// Route-segment Suspense boundary for the KPI page (cacheComponents rule): the child is a
// client component that reads useParams — Next 16 requires that dynamic access sit inside
// a Suspense boundary or the production build fails "Uncached data accessed outside of
// <Suspense>". Adding it here keeps the page component itself tidy.
export default function KpiLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
