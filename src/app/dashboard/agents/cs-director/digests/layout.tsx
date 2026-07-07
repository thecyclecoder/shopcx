import { Suspense } from "react";

// Route-segment Suspense boundary for the CS Director digests page (cacheComponents rule): the
// child is a client component reading uncached data (fetch on mount) — Next 16 with
// cacheComponents:true requires that dynamic access sit inside a Suspense boundary or the
// production build fails "Uncached data accessed outside of <Suspense>".
export default function CsDirectorDigestsLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
