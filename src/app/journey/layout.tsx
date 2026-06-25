import { Suspense, type ReactNode } from "react";

// cacheComponents: the journey page is a client component reading useParams() — wrap it in a <Suspense>
// boundary so its prerender doesn't fail with "Uncached data accessed outside of <Suspense>".
export default function JourneyLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
