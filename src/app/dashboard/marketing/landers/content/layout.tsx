import { Suspense, type ReactNode } from "react";

// cacheComponents guard — the child page reads dynamic workspace-scoped data (blueprints +
// content gaps), so wrap in a Suspense boundary at the segment layout. Without this the
// production `next build` fails ("Uncached data accessed outside of <Suspense>").
export default function LanderContentLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
