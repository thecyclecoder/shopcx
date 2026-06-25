import { Suspense, type ReactNode } from "react";

// cacheComponents: /workspace/select reads uncached auth/workspace data at request time. A <Suspense>
// boundary (NOT connection(), which doesn't satisfy the data-boundary requirement) wraps the page so its
// prerender doesn't fail with "Uncached data accessed outside of <Suspense>". Covers workspace/* pages.
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
