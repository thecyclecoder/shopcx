import { Suspense, type ReactNode } from "react";

// cacheComponents: the god-mode cockpit is a client component reading useParams() — wrap it in a
// <Suspense> boundary so its prerender doesn't fail with "Uncached data accessed outside of
// <Suspense>". Same pattern as src/app/journey/layout.tsx.
export default function GodModeLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
